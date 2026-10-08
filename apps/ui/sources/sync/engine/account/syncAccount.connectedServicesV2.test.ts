import { afterEach, describe, expect, it, vi } from 'vitest';

import { profileDefaults } from '@/sync/domains/profiles/profile';

const serverFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/http/client', () => ({ serverFetch: (...args: unknown[]) => serverFetchMock(...args) }));

vi.mock('expo-constants', () => ({
  default: {},
}));

vi.mock('expo-notifications', () => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(),
}));

vi.mock('@/sync/encryption/secretSettings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/sync/encryption/secretSettings')>();
  return {
    ...actual,
    deriveSettingsSecretsKey: async () => new Uint8Array(32).fill(9),
    sealSecretsDeep: (value: unknown) => value,
  };
});

describe('handleUpdateAccountSocketUpdate connectedServicesV2', () => {
  afterEach(() => serverFetchMock.mockReset());

  it('refetches a negotiated AGY projection after a legacy-safe push without temporarily deleting the current profile', async () => {
    const { handleUpdateAccountSocketUpdate, fetchAndApplyProfile } = await import('./syncAccount');
    const currentProfile = { ...profileDefaults, id: 'account', connectedServicesV2: [{
      serviceId: 'antigravity' as const, profiles: [{ profileId: 'default', status: 'connected' as const, kind: 'oauth' as const, providerEmail: null, providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null }], groups: [],
    }] };
    const applyProfile = vi.fn();
    serverFetchMock.mockResolvedValue(Response.json({ ...currentProfile, firstName: 'Ada' }));
    const invalidateProfile = vi.fn(() => {
      void fetchAndApplyProfile({ credentials: { token: 'token', secret: 'secret' }, applyProfile });
    });
    await handleUpdateAccountSocketUpdate({
      accountUpdate: { connectedServicesV2: [], connectedServicesProfileChanged: true },
      updateCreatedAt: 123, currentProfile,
      encryption: {} as any, applyProfile, applySettings: vi.fn(), invalidateProfile,
      log: { log: vi.fn() },
    } as Parameters<typeof handleUpdateAccountSocketUpdate>[0]);
    expect(invalidateProfile).toHaveBeenCalledTimes(1);
    expect(applyProfile.mock.calls[0]?.[0].connectedServicesV2).toEqual(currentProfile.connectedServicesV2);
    await vi.waitFor(() => expect(applyProfile).toHaveBeenCalledWith(expect.objectContaining({ firstName: 'Ada', connectedServicesV2: [expect.objectContaining({ serviceId: 'antigravity' })] })));
    expect(serverFetchMock).toHaveBeenCalledWith('/v1/account/profile', expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json; happier-connected-service-antigravity=1' }) }), { includeAuth: false });
  });

  it('applies connectedServicesV2 from account socket updates', async () => {
    const { handleUpdateAccountSocketUpdate } = await import('./syncAccount');

    const applyProfile = vi.fn();
    const applySettings = vi.fn();
    const encryption = {
      getContentPrivateKey: () => new Uint8Array(32).fill(7),
      decryptRaw: vi.fn(),
    } as any;

    const connectedServicesV2 = [
      {
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth', providerEmail: 'user@example.com' }],
      },
    ];

    await handleUpdateAccountSocketUpdate({
      accountUpdate: { connectedServicesV2 },
      updateCreatedAt: 123,
      currentProfile: { ...profileDefaults },
      encryption,
      applyProfile,
      applySettings,
      log: { log: vi.fn() },
    });

    expect(applyProfile).toHaveBeenCalledWith(expect.objectContaining({ connectedServicesV2 }));
  });
});
