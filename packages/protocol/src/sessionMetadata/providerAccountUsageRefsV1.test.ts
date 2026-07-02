import { describe, expect, it } from 'vitest';

import {
  SessionMetadataSchema,
  buildProviderAccountUsageRecordId,
  readProviderAccountUsageRecordIdsFromMetadata,
  writeProviderAccountUsageRecordIdToMetadata,
  type ProviderAccountUsageRecordKeyV1,
} from '../index.js';

function key(accountSubjectId: string): ProviderAccountUsageRecordKeyV1 {
  return {
    providerId: 'codex',
    accountSubjectId,
    subjectKind: 'account',
    quotaScope: 'account',
  };
}

describe('provider account usage refs session metadata', () => {
  it('writes sanitized canonical record ids into session metadata', () => {
    const firstRecordId = buildProviderAccountUsageRecordId(key('acct_1'));
    const secondRecordId = buildProviderAccountUsageRecordId(key('acct_2'));

    const metadata = writeProviderAccountUsageRecordIdToMetadata({}, {
      recordId: firstRecordId,
      updatedAtMs: 1_000,
    });
    const nextMetadata = writeProviderAccountUsageRecordIdToMetadata(metadata, {
      recordId: secondRecordId,
      updatedAtMs: 2_000,
    });

    expect(SessionMetadataSchema.safeParse(nextMetadata).success).toBe(true);
    expect(readProviderAccountUsageRecordIdsFromMetadata(nextMetadata)).toEqual([
      firstRecordId,
      secondRecordId,
    ]);
    expect(nextMetadata.providerAccountUsageRefsV1).toEqual({
      v: 1,
      recordIds: [firstRecordId, secondRecordId],
      updatedAtMs: 2_000,
    });
  });

  it('deduplicates existing refs and ignores malformed record ids', () => {
    const recordId = buildProviderAccountUsageRecordId(key('acct_1'));
    const metadata = {
      providerAccountUsageRefsV1: {
        v: 1,
        recordIds: [recordId, 'paug_v1_not-valid?', recordId],
        updatedAtMs: 500,
      },
    };

    const nextMetadata = writeProviderAccountUsageRecordIdToMetadata(metadata, {
      recordId,
      updatedAtMs: 1_000,
    });

    expect(readProviderAccountUsageRecordIdsFromMetadata(nextMetadata)).toEqual([recordId]);
  });

  it('keeps the newest bounded record-id window', () => {
    const recordIds = Array.from({ length: 36 }, (_, index) => (
      buildProviderAccountUsageRecordId(key(`acct_${index}`))
    ));
    const metadata = recordIds.reduce<Record<string, unknown>>((acc, recordId, index) => (
      writeProviderAccountUsageRecordIdToMetadata(acc, {
        recordId,
        updatedAtMs: 1_000 + index,
      })
    ), {});

    expect(readProviderAccountUsageRecordIdsFromMetadata(metadata)).toEqual(recordIds.slice(-32));
  });
});
