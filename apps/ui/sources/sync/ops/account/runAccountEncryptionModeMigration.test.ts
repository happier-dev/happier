import { describe, expect, it, vi } from 'vitest';
import type {
  AccountEncryptionMigrateRequest,
  AccountEncryptionMigrateSuccessResponse,
} from '@happier-dev/protocol';

import { runAccountEncryptionModeMigration } from './runAccountEncryptionModeMigration';

const address = {
  kind: 'newSession' as const,
  draftId: '00000000-0000-4000-8000-000000000301',
};
const document = {
  v: 1 as const,
  composer: {
    text: { mutationId: '00000000-0000-4000-8000-000000000302', value: 'draft' },
    mentions: { mutationId: '00000000-0000-4000-8000-000000000303', value: [] },
    attachments: { mutationId: '00000000-0000-4000-8000-000000000304', value: [] },
  },
  target: { kind: 'newSession' as const, authoring: {} },
  extensions: {},
};
const request = {
  toMode: 'plain' as const,
  expectedAccountVersion: 1,
  expectedSigningKeyFingerprint: 'signing-key',
  expectedContentKeyFingerprint: 'content-key',
  expectedSettingsVersion: 1,
  settingsContent: { t: 'plain' as const, v: {} },
  connectedServices: { action: 'assert_empty' as const },
  automations: { action: 'assert_empty' as const },
  machines: { action: 'assert_empty' as const },
  todos: { action: 'assert_empty' as const },
  artifacts: { action: 'assert_empty' as const },
  sessions: { action: 'assert_empty' as const },
  reviewComments: { action: 'assert_empty' as const },
  sessionOrganization: { action: 'assert_empty' as const },
  pets: { action: 'assert_empty' as const },
  sessionDrafts: {
    items: [{
      address,
      expectedRevision: 5,
      content: { t: 'plain' as const, v: { v: 1 as const, address, document } },
    }],
  },
} satisfies AccountEncryptionMigrateRequest;
const migratedRecord = {
  address,
  revision: 6,
  content: request.sessionDrafts.items[0].content,
  createdAt: 1,
  updatedAt: 2,
};

function success(
  overrides: Partial<AccountEncryptionMigrateSuccessResponse> = {},
): AccountEncryptionMigrateSuccessResponse {
  return {
    success: true,
    mode: 'plain',
    accountVersion: 2,
    settingsVersion: 2,
    ...overrides,
  };
}

describe('runAccountEncryptionModeMigration', () => {
  it('does not mutate the local cipher or repository before atomic server success', async () => {
    let resolve!: (value: AccountEncryptionMigrateSuccessResponse) => void;
    const serverResult = new Promise<AccountEncryptionMigrateSuccessResponse>((done) => { resolve = done; });
    const activateTargetMode = vi.fn();
    const acknowledgeSessionDrafts = vi.fn();

    const pending = runAccountEncryptionModeMigration({
      request,
      migrate: async () => await serverResult,
      activateTargetMode,
      acknowledgeSessionDrafts,
    });
    await Promise.resolve();

    expect(activateTargetMode).not.toHaveBeenCalled();
    expect(acknowledgeSessionDrafts).not.toHaveBeenCalled();

    resolve(success({ sessionDrafts: { records: [migratedRecord] } }));
    await pending;

    expect(activateTargetMode).toHaveBeenCalledOnce();
    expect(acknowledgeSessionDrafts).toHaveBeenCalledWith([migratedRecord]);
    expect(activateTargetMode.mock.invocationCallOrder[0]).toBeLessThan(
      acknowledgeSessionDrafts.mock.invocationCallOrder[0],
    );
  });

  it('rejects missing or stale success coverage before changing local state', async () => {
    const activateTargetMode = vi.fn();
    const acknowledgeSessionDrafts = vi.fn();

    await expect(runAccountEncryptionModeMigration({
      request,
      migrate: async () => success(),
      activateTargetMode,
      acknowledgeSessionDrafts,
    })).rejects.toThrow('draft migration response');

    expect(activateTargetMode).not.toHaveBeenCalled();
    expect(acknowledgeSessionDrafts).not.toHaveBeenCalled();
  });

  it('accepts semantically equal envelopes independent of object key insertion order', async () => {
    const reordered = {
      ...migratedRecord,
      content: {
        t: 'plain' as const,
        v: { document, address, v: 1 as const },
      },
    };
    await expect(runAccountEncryptionModeMigration({
      request,
      migrate: async () => success({ sessionDrafts: { records: [reordered] } }),
      activateTargetMode: vi.fn(),
      acknowledgeSessionDrafts: vi.fn(),
    })).resolves.toMatchObject({ mode: 'plain' });
  });

  it('keeps the released zero-draft success path optional', async () => {
    const activateTargetMode = vi.fn();
    const acknowledgeSessionDrafts = vi.fn();
    const { sessionDrafts: _sessionDrafts, ...zeroDraftRequest } = request;

    await expect(runAccountEncryptionModeMigration({
      request: zeroDraftRequest,
      migrate: async () => success(),
      activateTargetMode,
      acknowledgeSessionDrafts,
    })).resolves.toMatchObject({ mode: 'plain' });

    expect(activateTargetMode).toHaveBeenCalledOnce();
    expect(acknowledgeSessionDrafts).not.toHaveBeenCalled();
  });
});
