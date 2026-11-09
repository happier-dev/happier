import { describe, expect, it } from 'vitest';
import { createProviderConnectionViewFixture } from '@/dev/testkit/harness/providerSettingsHarness';
import { ProviderConnectionV1Schema, type ProviderConnectionV1 } from '@happier-dev/protocol/providers/connections/v1';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { buildProviderGatewayConfigurationMutation, buildProviderGatewaySlotMutation, chooseProviderGatewayContributionV1, readProviderGatewayContributionPurposes, readProviderGatewayModelRoles, presentProviderGatewayFamilyFacts } from './gatewayConfiguration';
import { readAccountAgentProviderRequirements, readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { ProviderContributionV1Schema } from '@happier-dev/protocol/providers/contributions/v1';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';

const gateway = () => createProviderConnectionViewFixture({ connectionId: 'pc_gateway', revision: 7,
    contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
    deployment: { kind: 'managedLocal', targetMachineId: 'machine-a', effects: null } });

describe('gateway configuration Action request', () => {
    it('presents only declared family restrictions through their contributing plugin translations', () => {
        const declaration = readAccountProviderDeclarations({ kind: 'account' }).find(entry => entry.definition.managedRuntime?.connectedAccounts?.length);
        if (!declaration?.definition.managedRuntime) throw new Error('Expected the admitted gateway declaration');
        const operationRestriction = {
            summary: { key: 'vendor.summary', fallback: 'Chat only' },
            sentence: { key: 'vendor.sentence', fallback: 'This vendor supports chat only.' },
        };
        const contributionKey = 'example.gateway/gateway';
        const definition = ProviderContributionV1Schema.parse({ ...declaration.definition, managedRuntime: {
            ...declaration.definition.managedRuntime, requestAuthUses: [], connectedAccounts: [
                { purpose: 'restricted-upstream', service: 'subscription', operationRestriction },
                { purpose: 'ordinary-upstream', service: 'subscription' },
            ],
        } });
        const purposes = readProviderGatewayContributionPurposes(contributionKey, [{ ...declaration, contributionKey, definition }])!;
        const localize = createPluginLocalizedTextResolver({ locale: 'fr', projection: { translationsByPluginId: {
            'example.gateway': { id: 'translations:example.gateway', pluginId: 'example.gateway', contributionKind: 'translations',
                locales: ['fr'], bundles: { fr: { 'vendor.summary': 'Discussion uniquement' } } },
        } } });
        expect(presentProviderGatewayFamilyFacts({ contributionKey, purposes, localize })).toEqual({
            'restricted-upstream': { restriction: { summary: 'Discussion uniquement', sentence: 'This vendor supports chat only.' } },
        });
    });

    it('projects contributed roles once per connection role and preserves their declared labels', () => {
        const requirements = readAccountAgentProviderRequirements('agent:happier.agent.codex/codex', { kind: 'account' })!;
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {
            first: { id: 'first', identity: { pluginId: 'acme.agent', localId: 'first' }, providerRequirements: {
                ...requirements, modelRoles: [{ id: 'reviewer', title: 'Code reviewer' }],
            } },
            second: { id: 'second', identity: { pluginId: 'acme.agent', localId: 'second' }, providerRequirements: {
                ...requirements, modelRoles: [{ id: 'reviewer', title: 'Code reviewer' }, { id: 'planner', title: 'Planner' }],
            } },
        } });
        expect(readProviderGatewayModelRoles({ kind: 'machine', projection })).toEqual([
            { id: 'reviewer', title: 'Code reviewer' }, { id: 'planner', title: 'Planner' },
        ]);
        expect(readProviderGatewayModelRoles({ kind: 'machine', projection: null })).toEqual([]);
    });

    it('builds Account configuration and slot edits without a machine target', () => {
        expect(buildProviderGatewayConfigurationMutation({ connection: gateway(), machineId: null,
            patch: { roleModels: null },
        })).toEqual({ action: 'update', connectionId: 'pc_gateway', expectedRevision: 7, roleModels: null });
        expect(buildProviderGatewaySlotMutation({ connectionId: ProviderConnectionIdSchema.parse('pc_gateway'), expectedRevision: 7,
            machineId: null, purposeBindingDefaults: {}, purpose: 'vendor', target: null,
        })).toEqual({ action: 'update', connectionId: 'pc_gateway', expectedRevision: 7,
            deployment: { kind: 'managedLocal', purposeBindingDefaults: {} } });
    });
    it('makes a connection a gateway with the slots it has when no slot is named', () => {
        const pool = { kind: 'group' as const, service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, groupId: 'work' };
        expect(buildProviderGatewaySlotMutation({ connectionId: ProviderConnectionIdSchema.parse('pc_gateway'), expectedRevision: 0,
            purposeBindingDefaults: { 'anthropic-upstream': pool }, purpose: null, target: null,
        })).toEqual({ action: 'update', connectionId: 'pc_gateway', expectedRevision: 0,
            deployment: { kind: 'managedLocal', purposeBindingDefaults: { 'anthropic-upstream': pool } } });
    });
    it('selects a sole admitted gateway and preserves multiple explicit choices', () => {
        expect(chooseProviderGatewayContributionV1(readAccountProviderDeclarations({ kind: 'account' }), {})).toEqual({ status: 'selected', contribution: {
            contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
            purposes: expect.arrayContaining([
                { purpose: 'openai-upstream', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
                { purpose: 'anthropic-upstream', service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' } },
            ]),
        } });
        const [gateway] = readAccountProviderDeclarations({ kind: 'account' }).filter(declaration => declaration.definition.managedRuntime?.connectedAccounts?.length);
        expect(chooseProviderGatewayContributionV1([gateway!, { ...gateway!, contributionKey: 'example.other/gateway' }], {}))
            .toMatchObject({ status: 'choice_required', choices: [
                { contributionKey: gateway!.contributionKey }, { contributionKey: 'example.other/gateway' },
            ] });
    });
    it('qualifies declaration-local gateway services while preserving explicit vendor identities', () => {
        const [declaration] = readAccountProviderDeclarations({ kind: 'account' }).filter(entry => entry.definition.managedRuntime?.connectedAccounts?.length);
        if (!declaration?.definition.managedRuntime) throw new Error('Expected the admitted gateway declaration');
        const qualified = { pluginId: 'vendor.accounts', localId: 'subscription' };
        const declarations = [{
            ...declaration,
            contributionKey: 'example.gateway/gateway',
            definition: { ...declaration.definition, managedRuntime: {
                ...declaration.definition.managedRuntime,
                requestAuthUses: [],
                connectedAccounts: [
                    { purpose: 'native-upstream', service: 'subscription' },
                    { purpose: 'other-upstream', service: qualified },
                ],
            } },
        }];
        expect(chooseProviderGatewayContributionV1(declarations, {})).toEqual({ status: 'selected', contribution: { contributionKey: 'example.gateway/gateway', purposes: expect.arrayContaining([
            { purpose: 'native-upstream', service: { pluginId: 'example.gateway', localId: 'subscription' } },
            { purpose: 'other-upstream', service: qualified },
        ]) } });
        expect(readProviderGatewayContributionPurposes('example.gateway/gateway', declarations)).toMatchObject([
            { purpose: 'native-upstream', service: { pluginId: 'example.gateway', localId: 'subscription' }, required: false },
            { purpose: 'other-upstream', service: qualified, required: false },
        ]);
    });
    it('accepts the unchanged saved Account connection rather than requiring a Machine view', () => {
        const saved = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
            source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
            role: 'named', displayName: 'Subscriptions', displayNameMode: 'custom', deployment: { kind: 'managedLocal' },
            gatewayPlacement: { kind: 'machine', machineId: 'hub-a' }, roleModels: { fast: 'haiku' },
            revision: 7, createdAt: 1, updatedAt: 1 });
        expect(buildProviderGatewayConfigurationMutation({ connection: saved, machineId: 'machine-a',
            patch: { gatewayPlacement: null },
        })).toEqual({ action: 'update', machineId: 'machine-a', connectionId: saved.id, expectedRevision: 7, gatewayPlacement: null });
    });
    it('pins the saved revision and changes only the requested configuration', () => {
        expect(buildProviderGatewayConfigurationMutation({ connection: gateway(), machineId: 'machine-a',
            patch: { gatewayPlacement: { kind: 'machine', machineId: 'hub-a' }, roleModels: { fast: 'haiku' } },
        })).toEqual({ action: 'update', machineId: 'machine-a', connectionId: 'pc_gateway', expectedRevision: 7,
            gatewayPlacement: { kind: 'machine', machineId: 'hub-a' }, roleModels: { fast: 'haiku' } });
    });
    it('supports reset without sending a deployment or resetting vendor slots', () => {
        expect(buildProviderGatewayConfigurationMutation({ connection: gateway(), machineId: 'machine-a',
            patch: { roleModels: null },
        })).toEqual({ action: 'update', machineId: 'machine-a', connectionId: 'pc_gateway', expectedRevision: 7, roleModels: null });
    });
    it('refuses external connections before constructing a managed mutation', () => {
        expect(() => buildProviderGatewayConfigurationMutation({ connection: createProviderConnectionViewFixture(),
            machineId: 'machine-a', patch: { gatewayPlacement: null } })).toThrow();
    });
});

