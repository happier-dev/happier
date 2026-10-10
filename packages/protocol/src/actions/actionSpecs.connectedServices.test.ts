import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import { ActionIdSchema, type ActionId } from './actionIds.js';

const service = { pluginId: 'happier.agent.codex', localId: 'openai' };

describe('connected-service configuration Action parity', () => {
  it('keeps service-configuration secret replacements in live approval custody and outside observation', () => {
    const spec = getActionSpec('connectedServices.configuration.replace');
    const input = { service, modeId: 'configured', expectedRevision: 'before',
      values: { endpoint: 'https://private-endpoint.test' }, secretValues: { token: 'private-replacement' } };
    expect(spec.approvalInputCustody).toBe('live_only');
    expect(spec.projectObservationInput?.(input)).toEqual({ service, modeId: 'configured', expectedRevision: 'before' });
  });
  it.each([
    ['connectedServices.configuration.get', { service, modeId: 'configured' }],
    ['connectedServices.configuration.replace', { service, modeId: 'configured', expectedRevision: null, values: {}, secretValues: {} }],
    ['connectedServices.accounts.rename', { account: { service, accountId: 'work' }, label: 'Team' }],
    ['connectedServices.accounts.default.set', { account: { service, accountId: 'work' }, agentId: 'codex', makeDefault: true }],
    ['connectedServices.pools.create', { service, group: { groupId: 'pool', displayName: 'Team' } }],
    ['connectedServices.pools.patch', { service, groupId: 'pool', displayName: 'Team', expectedGeneration: 1 }],
    ['connectedServices.pools.delete', { group: { service, groupId: 'pool' }, expectedGeneration: 1, expectedIncarnation: 'pool-life' }],
    ['connectedServices.pools.members.add', { group: { service, groupId: 'pool' }, connectedAccountId: 'work', priority: 100, enabled: true, expectedGeneration: 1 }],
    ['connectedServices.pools.members.patch', { group: { service, groupId: 'pool' }, connectedAccountId: 'work', enabled: false, expectedGeneration: 1 }],
    ['connectedServices.pools.members.remove', { group: { service, groupId: 'pool' }, connectedAccountId: 'work', expectedGeneration: 1 }],
    ['connectedServices.pools.switchNow', { group: { service, groupId: 'pool' }, connectedAccountId: 'work', expectedGeneration: 1, expectedIncarnation: '11111111-1111-4111-8111-111111111111', expectedRuntimeStateRevision: 1 }],
    ['connectedServices.pools.reorder', { group: { service, groupId: 'pool' }, accountIds: ['work', 'personal'] }],
    ['connectedServices.pools.default.set', { group: { service, groupId: 'pool' }, agentId: 'codex', makeDefault: true }],
    ['connectedServices.quota.reset', { machineId: 'machine-1', serviceId: 'openai-codex', profileId: 'work' }],
    ['connectedServices.quota.refresh', { account: { service, accountId: 'work' }, machineId: 'machine-1' }],
    ['connectedServices.identityPrivacy.set', { hidden: true }],
  ])('admits %s through a closed Action input', (id, input) => {
    const spec = getActionSpec(id as ActionId);
    expect(ActionIdSchema.safeParse(id).success).toBe(true);
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, accountId: 'caller-selected-account' }).success).toBe(false);
    expect(spec.surfaces.ui).toBe(true);
    expect(spec.surfaces.agent).toBe(true);
  });
  it('routes quota-reset execution to its machine owner rather than an Account server', () => {
    expect(getActionSpec('connectedServices.quota.reset').executionPlacement).toBe('machine');
  });
  it('does not grant agents writes to pool or member runtime state through configuration parity', () => {
    expect(getActionSpec('connectedServices.pools.create').inputSchema.safeParse({ service, group: { groupId: 'pool', state: {} } }).success).toBe(false);
    expect(getActionSpec('connectedServices.pools.patch').inputSchema.safeParse({ service, groupId: 'pool', expectedGeneration: 1, state: {} }).success).toBe(false);
    expect(getActionSpec('connectedServices.pools.members.patch').inputSchema.safeParse({ group: { service, groupId: 'pool' }, connectedAccountId: 'work', expectedGeneration: 1, state: {} }).success).toBe(false);
  });
});
