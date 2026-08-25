import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// Connected services are a separate owner with their own coverage. Stubbing
// them here leaves exactly one thing under test: which Agent declaration the
// spawn option base is built from.
vi.mock('@/components/sessions/new/modules/useNewSessionConnectedServices', () => ({
    useNewSessionConnectedServices: () => ({
        connectedServicesBindingsPayload: null,
        connectedServicesModelProbeCacheIdentity: null,
        connectedServicesAuthChip: null,
    }),
}));

const INSTALLED_AGENT_ID = 'acme.agent';
const SPAWN_MACHINE_ID = 'machine-b';

const INDEXING_OPTION_BEHAVIOR = Object.freeze({
    newSession: {
        agentOptions: [{ key: 'allowIndexing', kind: 'boolean', spawnConfigOption: true }],
    },
});

/**
 * The option base feeds `session.spawn_new`. Gating it on the bundled
 * presentation id answers `null` for every installed Agent, so the composer
 * renders an installed Agent's declared options and then drops the reader's
 * values before the spawn envelope is built. Reading the operational carrier —
 * on the machine that will run the Session — is what keeps render and spawn
 * honoring one declaration.
 */
describe('useNewSessionConnectedServicesAgentOptions (installed Agent)', () => {
    beforeEach(async () => {
        const { clearProjectedAgentUiBehaviorDescriptors } = await import('@/agents/registry/agentUiBehaviorProjection');
        clearProjectedAgentUiBehaviorDescriptors();
    });

    afterEach(async () => {
        const { clearProjectedAgentUiBehaviorDescriptors } = await import('@/agents/registry/agentUiBehaviorProjection');
        clearProjectedAgentUiBehaviorDescriptors();
    });

    async function publishOn(machineId: string): Promise<void> {
        const { publishProjectedAgentUiBehaviorDescriptors } = await import('@/agents/registry/agentUiBehaviorProjection');
        publishProjectedAgentUiBehaviorDescriptors({
            machineId,
            descriptorsByAgentId: {
                [INSTALLED_AGENT_ID]: {
                    kind: 'plugin.ui.v1',
                    pluginId: 'acme',
                    agentId: INSTALLED_AGENT_ID,
                    version: 1,
                    behavior: INDEXING_OPTION_BEHAVIOR,
                },
            },
        });
    }

    async function renderOptions(params: Readonly<{
        staticAgentId: string | null;
        runtimeCarrierAgentId: string | null;
        selectedMachineId: string | null;
    }>): Promise<Record<string, unknown> | null> {
        const { useNewSessionConnectedServicesAgentOptions } = await import('./useNewSessionConnectedServicesAgentOptions');
        let options: Record<string, unknown> | null = null;

        function Probe() {
            options = useNewSessionConnectedServicesAgentOptions({
                staticAgentId: params.staticAgentId as never,
                runtimeCarrierAgentId: params.runtimeCarrierAgentId as never,
                selectedMachineId: params.selectedMachineId,
                targetServerId: null,
                selectedBackendTargetKey: 'backend:acme.agent',
                setBackendNewSessionOptionStateByTargetKey: vi.fn(),
                agentOptionState: { allowIndexing: true },
                settings: {} as never,
                router: { push: vi.fn(), setParams: vi.fn() } as never,
            }).agentNewSessionOptions;
            return null;
        }

        await renderScreen(<Probe />);
        return options;
    }

    it('builds the spawn option base from the Agent that will run the Session', async () => {
        await publishOn(SPAWN_MACHINE_ID);

        await expect(renderOptions({
            staticAgentId: null,
            runtimeCarrierAgentId: INSTALLED_AGENT_ID,
            selectedMachineId: SPAWN_MACHINE_ID,
        })).resolves.toEqual({ allowIndexing: true });
    });

    it('withholds an option base another machine declares for the same installed Agent', async () => {
        // `machine-a` sorts first, so a machine-blind read would answer with it.
        await publishOn('machine-a');

        await expect(renderOptions({
            staticAgentId: null,
            runtimeCarrierAgentId: INSTALLED_AGENT_ID,
            selectedMachineId: SPAWN_MACHINE_ID,
        })).resolves.toBeNull();
    });
});
