import { randomBytes } from 'node:crypto';
import axios from 'axios';
import type { Socket } from 'socket.io-client';
import { logger } from '@/ui/logger';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { readStoredCredentials } from '@/persistence';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1, projectActionOperationSnapshotForV1Reader } from '@happier-dev/protocol/actions/operations/v1';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
import { resolveConnectedServicesServerApiTimeoutMs } from '@/api/client/connectedServicesServerApiTimeout';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import type { DaemonToServerEvents, ServerToDaemonEvents } from './socketTypes';

export function emitActionOperationSnapshotV1(params: Readonly<{
    socket: (Pick<Socket<ServerToDaemonEvents, DaemonToServerEvents>, 'emit'>
        & Partial<Pick<Socket<ServerToDaemonEvents, DaemonToServerEvents>, 'emitWithAck' | 'connected'>>) | null;
    machineId: string;
    content: import('@happier-dev/protocol/actions/operations/v1').ActionOperationRevisionEphemeralV1['content'];
    acknowledge?: true;
}>): void | Promise<boolean> {
    const payload: import('@happier-dev/protocol/actions/operations/v1').ActionOperationRevisionEphemeralV1 = {
        type: ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1,
        machineId: params.machineId,
        content: params.content,
    };
    if (params.acknowledge) {
        if (!params.socket?.emitWithAck) return Promise.resolve(false);
        return emitSocketWithAck({ socket: params.socket,
            event: ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1, payload, timeoutMs: null,
        }).then(answer => answer === true, () => false);
    }
    params.socket?.emit(ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1, payload);
}

/** Serialize the consumed machine activity stream through one Account encryption boundary. */
export function createActionOperationSnapshotPublisher(input: Readonly<{
    resolveAccountId(): Promise<string | null>;
    serverBaseUrl: string;
    readCredentials: typeof readStoredCredentials;
    publishContent(content: import('@happier-dev/protocol/actions/operations/v1').ActionOperationRevisionEphemeralV1['content']): void;
    publishContentAcknowledged?(content: import('@happier-dev/protocol/actions/operations/v1').ActionOperationRevisionEphemeralV1['content']): Promise<boolean>;
}>) {
    type Snapshot = import('@happier-dev/protocol/actions').ActionOperationSnapshotV1;
    const queued = new Map<string, Snapshot>();
    let draining: Promise<void> | null = null;
    const publishBatch = async (snapshots: readonly Snapshot[], acknowledge = false): Promise<boolean> => {
        if (acknowledge && !input.publishContentAcknowledged) return false;
        const credentials = await input.readCredentials().catch(() => null);
        if (!credentials) return false;
        const accountId = await input.resolveAccountId();
        if (!accountId || readAccountIdFromToken(credentials.token) !== accountId) {
            logger.warn('Withheld Action operation snapshot because the credential Account differs from the machine connection Account');
            return false;
        }
        const admitted = snapshots.filter(snapshot => snapshot.scope.accountId === accountId);
        if (admitted.length !== snapshots.length) {
            logger.warn('Withheld Action operation snapshot because the credential Account differs from the machine connection Account');
        }
        if (admitted.length === 0) return false;
        const accountMode = await readAccountEncryptionModeOnce({ credentials, usage: 'identity', scope: { token: credentials.token, serverBaseUrl: input.serverBaseUrl }, request: () => axios.get(
            `${input.serverBaseUrl.replace(/\/+$/, '')}/v1/account/encryption`, {
                headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${credentials.token}` },
                timeout: resolveConnectedServicesServerApiTimeoutMs(), validateStatus: () => true,
            },
        ) });
        if (accountMode.kind !== 'resolved') return false;
        const publish = async (content: import('@happier-dev/protocol/actions/operations/v1').ActionOperationRevisionEphemeralV1['content']) => {
            if (acknowledge) return await input.publishContentAcknowledged!(content);
            input.publishContent(content);
            return true;
        };
        if (accountMode.mode === 'plain') {
            for (const snapshot of admitted) {
                if (!await publish({ t: 'plain', v: projectActionOperationSnapshotForV1Reader(snapshot) })) return false;
            }
            return true;
        }
        if (!credentials.encryption) return false;
        const material = credentials.encryption.type === 'legacy'
            ? { type: 'legacy' as const, secret: credentials.encryption.secret }
            : { type: 'dataKey' as const, machineKey: credentials.encryption.machineKey };
        for (const snapshot of admitted) {
            if (!await publish({ t: 'encrypted', c: sealAccountScopedBlobCiphertext({
                kind: 'action_operation_snapshot', material, payload: projectActionOperationSnapshotForV1Reader(snapshot),
                randomBytes: (length) => new Uint8Array(randomBytes(length)),
            }) })) return false;
        }
        return true;
    };
    const drain = async (): Promise<void> => {
        while (queued.size > 0) {
            const batch = [...queued.values()];
            queued.clear();
            try {
                await publishBatch(batch);
            } catch (error) {
                logger.warn('Failed to publish Action operation snapshot', { error: serializeAxiosErrorForLog(error) });
            }
        }
    };
    const ensureDrain = (): Promise<void> => {
        if (draining) return draining;
        draining = drain().then(async () => {
            draining = null;
            // A revision queued between the drain's final empty check and this
            // continuation belongs to the same publication promise.
            if (queued.size > 0) await ensureDrain();
        });
        return draining;
    };
    const publish = (snapshot: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1): Promise<void> => {
        const queuedSnapshot = queued.get(snapshot.operationId);
        if (!queuedSnapshot || snapshot.revision > queuedSnapshot.revision) queued.set(snapshot.operationId, snapshot);
        return ensureDrain();
    };
    return Object.assign(publish, {
        async acknowledge(snapshot: Snapshot): Promise<boolean> {
            try { return await publishBatch([snapshot], true); }
            catch { return false; }
        },
    });
}
