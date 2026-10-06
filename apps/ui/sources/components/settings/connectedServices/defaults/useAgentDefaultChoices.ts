import * as React from 'react';

import { useApplySettings } from '@/sync/store/settingsWriters';
import { useSettingsSelector } from '@/sync/store/hooks';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol';

import { useConnectedServicesIndex } from '../model/useConnectedServicesIndex';
import {
    buildAgentDefaultChoices,
    writeAgentDefaultChoice,
    type AgentDefaultChoice,
    type AgentDefaultChoiceAgent,
} from './agentDefaultChoices';

const NO_AGENTS: readonly AgentDefaultChoiceAgent[] = [];

/**
 * The ★ menu's data for one account or pool: the agents that sign in through its service (from the
 * one agent catalog projection the Connected services index reads) and whether it is each one's
 * default, plus the writer. `cached`: a detail page never asks a machine for its agents on its own.
 */
export function useAgentDefaultChoices(target: QualifiedConnectedAccountPurposeBindingTargetV1): Readonly<{
    choices: readonly AgentDefaultChoice[];
    setDefault: (agentId: string, makeDefault: boolean) => void;
}> {
    const { agentEntries, agentsKnown } = useConnectedServicesIndex({ agents: 'cached' });
    const settings = useSettingsSelector((settings) => ({
        connectedAccountPurposeBindingsV1: settings.connectedAccountPurposeBindingsV1,
        connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
    }));
    const applySettings = useApplySettings();
    const defaultSettings = React.useMemo(() => ({
        connectedAccountPurposeBindingsV1: settings.connectedAccountPurposeBindingsV1,
        connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
    }), [settings.connectedAccountPurposeBindingsV1, settings.connectedServicesDefaultAuthByAgentIdV1]);
    const agents = agentsKnown ? agentEntries : NO_AGENTS;
    const choices = React.useMemo(
        () => buildAgentDefaultChoices({ agents, settings: defaultSettings, target }),
        [agents, defaultSettings, target],
    );
    const setDefault = React.useCallback((agentId: string, makeDefault: boolean) => {
        const written = writeAgentDefaultChoice({ agents, settings: defaultSettings, target, agentId, makeDefault });
        if (written) applySettings(written);
    }, [agents, applySettings, defaultSettings, target]);
    return React.useMemo(() => ({ choices, setDefault }), [choices, setDefault]);
}
