import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { useMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { useHomeSetupDismissals } from '@/components/hub/layout/useHomeSetupDismissals';
import { readNewSessionDraftProjectionFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { machineCollectionHref } from '@/components/settings/machines/collection/machineCollectionModel';
import type { SetupBlockItem } from '@/components/ui/setupBlocks/SetupBlockGrid';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { subscribeSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMachineListByServerId } from '@/sync/domains/state/storage';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

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
function useHomeComposerMachine(serverId: string) {
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const scope = binding?.isCurrent() ? binding.scope : null;
    const subscribe = React.useCallback((listener: () => void) => (
        scope ? subscribeSessionDraft(scope, { kind: 'newSession', draftId: HOME_COMPOSER_DRAFT_ID }, listener) : () => {}
    ), [scope]);
    const read = React.useCallback(() => (
        scope ? readNewSessionDraftProjectionFromRepository({ scope, draftId: HOME_COMPOSER_DRAFT_ID })?.draft.selectedMachineId ?? null : null
    ), [scope]);
    const draftMachineId = React.useSyncExternalStore(subscribe, read, read);
    const machines = useMachineListByServerId()[serverId] ?? null;
    return React.useMemo(() => {
        const live = (machines ?? []).filter((machine) => !machine.revokedAt);
        return live.find((machine) => machine.id === draftMachineId)
            ?? live.find((machine) => isMachineOnline(machine))
            ?? null;
    }, [draftMachineId, machines]);
}

/**
 * "Set up your first agent" as a Get set up block (lab H1), only while the composer's machine is online,
 * known, and has no agent installed. It spans the row and draws no paper of its own.
 */
export function useFirstAgentSetupItem(input: Readonly<{ phone: boolean }>): SetupBlockItem | null {
    const router = useRouter();
    const serverId = useActiveServerSnapshot().serverId;
    const machine = useHomeComposerMachine(serverId);
    const machineId = machine && isMachineOnline(machine) ? machine.id : null;
    // A hub asks no machine anything (DESIGN.md "Hubs"): cached and last-known facts only; the composer
    // and the machine page own the probes that fill them.
    const inventory = useMachineAgents({ serverId, machineId, load: false });
    const { hidden, dismiss } = useHomeSetupDismissals();
    const machineName = getMachineDisplayName(machine) ?? '';
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
                            testID={`hub-setup.firstAgent.form.${agent.agentId}`}
                            serverId={serverId}
                            machineId={machineId}
                            machineName={machineName}
                            agentId={agent.agentId}
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
