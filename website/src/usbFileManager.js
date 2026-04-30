// src/usbFileManager.js
// Manajemen file di USB dengan penyimpanan metadata kategori dan data santri

const usbFileManager = (function() {
    const HANDLE_KEY = 'usb_root_handle';
    const DB_NAME = 'USBFileManagerDB';
    const STORE_NAME = 'handles';
    const DB_VERSION = 2;
    const METADATA_FILE = 'file_metadata.json';

    // Cache metadata
    let metadataCache = null;

    // ===== INDEXEDDB: Simpan handle folder =====
    async function saveHandle(handle) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            };
            request.onsuccess = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.close();
                    reject(new Error('Object store tidak ditemukan setelah upgrade'));
                    return;
                }
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                store.put(handle, HANDLE_KEY);
                tx.oncomplete = () => {
                    db.close();
                    resolve();
                };
                tx.onerror = (err) => {
                    db.close();
                    reject(err);
                };
            };
            request.onerror = (err) => reject(err);
        });
    }

    async function loadHandle() {
        return new Promise((resolve) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            };
            request.onsuccess = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.close();
                    resolve(null);
                    return;
                }
                const tx = db.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const get = store.get(HANDLE_KEY);
                get.onsuccess = () => {
                    const result = get.result;
                    db.close();
                    resolve(result);
                };
                get.onerror = () => {
                    db.close();
                    resolve(null);
                };
            };
            request.onerror = () => resolve(null);
        });
    }

    // ===== Manajemen Metadata =====
    async function loadMetadata() {
        if (metadataCache !== null) return metadataCache;
        const dirHandle = await getRootHandle();
        if (!dirHandle) return {};
        try {
            const fileHandle = await dirHandle.getFileHandle(METADATA_FILE);
            const file = await fileHandle.getFile();
            const text = await file.text();
            metadataCache = JSON.parse(text);
            return metadataCache;
        } catch {
            metadataCache = {};
            return metadataCache;
        }
    }

    async function saveMetadata() {
        if (metadataCache === null) return;
        const dirHandle = await getRootHandle();
        if (!dirHandle) return;
        try {
            const fileHandle = await dirHandle.getFileHandle(METADATA_FILE, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(JSON.stringify(metadataCache, null, 2));
            await writable.close();
        } catch (err) {
            console.error('Gagal menyimpan metadata:', err);
        }
    }

    async function setFileCategory(filename, category) {
        await loadMetadata();
        metadataCache[filename] = category;
        await saveMetadata();
    }

    async function getFileCategory(filename) {
        await loadMetadata();
        return metadataCache[filename] || tebakKategori(filename);
    }

    async function removeFileCategory(filename) {
        await loadMetadata();
        delete metadataCache[filename];
        await saveMetadata();
    }

    // ===== Minta user memilih folder =====
    async function pilihFolder() {
        try {
            const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
            await saveHandle(dirHandle);
            // Reset cache karena folder baru
            metadataCache = null;
            return dirHandle;
        } catch (err) {
            if (err.name !== 'AbortError') console.error('Gagal memilih folder:', err);
            return null;
        }
    }

    // ===== Dapatkan handle root + periksa izin =====
    async function getRootHandle() {
        let handle = await loadHandle();
        if (!handle) return null;
        try {
            // Cek apakah handle masih valid (belum dihapus/dipindah)
            await handle.requestPermission({ mode: 'readwrite' });
            return handle;
        } catch {
            // Handle tidak valid, hapus dari IndexedDB
            return null;
        }
    }

    // ===== Daftar semua file di folder (kecuali file metadata) =====
    async function listFiles() {
        const dirHandle = await getRootHandle();
        if (!dirHandle) return [];
        await loadMetadata(); // pastikan metadata termuat

        const files = [];
        try {
            for await (const entry of dirHandle.values()) {
                if (entry.kind === 'file' && entry.name !== METADATA_FILE) {
                    const file = await entry.getFile();
                    const category = await getFileCategory(entry.name);
                    files.push({
                        name: entry.name,
                        size: file.size,
                        type: file.type || 'application/octet-stream',
                        lastModified: file.lastModified,
                        handle: entry,
                        category: category
                    });
                }
            }
            files.sort((a, b) => b.lastModified - a.lastModified);
        } catch (err) {
            console.error('Gagal membaca daftar file:', err);
        }
        return files;
    }

    // ===== Tebak kategori berdasarkan ekstensi file =====
    function tebakKategori(filename) {
        const lower = filename.toLowerCase();
        if (lower.includes('pelanggaran') && lower.endsWith('.json')) return 'pelanggaran';
        if (lower.includes('reward') && lower.endsWith('.json')) return 'reward';
        if (lower.includes('santri_data') && lower.endsWith('.json')) return 'santri';
        if (lower.match(/\.(xlsx|xls|doc|docx|pdf|jpg|jpeg|png|gif|txt)$/i)) return 'pengajuan';
        return 'lainnya';
    }

    // ===== Upload file ke folder =====
    async function uploadFile(file, category) {
        const dirHandle = await getRootHandle();
        if (!dirHandle) throw new Error('Tidak dapat mengakses folder. Silakan pilih folder terlebih dahulu.');

        const fileName = file.name;
        console.log(`Mengupload ${fileName} ke folder dengan kategori ${category}...`);

        try {
            // Cek apakah file sudah ada
            let fileHandle;
            try {
                fileHandle = await dirHandle.getFileHandle(fileName);
                // File sudah ada, tanyakan apakah ingin overwrite
                const overwrite = confirm(`File "${fileName}" sudah ada. Apakah ingin menimpa?`);
                if (!overwrite) throw new Error('Upload dibatalkan oleh user');
            } catch (e) {
                // File tidak ada, buat baru
                fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
            }
            
            const writable = await fileHandle.createWritable();
            await writable.write(file);
            await writable.close();
            // Simpan kategori
            await setFileCategory(fileName, category);
            console.log(`Berhasil upload: ${fileName} (kategori: ${category})`);
            return true;
        } catch (err) {
            console.error(`Gagal upload ${fileName}:`, err);
            throw new Error(`Gagal menulis file: ${err.message}`);
        }
    }

    // ===== Hapus file berdasarkan handle =====
    async function deleteFile(fileHandle) {
        const fileName = fileHandle.name;
        try {
            await fileHandle.remove();
            await removeFileCategory(fileName);
            console.log(`File ${fileName} berhasil dihapus`);
            return true;
        } catch (err) {
            console.error('Gagal hapus file:', err);
            return false;
        }
    }

    // ===== Ambil file sebagai Blob untuk di-download =====
    async function getFileBlob(fileHandle) {
        return await fileHandle.getFile();
    }

    // ===== Baca file JSON =====
    async function readJSONFile(filename) {
        try {
            const dirHandle = await getRootHandle();
            if (!dirHandle) return null;
            const fileHandle = await dirHandle.getFileHandle(filename);
            const file = await fileHandle.getFile();
            const text = await file.text();
            return JSON.parse(text);
        } catch {
            return null;
        }
    }

    // ===== Simpan data JSON =====
    async function saveData(filename, data) {
        try {
            const dirHandle = await getRootHandle();
            if (!dirHandle) return false;
            const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(JSON.stringify(data, null, 2));
            await writable.close();
            return true;
        } catch (err) {
            console.error('Gagal menyimpan data:', err);
            return false;
        }
    }

    // ===== Hapus semua file kecuali yang ditentukan =====
    async function deleteAllExcept(exceptions = []) {
        const dirHandle = await getRootHandle();
        if (!dirHandle) return 0;
        
        let deletedCount = 0;
        try {
            for await (const entry of dirHandle.values()) {
                if (entry.kind === 'file' && !exceptions.includes(entry.name) && entry.name !== METADATA_FILE) {
                    try {
                        await entry.remove();
                        await removeFileCategory(entry.name);
                        deletedCount++;
                    } catch (err) {
                        console.error(`Gagal hapus ${entry.name}:`, err);
                    }
                }
            }
        } catch (err) {
            console.error('Gagal membersihkan folder:', err);
        }
        return deletedCount;
    }

    // ===== Cek apakah folder sudah dipilih =====
    async function isFolderSelected() {
        const handle = await getRootHandle();
        return handle !== null;
    }

    // ===== API publik =====
    return {
        isSupported: () => 'showDirectoryPicker' in window,
        pilihFolder,
        listFiles,
        uploadFile,
        deleteFile,
        deleteAllExcept,
        getFileBlob,
        getRootHandle,
        readJSONFile,
        saveData,
        isFolderSelected
    };
})();