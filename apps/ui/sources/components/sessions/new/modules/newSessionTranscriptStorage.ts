import { getAgentBehavior } from '@/agents/catalog/catalog';
import type { Settings } from '@/sync/domains/settings/settings';

export type NewSessionTranscriptStorage = 'persisted' | 'direct';

type DirectTranscriptStorageSettings = Readonly<Record<string, unknown>>;

/**
 * One owner decides direct transcript storage for every Agent.
 *
 * `getAgentBehavior` is that owner: a bundled Agent's default behavior is built
 * from its own session-storage facts (and refined by its generated descriptor),
 * and an installed Agent's projected `plugin.ui.v1` descriptor is read by the
 * same interpreter. An Agent that declares nothing keeps the neutral
 * fail-closed floor, so this is never a bundled-only capability.
 */
export function supportsDirectTranscriptStorageForNewSession(params: Readonly<{
    agentId: string;
    /**
     * The machine that will run the Session. An installed Agent's storage
     * declaration is a per-machine fact, so a caller that knows the machine
     * reads that machine's declaration instead of borrowing another one's.
     * Omitted only by Account-wide surfaces where every machine's declaration
     * is equally applicable.
     */
    machineId?: string | null;
    settings: DirectTranscriptStorageSettings;
}>): boolean {
    const supportsTranscriptStorageMode = getAgentBehavior(params.agentId, params.machineId).newSession?.supportsTranscriptStorageMode;
    return supportsTranscriptStorageMode?.({
        agentId: params.agentId,
        settings: params.settings as Settings,
        storageMode: 'direct',
    }) === true;
}

export function coerceNewSessionTranscriptStorage(params: Readonly<{
    requested: NewSessionTranscriptStorage | null | undefined;
    agentId: string;
    machineId?: string | null;
    settings: DirectTranscriptStorageSettings;
    externalSessionsEnabled: boolean;
}>): NewSessionTranscriptStorage {
    if (params.requested !== 'direct') return 'persisted';
    if (!params.externalSessionsEnabled) return 'persisted';
    return supportsDirectTranscriptStorageForNewSession({
        agentId: params.agentId,
        machineId: params.machineId,
        settings: params.settings,
    })
        ? 'direct'
        : 'persisted';
}
