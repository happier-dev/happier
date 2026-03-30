import { logger } from '@/ui/logger'
import { backoff } from '@/utils/time';
import type { AgentState, Metadata } from '../types';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../encryption';
import { deriveActivitySummaryFromAgentState } from './deriveActivitySummaryFromAgentState';

type AckableSocket = {
    emitWithAck: (event: string, ...args: any[]) => Promise<any>;
};

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
                logger.debug('[API] updateMetadata skipped: metadataVersion is still unknown');
                return;
            }
        }

        const current = opts.getMetadata();
        const updated = opts.handler(current!);
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
        const answer = await opts.socket.emitWithAck('update-metadata', {
            sid: opts.sessionId,
            expectedVersion: opts.getMetadataVersion(),
            metadata: metadataPayload,
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

        // Hard error - ignore
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
                logger.debug('[API] updateAgentState skipped: agentStateVersion is still unknown');
                return;
            }
        }

        const updated = opts.handler(opts.getAgentState() || {});
        const agentStatePayload =
            opts.sessionEncryptionMode === 'plain'
                ? JSON.stringify(updated)
                : (updated ? encodeBase64(encrypt(opts.encryptionKey, opts.encryptionVariant, updated)) : null);
        const activitySummaryV1 = deriveActivitySummaryFromAgentState(updated);
        const answer = await opts.socket.emitWithAck('update-state', {
            sid: opts.sessionId,
            expectedVersion: opts.getAgentStateVersion(),
            agentState: agentStatePayload,
            activitySummaryV1,
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

        // Hard error - ignore
    });
}
