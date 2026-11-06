import { describe, expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import { buildSessionModelPickerSections } from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import {
    readAccountAgentProviderDeclarations,
    readAccountAgentProviderRequirements,
    readAccountProviderDeclarations,
    readProviderConnectionPickerKind,
    readProviderContributionIcon,
    resolveAccountAgentProviderRequirements,
    type ProviderDeclarationContext,
} from './accountProviderDeclarations';

describe('admitted Provider declarations', () => {
    it('reads only the addressed Provider declaration for kind and icon in a large Machine registry', () => {
        const definition = readAccountProviderDeclarations({ kind: 'account' }).find(row => row.definition.managedRuntime)!.definition;
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {
            providers: { family: 'providers', entriesById: Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => {
                const id = `acme.provider-${index}/gateway`;
                return [id, { id, pluginId: `acme.provider-${index}`, provenance: 'external', sourceKind: 'path',
                    definition: { ...definition, id: 'gateway', icon: 'cloud-outline' } }];
            })) },
        } });
        let declarationsRead = 0;
        const entries = projection.familiesById.providers!.entriesById;
        for (const entry of Object.values(entries)) {
            const admittedDefinition = entry.definition;
            Object.defineProperty(entry, 'definition', { get: () => { declarationsRead++; return admittedDefinition; } });
        }
        const context: ProviderDeclarationContext = { kind: 'machine', projection };
        expect(readProviderConnectionPickerKind({ kind: 'contribution', contributionKey: 'acme.provider-999/gateway' }, context)).toBe(definition.kind);
        expect(readProviderContributionIcon('acme.provider-999/gateway', context)).toBe('cloud-outline');
        expect(readProviderContributionIcon('acme.missing/gateway', context)).toBeNull();
        // Two exact reads inspect two definitions; unrelated registry entries and a missing key inspect none.
        expect(declarationsRead).toBe(2);
    });

    it('keeps missing or invalid Agent targets unknown during anonymous catalog composition', () => {
        const contexts: ProviderDeclarationContext[] = [
            { kind: 'account' },
            { kind: 'machine', projection: null },
            { kind: 'machine', projection: undefined },
            { kind: 'machine', projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1 }) },
        ];
        for (const context of contexts) for (const target of ['', ' ', 'not-a-target']) {
            expect(readAccountAgentProviderRequirements(target, context)).toBeNull();
            expect(resolveAccountAgentProviderRequirements(target, context)).toEqual({ kind: 'unknown' });
        }
    });

    it('keeps an addressed bundled Agent unknown before its Machine answers', () => {
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const requirements = readAccountAgentProviderRequirements(agentTargetKey, { kind: 'account' })!;
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {
            codex: { id: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' }, providerRequirements: requirements },
        } });
        for (const unavailable of [null, undefined]) {
            expect(resolveAccountAgentProviderRequirements(agentTargetKey, { kind: 'machine', projection: unavailable })).toEqual({ kind: 'unknown' });
            expect(readAccountProviderDeclarations({ kind: 'machine', projection: unavailable })).toEqual([]);
        }
        expect(resolveAccountAgentProviderRequirements(agentTargetKey, { kind: 'machine', projection })).toEqual({ kind: 'known', requirements });
        expect(resolveAccountAgentProviderRequirements(agentTargetKey, { kind: 'machine', projection: null })).toEqual({ kind: 'unknown' });
        expect(resolveAccountAgentProviderRequirements(agentTargetKey, { kind: 'account' })).toEqual({ kind: 'known', requirements });
        expect(readAccountProviderDeclarations({ kind: 'account' }).length).toBeGreaterThan(0);
    });
    it('reads exact installed identities, including local-id collisions, and withdraws absent requirements', () => {
        const requirements = readAccountAgentProviderRequirements('agent:happier.agent.codex/codex', { kind: 'account' })!;
        const definition = readAccountProviderDeclarations({ kind: 'account' }).find(row => row.definition.managedRuntime)!.definition;
        const projection = PluginProjectionV2Schema.parse({
            ...PluginProjectionV2Schema.parse({ v: 2, generation: 9 }),
            agentsById: { installed: { id: 'installed', identity: { pluginId: 'acme.agent', localId: 'codex' }, providerRequirements: requirements } },
            familiesById: { providers: { family: 'providers' as const, entriesById: {
                'acme.gateway/managed': { id: 'acme.gateway/managed', pluginId: 'acme.gateway', provenance: 'external' as const,
                    sourceKind: 'path' as const, definition: { ...definition, id: 'managed', icon: 'cloud-outline' } },
            } } },
        });
        expect(readAccountAgentProviderRequirements('agent:acme.agent/codex', { kind: 'machine', projection: projection })).toEqual(requirements);
        expect(readAccountAgentProviderDeclarations({ kind: 'machine', projection })).toEqual([
            { agentTargetKey: 'agent:acme.agent/codex', requirements },
        ]);
        expect(readAccountAgentProviderRequirements('agent:happier.agent.codex/codex', { kind: 'machine', projection: projection })).toBeNull();
        const declarations = readAccountProviderDeclarations({ kind: 'machine', projection: projection });
        expect(declarations.find(row => row.contributionKey === 'acme.gateway/managed')).toMatchObject({ provenance: 'external', definition: { id: 'managed' } });
        expect(readProviderConnectionPickerKind({ kind: 'contribution', contributionKey: 'acme.gateway/managed' }, { kind: 'machine', projection: projection })).toBe(definition.kind);
        expect(readProviderContributionIcon('acme.gateway/managed', { kind: 'machine', projection: projection })).toBe('cloud-outline');
        const withdrawn = PluginProjectionV2Schema.parse({ ...projection, agentsById: { installed: { id: 'installed', identity: { pluginId: 'acme.agent', localId: 'codex' } } } });
        expect(readAccountAgentProviderRequirements('agent:acme.agent/codex', { kind: 'machine', projection: withdrawn })).toBeNull();
        expect(readAccountAgentProviderDeclarations({ kind: 'machine', projection: withdrawn })).toEqual([]);
    });

    it('does not admit Team models when the exact Agent requirements are unknown', () => {
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey: 'agent:acme.missing/agent', nativeModels: [], providerGroups: [],
            hiddenNativeModelKeys: new Set(), providerProjectionAuthoritative: true,
            teamCredentialResources: [TeamCredentialResourceCatalogEntryV1Schema.parse({ id: 'resource', teamId: 'team', displayName: 'Models', resourceRevision: 1,
                readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
                directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
                connectedServiceSelections: [], sourcePresentation: { kind: 'provider', provider: {
                    identity: { pluginId: 'acme.gateway', localId: 'managed' }, definitionRevision: 1 } },
                providerModels: [{ descriptor: { id: 'image', name: 'Image', capabilities: { toolRoundTrips: 'unsupported' } },
                    selection: { kind: 'team_credential_provider_model', teamId: 'team', resourceId: 'resource', expectedResourceRevision: 1,
                        deliveryMode: 'brokered', agentTargetKey: 'agent:acme.missing/agent', modelId: 'image' },
                    application: { agentTargetKey: 'agent:acme.missing/agent', implementationIdentity: { pluginId: 'acme.gateway', localId: 'managed' },
                        endpointTemplateId: 'responses', protocol: 'openai-responses' }, sourceRevision: '1', availability: 'available' }],
            })],
        });
        expect(sections.flatMap(section => section.options)).toEqual([]);
    });

    it('keeps recovery inert when a retained Team selection has unknown Agent requirements', () => {
        const agentTargetKey = 'agent:acme.missing/agent';
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
            id: 'resource', teamId: 'team', displayName: 'Models', resourceRevision: 1,
            readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
            directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', providerModels: [],
            sourcePresentation: { kind: 'provider', provider: {
                identity: { pluginId: 'acme.gateway', localId: 'managed' }, definitionRevision: 1 } },
        });
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey, nativeModels: [], providerGroups: [], hiddenNativeModelKeys: new Set(),
            providerProjectionAuthoritative: true, teamCredentialResources: [resource],
            selectedTeamCredentialModel: { kind: 'team_credential_provider_model', teamId: 'team', resourceId: 'resource',
                expectedResourceRevision: 1, deliveryMode: 'brokered', agentTargetKey, modelId: 'retained' },
            onRecoverTeamCredentialResource: () => {},
        });
        expect(sections[0]?.options[0]).toMatchObject({ disabled: true });
        expect(sections[0]?.options[0]?.onActivate).toBeUndefined();
    });
});
