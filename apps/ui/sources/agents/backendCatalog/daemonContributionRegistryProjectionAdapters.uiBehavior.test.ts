import { afterEach, describe, expect, it } from 'vitest';

import type { PluginProjectionV2 } from '@happier-dev/protocol';

import {
    adaptDaemonContributionRegistryProjectionToMergedProjectionInputs,
    readProjectedAgentUiBehaviorDescriptors,
} from './daemonContributionRegistryProjectionAdapters';
import {
    clearProjectedAgentUiBehaviorDescriptors,
    publishProjectedAgentUiBehaviorDescriptors,
} from '@/agents/registry/agentUiBehaviorProjection';
import { resolveAgentUiBehavior } from '@/agents/registry/registryUiBehavior';

function projectionWithExternalAgent(): PluginProjectionV2 {
    return {
        v: 2,
        generation: 3,
        installedPackagesById: {},
        agentsById: {
            'acme.agent': {
                id: 'acme.agent',
                identity: { pluginId: 'acme.tools', localId: 'agent' },
                title: 'Acme Agent',
                channel: 'plugin',
                providerOwnedEnvironmentKeys: [],
                ui: {
                    behavior: {
                        permissions: {
                            footer: {
                                usePermissionUpdates: true,
                                forceReadOnlyAfterStop: false,
                                supportsExecPolicyAmendment: true,
                                stopHandling: 'denyOnly',
                            },
                        },
                        newSession: { transcriptStorageModes: ['direct'] },
                    },
                    session: {
                        visibleMessages: {
                            kind: 'session.visibleMessages.v1',
                            subagentKinds: ['acme_worker'],
                            fallbackToolNames: ['AcmeWorker'],
                            excludeJsonEventTypes: ['acme_internal'],
                        },
                    },
                },
            },
            'acme.plain': {
                id: 'acme.plain',
                identity: { pluginId: 'acme.tools', localId: 'plain' },
                title: 'Acme Plain',
                channel: 'plugin',
                providerOwnedEnvironmentKeys: [],
            },
        },
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {},
        diagnostics: [],
    } as unknown as PluginProjectionV2;
}

describe('daemon-projected Agent UI behavior descriptors', () => {
    afterEach(() => {
        clearProjectedAgentUiBehaviorDescriptors();
    });

    it('carries a declared descriptor from the daemon projection to the behavior resolver', () => {
        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(
            projectionWithExternalAgent(),
        );

        const descriptorsByAgentId = readProjectedAgentUiBehaviorDescriptors(
            adapted.mergedProviderProjectionById,
        );
        expect(Object.keys(descriptorsByAgentId)).toEqual(['acme.agent']);
        expect(descriptorsByAgentId['acme.agent']).toMatchObject({
            kind: 'plugin.ui.v1',
            pluginId: 'acme.tools',
            agentId: 'acme.agent',
            version: 1,
            session: {
                visibleMessages: {
                    kind: 'session.visibleMessages.v1',
                    subagentKinds: ['acme_worker'],
                    fallbackToolNames: ['AcmeWorker'],
                    excludeJsonEventTypes: ['acme_internal'],
                },
            },
        });

        publishProjectedAgentUiBehaviorDescriptors({ machineId: 'm1', descriptorsByAgentId });

        expect(resolveAgentUiBehavior('acme.agent').permissions?.footer).toEqual({
            usePermissionUpdates: true,
            forceReadOnlyAfterStop: false,
            supportsExecPolicyAmendment: true,
            stopHandling: 'denyOnly',
        });
        expect(resolveAgentUiBehavior('acme.plain').permissions?.footer?.stopHandling).toBe('denyAndAbortRun');
    });
});
