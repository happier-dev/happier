import { describe, expect, it } from 'vitest';
import { buildProviderAccountUsageMaterialChangesV1, readProviderAccountUsageChangedRecordIdsV1,
  readProviderAccountUsageChangeRecordIdV1 } from './providerAccountUsage.js';

describe('Provider usage change scope', () => {
  const first = 'paug_v1_abcdefgh';
  const second = 'paug_v1_ijklmnop';
  const page = (id: string, cursor = 1) => buildProviderAccountUsageMaterialChangesV1(id)
    .map((change, index) => ({ ...change, cursor: cursor + index }));

  it('keeps the predecessor key and scopes a coalesced page to every changed record', () => {
    expect(page(first)[0]?.entityId).toBe('provider-account-usage');
    expect(readProviderAccountUsageChangedRecordIdsV1([page(first)[1]!, ...page(second, 3)]))
      .toEqual([first, second]);
    expect(readProviderAccountUsageChangeRecordIdV1(page(first)[1]!.entityId)).toBe(first);
  });

  it('keeps legacy, incomplete, malformed and mixed unknown scopes full', () => {
    expect(readProviderAccountUsageChangedRecordIdsV1([{ kind: 'account', entityId: 'provider-account-usage', cursor: 3 }, page(first)[1]!])).toBeUndefined();
    expect(readProviderAccountUsageChangedRecordIdsV1([page(first)[0]!])).toBeUndefined();
    expect(readProviderAccountUsageChangedRecordIdsV1([...page(first), { kind: 'account', entityId: 'self', cursor: 3 }])).toBeUndefined();
    expect(readProviderAccountUsageChangedRecordIdsV1([{ kind: 'account', entityId: 'provider-account-usage-record:invalid', cursor: 1 }])).toBeUndefined();
    expect(readProviderAccountUsageChangedRecordIdsV1([{ ...page(first)[0]!, cursor: 5 }, page(first)[1]!])).toBeUndefined();
    expect(readProviderAccountUsageChangedRecordIdsV1([page(first)[1]!])).toEqual([first]);
  });
});
