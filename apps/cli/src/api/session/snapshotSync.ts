import type { AgentState, Metadata } from '../types';
import { decodeBase64, decrypt } from '../encryption';
import { fetchSessionByIdCompat } from '@/sessionControl/sessionsHttp';

export function shouldSyncSessionSnapshotOnConnect(opts: { metadataVersion: number; agentStateVersion: number }): boolean {
    return opts.metadataVersion < 0 || opts.agentStateVersion < 0;
}

export async function fetchSessionSnapshotUpdateFromServer(opts: {
    token: string;
    sessionId: string;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    currentMetadataVersion: number;
    currentAgentStateVersion: number;
}): Promise<{
    metadata?: { metadata: Metadata; metadataVersion: number };
    agentState?: { agentState: AgentState | null; agentStateVersion: number };
}> {
    const raw = await fetchSessionByIdCompat({ token: opts.token, sessionId: opts.sessionId });
    if (!raw) return {};

    const sessionEncryptionMode: 'e2ee' | 'plain' =
        (raw as any)?.encryptionMode === 'plain' ? 'plain' : 'e2ee';

    const out: {
        metadata?: { metadata: Metadata; metadataVersion: number };
        agentState?: { agentState: AgentState | null; agentStateVersion: number };
    } = {};

    // Sync metadata if it is newer than our local view.
    const nextMetadataVersion = typeof raw.metadataVersion === 'number' ? raw.metadataVersion : null;
    const rawMetadata = typeof raw.metadata === 'string' ? raw.metadata : null;
    if (rawMetadata && nextMetadataVersion !== null && nextMetadataVersion > opts.currentMetadataVersion) {
        const nextMetadata =
            sessionEncryptionMode === 'plain'
                ? (JSON.parse(rawMetadata) as Metadata)
                : decrypt(opts.encryptionKey, opts.encryptionVariant, decodeBase64(rawMetadata));
        if (nextMetadata) {
            out.metadata = { metadata: nextMetadata, metadataVersion: nextMetadataVersion };
        }
    }

    // Sync agent state if it is newer than our local view.
    const nextAgentStateVersion = typeof raw.agentStateVersion === 'number' ? raw.agentStateVersion : null;
    const rawAgentState = typeof raw.agentState === 'string' ? raw.agentState : null;
    if (nextAgentStateVersion !== null && nextAgentStateVersion > opts.currentAgentStateVersion) {
        out.agentState = {
            agentState:
                !rawAgentState
                    ? null
                    : sessionEncryptionMode === 'plain'
                        ? (JSON.parse(rawAgentState) as AgentState)
                        : decrypt(opts.encryptionKey, opts.encryptionVariant, decodeBase64(rawAgentState)),
            agentStateVersion: nextAgentStateVersion,
        };
    }

    return out;
}
