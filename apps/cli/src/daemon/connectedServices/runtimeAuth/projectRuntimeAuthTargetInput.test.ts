import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { projectConnectedServiceRuntimeAuthTargetInput } from './projectRuntimeAuthTargetInput';

describe('projectConnectedServiceRuntimeAuthTargetInput', () => {
  it('keeps host custody private and projects only exact named runtime operations', async () => {
    const credential = buildConnectedServiceCredentialRecord({
      now: 1,
      serviceId: 'claude-subscription',
      profileId: 'team',
      kind: 'oauth',
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'team-account',
        providerEmail: 'team@example.com',
      },
    });
    const nativeHome = {
      root: '/host-owned/claude-home',
      readFiles: vi.fn(async () => ({})),
      replaceFiles: vi.fn(async () => undefined),
    };
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({ ok: true }));
    const providerRequest = vi.fn(async () => ({ account: 'team-account' }));
    const request = projectConnectedServiceRuntimeAuthTargetInput({
      agentId: 'claude',
      materializedSelection: {
        serviceId: 'happier.agent.claude/claude-subscription',
        profileId: 'team',
        credential,
        record: credential,
        exec: { run: vi.fn() },
        nativeHome,
        applyConnectedServiceAuthGeneration,
        client: { request: providerRequest },
        invalidateTransports: vi.fn(),
        backendMode: 'appServer',
        forcedWorkspaceId: 'team-account',
        forcedLoginMethod: 'chatgptAuthTokens',
        openaiCodexProfileId: 'team',
      },
      fallbackSelection: {},
    });

    expect(request).toMatchObject({
      target: { agentId: 'claude' },
      credential,
      nativeHome: {
        readFiles: expect.any(Function),
        replaceFiles: expect.any(Function),
      },
      applySelectedAuthGeneration: expect.any(Function),
      readProviderAccount: expect.any(Function),
      readProviderUsage: expect.any(Function),
      selection: {
        serviceId: 'happier.agent.claude/claude-subscription',
        profileId: 'team',
        sourceProviderAccountId: 'team-account',
        sourceAccountLabel: 'team@example.com',
      },
    });
    expect(request.selection).not.toHaveProperty('credential');
    expect(request.selection).not.toHaveProperty('record');
    expect(request.selection).not.toHaveProperty('exec');
    expect(request.selection).not.toHaveProperty('nativeHome');
    expect(request.selection).not.toHaveProperty('invalidateTransports');
    expect(request.selection).not.toHaveProperty('backendMode');
    expect(request.selection).not.toHaveProperty('forcedWorkspaceId');
    expect(request.selection).not.toHaveProperty('forcedLoginMethod');
    expect(request.selection).not.toHaveProperty('openaiCodexProfileId');
    await expect(request.applySelectedAuthGeneration?.()).resolves.toEqual({ ok: true });
    await expect(request.readProviderAccount?.()).resolves.toEqual({ account: 'team-account' });
    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'happier.agent.claude/claude-subscription',
      authGeneration: expect.objectContaining({ credential }),
    }));
    expect(providerRequest).toHaveBeenCalledWith('account/read');
  });
});
