import type { AgentState, Metadata } from '../types';
import { decodeBase64, decrypt } from '../encryption';
import { fetchSessionByIdCompat } from '@/sessionControl/sessionsHttp';
import { isDeepStrictEqual } from 'node:util';
import { tryParseJsonRecord } from '@/utils/tryParseJsonRecord';

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
    currentMetadata?: Metadata | null;
    currentAgentState?: AgentState | null;
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
    if (rawMetadata && nextMetadataVersion !== null && nextMetadataVersion >= opts.currentMetadataVersion) {
        const nextMetadata: Metadata | null = (() => {
            if (sessionEncryptionMode === 'plain') {
                return tryParseJsonRecord(rawMetadata) as unknown as Metadata | null;
            }
            try {
                return decrypt(opts.encryptionKey, opts.encryptionVariant, decodeBase64(rawMetadata)) as Metadata;
            } catch {
                return null;
            }
        })();
        if (
            nextMetadata &&
            (
                nextMetadataVersion > opts.currentMetadataVersion ||
                !isDeepStrictEqual(nextMetadata, opts.currentMetadata ?? null)
            )
        ) {
            out.metadata = { metadata: nextMetadata, metadataVersion: nextMetadataVersion };
        }
    }

    // Sync agent state if it is newer than our local view.
    const nextAgentStateVersion = typeof raw.agentStateVersion === 'number' ? raw.agentStateVersion : null;
    const rawAgentState = typeof raw.agentState === 'string' ? raw.agentState : null;
    if (nextAgentStateVersion !== null && nextAgentStateVersion >= opts.currentAgentStateVersion) {
        const nextAgentState: AgentState | null | undefined = (() => {
            if (!rawAgentState) return null;
            if (sessionEncryptionMode === 'plain') {
                const parsed = tryParseJsonRecord(rawAgentState);
                return parsed ? (parsed as unknown as AgentState) : undefined;
            }
            try {
                return decrypt(opts.encryptionKey, opts.encryptionVariant, decodeBase64(rawAgentState)) as AgentState;
            } catch {
                return undefined;
            }
        })();
        if (
            nextAgentState !== undefined &&
            (
                nextAgentStateVersion > opts.currentAgentStateVersion ||
                !isDeepStrictEqual(nextAgentState, opts.currentAgentState ?? null)
            )
        ) {
            out.agentState = { agentState: nextAgentState, agentStateVersion: nextAgentStateVersion };
        }
    }

    return out;
}
