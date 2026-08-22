import { logger } from '@/ui/logger'
import { backoff } from '@/utils/time';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import type { AgentState, Metadata } from '../types';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../encryption';
import { deriveActivitySummaryFromAgentState } from './deriveActivitySummaryFromAgentState';
import {
    projectSessionMetadataAgentVocabularyWriteCompatibilityV1,
    SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT,
    SessionRuntimeActivitySnapshotAckSchema,
    SessionRuntimeActivitySnapshotRequestSchema,
} from '@happier-dev/protocol';

type AckableSocket = {
    emitWithAck: (event: string, ...args: any[]) => Promise<any>;
    connected?: boolean;
    timeout?: (ms: number) => AckableSocket;
};

type SessionStateUpdateError = Error & {
    code: string;
    retryable: boolean;
};

type SessionStateUpdateCryptoContext =
    | Readonly<{
        sessionEncryptionMode: 'plain';
        encryptionKey?: never;
        encryptionVariant?: never;
    }>
    | Readonly<{
        sessionEncryptionMode: 'e2ee';
        encryptionKey: Uint8Array;
        encryptionVariant: 'legacy' | 'dataKey';
    }>;

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
    getMetadata: () => Metadata | null;
    setMetadata: (metadata: Metadata | null) => void;
    getMetadataVersion: () => number;
    setMetadataVersion: (version: number) => void;
    syncSessionSnapshotFromServer: () => Promise<void>;
    handler: (metadata: Metadata) => Metadata;
} & SessionStateUpdateCryptoContext): Promise<Readonly<{
    metadata: Metadata;
    version: number;
    ciphertext: string;
}>> {
    return await backoff(async () => {
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
        const wireMetadata =
            projectSessionMetadataAgentVocabularyWriteCompatibilityV1(
                updated,
            );
        logger.debug('[API] updateMetadata attempting', {
            expectedVersion: opts.getMetadataVersion(),
            hasModeOverride: Boolean((updated as Record<string, unknown> | null)?.acpSessionModeOverrideV1),
            hasModelOverride: Boolean((updated as Record<string, unknown> | null)?.modelOverrideV1),
            hasOpenCodeSessionId: typeof (updated as Record<string, unknown> | null)?.opencodeSessionId === 'string',
            currentModeId: readLoggedCurrentModeId(updated as Record<string, unknown> | null),
        });
        const metadataPayload =
            opts.sessionEncryptionMode === 'plain'
                ? JSON.stringify(wireMetadata)
                : encodeBase64(encrypt(
                    opts.encryptionKey,
                    opts.encryptionVariant,
                    wireMetadata,
                ));
        const answer = await emitSocketWithAck<any>({
            socket: opts.socket,
            event: 'update-metadata',
            payload: {
                sid: opts.sessionId,
                expectedVersion: opts.getMetadataVersion(),
                metadata: metadataPayload,
            },
        });

        if (answer.result === 'success') {
            logger.debug('[API] updateMetadata success', {
                version: answer.version,
                hasModeOverride: Boolean((updated as Record<string, unknown> | null)?.acpSessionModeOverrideV1),
                hasModelOverride: Boolean((updated as Record<string, unknown> | null)?.modelOverrideV1),
                hasOpenCodeSessionId: typeof (updated as Record<string, unknown> | null)?.opencodeSessionId === 'string',
                currentModeId: readLoggedCurrentModeId(updated as Record<string, unknown> | null),
            });
            opts.setMetadata(updated);
            opts.setMetadataVersion(answer.version);
            return {
                metadata: updated,
                version: answer.version,
                ciphertext: String(answer.metadata),
            };
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

        if (answer.result === 'publisher-superseded') {
            throw createSessionStateUpdateError(
                'metadata update refused because this session publisher was superseded',
                'session_publisher_authority_lost',
                false,
            );
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
    getAgentState: () => AgentState | null;
    setAgentState: (agentState: AgentState | null) => void;
    getAgentStateVersion: () => number;
    setAgentStateVersion: (version: number) => void;
    syncSessionSnapshotFromServer: () => Promise<void>;
    handler: (agentState: AgentState) => AgentState;
} & SessionStateUpdateCryptoContext): Promise<Readonly<{
    agentState: AgentState | null;
    version: number;
    ciphertext: string | null;
}>> {
    return await backoff(async () => {
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
        const answer = await emitSocketWithAck<any>({
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
            return {
                agentState: next,
                version: answer.version,
                ciphertext: typeof answer.agentState === 'string'
                    ? answer.agentState
                    : null,
            };
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

export async function updateSessionRuntimeActivityProjectionWithAck(opts: {
    socket: AckableSocket;
    sessionId: string;
    mutationId: string;
    state: 'active' | 'idle' | 'unknown';
    runtimeActivityActiveCount: number;
}): Promise<Readonly<{
    disposition: 'applied' | 'unchanged';
    projection: Readonly<{
    runtimeActivityState: 'active' | 'idle' | 'unknown';
    runtimeActivityActiveCount: number;
    runtimeActivityObservedAt: number | null;
    runtimeActivityRevision: number;
    }>;
}>> {
    return await backoff(async () => {
        const request = SessionRuntimeActivitySnapshotRequestSchema.parse({
            sessionId: opts.sessionId,
            mutationId: opts.mutationId,
            snapshot: {
                state: opts.state,
                activeCount: opts.runtimeActivityActiveCount,
            },
        });
        const rawAnswer = await emitSocketWithAck<unknown>({
            socket: opts.socket,
            event: SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT,
            payload: request,
        });
        const parsedAnswer =
            SessionRuntimeActivitySnapshotAckSchema.safeParse(rawAnswer);
        if (!parsedAnswer.success) {
            throw createSessionStateUpdateError(
                'runtime activity update failed: invalid acknowledgement',
                'runtime_activity_update_failed',
                true,
            );
        }
        const answer = parsedAnswer.data;

        if (
            (answer.status === 'applied' || answer.status === 'unchanged')
            && answer.sessionId === opts.sessionId
            && answer.mutationId === opts.mutationId
        ) {
            return {
                disposition: answer.status,
                projection: {
                    runtimeActivityState: answer.projection.state,
                    runtimeActivityActiveCount: answer.projection.activeCount,
                    runtimeActivityObservedAt: answer.projection.observedAt,
                    runtimeActivityRevision: answer.projection.revision,
                },
            };
        }

        throw createSessionStateUpdateError(
            `runtime activity update failed: ${
                'reason' in answer ? answer.reason : answer.status
            }`,
            'runtime_activity_update_failed',
            true,
        );
    });
}
