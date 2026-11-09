import { describe, expect, it } from 'vitest';
import {
    SessionTeamCredentialBindingIntentsV1Schema,
    TeamCredentialProviderModelSelectionV1Schema,
    TeamCredentialResourceCatalogEntryV1Schema,
} from '@happier-dev/protocol/teams';

import {
    findCurrentTeamCredentialProviderModel,
    findAssignedProviderModelCredentialBinding,
    resourceHasAvailableTeamCredentialProviderModel,
} from './teamCredentialProviderModelCurrentness';

describe('resourceHasAvailableTeamCredentialProviderModel', () => {
    it('hydrates only an assigned Provider-model intent and leaves a clear intent unselected', () => {
        const clear = SessionTeamCredentialBindingIntentsV1Schema.parse([{
            v: 1,
            slot: { kind: 'provider_model' },
            resourceId: null,
        }]);
        const assigned = SessionTeamCredentialBindingIntentsV1Schema.parse([{
            v: 1,
            slot: { kind: 'provider_model' },
            resourceId: 'resource-1',
            expectedResourceRevision: 3,
            deliveryMode: 'brokered',
        }]);

        expect(findAssignedProviderModelCredentialBinding(clear)).toBeNull();
        expect(findAssignedProviderModelCredentialBinding(assigned)).toEqual(assigned[0]);
        expect(findAssignedProviderModelCredentialBinding(undefined)).toBeNull();
    });

    it.each([
        ['brokered', 'direct'],
        ['direct', 'brokered'],
    ] as const)('does not let the selected %s route cross-match an available %s route twin', (selectedRoute, availableTwinRoute) => {
        const selected = TeamCredentialProviderModelSelectionV1Schema.parse({
            kind: 'team_credential_provider_model',
            resourceId: 'resource-1',
            teamId: 'team-1',
            expectedResourceRevision: 3,
            deliveryMode: selectedRoute,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            modelId: 'gpt-5',
        });
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
            id: 'resource-1',
            teamId: 'team-1',
            displayName: 'Shared provider',
            resourceRevision: 3,
            readiness: { kind: 'available' },
            recoveryAction: null,
            mayBroker: true,
            mayReceiveDirect: true,
            directMaterialState: 'current',
            sessionUsePolicy: 'personal_allowed',
            providerModels: [{
                selection: { ...selected, deliveryMode: availableTwinRoute },
                descriptor: { id: 'gpt-5', name: 'GPT-5' },
                application: {
                    agentTargetKey: selected.agentTargetKey,
                    implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
                    endpointTemplateId: 'responses',
                    protocol: 'openai-responses',
                },
                sourceRevision: 'source-1',
                availability: 'available',
            }],
            sourcePresentation: {
                kind: 'provider',
                provider: {
                    identity: { pluginId: 'happier.provider.openai', localId: 'openai' },
                    definitionRevision: 1,
                },
            },
        });

        expect(resourceHasAvailableTeamCredentialProviderModel(resource, selected)).toBe(false);
        expect(findCurrentTeamCredentialProviderModel(resource, selected)).toBeNull();
        const offered = resource.providerModels[0]!.selection;
        const limited = { ...resource, readiness: {
            kind: 'limit_reached' as const, metric: 'total_tokens' as const, resetsAtUtc: '2026-09-15T00:00:00.000Z',
        } };
        expect(resourceHasAvailableTeamCredentialProviderModel(limited, offered)).toBe(offered.deliveryMode === 'direct');
        expect(resourceHasAvailableTeamCredentialProviderModel(resource, {
            ...selected,
            deliveryMode: availableTwinRoute,
        })).toBe(true);
        expect(findCurrentTeamCredentialProviderModel({ ...resource, readiness: { kind: 'limit_reached',
            metric: 'inference_requests', resetsAtUtc: '2026-10-26T00:00:00Z' } }, {
            ...selected,
            deliveryMode: availableTwinRoute,
        })?.availability).toBe('available');
    });
});
