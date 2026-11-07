import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { AgentExecutionTargetV1 } from '@happier-dev/plugin-sdk/agents';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import type { TriageActionV1 } from '../settings/actions.js';
import { readTriageInvestigationAgentV1 } from './agentTarget.js';
import { readTriageActionExecutionPlacementV1, type TriageActionExecutionPlacementV1 } from './actionLaunch.js';
import { readTriageActionPlacementV1, readTriageActionProfileV1, type TriageActionResolutionHostV1 } from './actionResolution.js';
import type { TriageForgeIdentityV1 } from './launchPlacement.js';

export type TriageEntrySessionStartChoicesHostV1 = TriageActionResolutionHostV1
    & Pick<PluginUiHostApi, 'executeAction' | 'readMachineDisplayName'>;

export type TriageEntrySessionStartChoiceInputV1 = Readonly<{
    action: Pick<TriageActionV1, 'profileId' | 'workspaceMode'> | null;
    repository?: TriageForgeIdentityV1;
}>;

export type TriageEntrySessionStartTargetV1 =
    | Readonly<{ status: 'idle' | 'loading' | 'unavailable' }>
    | Readonly<{
        status: 'ready';
        agent: Readonly<{ targetKey: string; label: string; agentTarget: AgentExecutionTargetV1 }> | null;
        machine: (TriageActionExecutionPlacementV1 & Readonly<{ label: string }>) | null;
    }>;

/** Presentation reads the same inventory/default and placement decisions as an actual start. */
export async function readTriageEntrySessionStartTargetV1(
    host: TriageEntrySessionStartChoicesHostV1,
    input: TriageEntrySessionStartChoiceInputV1,
    options?: PluginCancellationOptions,
): Promise<TriageEntrySessionStartTargetV1> {
    if (input.action === null) return { status: 'idle' };
    const action = input.action;
    try {
        const profile = action.profileId === null ? null : await readTriageActionProfileV1(host, action.profileId, options);
        if (profile !== null && profile.status !== 'read') return { status: 'unavailable' };
        const [inventory, placement] = await Promise.all([
            readTriageInvestigationAgentV1(host, profile?.preferredAgentTargetKey, options),
            readTriageActionPlacementV1(host, action, profile?.preferences, input.repository, options),
        ]);
        if (inventory.selection.status === 'unavailable') return { status: 'unavailable' };
        const execution = readTriageActionExecutionPlacementV1(placement);
        const name = execution === null ? null : await host.readMachineDisplayName(execution.executionTarget, options);
        return {
            status: 'ready',
            agent: inventory.selection.status === 'resolved' && inventory.selected !== undefined
                ? { ...inventory.selected, agentTarget: inventory.selection.agentTarget } : null,
            machine: execution !== null && name?.status === 'ready' ? { ...execution, label: name.displayName } : null,
        };
    } catch { return { status: 'unavailable' }; }
}

type SessionSummaryResult = Exclude<PluginActionResultById['session.list'], Readonly<{ view: 'awareness' }>>;
type FullSessionSummary = Extract<SessionSummaryResult['sessions'][number], { createdAt: number }>;
export type TriageRecentSessionV1 = Readonly<{
    id: string;
    title?: string;
    serverId?: string;
    serverName?: string;
    locationLabel?: string;
    updatedAt: number;
}> & Readonly<Partial<Pick<FullSessionSummary,
    'path' | 'host' | 'machineId' | 'active' | 'latestTurnStatus' | 'runtimeActivityState' | 'lastRuntimeIssue' | 'pendingCount'
>>>;
export type TriageRecentSessionsV1 =
    | Readonly<{ status: 'idle' | 'loading' | 'unavailable' }>
    | Readonly<{ status: 'ready'; items: readonly TriageRecentSessionV1[]; hasMore: boolean }>;

function isSummary(result: PluginActionResultById['session.list']): result is SessionSummaryResult {
    return !('view' in result);
}

/** The menu owns demand; the host owns resumability, ordering, page size and Home identity. */
export async function readTriageRecentSessionsV1(
    host: Pick<PluginUiHostApi, 'executeAction'>,
    menuOpen: boolean,
    options?: PluginCancellationOptions,
): Promise<TriageRecentSessionsV1> {
    if (!menuOpen) return { status: 'idle' };
    try {
        const result = await host.executeAction('session.list', { view: 'summary', resumableOnly: true }, options);
        if (!isSummary(result)) return { status: 'unavailable' };
        // Keep the typed host rows intact, including optional Home qualification.
        return { status: 'ready', items: result.sessions, hasMore: result.hasNext === true || result.nextCursor != null };
    } catch { return { status: 'unavailable' }; }
}
