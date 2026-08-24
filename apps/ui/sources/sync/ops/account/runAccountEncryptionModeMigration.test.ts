import { describe, expect, it, vi } from 'vitest';

import { runAccountEncryptionModeMigration } from './runAccountEncryptionModeMigration';

const address = { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000301' } as const;
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
  expectedSettingsVersion: 1,
  settingsContent: { t: 'plain' as const, v: {} },
  connectedServices: { action: 'assert_empty' as const },
  automations: { action: 'assert_empty' as const },
  sessionDrafts: {
    items: [{ address, expectedRevision: 5, content: { t: 'plain' as const, v: { v: 1 as const, address, document } } }],
  },
};
const migratedRecord = {
  address,
  revision: 6,
  content: request.sessionDrafts.items[0].content,
  createdAt: 1,
  updatedAt: 2,
};

describe('runAccountEncryptionModeMigration', () => {
  it('does not mutate the local cipher or repository before atomic server success', async () => {
    let resolve!: (value: any) => void;
    const serverResult = new Promise<any>((done) => { resolve = done; });
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

    resolve({
      success: true,
      mode: 'plain',
      settingsVersion: 2,
      sessionDrafts: { records: [migratedRecord] },
    });
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
      migrate: async () => ({ success: true, mode: 'plain', settingsVersion: 2 }),
      activateTargetMode,
      acknowledgeSessionDrafts,
    })).rejects.toThrow('draft migration response');

    expect(activateTargetMode).not.toHaveBeenCalled();
    expect(acknowledgeSessionDrafts).not.toHaveBeenCalled();
  });

  it('keeps the released zero-draft success path optional', async () => {
    const activateTargetMode = vi.fn();
    const acknowledgeSessionDrafts = vi.fn();
    const zeroDraftRequest = { ...request, sessionDrafts: undefined };

    await expect(runAccountEncryptionModeMigration({
      request: zeroDraftRequest,
      migrate: async () => ({ success: true, mode: 'plain', settingsVersion: 2 }),
      activateTargetMode,
      acknowledgeSessionDrafts,
    })).resolves.toMatchObject({ mode: 'plain' });

    expect(activateTargetMode).toHaveBeenCalledOnce();
    expect(acknowledgeSessionDrafts).not.toHaveBeenCalled();
  });
});
