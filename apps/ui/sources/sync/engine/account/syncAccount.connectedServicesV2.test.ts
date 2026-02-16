import { describe, expect, it, vi } from 'vitest';

import { profileDefaults } from '@/sync/domains/profiles/profile';

vi.mock('expo-constants', () => ({
  default: {},
}));

vi.mock('expo-notifications', () => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(),
}));

describe('handleUpdateAccountSocketUpdate connectedServicesV2', () => {
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

