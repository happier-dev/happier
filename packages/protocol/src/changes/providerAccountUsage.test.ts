import { describe, expect, it } from 'vitest';
import { buildConnectedServicesAccountChangeV1, TEAM_CREDENTIAL_MATERIAL_ACCOUNT_CHANGE_ENTITY_ID_V1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from './index.js';
import { buildProviderAccountUsageMaterialChangesV1, readProviderAccountUsageChangeScopeV1,
  readProviderAccountUsageChangeRecordIdV1 } from './providerAccountUsage.js';

describe('Provider usage change scope', () => {
  const first = 'paug_v1_abcdefgh';
  const second = 'paug_v1_ijklmnop';
  const page = (id: string, cursor = 1) => buildProviderAccountUsageMaterialChangesV1(id)
    .map((change, index) => ({ ...change, cursor: cursor + index }));

  it('keeps the predecessor key and scopes a coalesced page to every changed record', () => {
    expect(page(first)[0]?.entityId).toBe('provider-account-usage');
    expect(readProviderAccountUsageChangeScopeV1([page(first)[1]!, ...page(second, 3)]))
      .toEqual({ recordIds: [first, second], bindingServiceKeys: [] });
    expect(readProviderAccountUsageChangeRecordIdV1(page(first)[1]!.entityId)).toBe(first);
  });

  it('keeps legacy, incomplete, malformed and mixed unknown scopes full', () => {
    expect(readProviderAccountUsageChangeScopeV1([{ kind: 'account', entityId: 'provider-account-usage', cursor: 3 }, page(first)[1]!])).toBeUndefined();
    expect(readProviderAccountUsageChangeScopeV1([page(first)[0]!])).toBeUndefined();
    expect(readProviderAccountUsageChangeScopeV1([...page(first), { kind: 'account', entityId: 'self', cursor: 3 }])).toBeUndefined();
    expect(readProviderAccountUsageChangeScopeV1([{ kind: 'account', entityId: 'provider-account-usage-record:invalid', cursor: 1 }])).toBeUndefined();
    expect(readProviderAccountUsageChangeScopeV1([{ ...page(first)[0]!, cursor: 5 }, page(first)[1]!])).toBeUndefined();
    expect(readProviderAccountUsageChangeScopeV1([page(first)[1]!])).toEqual({ recordIds: [first], bindingServiceKeys: [] });
  });

  it('retains eight quota records through heterogeneous non-authority account rows', () => {
    const records = Array.from({ length: 8 }, (_, index) => `paug_v1_${String(index).padStart(2, '0')}abcdefgh`);
    const changes = records.flatMap((id, index) => page(id, index * 2 + 1));
    changes.push(
      { kind: 'account', entityId: 'home-governance', cursor: 100 },
      { kind: 'account', entityId: 'c8e100dc-0565-4c09-9bc9-a02222cfbc87', cursor: 101 },
      { kind: 'machine', entityId: 'machine-a', cursor: 102 },
      { kind: 'pluginDomain', entityId: 'pluginDomain/example/data-kv', cursor: 103 },
    );
    expect(readProviderAccountUsageChangeScopeV1(changes)).toEqual({ recordIds: records, bindingServiceKeys: [] });
  });

  it('keeps named records when the same durable page also names a qualified service', () => {
    const binding = buildConnectedServicesAccountChangeV1({ pluginId: 'happier.agent.claude', localId: 'claude-subscription' });
    expect(readProviderAccountUsageChangeScopeV1([...page(first), { ...binding, cursor: 3 },
      { kind: 'machine', entityId: 'machine-a', cursor: 4 }]))
      .toEqual({ recordIds: [first], bindingServiceKeys: ['happier.agent.claude/claude-subscription'] });
    expect(readProviderAccountUsageChangeScopeV1([...page(first), { ...binding, kind: 'kv', cursor: 3 }]))
      .toEqual({ recordIds: [first], bindingServiceKeys: [] });
    expect(readProviderAccountUsageChangeScopeV1([{ ...binding, cursor: 1 },
      { kind: 'machine', entityId: 'machine-a', cursor: 2 }]))
      .toEqual({ recordIds: [], bindingServiceKeys: ['happier.agent.claude/claude-subscription'] });
    expect(readProviderAccountUsageChangeScopeV1([...page(first), { ...binding, cursor: 3,
      hint: { connectedServices: true } }])).toBeUndefined();
    expect(readProviderAccountUsageChangeScopeV1([page(first)[0]!, { ...binding, cursor: 3 }])).toBeUndefined();
  });

  it('retains named Account-owned quota records across Team rows, but not Connected Account authority changes', () => {
    const changes = [...page(first), { kind: 'account', entityId: TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1, cursor: 3 },
      { kind: 'account', entityId: TEAM_CREDENTIAL_MATERIAL_ACCOUNT_CHANGE_ENTITY_ID_V1, cursor: 4 }, ...page(second, 5)];
    expect(readProviderAccountUsageChangeScopeV1(changes)).toEqual({ recordIds: [first, second], bindingServiceKeys: [] });
    expect(readProviderAccountUsageChangeScopeV1([...page(first), { kind: 'account', entityId: 'connected-services', cursor: 3 }])).toBeUndefined();
  });
});
