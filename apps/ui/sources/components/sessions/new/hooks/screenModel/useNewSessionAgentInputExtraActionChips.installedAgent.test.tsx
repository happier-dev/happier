import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { renderScreen } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

import { installNewSessionScreenModelCommonModuleMocks } from '../newSessionScreenModelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionScreenModelCommonModuleMocks({
    storage: async () => createStorageModuleStub({
        storage: {
            getState: () => ({}),
        },
    }),
});

vi.mock('@/components/sessions/agentInput/sessionActions/buildNewSessionActionShortcutChips', () => ({
    buildNewSessionActionShortcutChips: () => [],
}));

const INSTALLED_AGENT_ID = 'acme.agent';
const SPAWN_MACHINE_ID = 'machine-b';

const INDEXING_CHIP_BEHAVIOR = Object.freeze({
    components: {
        slots: [
            {
                id: 'acme-allow-indexing',
                slot: 'newSession.agentInputExtraActionChips',
                chip: {
                    kind: 'booleanOption',
                    optionStateKey: 'allowIndexing',
                    iconName: 'magnifying-glass',
                    onLabelKey: 'agentInput.auggieIndexingChip.on',
                    offLabelKey: 'agentInput.auggieIndexingChip.off',
                },
            },
        ],
    },
});

const BASE_PARAMS = {
    agentOptionState: { allowIndexing: false },
    showAutomationActionChips: false,
    automationDraft: {
        enabled: false,
        name: '',
        description: '',
        triggers: [{
            clientId: 'schedule-hourly',
            definition: {
                kind: 'schedule' as const,
                enabled: true,
                schedule: { kind: 'interval' as const, everyMs: 60 * 60_000 },
            },
        }],
    },
    automationLabel: 'Automate',
    showServerPickerChip: false,
    targetServerId: null,
    targetServerName: 'Server A',
    externalSessionsFeatureEnabled: false,
    supportsDirectTranscriptStorage: false,
    transcriptStorage: 'persisted' as const,
    selectedMachineIsWindows: false,
    windowsRemoteSessionLaunchMode: null,
    windowsTerminalAvailable: false,
};

/**
 * The composer is the launch surface, so an installed Agent's declared chips
 * have to reach it through the operational Agent identity. Gating the read on
 * the bundled presentation id makes the read answer `null` for every installed
 * Agent, which is the exact parity gap this covers.
 */
describe('useNewSessionAgentInputExtraActionChips (installed Agent)', () => {
    beforeEach(async () => {
        const { clearProjectedAgentUiBehaviorDescriptors } = await import('@/agents/registry/agentUiBehaviorProjection');
        clearProjectedAgentUiBehaviorDescriptors();
    });

    afterEach(async () => {
        const { clearProjectedAgentUiBehaviorDescriptors } = await import('@/agents/registry/agentUiBehaviorProjection');
        clearProjectedAgentUiBehaviorDescriptors();
    });

    async function renderChips(params: Readonly<{
        staticAgentId: string | null;
        runtimeCarrierAgentId: string | null;
        selectedMachineId: string | null;
    }>): Promise<ReadonlyArray<AgentInputExtraActionChip>> {
        const { useNewSessionAgentInputExtraActionChips } = await import('./useNewSessionAgentInputExtraActionChips');
        let chips: ReadonlyArray<AgentInputExtraActionChip> = [];

        function Probe() {
            chips = useNewSessionAgentInputExtraActionChips({
                ...BASE_PARAMS,
                staticAgentId: params.staticAgentId,
                runtimeCarrierAgentId: params.runtimeCarrierAgentId,
                selectedMachineId: params.selectedMachineId,
                setAgentOptionState: vi.fn(),
                onAutomationChange: vi.fn(),
                onTranscriptStorageChange: vi.fn(),
                onWindowsRemoteSessionLaunchModeChange: vi.fn(),
                onActionShortcutPress: vi.fn(),
            });
            return null;
        }

        await renderScreen(<Probe />);
        return chips;
    }

    it('offers the chips an installed Agent declares on the machine the composer will spawn on', async () => {
        const { publishProjectedAgentUiBehaviorDescriptors } = await import('@/agents/registry/agentUiBehaviorProjection');
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: SPAWN_MACHINE_ID,
            descriptorsByAgentId: {
                [INSTALLED_AGENT_ID]: {
                    kind: 'plugin.ui.v1',
                    pluginId: 'acme',
                    agentId: INSTALLED_AGENT_ID,
                    version: 1,
                    behavior: INDEXING_CHIP_BEHAVIOR,
                },
            },
        });

        const chips = await renderChips({
            staticAgentId: null,
            runtimeCarrierAgentId: INSTALLED_AGENT_ID,
            selectedMachineId: SPAWN_MACHINE_ID,
        });

        expect(chips.map((chip) => chip.key)).toContain('acme-allow-indexing');
    });

    it('withholds chips another machine declares for the same installed Agent', async () => {
        const { publishProjectedAgentUiBehaviorDescriptors } = await import('@/agents/registry/agentUiBehaviorProjection');
        // `machine-a` sorts first, so a machine-blind read would answer with it.
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-a',
            descriptorsByAgentId: {
                [INSTALLED_AGENT_ID]: {
                    kind: 'plugin.ui.v1',
                    pluginId: 'acme',
                    agentId: INSTALLED_AGENT_ID,
                    version: 1,
                    behavior: INDEXING_CHIP_BEHAVIOR,
                },
            },
        });

        const chips = await renderChips({
            staticAgentId: null,
            runtimeCarrierAgentId: INSTALLED_AGENT_ID,
            selectedMachineId: SPAWN_MACHINE_ID,
        });

        expect(chips.map((chip) => chip.key)).not.toContain('acme-allow-indexing');
    });
});
