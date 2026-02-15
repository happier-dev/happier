import { deriveKey } from "@/encryption/deriveKey";
import { AES256Encryption, BoxEncryption, SecretBoxEncryption, Encryptor, Decryptor } from "./encryptor";
import { encodeHex } from "@/encryption/hex";
import { EncryptionCache } from "./encryptionCache";
import { SessionEncryption } from "./sessionEncryption";
import { MachineEncryption } from "./machineEncryption";
import { encodeBase64, decodeBase64 } from "@/encryption/base64";
import sodium from '@/encryption/libsodium.lib';
import { decryptBox, encryptBox } from "@/encryption/libsodium";
import { randomUUID } from '@/platform/randomUUID';
import { getRandomBytes } from '@/platform/cryptoRandom';
import {
    openAccountScopedBlobCiphertext,
    openEncryptedDataKeyEnvelopeV1,
    sealAccountScopedBlobCiphertext,
    sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';

export class Encryption {

    static async create(masterSecret: Uint8Array) {

        // Derive content data key to open session and machine records
        const contentDataKey = await deriveKey(masterSecret, 'Happy EnCoder', ['content']);

        // Derive content data key keypair
        const contentKeyPair = sodium.crypto_box_seed_keypair(contentDataKey);

        // Derive anonymous ID
        const anonID = encodeHex((await deriveKey(masterSecret, 'Happy Coder', ['analytics', 'id']))).slice(0, 16).toLowerCase();

        // Create encryption
        return new Encryption(anonID, masterSecret, contentKeyPair);
    }

    static async createFromContentKeyPair(params: { publicKey: Uint8Array; machineKey: Uint8Array }) {
        // Best-effort: we don't have the original secret seed in dataKey mode.
        // Using machineKey as the legacy secret keeps legacy fallback deterministic while
        // ensuring content-key based encryption/decryption works.
        const fallbackKey = params.machineKey;
        const anonID = encodeHex((await deriveKey(fallbackKey, 'Happy Coder', ['analytics', 'id']))).slice(0, 16).toLowerCase();
        const contentKeyPair: sodium.KeyPair = { publicKey: params.publicKey, privateKey: params.machineKey };
        return new Encryption(anonID, fallbackKey, contentKeyPair, true);
    }

    private readonly fallbackEncryption: Encryptor & Decryptor;
    // Automation templates must be decryptable by the daemon across credential modes.
    // We always seal them with secretbox using the master secret (legacy) or machine key (dataKey).
    private readonly automationTemplateEncryption: Encryptor & Decryptor;
    private readonly contentKeyPair: sodium.KeyPair;
    readonly anonID: string;
    readonly contentDataKey: Uint8Array;

    // Session and machine encryption management
    private sessionEncryptions = new Map<string, SessionEncryption>();
    private sessionKeyFingerprints = new Map<string, string>();
    private machineEncryptions = new Map<string, MachineEncryption>();
    private cache: EncryptionCache;

    private constructor(
        anonID: string,
        masterSecret: Uint8Array,
        contentKeyPair: sodium.KeyPair,
        useDataKeyFallback = false
    ) {
        this.anonID = anonID;
        this.contentKeyPair = contentKeyPair;
        this.fallbackEncryption = useDataKeyFallback
            ? new AES256Encryption(masterSecret)
            : new SecretBoxEncryption(masterSecret);
        this.automationTemplateEncryption = new SecretBoxEncryption(masterSecret);
        this.cache = new EncryptionCache();
        this.contentDataKey = contentKeyPair.publicKey;
    }

    getContentPrivateKey(): Uint8Array {
        return this.contentKeyPair.privateKey;
    }

    //
    // Core encryption opening
    //

    async openEncryption(dataEncryptionKey: Uint8Array | null): Promise<Encryptor & Decryptor> {
        if (!dataEncryptionKey) {
            return this.fallbackEncryption;
        }
        return new AES256Encryption(dataEncryptionKey);
    }

    //
    // Session operations
    //

    /**
     * Initialize sessions with their encryption keys
     * This should be called once when sessions are loaded
     */
    async initializeSessions(sessions: Map<string, Uint8Array | null>): Promise<void> {
        for (const [sessionId, dataKey] of sessions) {
            const fingerprint = dataKey ? encodeBase64(dataKey, 'base64') : '__no_key__';
            const existing = this.sessionEncryptions.get(sessionId);
            const existingFingerprint = this.sessionKeyFingerprints.get(sessionId);
            // Skip if already initialized with the same key (or both missing).
            if (existing && existingFingerprint === fingerprint) {
                continue;
            }

            // Create appropriate encryptor based on data key
            const encryptor = await this.openEncryption(dataKey);

            // Create and cache session encryption
            const sessionEnc = new SessionEncryption(
                sessionId,
                encryptor,
                this.cache
            );
            this.sessionEncryptions.set(sessionId, sessionEnc);
            this.sessionKeyFingerprints.set(sessionId, fingerprint);

            // If the session key changed (often due to decryptEncryptionKey becoming available later),
            // clear cached decrypted session data so future reads use the updated encryptor.
            // Note: message cache is keyed only by messageId; encrypted messages that previously
            // failed to decrypt must not be permanently cached (handled in SessionEncryption).
            if (existing) {
                this.cache.clearSessionCache(sessionId);
            }
        }
    }

    /**
     * Get session encryption if it has been initialized
     * Returns null if not initialized (should never happen in normal flow)
     */
    getSessionEncryption(sessionId: string): SessionEncryption | null {
        return this.sessionEncryptions.get(sessionId) || null;
    }

    /**
     * Remove session encryption from memory when session is deleted
     */
    removeSessionEncryption(sessionId: string): void {
        this.sessionEncryptions.delete(sessionId);
        this.sessionKeyFingerprints.delete(sessionId);
        // Also clear any cached data for this session
        this.cache.clearSessionCache(sessionId);
    }

    //
    // Machine operations
    //

    /**
     * Initialize machines with their encryption keys
     * This should be called once when machines are loaded
     */
    async initializeMachines(machines: Map<string, Uint8Array | null>): Promise<void> {
        for (const [machineId, dataKey] of machines) {
            // Skip if already initialized
            if (this.machineEncryptions.has(machineId)) {
                continue;
            }

            // Create appropriate encryptor based on data key
            const encryptor = await this.openEncryption(dataKey);

            // Create and cache machine encryption
            const machineEnc = new MachineEncryption(
                machineId,
                encryptor,
                this.cache
            );
            this.machineEncryptions.set(machineId, machineEnc);
        }
    }

    /**
     * Get machine encryption if it has been initialized
     * Returns null if not initialized (should never happen in normal flow)
     */
    getMachineEncryption(machineId: string): MachineEncryption | null {
        return this.machineEncryptions.get(machineId) || null;
    }

    //
    // Legacy methods for machine metadata (temporary until machines are migrated)
    //

    async encryptRaw(data: any): Promise<string> {
        const encrypted = await this.fallbackEncryption.encrypt([data]);
        return encodeBase64(encrypted[0], 'base64');
    }

    async decryptRaw(encrypted: string): Promise<any | null> {
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await this.fallbackEncryption.decrypt([encryptedData]);
            return decrypted[0] || null;
        } catch (error) {
            return null;
        }
    }

    async encryptAutomationTemplateRaw(data: any): Promise<string> {
        const machineKey = this.getContentPrivateKey();
        return sealAccountScopedBlobCiphertext({
            kind: 'automation_template_payload',
            material: { type: 'dataKey', machineKey },
            payload: data,
            randomBytes: getRandomBytes,
        });
    }

    async decryptAutomationTemplateRaw(encrypted: string): Promise<any | null> {
        const machineKey = this.getContentPrivateKey();
        const opened = openAccountScopedBlobCiphertext({
            kind: 'automation_template_payload',
            material: { type: 'dataKey', machineKey },
            ciphertext: encrypted,
        });
        if (opened) return opened.value ?? null;

        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const machineDecrypted = await new SecretBoxEncryption(machineKey).decrypt([encryptedData]);
            if (machineDecrypted[0]) return machineDecrypted[0];

            const decrypted = await this.automationTemplateEncryption.decrypt([encryptedData]);
            return decrypted[0] || null;
        } catch {
            return null;
        }
    }

    //
    // Data Encryption Key decryption
    //

    async decryptEncryptionKey(encrypted: string) {
        const encryptedKey = decodeBase64(encrypted, 'base64');
        return openEncryptedDataKeyEnvelopeV1({
            envelope: encryptedKey,
            recipientSecretKeyOrSeed: this.contentKeyPair.privateKey,
        });
    }

    async encryptEncryptionKey(key: Uint8Array): Promise<Uint8Array> {
        // Use public key for encryption (encrypt TO ourselves)
        return sealEncryptedDataKeyEnvelopeV1({
            dataKey: key,
            recipientPublicKey: this.contentKeyPair.publicKey,
            randomBytes: getRandomBytes,
        });
    }

    generateId(): string {
        return randomUUID();
    }
}
