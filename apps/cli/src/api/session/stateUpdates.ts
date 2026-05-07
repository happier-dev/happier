import { logger } from '@/ui/logger'
import { backoff } from '@/utils/time';
import { resolveSessionControlSocketAckTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import type { AgentState, Metadata } from '../types';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../encryption';
import { deriveActivitySummaryFromAgentState } from './deriveActivitySummaryFromAgentState';

type AckableSocket = {
    emitWithAck: (event: string, ...args: any[]) => Promise<any>;
    timeout?: (ms: number) => AckableSocket;
};

type SessionStateUpdateError = Error & {
    code: string;
    retryable: boolean;
};

function createSessionStateUpdateError(message: string, code: string, retryable: boolean): SessionStateUpdateError {
    const error = new Error(message) as SessionStateUpdateError;
    error.code = code;
    error.retryable = retryable;
    return error;
}

function describeAckFailure(answer: any): string {
    const reason = typeof answer?.error === 'string'
        ? answer.error
        : typeof answer?.message === 'string'
            ? answer.message
            : typeof answer?.result === 'string'
                ? answer.result
                : 'unknown result';
    return reason;
}

async function emitWithAck(opts: {
    socket: AckableSocket;
    event: string;
    payload: unknown;
}): Promise<any> {
    const socketWithTimeout = opts.socket.timeout?.(resolveSessionControlSocketAckTimeoutMs()) ?? opts.socket;
    return await socketWithTimeout.emitWithAck(opts.event, opts.payload);
}

function readLoggedCurrentModeId(metadata: Record<string, unknown> | null | undefined): string | null {
    const genericCurrentModeId = typeof metadata?.sessionModesV1 === 'object'
        && typeof (metadata as any).sessionModesV1?.currentModeId === 'string'
        ? (metadata as any).sessionModesV1.currentModeId
        : null;
    if (genericCurrentModeId) {
        return genericCurrentModeId;
    }

    return typeof metadata?.acpSessionModesV1 === 'object'
        && typeof (metadata as any).acpSessionModesV1?.currentModeId === 'string'
        ? (metadata as any).acpSessionModesV1.currentModeId
        : null;
}

export async function updateSessionMetadataWithAck(opts: {
    socket: AckableSocket;
    sessionId: string;
    sessionEncryptionMode: 'e2ee' | 'plain';
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    getMetadata: () => Metadata | null;
    setMetadata: (metadata: Metadata | null) => void;
    getMetadataVersion: () => number;
    setMetadataVersion: (version: number) => void;
    syncSessionSnapshotFromServer: () => Promise<void>;
    handler: (metadata: Metadata) => Metadata;
}): Promise<void> {
    await backoff(async () => {
        if (opts.getMetadataVersion() < 0) {
            await opts.syncSessionSnapshotFromServer();
            if (opts.getMetadataVersion() < 0) {
                throw createSessionStateUpdateError(
                    'metadataVersion is still unknown after session snapshot sync',
                    'metadata_version_unknown',
                    false,
                );
            }
        }

        const current = opts.getMetadata() ?? ({} as Metadata);
        const updated = opts.handler(current);
        logger.debug('[API] updateMetadata attempting', {
            expectedVersion: opts.getMetadataVersion(),
            hasModeOverride: Boolean((updated as Record<string, unknown> | null)?.acpSessionModeOverrideV1),
            hasModelOverride: Boolean((updated as Record<string, unknown> | null)?.modelOverrideV1),
            hasOpenCodeSessionId: typeof (updated as Record<string, unknown> | null)?.opencodeSessionId === 'string',
            currentModeId: readLoggedCurrentModeId(updated as Record<string, unknown> | null),
        });
        const metadataPayload =
            opts.sessionEncryptionMode === 'plain'
                ? JSON.stringify(updated)
                : encodeBase64(encrypt(opts.encryptionKey, opts.encryptionVariant, updated));
        const answer = await emitWithAck({
            socket: opts.socket,
            event: 'update-metadata',
            payload: {
                sid: opts.sessionId,
                expectedVersion: opts.getMetadataVersion(),
                metadata: metadataPayload,
            },
        });

        if (answer.result === 'success') {
            const next =
                opts.sessionEncryptionMode === 'plain'
                    ? JSON.parse(String(answer.metadata ?? 'null'))
                    : decrypt(opts.encryptionKey, opts.encryptionVariant, decodeBase64(answer.metadata));
            logger.debug('[API] updateMetadata success', {
                version: answer.version,
                hasModeOverride: Boolean((next as Record<string, unknown> | null)?.acpSessionModeOverrideV1),
                hasModelOverride: Boolean((next as Record<string, unknown> | null)?.modelOverrideV1),
                hasOpenCodeSessionId: typeof (next as Record<string, unknown> | null)?.opencodeSessionId === 'string',
                currentModeId: readLoggedCurrentModeId(next as Record<string, unknown> | null),
            });
            opts.setMetadata(next);
            opts.setMetadataVersion(answer.version);
            return;
        }

        if (answer.result === 'version-mismatch') {
            if (answer.version > opts.getMetadataVersion()) {
                opts.setMetadataVersion(answer.version);
                const next =
                    opts.sessionEncryptionMode === 'plain'
                        ? JSON.parse(String(answer.metadata ?? 'null'))
                        : decrypt(opts.encryptionKey, opts.encryptionVariant, decodeBase64(answer.metadata));
                logger.debug('[API] updateMetadata version-mismatch', {
                    version: answer.version,
                    hasModeOverride: Boolean((next as Record<string, unknown> | null)?.acpSessionModeOverrideV1),
                    hasModelOverride: Boolean((next as Record<string, unknown> | null)?.modelOverrideV1),
                    hasOpenCodeSessionId: typeof (next as Record<string, unknown> | null)?.opencodeSessionId === 'string',
                    currentModeId: readLoggedCurrentModeId(next as Record<string, unknown> | null),
                });
                opts.setMetadata(next);
            }
            throw new Error('Metadata version mismatch');
        }

        throw createSessionStateUpdateError(
            `metadata update failed: ${describeAckFailure(answer)}`,
            'metadata_update_failed',
            false,
        );
    });
}

export async function updateSessionAgentStateWithAck(opts: {
    socket: AckableSocket;
    sessionId: string;
    sessionEncryptionMode: 'e2ee' | 'plain';
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    getAgentState: () => AgentState | null;
    setAgentState: (agentState: AgentState | null) => void;
    getAgentStateVersion: () => number;
    setAgentStateVersion: (version: number) => void;
    syncSessionSnapshotFromServer: () => Promise<void>;
    handler: (agentState: AgentState) => AgentState;
}): Promise<void> {
    await backoff(async () => {
        if (opts.getAgentStateVersion() < 0) {
            await opts.syncSessionSnapshotFromServer();
            if (opts.getAgentStateVersion() < 0) {
                throw createSessionStateUpdateError(
                    'agentStateVersion is still unknown after session snapshot sync',
                    'agent_state_version_unknown',
                    false,
                );
            }
        }

        const updated = opts.handler(opts.getAgentState() || {});
        const agentStatePayload =
            opts.sessionEncryptionMode === 'plain'
                ? JSON.stringify(updated)
                : (updated ? encodeBase64(encrypt(opts.encryptionKey, opts.encryptionVariant, updated)) : null);
        const activitySummaryV1 = deriveActivitySummaryFromAgentState(updated);
        const answer = await emitWithAck({
            socket: opts.socket,
            event: 'update-state',
            payload: {
                sid: opts.sessionId,
                expectedVersion: opts.getAgentStateVersion(),
                agentState: agentStatePayload,
                activitySummaryV1,
            },
        });

        if (answer.result === 'success') {
            const next =
                !answer.agentState
                    ? null
                    : opts.sessionEncryptionMode === 'plain'
                        ? JSON.parse(String(answer.agentState))
                        : decrypt(opts.encryptionKey, opts.encryptionVariant, decodeBase64(answer.agentState));
            opts.setAgentState(next);
            opts.setAgentStateVersion(answer.version);
            logger.debug('Agent state updated', opts.getAgentState());
            return;
        }

        if (answer.result === 'version-mismatch') {
            if (answer.version > opts.getAgentStateVersion()) {
                opts.setAgentStateVersion(answer.version);
                const next =
                    !answer.agentState
                        ? null
                        : opts.sessionEncryptionMode === 'plain'
                            ? JSON.parse(String(answer.agentState))
                            : decrypt(opts.encryptionKey, opts.encryptionVariant, decodeBase64(answer.agentState));
                opts.setAgentState(next);
            }
            throw new Error('Agent state version mismatch');
        }

        throw createSessionStateUpdateError(
            `agent state update failed: ${describeAckFailure(answer)}`,
            'agent_state_update_failed',
            false,
        );
    });
}
