import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { Credentials } from '@/persistence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';

import { withCodexAppServerControlClient } from '../appServer/control/withCodexAppServerControlClient';
import { materializeCodexConnectedServiceRuntimeAuthSelection } from './materializeCodexConnectedServiceRuntimeAuthSelection';

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext: vi.fn(),
}));

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc: vi.fn(),
}));

vi.mock('../appServer/control/withCodexAppServerControlClient', () => ({
  withCodexAppServerControlClient: vi.fn(),
}));

describe('materializeCodexConnectedServiceRuntimeAuthSelection', () => {
  beforeEach(() => {
    vi.mocked(resolveSessionTransportContext).mockReset();
    vi.mocked(callSessionRpc).mockReset();
    vi.mocked(withCodexAppServerControlClient).mockReset();
  });

  it('materializes direct live runtime apply through session RPC without probing a control app-server', async () => {
    vi.mocked(resolveSessionTransportContext).mockResolvedValue({
      ok: true,
      sessionId: 'sess_1',
      ctx: { transport: 'test' },
      mode: 'daemon',
    } as unknown as Awaited<ReturnType<typeof resolveSessionTransportContext>>);
    vi.mocked(callSessionRpc).mockResolvedValue({
      ok: true,
      appliedVia: 'direct_live_hot_auth',
      verification: { activeAccountId: 'acct_target' },
    });

    const credential = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'target',
      kind: 'oauth',
      expiresAt: 2_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct_target',
        providerEmail: 'target@example.test',
      },
    });
    const baseSelection = {
      serviceId: 'openai-codex',
      binding: { source: 'connected', selection: 'group', groupId: 'main', profileId: 'target' },
      profileId: 'target',
      groupId: 'main',
      activeProfileId: 'target',
      fallbackProfileId: 'old',
      generation: 8,
      credentialRevision: null,
      record: credential,
    } as const;

    const materialized = await materializeCodexConnectedServiceRuntimeAuthSelection({
      credentials: { token: 'machine-token' } as Credentials,
      api: {} as never,
      input: {
        mode: 'apply',
        tracked: {
          startedBy: 'daemon',
          happySessionId: 'sess_1',
          pid: 123,
          spawnOptions: {
            directory: '/tmp/project',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          },
        },
        sessionId: 'sess_1',
        agentId: 'codex',
        serviceId: 'openai-codex',
        previous: null,
        next: { source: 'connected', selection: 'group', serviceId: 'openai-codex', profileId: 'target', groupId: 'main' },
        previousBindings: { v: 1, bindingsByServiceId: {} },
        normalizedBindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'group', groupId: 'main', profileId: 'target' },
          },
        },
        groupMetadata: {
          groupId: 'main',
          activeProfileId: 'target',
          fallbackProfileId: 'old',
          generation: 8,
        },
        applyReason: 'same_provider_account_exhausted',
        requireDirectLiveHotApply: true,
      },
      baseSelection,
    });

    expect(withCodexAppServerControlClient).not.toHaveBeenCalled();
    expect(materialized).toMatchObject({
      serviceId: 'openai-codex',
      applyReason: 'same_provider_account_exhausted',
      requireDirectLiveHotApply: true,
    });

    const apply = (materialized as Readonly<{
      applyConnectedServiceAuthGeneration?: (request: unknown) => Promise<unknown>;
    }>).applyConnectedServiceAuthGeneration;
    await expect(apply?.({ serviceId: 'openai-codex', reason: 'same_provider_account_exhausted' }))
      .resolves
      .toEqual({
        ok: true,
        appliedVia: 'direct_live_hot_auth',
        verification: { activeAccountId: 'acct_target' },
      });
    expect(callSessionRpc).toHaveBeenCalledWith({
      token: 'machine-token',
      sessionId: 'sess_1',
      ctx: { transport: 'test' },
      mode: 'daemon',
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION}`,
      request: { serviceId: 'openai-codex', reason: 'same_provider_account_exhausted' },
    });
  });
});
