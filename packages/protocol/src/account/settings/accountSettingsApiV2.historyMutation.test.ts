import { describe, expect, it } from 'vitest';
import { AccountSettingsV2HistoryMutationRequestSchema } from './accountSettingsApiV2.js';

describe('Account Settings exact history mutation admission', () => {
  it('requires a captured content, settings version and mode/key currentness for normalization and exact purge', () => {
    const captured = { expectedSettingsVersion: 7,
      expectedProfileTransferRevision: 'absent',
      expectedEncryptionCurrentness: { mode: 'plain', signingKeyFingerprint: null, contentKeyFingerprint: null },
      expectedContent: { t: 'plain', v: { secrets: [] } },
      operation: { kind: 'normalize', removedRoots: ['secrets'], content: { t: 'plain', v: {} } },
    };
    expect(AccountSettingsV2HistoryMutationRequestSchema.safeParse(captured).success).toBe(true);
    expect(AccountSettingsV2HistoryMutationRequestSchema.safeParse({ ...captured, operation: { ...captured.operation,
      savedSecretTransfers: [{ savedSecretId: 'old-secret', resourceId: 'resource', expectedRevision: 1 }],
      transferredProfileIds: [],
    } }).success).toBe(true);
    expect(AccountSettingsV2HistoryMutationRequestSchema.safeParse({ ...captured, operation: { kind: 'purge' } }).success).toBe(true);
    expect(AccountSettingsV2HistoryMutationRequestSchema.safeParse({ ...captured, expectedContent: undefined,
      operation: { kind: 'purge' } }).success).toBe(true);
    for (const bad of [
      { ...captured, expectedContent: undefined },
      { ...captured, expectedSettingsVersion: undefined },
      { ...captured, expectedProfileTransferRevision: undefined },
      { ...captured, expectedEncryptionCurrentness: { mode: 'plain' } },
      { ...captured, operation: { kind: 'purge', all: true } },
    ]) expect(AccountSettingsV2HistoryMutationRequestSchema.safeParse(bad).success).toBe(false);
  });
});
