import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readCredentials: vi.fn(),
  readStoredCredentials: vi.fn(),
}));

vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readCredentials: mocks.readCredentials,
  readStoredCredentials: mocks.readStoredCredentials,
}));

describe('plain-account stored credential boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readCredentials.mockResolvedValue(null);
    mocks.readStoredCredentials.mockResolvedValue({
      token: 'token-only',
      encryption: null,
    });
  });

  it('updates plugin account settings with token-only credentials', async () => {
    const { resetActiveAccountSettingsSnapshotForTests } = await import(
      '@/settings/accountSettings/activeAccountSettingsSnapshot'
    );
    const { updateActivePluginAccountSettings } = await import(
      '@/plugins/runtime/context/accountSettingsStorage'
    );
    resetActiveAccountSettingsSnapshotForTests();

    await expect(updateActivePluginAccountSettings(
      {
        operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }],
      },
      {
        accountSettingsUpdateDeps: {
          fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 0 }),
          resolveAccountEncryptionMode: async () => 'plain',
          updateSettings: async () => ({ success: true, version: 1 }),
          writeCache: async () => {},
          resolveCachePath: () => '/tmp/plain-plugin-account-settings',
        },
      },
    )).resolves.toMatchObject({
      status: 'applied',
      settings: { reviewPromptLikedApp: true },
    });
    expect(mocks.readCredentials).not.toHaveBeenCalled();
  });

  it('uploads an account pet with bearer-only authentication', async () => {
    const { createAccountPetViaActiveServer } = await import(
      '@/pets/storage/createAccountPetClient'
    );

    const result = await createAccountPetViaActiveServer({
      manifest: {
        id: 'blink',
        displayName: 'Blink',
        description: 'Happier companion pet',
        spritesheetPath: 'spritesheet.png',
      },
      spritesheet: {
        mediaType: 'image/png',
        encoding: 'base64',
        data: 'iVBORw0KGgo=',
        sizeBytes: 8,
        digest: 'sha256:asset',
      },
      origin: { kind: 'manualImport' },
    }, {
      serverUrl: 'https://happier.example.test',
      fetcher: async (_url, init) => {
        expect(init.headers).toMatchObject({
          Authorization: 'Bearer token-only',
        });
        return new Response(JSON.stringify({
          ok: false,
          errorCode: 'custom_pet_sync_requires_plaintext',
          error: 'custom_pet_sync_requires_plaintext',
        }), { status: 400 });
      },
    });

    expect(result.errorCode).toBe('custom_pet_sync_requires_plaintext');
    expect(mocks.readCredentials).not.toHaveBeenCalled();
  });
});
