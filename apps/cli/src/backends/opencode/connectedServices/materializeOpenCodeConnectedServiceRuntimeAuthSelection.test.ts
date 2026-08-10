import { describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { OPEN_CODE_BROKER_SELECTION_IDENTITY_ENV } from '@/backends/opencode/brokerPlugin';
import { materializeOpenCodeConnectedServiceRuntimeAuthSelection } from './materializeOpenCodeConnectedServiceRuntimeAuthSelection';

const {
  resolveConnectedServiceCredentialsMock,
  materializeOpenCodeConnectedServiceAuthMock,
  resolveSharedManagedOpenCodeServerStatePathForEnvMock,
  readSharedManagedOpenCodeServerStateByLaunchFingerprintBestEffortMock,
} = vi.hoisted(() => ({
  resolveConnectedServiceCredentialsMock: vi.fn(),
  materializeOpenCodeConnectedServiceAuthMock: vi.fn(),
  resolveSharedManagedOpenCodeServerStatePathForEnvMock: vi.fn(),
  readSharedManagedOpenCodeServerStateByLaunchFingerprintBestEffortMock: vi.fn(),
}));

vi.mock('@/cloud/connectedServices/resolveConnectedServiceCredentials', () => ({
  resolveConnectedServiceCredentials: resolveConnectedServiceCredentialsMock,
}));

vi.mock('./materializeOpenCodeConnectedServiceAuth', () => ({
  materializeOpenCodeConnectedServiceAuth: materializeOpenCodeConnectedServiceAuthMock,
}));

vi.mock('@/backends/opencode/server/sharedManagedServer', () => ({
  resolveSharedManagedOpenCodeServerStatePathForEnv: resolveSharedManagedOpenCodeServerStatePathForEnvMock,
  readSharedManagedOpenCodeServerStateByLaunchFingerprintBestEffort: readSharedManagedOpenCodeServerStateByLaunchFingerprintBestEffortMock,
}));

describe('materializeOpenCodeConnectedServiceRuntimeAuthSelection', () => {
  it('carries prior managed-server fingerprint context for auth-switch detach recovery', async () => {
    const previousRecord = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'prev-profile',
      kind: 'oauth',
      expiresAt: 9_999,
      oauth: {
        accessToken: 'old-access-token',
        refreshToken: 'old-refresh-token',
        tokenType: null,
        scope: null,
        idToken: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });
    resolveConnectedServiceCredentialsMock.mockResolvedValue(new Map([['openai-codex', previousRecord]]));
    materializeOpenCodeConnectedServiceAuthMock.mockResolvedValue({
      env: { OPENCODE_AUTH_CONTENT: '{\"openai\":{\"type\":\"oauth\"}}' },
    });
    resolveSharedManagedOpenCodeServerStatePathForEnvMock.mockReturnValue('/tmp/happier/opencode/managed-servers/prev-fingerprint.json');
    readSharedManagedOpenCodeServerStateByLaunchFingerprintBestEffortMock.mockResolvedValue({
      baseUrl: 'http://127.0.0.1:43111',
      pid: 123,
      startedAtMs: 1,
      ownerToken: 'owner-token-1',
    });

    const result = await materializeOpenCodeConnectedServiceRuntimeAuthSelection({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      },
      api: {} as any,
      input: {
        mode: 'apply',
        tracked: {
          startedBy: 'daemon',
          happySessionId: 'sess_1',
          pid: 999,
          spawnOptions: {
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
          },
        },
        sessionId: 'sess_1',
        agentId: 'opencode',
        serviceId: 'openai-codex',
        previous: {
          source: 'connected',
          selection: 'profile',
          serviceId: 'openai-codex',
          profileId: 'prev-profile',
          groupId: null,
        },
        next: {
          source: 'connected',
          selection: 'profile',
          serviceId: 'openai-codex',
          profileId: 'next-profile',
          groupId: null,
        },
        previousBindings: { v: 1, bindingsByServiceId: {} },
        normalizedBindings: { v: 1, bindingsByServiceId: {} },
      },
      baseSelection: {
        serviceId: 'openai-codex',
        binding: { source: 'connected', selection: 'profile', profileId: 'next-profile' },
        profileId: 'next-profile',
        credentialRevision: null,
        record: { profileId: 'next-profile' },
      },
      processEnv: {
        HOME: '/tmp/happier',
      },
    });

    expect(result).toMatchObject({
      previousLaunchFingerprint: 'prev-fingerprint',
      previousOwnerToken: 'owner-token-1',
    });
    expect(typeof (result as Record<string, unknown>).restartAndResume).toBe('function');
  });

  it('carries the frozen broker selection identity so hot apply can update daemon-side selection indirection', async () => {
    resolveConnectedServiceCredentialsMock.mockResolvedValue(new Map());

    const result = await materializeOpenCodeConnectedServiceRuntimeAuthSelection({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      },
      api: {} as any,
      input: {
        mode: 'apply',
        tracked: {
          startedBy: 'daemon',
          happySessionId: 'sess_1',
          pid: 999,
          spawnOptions: {
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
            environmentVariables: {
              [OPEN_CODE_BROKER_SELECTION_IDENTITY_ENV]: 'opencode|connected|broker:1|openai-codex:acct-old:',
            },
          },
        },
        sessionId: 'sess_1',
        agentId: 'opencode',
        serviceId: 'openai-codex',
        previous: null,
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: 'openai-codex',
          profileId: 'profile-new',
          groupId: 'main',
        },
        previousBindings: { v: 1, bindingsByServiceId: {} },
        normalizedBindings: { v: 1, bindingsByServiceId: {} },
      },
      baseSelection: {
        serviceId: 'openai-codex',
        binding: { source: 'connected', selection: 'group', groupId: 'main', profileId: 'profile-new' },
        profileId: 'profile-new',
        groupId: 'main',
        activeProfileId: 'profile-new',
        fallbackProfileId: 'profile-old',
        generation: 12,
        credentialRevision: null,
        record: { profileId: 'profile-new' },
      },
      processEnv: {
        HOME: '/tmp/happier',
      },
    });

    expect(result).toMatchObject({
      brokerSelectionIdentity: 'opencode|connected|broker:1|openai-codex:acct-old:',
      serviceId: 'openai-codex',
      activeProfileId: 'profile-new',
      generation: 12,
    });
  });
});
