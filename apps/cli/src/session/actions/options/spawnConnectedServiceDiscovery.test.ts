import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileResponseSchema, ConnectedServiceAuthGroupV1Schema } from '@happier-dev/protocol';

import { logger } from '@/ui/logger';

import { listSpawnConnectedServiceItems } from './spawnConnectedServiceDiscovery';

const http = vi.hoisted(() => ({ get: vi.fn() }));
// HTTP is the only replaced boundary; V3 parsing and option projection stay real.
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, get: http.get } };
});

const accountProfile = AccountProfileResponseSchema.parse({
  id: 'account',
  connectedServicesV2: [{
    serviceId: 'openai-codex',
    profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
    groups: [{ groupId: 'pool', displayName: 'Pool', activeProfileId: 'work', memberProfileIds: ['work'], generation: 1 }],
  }],
});

function group(autoSwitch: boolean) {
  return ConnectedServiceAuthGroupV1Schema.parse({
    v: 1, serviceId: 'openai-codex', groupId: 'pool', displayName: 'Pool',
    activeProfileId: 'work', generation: 2, runtimeStateRevision: 1,
    policy: { autoSwitch }, state: { status: 'ready' }, createdAt: 1, updatedAt: 2,
    members: ['work', 'disabled'].map((profileId) => ({
      v: 1, serviceId: 'openai-codex', groupId: 'pool', profileId,
      enabled: profileId !== 'disabled', createdAt: 1, updatedAt: 2,
    })),
  });
}

function discover(accountGroupsFeatureEnabled = true, agentId = 'codex') {
  return listSpawnConnectedServiceItems({
    token: 'test-token', accountProfile, accountSettings: {}, agentId,
    connectedServicesFeatureEnabled: true, accountGroupsFeatureEnabled,
  });
}

describe('spawn connected-service discovery authoritative pool policy', () => {
  beforeEach(() => {
    http.get.mockReset();
    vi.spyOn(logger, 'warnFile').mockClear();
  });

  it.each([true, false])('reports V3 autoSwitch=%s with enabled members only', async (autoSwitch) => {
    http.get.mockResolvedValue({ status: 200, data: { groups: [group(autoSwitch)] } });
    const result = await discover();
    expect(result.items[0]?.accountGroups).toEqual([
      expect.objectContaining({ autoSwitch, generation: 2, enabledMemberCount: 1, memberProfileIds: ['work'] }),
    ]);
    expect(String(http.get.mock.calls[0]?.[0])).toContain('/v3/connect/openai-codex/groups');
  });

  it.each([404, 503])('keeps the pool and reports unknown when V3 returns %s', async (status) => {
    http.get.mockRejectedValue(Object.assign(new Error('unavailable'), { response: { status } }));
    const result = await discover();
    expect(result.items[0]?.accountGroups).toEqual([
      expect.objectContaining({ groupId: 'pool', autoSwitch: null, memberProfileIds: ['work'] }),
    ]);
    expect(logger.warnFile).toHaveBeenCalledWith(
      expect.any(String), { serviceId: 'openai-codex' },
    );
  });

  it('does not fetch policy when account groups are disabled', async () => {
    const result = await discover(false);
    expect(result.items[0]?.accountGroups).toEqual([]);
    expect(http.get).not.toHaveBeenCalled();
  });
});
