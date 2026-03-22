import { getAgentBehavior, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import type { Settings } from '@/sync/domains/settings/settings';

export type NewSessionTranscriptStorage = 'persisted' | 'direct';

type DirectTranscriptStorageSettings = Partial<Settings>;

export function supportsDirectTranscriptStorageForNewSession(params: Readonly<{
    agentId: AgentId;
    settings: DirectTranscriptStorageSettings;
}>): boolean {
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
    agentId: AgentId;
    settings: DirectTranscriptStorageSettings;
    directSessionsEnabled: boolean;
}>): NewSessionTranscriptStorage {
    if (params.requested !== 'direct') return 'persisted';
    if (!params.directSessionsEnabled) return 'persisted';
    return supportsDirectTranscriptStorageForNewSession({
        agentId: params.agentId,
        settings: params.settings,
    })
        ? 'direct'
        : 'persisted';
}
