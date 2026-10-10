import { describe, expect, it } from 'vitest';
import { createProviderConnectionViewFixture } from '@/dev/testkit';
import { ProviderConnectionV1Schema, type ProviderConnectionV1 } from '@happier-dev/protocol/providers/connections/v1';
import { buildProviderGatewayConfigurationMutation, buildProviderGatewaySlotMutation } from './gatewayConfiguration';

const gateway = () => createProviderConnectionViewFixture({ connectionId: 'pc_gateway', revision: 7,
    contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
    deployment: { kind: 'managedLocal', targetMachineId: 'machine-a', effects: null } });

describe('gateway configuration Action request', () => {
    it('builds Account configuration and slot edits without a machine target', () => {
        expect(buildProviderGatewayConfigurationMutation({ connection: gateway(), machineId: null,
            patch: { claudeHelperModels: null },
        })).toEqual({ action: 'update', connectionId: 'pc_gateway', expectedRevision: 7, claudeHelperModels: null });
        expect(buildProviderGatewaySlotMutation({ connectionId: 'pc_gateway', expectedRevision: 7,
            machineId: null, purposeBindingDefaults: {}, purpose: 'vendor', target: null,
        })).toEqual({ action: 'update', connectionId: 'pc_gateway', expectedRevision: 7,
            deployment: { kind: 'managedLocal', purposeBindingDefaults: {} } });
    });
    it('accepts the unchanged saved Account connection rather than requiring a Machine view', () => {
        const saved = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
            source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
            role: 'named', displayName: 'Subscriptions', displayNameMode: 'custom', deployment: { kind: 'managedLocal' },
            gatewayPlacement: { kind: 'machine', machineId: 'hub-a' }, claudeHelperModels: { fast: 'haiku' },
            revision: 7, createdAt: 1, updatedAt: 1 });
        expect(buildProviderGatewayConfigurationMutation({ connection: saved, machineId: 'machine-a',
            patch: { gatewayPlacement: null },
        })).toEqual({ action: 'update', machineId: 'machine-a', connectionId: saved.id, expectedRevision: 7, gatewayPlacement: null });
    });
    it('pins the saved revision and changes only the requested configuration', () => {
        expect(buildProviderGatewayConfigurationMutation({ connection: gateway(), machineId: 'machine-a',
            patch: { gatewayPlacement: { kind: 'machine', machineId: 'hub-a' }, claudeHelperModels: { fast: 'haiku' } },
        })).toEqual({ action: 'update', machineId: 'machine-a', connectionId: 'pc_gateway', expectedRevision: 7,
            gatewayPlacement: { kind: 'machine', machineId: 'hub-a' }, claudeHelperModels: { fast: 'haiku' } });
    });
    it('supports reset without sending a deployment or resetting vendor slots', () => {
        expect(buildProviderGatewayConfigurationMutation({ connection: gateway(), machineId: 'machine-a',
            patch: { claudeHelperModels: null },
        })).toEqual({ action: 'update', machineId: 'machine-a', connectionId: 'pc_gateway', expectedRevision: 7, claudeHelperModels: null });
    });
    it('refuses external connections before constructing a managed mutation', () => {
        expect(() => buildProviderGatewayConfigurationMutation({ connection: createProviderConnectionViewFixture(),
            machineId: 'machine-a', patch: { gatewayPlacement: null } })).toThrow();
    });
});

describe('gateway vendor-slot Action request', () => {
    const codex = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const claude = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
    const saved = { connectionId: 'pc_gateway' as ProviderConnectionV1['id'], expectedRevision: 7, machineId: 'machine-a',
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
