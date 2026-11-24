import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { AgentExecutionTargetV1 } from '@happier-dev/plugin-sdk/agents';
import type { PluginUiHostApi, SelectActionInputResult } from '@happier-dev/plugin-sdk/ui';
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

export async function selectTriageSendRecipientV1(
    host: Pick<PluginUiHostApi, 'selectActionInput'>,
    eligibility: TriageEntrySessionStartChoiceInputV1,
    options?: PluginCancellationOptions,
): Promise<SelectActionInputResult> {
    if (options?.signal?.aborted || eligibility.action === null) return { kind: 'cancelled' };
    return await host.selectActionInput({
        hostAction: { action: 'session.transcript.get', projection: 'sessionAddress' },
        sessionCandidateQuery: eligibility.action.workspaceMode === 'reference_only' ? { workspace: 'any' } : {
            workspace: 'accepted',
            ...(eligibility.repository === undefined ? {} : { repository: eligibility.repository }),
        },
    }, options);
}
