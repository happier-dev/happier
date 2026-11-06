import * as React from 'react';
import { buildMachineAgentInventoryKey } from '@happier-dev/protocol/capabilities';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { useMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { useHomeSetupDismissals } from '@/components/hub/layout/useHomeSetupDismissals';
import { readNewSessionDraftProjectionFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { machineCollectionHref } from '@/components/settings/machines/collection/machineCollectionModel';
import type { SetupBlockItem } from '@/components/ui/setupBlocks/SetupBlockGrid';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { subscribeSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMachineListForServerSelection, useServerScopedMachine } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';

import { AgentSetupForm } from './AgentSetupForm';
import { FirstAgentSetupBlock } from './FirstAgentSetupBlock';
import { MachineAgentMark } from './MachineAgentMark';
import { shouldOfferFirstAgentSetup } from './machineAgentPresentation';

/** Home's composer draft (`HubComposerSection`): the machine it will start on is this block's machine. */
export const HOME_COMPOSER_DRAFT_ID = 'home-composer';
/** Customize → Hidden setup steps id of "Set up your first agent". */
export const FIRST_AGENT_SETUP_STEP_ID = 'setup:first-agent';

/**
 * The machine Home's composer will start on: the one its draft names, else the first online machine of
 * the Home (what the composer falls back to). Null while there is none.
 */
function useHomeComposerMachineId(serverId: string) {
    const reachabilityRevision = useMachineReachabilityRevision();
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const scope = binding?.isCurrent() ? binding.scope : null;
    const subscribe = React.useCallback((listener: () => void) => (
        scope ? subscribeSessionDraft(scope, { kind: 'newSession', draftId: HOME_COMPOSER_DRAFT_ID }, listener) : () => {}
    ), [scope]);
    const read = React.useCallback(() => (
        scope ? readNewSessionDraftProjectionFromRepository({ scope, draftId: HOME_COMPOSER_DRAFT_ID })?.draft.selectedMachineId ?? null : null
    ), [scope]);
    const draftMachineId = React.useSyncExternalStore(subscribe, read, read);
    const select = React.useCallback((machines: readonly Machine[]) => {
        const machine = machines.find((candidate) => candidate.id === draftMachineId)
            ?? machines.find((candidate) => isMachineSelectableForFleet(scope, candidate));
        return machine && isMachineSelectableForFleet(scope, machine) ? machine.id : null;
    }, [draftMachineId, reachabilityRevision, scope]);
    return useMachineListForServerSelection(serverId, select);
}

/**
 * "Set up your first agent" as a Get set up block (lab H1), only while the composer's machine is online,
 * known, and has no agent installed. It spans the row and draws no paper of its own.
 */
export function useFirstAgentSetupItem(input: Readonly<{ phone: boolean }>): SetupBlockItem | null {
    const router = useRouter();
    const serverId = useActiveServerSnapshot().serverId;
    const machineId = useHomeComposerMachineId(serverId);
    // A hub asks no machine anything (DESIGN.md "Hubs"): cached and last-known facts only; the composer
    // and the machine page own the probes that fill them.
    const inventory = useMachineAgents({ serverId, machineId, load: false });
    const { hidden, dismiss } = useHomeSetupDismissals();
    const machineName = useServerScopedMachine(serverId, machineId, getMachineSentenceName);
    const needed = machineId !== null
        && shouldOfferFirstAgentSetup(inventory)
        && !hidden.has(FIRST_AGENT_SETUP_STEP_ID);
    const agents = inventory.agents;
    return React.useMemo((): SetupBlockItem | null => {
        if (!needed || !machineId) return null;
        return {
            id: FIRST_AGENT_SETUP_STEP_ID,
            span: 'row',
            renderTile: () => (
                <FirstAgentSetupBlock
                    testID="hub-setup.firstAgent"
                    machineName={machineName}
                    agents={agents}
                    phone={input.phone}
                    renderMark={(agent) => <MachineAgentMark agentId={agent.agentId} machineId={machineId} serverId={serverId} size={22} />}
                    renderForm={(agent) => (
                        <AgentSetupForm
                            testID={`hub-setup.firstAgent.form.${buildMachineAgentInventoryKey(agent)}`}
                            serverId={serverId}
                            machineId={machineId}
                            machineName={machineName}
                            agentId={agent.agentId}
                            definitionId={agent.definitionId}
                            layout="compact"
                        />
                    )}
                    onAllAgents={() => router.push(machineCollectionHref({ machineId, serverId }) as never)}
                    onDismiss={() => dismiss(FIRST_AGENT_SETUP_STEP_ID)}
                />
            ),
        };
    }, [agents, dismiss, input.phone, machineId, machineName, needed, router, serverId]);
}
