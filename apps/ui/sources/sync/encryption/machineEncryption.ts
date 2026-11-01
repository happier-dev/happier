import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { t } from '@/text';
import { decodePlainMachineStoredContent, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { MachineMetadata, MachineMetadataSchema } from '../domains/state/storageTypes';
import { EncryptionCache } from './encryptionCache';
import { Decryptor, Encryptor } from './encryptor';
import { syncPerformanceTelemetry } from '../runtime/syncPerformanceTelemetry';

export const MACHINE_ENCRYPT_RAW_ATTRIBUTION_EVENTS = {
    metadataWrite: 'sync.encryption.machine.encryptRaw.metadataWrite',
    scopedRpcSessionWrite: 'sync.encryption.machine.encryptRaw.scopedRpc.sessionWrite',
    scopedRpcOther: 'sync.encryption.machine.encryptRaw.scopedRpc.other',
} as const;

export type MachineEncryptRawAttributionEventName =
    (typeof MACHINE_ENCRYPT_RAW_ATTRIBUTION_EVENTS)[keyof typeof MACHINE_ENCRYPT_RAW_ATTRIBUTION_EVENTS];

export async function measureMachineEncryptRawAttribution<T>(
    attributionEventName: MachineEncryptRawAttributionEventName,
    encrypt: () => Promise<T>,
): Promise<T> {
    return await syncPerformanceTelemetry.measureAsync(
        attributionEventName,
        { items: 1 },
        encrypt,
    );
}

export class MachineEncryption {
    readonly mode: 'plain' | 'e2ee';
    private machineId: string;
    private encryptor: (Encryptor & Decryptor) | null;
    private cache: EncryptionCache;

    constructor(
        machineId: string,
        encryptor: (Encryptor & Decryptor) | null,
        cache: EncryptionCache
    ) {
        this.mode = encryptor ? 'e2ee' : 'plain';
        this.machineId = machineId;
        this.encryptor = encryptor;
        this.cache = cache;
    }

    private async encode(value: unknown): Promise<string> {
        if (!this.encryptor) return encodePlainMachineStoredContent(value);
        const encrypted = await this.encryptor.encrypt([value]);
        return encodeBase64(encrypted[0], 'base64');
    }

    private async decode(value: string): Promise<unknown> {
        if (!this.encryptor) return decodePlainMachineStoredContent(value);
        const decrypted = await this.encryptor.decrypt([decodeBase64(value, 'base64')]);
        return decrypted[0] ?? null;
    }

    async encodeRpcPayload(payload: unknown): Promise<unknown> {
        return this.mode === 'plain' ? payload : await this.encryptRaw(payload);
    }

    async decodeRpcResult(value: unknown): Promise<unknown> {
        if (this.mode === 'plain') return value;
        const encrypted = Array.isArray(value) && value.length === 1 ? value[0] : value;
        const decoded = typeof encrypted === 'string' ? await this.decryptRaw(encrypted) : null;
        if (decoded === null || decoded === undefined) {
            throw createRpcCallError({ error: t('errors.machineRpcDecryptionFailed'), errorCode: 'machine_rpc_decryption_failed' });
        }
        return decoded;
    }

    /**
     * Encrypt machine metadata
     */
    async encryptMetadata(metadata: MachineMetadata): Promise<string> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.machine.encryptMetadata',
            { items: 1 },
            async () => {
                return await this.encode(metadata);
            },
        );
    }

    /**
     * Decrypt machine metadata with caching
     */
    async decryptMetadata(version: number, encrypted: string): Promise<MachineMetadata | null> {
        // Check cache first
        const cached = this.cache.getCachedMachineMetadata(this.machineId, version);
        if (cached) {
            return cached;
        }

        // Decrypt if not cached
        try {
            const decrypted = await syncPerformanceTelemetry.measureAsync(
                'sync.encryption.machine.decryptMetadata',
                { items: 1 },
                async () => [await this.decode(encrypted)],
            );
            if (!decrypted[0]) {
                return null;
            }
            
            const parsed = MachineMetadataSchema.safeParse(decrypted[0]);
            if (!parsed.success) {
                console.error('Failed to parse machine metadata:', parsed.error);
                return null;
            }

            // Cache the result
            this.cache.setCachedMachineMetadata(this.machineId, version, parsed.data);
            return parsed.data;
        } catch (error) {
            console.error('Failed to decrypt machine metadata:', error);
            return null;
        }
    }

    /**
     * Encrypt daemon state
     */
    async encryptDaemonState(state: any): Promise<string> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.machine.encryptDaemonState',
            { items: 1 },
            async () => {
                return await this.encode(state);
            },
        );
    }

    /**
     * Decrypt daemon state with caching
     */
    async decryptDaemonState(version: number, encrypted: string | null | undefined): Promise<any | null> {
        if (!encrypted) {
            return null;
        }

        // Check cache first
        const cached = this.cache.getCachedDaemonState(this.machineId, version);
        if (cached !== undefined) {
            return cached;
        }

        // Decrypt if not cached
        try {
            const decrypted = await syncPerformanceTelemetry.measureAsync(
                'sync.encryption.machine.decryptDaemonState',
                { items: 1 },
                async () => [await this.decode(encrypted)],
            );
            const result = decrypted[0] || null;
            
            // Cache the result (including null values)
            this.cache.setCachedDaemonState(this.machineId, version, result);
            return result;
        } catch (error) {
            console.error('Failed to decrypt daemon state:', error);
            // Cache null result to avoid repeated decryption attempts
            this.cache.setCachedDaemonState(this.machineId, version, null);
            return null;
        }
    }

    /**
     * Encrypt raw data using machine-specific encryption
     */
    async encryptRaw(data: any): Promise<string> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.machine.encryptRaw',
            { items: 1 },
            async () => {
                return await this.encode(data);
            },
        );
    }

    /**
     * Decrypt raw data using machine-specific encryption
     */
    async decryptRaw(encrypted: string): Promise<any | null> {
        try {
            const decrypted = await syncPerformanceTelemetry.measureAsync(
                'sync.encryption.machine.decryptRaw',
                { items: 1 },
                async () => [await this.decode(encrypted)],
            );
            return decrypted[0] ?? null;
        } catch (error) {
            console.error('Failed to decrypt raw data:', error);
            return null;
        }
    }
}
