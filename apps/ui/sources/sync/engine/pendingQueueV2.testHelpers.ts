import { Encryption } from '../encryption/encryption';
import { storage } from '../storage';
import type { Session } from '../storageTypes';
import type { RawRecord } from '../typesRaw';

const initialStorageState = storage.getState();

export function resetPendingQueueState(): void {
    storage.setState(initialStorageState, true);
}

export async function createPendingQueueEncryption(params: {
    sessionId: string;
    seedByte?: number;
}): Promise<Encryption> {
    const encryption = await Encryption.create(new Uint8Array(32).fill(params.seedByte ?? 3));
    await encryption.initializeSessions(new Map([[params.sessionId, null]]));
    return encryption;
}

export function getSessionEncryptionOrThrow(params: {
    encryption: Encryption;
    sessionId: string;
}): NonNullable<ReturnType<Encryption['getSessionEncryption']>> {
    const sessionEncryption = params.encryption.getSessionEncryption(params.sessionId);
    if (!sessionEncryption) {
        throw new Error(`missing session encryption for ${params.sessionId}`);
    }
    return sessionEncryption;
}

export function buildSession(params: {
    sessionId: string;
    overrides?: Partial<Session>;
}): Session {
    const now = Date.now();
    return {
        id: params.sessionId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
        ...(params.overrides ?? {}),
    };
}

export async function encryptRawRecordForPending(params: {
    encryption: Encryption;
    sessionId: string;
    rawRecord: RawRecord;
}): Promise<string> {
    const sessionEncryption = getSessionEncryptionOrThrow({
        encryption: params.encryption,
        sessionId: params.sessionId,
    });
    return sessionEncryption.encryptRawRecord(params.rawRecord);
}
