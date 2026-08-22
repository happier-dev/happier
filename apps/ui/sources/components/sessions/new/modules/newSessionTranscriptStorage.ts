import { getAgentBehavior, getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import type { Settings } from '@/sync/domains/settings/settings';

export type NewSessionTranscriptStorage = 'persisted' | 'direct';

type DirectTranscriptStorageSettings = Readonly<Record<string, unknown>>;

export function supportsDirectTranscriptStorageForNewSession(params: Readonly<{
    agentId: string;
    settings: DirectTranscriptStorageSettings;
}>): boolean {
    if (!isBundledAgentId(params.agentId)) return false;
    if (getAgentCore(params.agentId).sessionStorage.direct !== true) return false;
    const supportsTranscriptStorageMode = getAgentBehavior(params.agentId).newSession?.supportsTranscriptStorageMode;
    if (!supportsTranscriptStorageMode) return true;
    return supportsTranscriptStorageMode({
        agentId: params.agentId,
        settings: params.settings as Settings,
        storageMode: 'direct',
    });
}

export function coerceNewSessionTranscriptStorage(params: Readonly<{
    requested: NewSessionTranscriptStorage | null | undefined;
    agentId: string;
    settings: DirectTranscriptStorageSettings;
    externalSessionsEnabled: boolean;
}>): NewSessionTranscriptStorage {
    if (params.requested !== 'direct') return 'persisted';
    if (!params.externalSessionsEnabled) return 'persisted';
    return supportsDirectTranscriptStorageForNewSession({
        agentId: params.agentId,
        settings: params.settings,
    })
        ? 'direct'
        : 'persisted';
}
