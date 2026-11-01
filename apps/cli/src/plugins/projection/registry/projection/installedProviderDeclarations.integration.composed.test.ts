import { describe, expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { projectAgentProviderBrokerApplications } from '@happier-dev/protocol/providers/catalog/brokerApplicationProjectionV1';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import { parseProviderContributionIdentityV1 } from '@happier-dev/protocol/providers/contribution-identity';

import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { buildPluginProjectionV2 } from './v2';
import {
    readAccountAgentProviderRequirements,
    readAccountProviderDeclarations,
} from '../../../../../../ui/sources/providers/catalog/accountProviderDeclarations';
import { buildSessionModelPickerSections } from '../../../../../../ui/sources/components/sessions/modelPicker/buildSessionModelPickerSections';

describe('installed Agent and managed Provider declaration projection', () => {
    it('carries the admitted installed declarations through the Machine projection into client broker discovery', async () => {
        const fixture = await createManagedRunLaunchFixture({
            activateAgent: false,
            requiredCapabilities: { streaming: true, toolRoundTrips: true },
        });
        try {
            const projection = PluginProjectionV2Schema.parse(buildPluginProjectionV2({
                registry: fixture.lease.registry.contributes,
                generation: 1,
            }));
            const requirements = readAccountAgentProviderRequirements(fixture.agentTargetKey, { kind: 'machine', projection: projection });
            expect(requirements?.acceptsProtocols).toEqual(['openai-responses']);
            expect(requirements?.required).toEqual({ streaming: true, toolRoundTrips: true });
            const declarations = readAccountProviderDeclarations({ kind: 'machine', projection: projection });
            const installedProvider = declarations.find(row => row.contributionKey === 'acme.managed-run/gateway');
            expect(installedProvider).toMatchObject({
                contributionKey: 'acme.managed-run/gateway',
                provenance: 'external',
                definition: { managedRuntime: { endpointTemplateIds: ['responses'] } },
            });
            expect(projectAgentProviderBrokerApplications({
                providers: declarations.flatMap(declaration => {
                    const parsed = parseProviderContributionIdentityV1(declaration.contributionKey);
                    return parsed ? [{ identity: parsed.identity, definition: declaration.definition }] : [];
                }),
                agentTargetKey: fixture.agentTargetKey,
                acceptedProtocols: requirements?.acceptsProtocols ?? [],
            })).toContainEqual({
                agentTargetKey: fixture.agentTargetKey,
                implementationIdentity: { pluginId: 'acme.managed-run', localId: 'gateway' },
                endpointTemplateId: 'responses',
                protocol: 'openai-responses',
            });
            const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
                id: 'resource-1', teamId: 'team-1', displayName: 'Installed Provider', resourceRevision: 1,
                readiness: { kind: 'available' }, recoveryAction: null,
                mayBroker: true, mayReceiveDirect: false,
                directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
                providerModels: [
                    { id: 'image-only', toolRoundTrips: 'unsupported' },
                    { id: 'unknown-chat', toolRoundTrips: 'unknown' },
                    { id: 'tool-chat', toolRoundTrips: 'supported' },
                ].map(model => ({
                    selection: { kind: 'team_credential_provider_model', resourceId: 'resource-1', teamId: 'team-1',
                        expectedResourceRevision: 1, deliveryMode: 'brokered', agentTargetKey: fixture.agentTargetKey, modelId: model.id },
                    descriptor: { id: model.id, name: model.id,
                        capabilities: { toolRoundTrips: model.toolRoundTrips } },
                    application: { agentTargetKey: fixture.agentTargetKey,
                        implementationIdentity: { pluginId: 'acme.managed-run', localId: 'gateway' },
                        endpointTemplateId: 'responses', protocol: 'openai-responses' },
                    sourceRevision: 'source-v1', availability: 'available',
                })),
                sourcePresentation: { kind: 'provider', provider: {
                    identity: { pluginId: 'acme.managed-run', localId: 'gateway' }, definitionRevision: 1,
                } },
            });
            const sections = buildSessionModelPickerSections({
                agentTargetKey: fixture.agentTargetKey, declarationContext: { kind: 'machine', projection: projection },
                nativeModels: [], hiddenNativeModelKeys: new Set(),
                providerProjectionAuthoritative: true, providerGroups: [], teamCredentialResources: [resource],
            });
            expect(sections.flatMap(section => section.options.map(option => option.value?.modelId)))
                .toEqual(['unknown-chat', 'tool-chat']);
        } finally {
            await fixture.cleanup();
        }
    });
});
