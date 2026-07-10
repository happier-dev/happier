import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/plugin-sdk/experimental/cloud/auth';

import { OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION } from './runtime.js';

type RuntimeControlReachabilityCall = Readonly<Record<string, unknown>>;

function readRuntimeConnectedServices() {
  return OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION.runtimeControl?.connectedServices;
}

function readConnectedServices() {
  return OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION.connectedServices;
}

describe('OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION connected-service runtime-control hooks', () => {
  it('exports a provider-owned model preflight contribution for source-real dynamic probing', () => {
    expect(OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION.preflightSessionControls).toEqual({
      failureCacheStrategy: 'cooldown',
      probeModelsRaw: expect.any(Function),
      cliModelsCommandArgs: ['--list-models'],
    });
  });

  it('exports provider-owned auth materialization and state sharing through connectedServices', async () => {
    const connectedServices = readConnectedServices();
    const now = 1_700_000_000_000;
    const openaiCodex = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'codex-work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'codex-access-token',
        refreshToken: 'codex-refresh-token',
        idToken: 'codex-id-token',
        providerAccountId: 'codex-account',
        providerEmail: 'codex@example.com',
        scope: 'openid profile',
        tokenType: 'Bearer',
      },
    });
    const openai = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai',
      profileId: 'openai-api',
      kind: 'token',
      token: {
        token: 'openai-api-key',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const claudeSubscription = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-work',
      kind: 'token',
      token: {
        token: 'claude-setup-token',
        providerAccountId: null,
        providerEmail: 'claude@example.com',
      },
    });
    const anthropic = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'anthropic',
      profileId: 'anthropic-api',
      kind: 'token',
      token: {
        token: 'anthropic-api-key',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const gemini = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'gemini',
      profileId: 'gemini-api',
      kind: 'token',
      token: {
        token: 'gemini-api-key',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    expect(connectedServices?.serviceIds).toEqual([
      'openai-codex',
      'openai',
      'claude-subscription',
      'anthropic',
      'gemini',
    ]);
    expect(connectedServices?.materializedRootSubdir).toBe('ohmypi-auth');
    expect(connectedServices?.readConnectedServiceId('openai')).toBe('openai');
    expect(connectedServices?.readConnectedServiceId({ serviceId: 'gemini' })).toBe('gemini');
    expect(connectedServices?.readConnectedServiceId({ serviceId: 'unsupported' })).toBeNull();
    expect(connectedServices?.createAuthMaterializationInput('anthropic', anthropic)).toEqual({
      anthropic,
    });
    expect(connectedServices?.stateSharingDescriptor).toMatchObject({
      providerId: 'ohMyPi',
      providerSupportStatus: 'unsupported',
      authIsolation: {
        mode: 'process_env',
        secretEntries: [
          'OPENAI_CODEX_OAUTH_TOKEN',
          'OPENAI_API_KEY',
          'ANTHROPIC_OAUTH_TOKEN',
          'ANTHROPIC_API_KEY',
          'GEMINI_API_KEY',
        ],
      },
    });

    await expect(connectedServices?.materializeAuthEnvironment({
      openaiCodex,
      openai,
      claudeSubscription,
      anthropic,
      gemini,
    })).resolves.toEqual({
      env: {
        OPENAI_CODEX_OAUTH_TOKEN: 'codex-access-token',
        OPENAI_API_KEY: 'openai-api-key',
        ANTHROPIC_OAUTH_TOKEN: 'claude-setup-token',
        ANTHROPIC_API_KEY: 'anthropic-api-key',
        GEMINI_API_KEY: 'gemini-api-key',
      },
    });
  });

  it('exports restart/rematerialize runtime auth semantics for connected-service switches', async () => {
    const connectedServices = readConnectedServices();
    const adapter = connectedServices?.runtimeAuthAdapter;

    expect(adapter?.classifyRuntimeAuthFailure({
      target: { agentId: 'ohMyPi' },
      error: new Error('rate limit reached'),
      selection: {
        openaiProfileId: 'openai-work',
        geminiProfileId: 'gemini-work',
      },
    })).toBeNull();
    await expect(adapter?.materializeActiveProfile({
      target: { agentId: 'ohMyPi' },
      selection: {
        openaiProfileId: 'openai-work',
        geminiProfileId: 'gemini-work',
      },
    })).resolves.toEqual({
      supported: true,
      activeProfiles: {
        openai: 'openai-work',
        gemini: 'gemini-work',
      },
    });
    expect(adapter?.canHotApply({
      target: { agentId: 'ohMyPi' },
      selection: null,
    })).toEqual({ supported: false, recovery: 'restart_rematerialize' });
    await expect(adapter?.recoverAfterRuntimeAuthSwitch({
      target: { agentId: 'ohMyPi' },
      selection: null,
    })).resolves.toEqual({ recovered: false, recovery: 'restart_rematerialize' });
    await expect(adapter?.verifyActiveAccount?.({
      target: { agentId: 'ohMyPi' },
      selection: null,
    })).resolves.toEqual({
      status: 'verified',
      reason: 'provider_restart_rematerialization_authoritative',
    });
  });

  it('rejects Gemini OAuth connected-service records instead of materializing them as API keys', async () => {
    const connectedServices = readConnectedServices();
    const now = 1_700_000_000_000;
    const geminiOauth = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'gemini',
      profileId: 'gemini-oauth',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'gemini-oauth-access-token',
        refreshToken: 'gemini-oauth-refresh-token',
        idToken: null,
        providerAccountId: null,
        providerEmail: null,
        scope: 'email',
        tokenType: 'Bearer',
      },
    });

    await expect(connectedServices?.materializeAuthEnvironment({
      gemini: geminiOauth,
    })).rejects.toThrow(/Gemini OAuth credentials are not supported/i);
  });

  it('keeps Claude subscription OAuth unsupported until the OhMyPi runtime supports refreshable auth', async () => {
    const connectedServices = readConnectedServices();
    const now = 1_700_000_000_000;
    const claudeOauth = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-oauth',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'claude-oauth-access-token',
        refreshToken: 'claude-oauth-refresh-token',
        idToken: null,
        providerAccountId: 'claude-account',
        providerEmail: 'claude@example.com',
        scope: 'user:profile user:inference user:sessions:claude_code',
        tokenType: 'Bearer',
      },
    });

    await expect(connectedServices?.materializeAuthEnvironment({
      claudeSubscription: claudeOauth,
    })).rejects.toThrow(/Claude subscription OAuth credentials are not supported/i);
  });

  it('exports provider-owned resume reachability through the public runtime-control contribution', async () => {
    const connectedServices = readRuntimeConnectedServices();
    const root = await mkdtemp(join(tmpdir(), 'happier-ohmypi-contribution-reachable-'));

    try {
      const agentDir = join(root, 'omp-agent-dir');
      const sessionFile = join(
        agentDir,
        'sessions',
        '--tmp-project--',
        '2026-05-28T00-00-00-000Z_omp-session-1.jsonl',
      );
      await mkdir(join(agentDir, 'sessions', '--tmp-project--'), { recursive: true });
      await writeFile(sessionFile, '{}\n');

      await expect(connectedServices?.verifyResumeReachable?.({
        targetMaterializedRoot: root,
        targetMaterializedEnv: { PI_CODING_AGENT_DIR: agentDir },
        vendorResumeId: 'omp-session-1',
        cwd: '/tmp/project',
      })).resolves.toEqual({ ok: true, resolvedPath: await realpath(sessionFile) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exports restart/rematerialize continuity and same-home reachability checks', async () => {
    const connectedServices = readRuntimeConnectedServices();
    const previousBinding = {
      source: 'connected' as const,
      selection: 'profile' as const,
      serviceId: 'anthropic',
      profileId: 'primary',
      groupId: null,
    };
    const nextBinding = {
      ...previousBinding,
      profileId: 'backup',
    };

    await expect(connectedServices?.resolveSwitchContinuity?.({
      runtimeControl: { reachability: { verifyMaterializedState: vi.fn() } } as never,
      params: {
        sessionId: 'sess_omp_1',
        agentId: 'ohMyPi',
        serviceId: 'anthropic',
        previousBinding,
        nextBinding,
        fromBindings: { v: 1, bindingsByServiceId: {} },
        toBindings: { v: 1, bindingsByServiceId: {} },
      },
    })).resolves.toEqual({
      mode: 'restart_same_home',
      reason: 'ohmypi_restart_rematerialize_required',
    });

    const verifyMaterializedState = vi.fn(async (_input: RuntimeControlReachabilityCall) => ({
      ok: true,
      value: { ok: true },
    }));
    await expect(connectedServices?.resolveSwitchContinuity?.({
      runtimeControl: { reachability: { verifyMaterializedState } } as never,
      params: {
        sessionId: 'sess_omp_2',
        agentId: 'ohMyPi',
        serviceId: 'anthropic',
        previousBinding,
        nextBinding: previousBinding,
        fromBindings: { v: 1, bindingsByServiceId: {} },
        toBindings: { v: 1, bindingsByServiceId: {} },
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'mat_omp_1',
          createdAt: 1,
        },
        vendorResumeId: 'omp-session-1',
        targetMaterializedRoot: '/tmp/materialized',
        targetMaterializedEnv: { PI_CODING_AGENT_DIR: '/tmp/materialized/omp-agent-dir' },
        cwd: '/tmp/project',
        candidatePersistedSessionFile: '/tmp/omp-session.jsonl',
      },
    })).resolves.toEqual({ mode: 'restart_same_home' });
    expect(verifyMaterializedState).toHaveBeenCalledWith({
      agentId: 'ohMyPi',
      serviceId: 'anthropic',
      targetMaterializedRoot: '/tmp/materialized',
      targetMaterializedEnv: { PI_CODING_AGENT_DIR: '/tmp/materialized/omp-agent-dir' },
      requestedStateMode: 'isolated',
      effectiveStateMode: 'isolated',
      materializationIdentity: {
        v: 1,
        id: 'mat_omp_1',
        createdAt: 1,
      },
      vendorResumeId: 'omp-session-1',
      cwd: '/tmp/project',
      candidatePersistedSessionFile: '/tmp/omp-session.jsonl',
    });
  });
});

describe('OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION external-session host adapters', () => {
  it('contributes a transcript store adapter from the plugin surface', async () => {
    const createTranscriptStoreAdapter =
      OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION.externalSessions?.createTranscriptStoreAdapter;

    expect(createTranscriptStoreAdapter).toBeTypeOf('function');
  });
});
