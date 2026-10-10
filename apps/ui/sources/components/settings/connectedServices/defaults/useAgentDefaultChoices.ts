import * as React from 'react';

import { useConnectedAccountPurposeDefaults } from '@/hooks/server/connectedServices/useConnectedAccountPurposeDefaults';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol';
import { t } from '@/text';

import { useConnectedServicesIndex } from '../model/useConnectedServicesIndex';
import {
    buildAgentDefaultChoices,
    type AgentDefaultChoice,
    type AgentDefaultChoiceAgent,
} from './agentDefaultChoices';

const NO_AGENTS: readonly AgentDefaultChoiceAgent[] = [];
const NO_CHOICES: readonly AgentDefaultChoice[] = [];

/**
 * The ★ menu's data for one account or pool: the agents that sign in through its service (from the
 * one agent catalog projection the Connected services index reads) and whether it is each one's
 * default, plus the writer. `cached`: a detail page never asks a machine for its agents on its own.
 */
export function useAgentDefaultChoices(target: QualifiedConnectedAccountPurposeBindingTargetV1): Readonly<{
    choices: readonly AgentDefaultChoice[];
    setDefault: (agentId: string, makeDefault: boolean) => Promise<void>;
    disabledReason: string | undefined;
}> {
    const { agentEntries, agentsKnown, appShellProjection } = useConnectedServicesIndex({ agents: 'cached' });
    const { catalog, legacySettings, mutateDefaults } = useConnectedAccountPurposeDefaults();
    const agents = agentsKnown ? agentEntries : NO_AGENTS;
    const choices = React.useMemo(
        () => catalog.value ? buildAgentDefaultChoices({ agents, settings: legacySettings, purposeBindings: catalog.value, target }) : NO_CHOICES,
        [agents, catalog.value, legacySettings, target],
    );
    const setDefault = React.useCallback(async (agentId: string, makeDefault: boolean) => {
        if (!agentsKnown) throw new Error('agent_catalog_unavailable');
        await mutateDefaults({ kind: 'target', target, agentId, makeDefault,
            ...(appShellProjection.machineId ? { machineId: appShellProjection.machineId } : {}) });
    }, [agentsKnown, appShellProjection.machineId, mutateDefaults, target]);
    const disabledReason = !agentsKnown || catalog.status === 'loading' ? t('common.loading')
        : catalog.status !== 'ready' || catalog.stale ? t('common.unavailable') : undefined;
    return React.useMemo(() => ({ choices, setDefault, disabledReason }), [choices, setDefault, disabledReason]);
}
