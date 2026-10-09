import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { MachineMetadata, MachineMetadataSchema } from '../domains/state/storageTypes';
import { EncryptionCache } from './encryptionCache';
import { Decryptor, Encryptor } from './encryptor';
import { syncPerformanceTelemetry } from '../runtime/syncPerformanceTelemetry';
import { AccessibleMachineAccessStoredReadV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { MachineKeyBasisStoredReadV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import type { MachineEncryptionContextInput } from './encryption';
import { parseMachinePublishedMetadataV1, parseMachinePublishedDaemonStateV1, StoredMachinePublishedDaemonStateV1Schema, type MachinePublishedDaemonStateV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';

/** The recipient opening envelope and owner encoded-write identity have distinct jobs. */
export function readMachineEncryptionContextInput(
    machine: Readonly<{ dataEncryptionKey?: unknown; keyBasis?: unknown; access?: unknown; isShared?: boolean }>,
    viewerAccountId: string | null,
): MachineEncryptionContextInput {
    const dataEncryptionKey = typeof machine.dataEncryptionKey === 'string' ? machine.dataEncryptionKey : null;
    const basis = MachineKeyBasisStoredReadV1Schema.safeParse(machine.keyBasis);
    const access = AccessibleMachineAccessStoredReadV1Schema.safeParse(machine.access);
    return {
        dataEncryptionKey,
        ...(access.success ? { resourceMode: access.data.resourceMode, accessState: access.data.accessState }
            : machine.access !== undefined || machine.isShared ? { accessState: 'unavailable' as const } : {}),
        expectedDataEncryptionKey: machine.keyBasis !== undefined
            ? basis.success ? basis.data.dataEncryptionKey : undefined
            : machine.isShared || (machine.access !== undefined && (!access.success || access.data.custodian.accountId !== viewerAccountId))
                ? undefined
                : dataEncryptionKey,
    };
}

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
    private machineId: string;
    private encryptor: Encryptor & Decryptor;
    private cache: EncryptionCache;

    constructor(
        machineId: string,
        encryptor: Encryptor & Decryptor,
        cache: EncryptionCache,
        private readonly isCurrent: () => boolean = () => true,
    ) {
        this.machineId = machineId;
        this.encryptor = encryptor;
        this.cache = cache;
    }

    /**
     * Encrypt machine metadata
     */
    async encryptMetadata(metadata: MachineMetadata): Promise<string> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.machine.encryptMetadata',
            { items: 1 },
            async () => {
                const encrypted = await this.encryptor.encrypt([parseMachinePublishedMetadataV1(metadata)]);
                return encodeBase64(encrypted[0], 'base64');
            },
        );
    }

    /**
     * Decrypt machine metadata with caching
     */
    async decryptMetadata(version: number, encrypted: string): Promise<MachineMetadata | null> {
        if (!this.isCurrent()) return null;
        // Check cache first
        const cached = this.cache.getCachedMachineMetadata(this.machineId, version);
        if (cached) {
            return cached;
        }

        // Decrypt if not cached
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await syncPerformanceTelemetry.measureAsync(
                'sync.encryption.machine.decryptMetadata',
                { items: 1 },
                async () => this.encryptor.decrypt([encryptedData]),
            );
            if (!this.isCurrent()) return null;
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
    async encryptDaemonState(state: unknown): Promise<string> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.machine.encryptDaemonState',
            { items: 1 },
            async () => {
                const encrypted = await this.encryptor.encrypt([parseMachinePublishedDaemonStateV1(state)]);
                return encodeBase64(encrypted[0], 'base64');
            },
        );
    }

    /**
     * Decrypt daemon state with caching
     */
    async decryptDaemonState(version: number, encrypted: string | null | undefined): Promise<MachinePublishedDaemonStateV1 | null> {
        if (!this.isCurrent() || !encrypted) {
            return null;
        }

        // Check cache first
        const cached = this.cache.getCachedDaemonState(this.machineId, version);
        if (cached !== undefined) {
            return cached;
        }

        // Decrypt if not cached
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await syncPerformanceTelemetry.measureAsync(
                'sync.encryption.machine.decryptDaemonState',
                { items: 1 },
                async () => this.encryptor.decrypt([encryptedData]),
            );
            if (!this.isCurrent()) return null;
            const parsed = StoredMachinePublishedDaemonStateV1Schema.safeParse(decrypted[0]);
            const result = parsed.success ? parsed.data : null;
            
            // Cache the result (including null values)
            this.cache.setCachedDaemonState(this.machineId, version, result);
            return result;
        } catch (error) {
            if (!this.isCurrent()) return null;
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
                const encrypted = await this.encryptor.encrypt([data]);
                return encodeBase64(encrypted[0], 'base64');
            },
        );
    }

    /**
     * Decrypt raw data using machine-specific encryption
     */
    async decryptRaw(encrypted: string): Promise<any | null> {
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await syncPerformanceTelemetry.measureAsync(
                'sync.encryption.machine.decryptRaw',
                { items: 1 },
                async () => this.encryptor.decrypt([encryptedData]),
            );
            return decrypted[0] || null;
        } catch (error) {
            console.error('Failed to decrypt raw data:', error);
            return null;
        }
    }
}
