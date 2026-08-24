import { describe, expect, it, vi } from 'vitest';

import { AccountProfileSchema } from '@happier-dev/protocol';
import { profileDefaults, type Profile } from '@/sync/domains/profiles/profile';

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

function createConnectedAccountV4(): Profile['connectedAccountsV4'][number] {
  return {
    ref: {
      service: {
        pluginId: 'third-party.connected-accounts',
        localId: 'service/with/path',
      },
      accountId: 'account/with/path',
    },
    status: 'connected',
    authenticationModeId: 'manual',
    revisionSemantics: 'revisioned',
    credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz',
    configurationReady: false,
    configurationRevision: null,
    displayName: 'Connected account',
    scopes: [],
  };
}

function createConnectedAccountGroupV4(): Profile['connectedAccountGroupsV4'][number] {
  return {
    v: 1,
    ref: {
      service: {
        pluginId: 'third-party.connected-accounts',
        localId: 'service/with/path',
      },
      groupId: 'fallback',
    },
    incarnation: 'qualified-group-row-fallback',
    displayName: null,
    policy: {
      v: 1,
      strategy: 'least_limited',
      autoSwitch: false,
      switchOn: {
        usageLimit: true,
        authExpired: true,
        accountChanged: true,
        refreshFailure: false,
      },
      cooldownMs: 30_000,
      honorProviderResetsAt: true,
      autoRestorePrimaryWhenReset: false,
      maxSwitchesPerTurn: 1,
      maxSwitchesPerSessionHour: 3,
      softSwitchRemainingPercent: 15,
      probeIfSnapshotOlderThanMs: 300_000,
      preTurnProbeMode: 'when_stale',
      preTurnProbeOrder: 'current_first_then_candidates',
      recoveryMode: 'switch_or_wait',
      resumePromptMode: 'standard',
    },
    activeConnectedAccountId: 'account/with/path',
    generation: 0,
    runtimeStateRevision: 0,
    state: {},
    createdAt: 1,
    updatedAt: 1,
    members: [],
  };
}

describe('handleUpdateAccountSocketUpdate Connected Services profile fields', () => {
  it('applies every current Connected Services projection from account socket updates', async () => {
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
    const connectedServiceCredentialRevisionsV1 = [
      {
        serviceId: 'openai-codex',
        profileId: 'work',
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      },
    ];
    const connectedAccountsV4: Profile['connectedAccountsV4'] = [createConnectedAccountV4()];
    const connectedAccountGroupsV4: Profile['connectedAccountGroupsV4'] = [createConnectedAccountGroupV4()];
    const expectedProjection = AccountProfileSchema.parse({
      ...profileDefaults,
      connectedAccountsV4,
      connectedAccountGroupsV4,
    });

    await handleUpdateAccountSocketUpdate({
      accountUpdate: {
        connectedServicesV2,
        connectedServiceCredentialRevisionsV1,
        connectedAccountsV4,
        connectedAccountGroupsV4,
      },
      updateCreatedAt: 123,
      currentProfile: { ...profileDefaults },
      encryption,
      applyProfile,
      applySettings,
      log: { log: vi.fn() },
    });

    expect(applyProfile).toHaveBeenCalledWith(expect.objectContaining({
      connectedServicesV2,
      connectedServiceCredentialRevisionsV1,
      connectedAccountsV4: expectedProjection.connectedAccountsV4,
      connectedAccountGroupsV4: expectedProjection.connectedAccountGroupsV4,
    }));
  });

  it('keeps the last valid V4 projection when a socket update omits revision semantics', async () => {
    const { handleUpdateAccountSocketUpdate } = await import('./syncAccount');

    const applyProfile = vi.fn();
    const applySettings = vi.fn();
    const log = { log: vi.fn() };
    const encryption = {
      getContentPrivateKey: () => new Uint8Array(32).fill(7),
      decryptRaw: vi.fn(),
    } as any;
    const connectedAccountsV4: Profile['connectedAccountsV4'] = [createConnectedAccountV4()];
    const { revisionSemantics: _revisionSemantics, ...malformedConnectedAccount } = createConnectedAccountV4();

    await handleUpdateAccountSocketUpdate({
      accountUpdate: {
        username: 'updated username',
        connectedAccountsV4: [malformedConnectedAccount],
      },
      updateCreatedAt: 123,
      currentProfile: { ...profileDefaults, connectedAccountsV4 },
      encryption,
      applyProfile,
      applySettings,
      log,
    });

    expect(applyProfile).toHaveBeenCalledWith(expect.objectContaining({
      username: 'updated username',
      connectedAccountsV4,
    }));
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('Connected Accounts V4'));
  });

  it('accepts an explicit empty V4 account projection', async () => {
    const { handleUpdateAccountSocketUpdate } = await import('./syncAccount');

    const applyProfile = vi.fn();
    const applySettings = vi.fn();
    const log = { log: vi.fn() };
    const encryption = {
      getContentPrivateKey: () => new Uint8Array(32).fill(7),
      decryptRaw: vi.fn(),
    } as any;

    await handleUpdateAccountSocketUpdate({
      accountUpdate: { connectedAccountsV4: [] },
      updateCreatedAt: 123,
      currentProfile: { ...profileDefaults, connectedAccountsV4: [createConnectedAccountV4()] },
      encryption,
      applyProfile,
      applySettings,
      log,
    });

    expect(applyProfile).toHaveBeenCalledWith(expect.objectContaining({ connectedAccountsV4: [] }));
    expect(log.log).not.toHaveBeenCalled();
  });
});
