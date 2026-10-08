import { Encryption } from '@/sync/encryption/encryption';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { RawRecord } from "@happier-dev/session-core/raw";
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot, setActiveServer } from '@/sync/domains/server/serverRuntime';
import { switchConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';

const initialStorageState = storage.getState();

export async function resetPendingQueueState(activeScope?: ServerAccountScope): Promise<void> {
    storage.setState(initialStorageState, true);
    if (activeScope) await activatePendingQueueScope(activeScope);
}

export async function activatePendingQueueScope(activeScope: ServerAccountScope): Promise<void> {
    const server = await upsertServerProfile({ serverUrl: `https://${activeScope.serverId}` });
    if (server.id !== activeScope.serverId) throw new Error('Pending queue fixture requires its exact Home profile');
    await setActiveServer({ serverId: server.id, scope: 'device' });
    if (getActiveServerSnapshot().serverId !== activeScope.serverId) throw new Error('Pending queue fixture did not select its exact Home');
    // Pending projections follow the applied Home, not just the selected profile.
    // With the fixture's empty credential store, this applies the real connection
    // owner without starting authenticated Sync or issuing network requests.
    await switchConnectionToActiveServer();
    storage.getState().activateProfileScope(activeScope);
    await storage.getState().activateSettingsScope(activeScope);
    storage.getState().activateSessionLocalStateScope(activeScope);
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

export function currentPendingEnqueueAck(
    init: RequestInit | undefined,
    pending: Readonly<Record<string, unknown>> = {},
): Response {
    const body = JSON.parse(String(init?.body ?? 'null')) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('Expected a current Pending enqueue request body');
    }
    const request = body as Readonly<Record<string, unknown>>;
    return Response.json({
        requestedAction: request.requestedAction,
        pending: {
            localId: request.localId,
            ...pending,
        },
    });
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
