import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { AgentExecutionTargetV1 } from '@happier-dev/plugin-sdk/agents';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import type { PluginUiHostApi, SelectActionInputResult } from '@happier-dev/plugin-sdk/ui';
import type { TriageActionV1 } from '../settings/actions.js';
import { readTriageInvestigationAgentV1 } from './agentTarget.js';
import { readTriageActionExecutionPlacementV1, type TriageActionExecutionPlacementV1 } from './actionLaunch.js';
import { readTriageActionPlacementV1, readTriageActionProfileV1, type TriageActionResolutionHostV1 } from './actionResolution.js';
import type { TriageForgeIdentityV1 } from './launchPlacement.js';
import { evaluateTriageExistingSessionWorkspaceV1 } from './existingSessionEligibility.js';

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
    host: Pick<PluginUiHostApi, 'executeAction'> & Partial<Pick<PluginUiHostApi, 'readSession'>>,
    menuOpen: boolean,
    options?: PluginCancellationOptions & Readonly<{
        eligibility?: TriageEntrySessionStartChoiceInputV1;
        allPages?: boolean;
    }>,
): Promise<TriageRecentSessionsV1> {
    if (!menuOpen) return { status: 'idle' };
    try {
        const items: TriageRecentSessionV1[] = [];
        let cursor: string | undefined;
        let hasMore: boolean;
        do {
            if (options?.signal?.aborted) return { status: 'unavailable' };
            const result = await host.executeAction('session.list', {
                view: 'summary', resumableOnly: true, ...(cursor === undefined ? {} : { cursor }),
            }, options);
            if (!isSummary(result)) return { status: 'unavailable' };
            const eligibility = options?.eligibility;
            if (eligibility === undefined) items.push(...result.sessions);
            else {
                const action = eligibility.action;
                const readSession = host.readSession?.bind(host);
                if (action === null || !readSession) return { status: 'unavailable' };
                const decisions = await Promise.all(result.sessions.map(async row => {
                    if (row.serverId === undefined) return null;
                    const state = await readSession(row.id, options).catch(() => null);
                    return state?.sessionId === row.id && state.serverId === row.serverId
                        && evaluateTriageExistingSessionWorkspaceV1(action.workspaceMode,
                            eligibility.repository, state.acceptedWorkspace).kind !== 'unavailable' ? row : null;
                }));
                for (const row of decisions) if (row !== null) items.push(row);
            }
            cursor = result.nextCursor ?? undefined;
            hasMore = result.hasNext === true || cursor !== undefined;
        } while (options?.allPages && cursor !== undefined);
        return { status: 'ready', items, hasMore };
    } catch { return { status: 'unavailable' }; }
}

/** Find uses the same candidate owner as the recent menu, across every host page. */
export async function selectTriageSendRecipientV1(
    host: Pick<PluginUiHostApi, 'executeAction' | 'selectActionInput'> & Partial<Pick<PluginUiHostApi, 'readSession'>>,
    eligibility: TriageEntrySessionStartChoiceInputV1,
    options?: PluginCancellationOptions,
): Promise<SelectActionInputResult | null> {
    const candidates = await readTriageRecentSessionsV1(host, true, { ...options, eligibility, allPages: true });
    if (candidates.status !== 'ready' || options?.signal?.aborted) return null;
    return await host.selectActionInput({
        hostAction: { action: 'session.transcript.get', projection: 'sessionAddress' },
        sessionCandidates: candidates.items.flatMap(row => row.serverId === undefined ? []
            : [{ serverId: row.serverId, sessionId: row.id }]),
    }, options);
}
