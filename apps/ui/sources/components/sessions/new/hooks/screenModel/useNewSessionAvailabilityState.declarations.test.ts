import { afterEach, describe, expect, it } from 'vitest';

import {
    clearProjectedAgentUiBehaviorDescriptors,
    publishProjectedAgentUiBehaviorDescriptors,
} from '@/agents/registry/agentUiBehaviorProjection';
import { makeSettings } from '@/agents/registry/registryUiBehavior.testHelpers';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

import { resolveNewSessionDeclarationAvailabilityFacts } from './useNewSessionAvailabilityState';

describe('resolveNewSessionDeclarationAvailabilityFacts', () => {
    afterEach(() => clearProjectedAgentUiBehaviorDescriptors());

    it('uses the selected machine declaration for an installed Agent absent from bundled ids', () => {
        const agentId = 'acme.review/assistant';
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-a',
            descriptorsByAgentId: {
                [agentId]: {
                    newSession: {
                        relevantInstallableDepKeys: ['acme.cli'],
                        canSelectWithoutDetectedCli: true,
                    },
                },
            },
        });
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-b',
            descriptorsByAgentId: {
                [agentId]: {
                    newSession: {
                        relevantInstallableDepKeys: [],
                        canSelectWithoutDetectedCli: false,
                    },
                },
            },
        });
        const entry = {
            kind: 'pluginBackend',
            agentId,
            backendTargetKey: 'backend:acme.review',
        } as ResolvedBackendCatalogEntry;

        expect(resolveNewSessionDeclarationAvailabilityFacts({
            resolvedBackendEntries: [entry],
            selectedMachineId: 'machine-b',
            settings: makeSettings(),
            resumeSessionId: null,
            externalSessionsFeatureEnabled: false,
            backendNewSessionOptionStateByTargetKey: {},
        })).toEqual({
            installableDepKeyCountByAgentId: { [agentId]: 0 },
            selectableWithoutCliByAgentId: { [agentId]: false },
        });
    });
});
