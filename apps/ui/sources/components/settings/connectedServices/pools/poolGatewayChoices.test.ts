import { describe, expect, it } from 'vitest';
import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import { buildPoolGatewayChoices, buildPoolGatewayMutation } from './poolGatewayChoices';

const codex = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const claude = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
const pool = { kind: 'group' as const, service: codex, groupId: 'pool-a' };
const otherPool = { ...pool, groupId: 'pool-b' };
const claudePool = { kind: 'group' as const, service: claude, groupId: 'claude-pool' };
function connection(target = otherPool) {
    return ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
        source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
        role: 'named', displayName: 'Subscriptions', displayNameMode: 'custom', deployment: { kind: 'managedLocal' },
        purposeBindingDefaults: { 'openai-upstream': target, 'anthropic-upstream': claudePool },
        revision: 3, createdAt: 1, updatedAt: 1 });
}
const NO_GRANTS = { accountGrants: [], machineGrants: [] };
describe('pool gateway assignment', () => {
    it('reads whether the gateway is on from the same fact as its page and the rail', () => {
        const half = buildPoolGatewayChoices({ connections: [connection(pool)], target: pool,
            accountGrants: [{ connectionId: 'pc_gateway' }], machineGrants: [] });
        expect(half[0]).toMatchObject({ enabled: true, gatewayOn: false });
        const on = buildPoolGatewayChoices({ connections: [connection(pool)], target: pool,
            accountGrants: [{ connectionId: 'pc_gateway' }], machineGrants: [{ connectionId: 'pc_gateway' }] });
        expect(on[0]).toMatchObject({ enabled: true, gatewayOn: true });
    });
    it('uses the contribution vendor slot, presents its replacement and preserves the other vendor', () => {
        const choices = buildPoolGatewayChoices({ connections: [connection()], target: pool, ...NO_GRANTS });
        expect(choices).toEqual([expect.objectContaining({ connectionId: 'pc_gateway', purpose: 'openai-upstream', enabled: false,
            replacementTarget: otherPool })]);
        const request = buildPoolGatewayMutation({ choice: choices[0], target: pool, enabled: true, machineId: 'machine-a' });
        expect(request).toEqual({ action: 'update', machineId: 'machine-a', connectionId: 'pc_gateway', expectedRevision: 3,
            deployment: { kind: 'managedLocal', purposeBindingDefaults: { 'openai-upstream': pool, 'anthropic-upstream': claudePool } } });
        expect(buildPoolGatewayMutation({ choice: choices[0], target: pool, enabled: false, machineId: 'machine-a' })).toBeNull();
    });
    it('clears only its own exact qualified pool and captures the connection revision', () => {
        const choices = buildPoolGatewayChoices({ connections: [connection(pool)], target: pool, ...NO_GRANTS });
        expect(choices[0].enabled).toBe(true);
        expect(buildPoolGatewayMutation({ choice: choices[0], target: pool, enabled: false, machineId: 'machine-a' })).toEqual({
            action: 'update', machineId: 'machine-a', connectionId: 'pc_gateway', expectedRevision: 3,
            deployment: { kind: 'managedLocal', purposeBindingDefaults: { 'anthropic-upstream': claudePool } },
        });
        expect(buildPoolGatewayMutation({ choice: choices[0], target: { ...pool, service: claude }, enabled: true, machineId: 'machine-a' })).toBeNull();
    });
    it('keeps gateway choice explicit without machine views and excludes unknown saved contributions', () => {
        const one = connection();
        const two = ProviderConnectionV1Schema.parse({ ...one, id: 'pc_second' });
        expect(buildPoolGatewayChoices({ connections: [one, two], target: pool, ...NO_GRANTS }).map(c => c.connectionId))
            .toEqual(['pc_gateway', 'pc_second']);
        const unknown = ProviderConnectionV1Schema.parse({ ...one, source: { kind: 'contribution', contributionKey: 'other.provider/gateway' } });
        expect(buildPoolGatewayChoices({ connections: [unknown], target: pool, ...NO_GRANTS })).toEqual([]);
    });
    it('uses immutable admitted slots after a saved config revision changes and writes the current revision', () => {
        const saved = ProviderConnectionV1Schema.parse({ ...connection(), displayName: 'Renamed', revision: 4 });
        const choices = buildPoolGatewayChoices({ connections: [saved], target: pool, ...NO_GRANTS });
        expect(choices).toEqual([expect.objectContaining({ connectionId: saved.id, title: 'Renamed', revision: 4 })]);
        expect(buildPoolGatewayMutation({ choice: choices[0], target: pool, enabled: true, machineId: 'machine-a' }))
            .toMatchObject({ expectedRevision: 4, deployment: { purposeBindingDefaults: { 'openai-upstream': pool } } });
    });
});