describe('gateway vendor-slot Action request', () => {
    const codex = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const claude = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
    const saved = { connectionId: ProviderConnectionIdSchema.parse('pc_gateway'), expectedRevision: 7, machineId: 'machine-a',
        purposeBindingDefaults: {
            'openai-upstream': { kind: 'group' as const, service: codex, groupId: 'codex-pool' },
            'anthropic-upstream': { kind: 'group' as const, service: claude, groupId: 'lab-pool' },
        } };
    it('changes one vendor slot and carries the others unchanged at the revision that was read', () => {
        const account = { kind: 'account' as const, account: { service: claude, accountId: 'work' } };
        expect(buildProviderGatewaySlotMutation({ ...saved, purpose: 'anthropic-upstream', target: account })).toEqual({
            action: 'update', machineId: 'machine-a', connectionId: 'pc_gateway', expectedRevision: 7,
            deployment: { kind: 'managedLocal', purposeBindingDefaults: {
                'openai-upstream': saved.purposeBindingDefaults['openai-upstream'], 'anthropic-upstream': account } } });
    });
    it('leaves a vendor unused by removing only its slot', () => {
        expect(buildProviderGatewaySlotMutation({ ...saved, purpose: 'anthropic-upstream', target: null }).deployment).toEqual({
            kind: 'managedLocal', purposeBindingDefaults: { 'openai-upstream': saved.purposeBindingDefaults['openai-upstream'] } });
    });
});
