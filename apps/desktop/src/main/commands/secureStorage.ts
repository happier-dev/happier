import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type SafeStorageBoundary = Readonly<{
    isEncryptionAvailable: () => boolean;
    encryptString: (value: string) => Buffer;
    decryptString: (value: Buffer) => string;
    getSelectedStorageBackend?: () => string;
}>;

export type ElectronSecureStorageDependencies = Readonly<{
    userDataPath: () => string;
    crypto: SafeStorageBoundary;
}>;

const STORAGE_DIRECTORY = ['device-local-storage', 'v1'] as const;
const KEY_DOMAIN = 'happier.desktop.device-local-storage.v1\0';

function opaqueScopedKey(key: string): string {
    return createHash('sha256').update(KEY_DOMAIN).update(key).digest('hex');
}

function isMissingFile(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * The app's one device-local custody owner, shared by every window of this process (the
 * `desktop_secure_storage_*` commands), like the Tauri owner in `src-tauri/src/secure_storage.rs`.
 *
 * It keeps the last value it read or wrote for each key in memory, so windows read it over IPC
 * instead of reading and decrypting the file on every authenticated request. File operations on a
 * key run one at a time, and the remembered value changes in that same order, so it always matches
 * the file; a read in flight is shared. A failed call leaves the key uncached. Every call still checks safeStorage
 * first, so custody fails closed when protection becomes unavailable. The single-instance lock
 * guarantees no second process writes these files.
 */
export class ElectronSecureStorage {
    readonly #dependencies: ElectronSecureStorageDependencies;
    readonly #values = new Map<string, Promise<string | null>>();
    readonly #tails = new Map<string, Promise<unknown>>();

    constructor(dependencies: ElectronSecureStorageDependencies) {
        this.#dependencies = dependencies;
    }

    #assertEncryptionAvailable(): void {
        if (!this.#dependencies.crypto.isEncryptionAvailable()) {
            throw new Error('Electron safeStorage encryption is unavailable');
        }
        if (this.#dependencies.crypto.getSelectedStorageBackend?.() === 'basic_text') {
            throw new Error('Electron safeStorage has no protected OS credential backend');
        }
    }

    #pathFor(key: string): string {
        return join(this.#dependencies.userDataPath(), ...STORAGE_DIRECTORY, `${opaqueScopedKey(key)}.bin`);
    }

    #serialize<T>(key: string, run: () => Promise<T>): Promise<T> {
        const next = (this.#tails.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
        this.#tails.set(key, next);
        void next.catch(() => {}).then(() => {
            if (this.#tails.get(key) === next) this.#tails.delete(key);
        });
        return next;
    }

    async read(key: string): Promise<string | null> {
        this.#assertEncryptionAvailable();
        const known = this.#values.get(key);
        if (known) return await known;
        const reading = this.#serialize(key, () => this.#readFile(key));
        this.#values.set(key, reading);
        reading.catch(() => {
            if (this.#values.get(key) === reading) this.#values.delete(key);
        });
        return await reading;
    }

    async #readFile(key: string): Promise<string | null> {
        try {
            return this.#dependencies.crypto.decryptString(await readFile(this.#pathFor(key)));
        } catch (error) {
            if (isMissingFile(error)) return null;
            throw error;
        }
    }

    async write(key: string, value: string): Promise<void> {
        this.#assertEncryptionAvailable();
        // Whatever a failed write left on disk, the next read asks the file.
        this.#values.delete(key);
        await this.#serialize(key, async () => {
            await this.#writeFile(key, value);
            this.#values.set(key, Promise.resolve(value));
        });
    }

    async #writeFile(key: string, value: string): Promise<void> {
        const destination = this.#pathFor(key);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') {
            await chmod(dirname(destination), 0o700);
        }
        const temporary = `${destination}.${randomUUID()}.tmp`;
        const ciphertext = this.#dependencies.crypto.encryptString(value);
        const handle = await open(temporary, 'wx', 0o600);
        try {
            await handle.writeFile(ciphertext);
            await handle.sync();
            await handle.close();
            await rename(temporary, destination);
            if (process.platform !== 'win32') {
                await chmod(destination, 0o600);
            }
        } catch (error) {
            await handle.close().catch(() => {});
            await unlink(temporary).catch(() => {});
            throw error;
        }
    }

    async remove(key: string): Promise<void> {
        this.#assertEncryptionAvailable();
        this.#values.delete(key);
        await this.#serialize(key, async () => {
            await rm(this.#pathFor(key), { force: true });
            this.#values.set(key, Promise.resolve(null));
        });
    }
}
