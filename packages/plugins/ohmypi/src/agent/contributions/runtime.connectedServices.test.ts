import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION } from './runtime.js';
import { OH_MY_PI_PREFLIGHT_SESSION_CONTROLS } from '../preflight/models.js';

function readConnectedServices() {
  return OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION.connectedServices;
}

describe('OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION connected-service runtime-control hooks', () => {
  it('owns switch continuity on the canonical connectedServices contribution only', () => {
    expect(OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION).not.toHaveProperty('runtimeControl');
    expect(readConnectedServices()).toMatchObject({
      shouldRestartForServiceSwitch: expect.any(Function),
      restartRematerializeRequiredReason: 'ohmypi_restart_rematerialize_required',
      sameAuthGroupRequiresResumeReachability: true,
      verifyResumeReachable: expect.any(Function),
    });
  });

  it('keeps public model preflight declaration separate from connected-service ownership', () => {
    expect(OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION).not.toHaveProperty('preflightSessionControls');
    expect(OH_MY_PI_PREFLIGHT_SESSION_CONTROLS.models?.command).toEqual({
      toolId: 'ohmypi-cli',
      args: ['--list-models'],
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
      connectedAccountMaterializationAuthority: 'legacy_unfenced_one_shot',
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

  it('does not translate raw credential records for qualified materialization authority', async () => {
    const connectedServices = readConnectedServices();
    const openai = buildConnectedServiceCredentialRecord({
      now: 1_700_000_000_000,
      serviceId: 'openai',
      profileId: 'openai-qualified',
      kind: 'token',
      token: {
        token: 'must-not-reach-qualified-launch',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    await expect(connectedServices.materializeAuthEnvironment({
      connectedAccountMaterializationAuthority: 'qualified',
      openai,
    })).resolves.toEqual({ env: {} });
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
      status: 'unavailable',
      retryable: true,
      reason: 'ohmypi_provider_outcome_pending',
    });
  });

  it('proves one provider outcome only for the complete atomic five-service epoch', async () => {
    const adapter = readConnectedServices()?.runtimeAuthAdapter as unknown as Readonly<{
      verifyProviderOutcome?: (input: unknown) => Promise<unknown>;
    }>;
    const exactSelections = [
      ['openai-codex', 'codex-work', 'csr_abcdefghijklmnopqrstuv'],
      ['openai', 'openai-work', 'csr_bcdefghijklmnopqrstuvw'],
      ['claude-subscription', 'claude-work', 'csr_cdefghijklmnopqrstuvwx'],
      ['anthropic', 'anthropic-work', 'csr_defghijklmnopqrstuvwxy'],
      ['gemini', 'gemini-work', 'csr_efghijklmnopqrstuvwxyz'],
    ].map(([serviceId, profileId, credentialRevision]) => ({
      kind: 'profile', serviceId, profileId, credentialRevision,
    }));

    const result = await adapter.verifyProviderOutcome?.({
      target: { agentId: 'ohMyPi' },
      selections: exactSelections,
      outcome: { kind: 'provider_activity', event: 'assistant_message_end' },
    });
    expect(result).toMatchObject({
      status: 'verified',
      source: 'ohmypi_provider_activity',
      targets: expect.arrayContaining(exactSelections.map((selection) => ({
        serviceId: selection.serviceId,
        profileId: selection.profileId,
        groupId: null,
        groupGeneration: null,
        credentialRevision: selection.credentialRevision,
      }))),
    });
    expect((result as { targets?: unknown[] } | undefined)?.targets).toHaveLength(5);

    await expect(adapter.verifyProviderOutcome?.({
      target: { agentId: 'ohMyPi' },
      selections: exactSelections.slice(0, 4),
      outcome: { kind: 'provider_activity', event: 'assistant_message_end' },
    })).resolves.toMatchObject({ status: 'unavailable', reason: 'ohmypi_complete_selection_required' });
    await expect(adapter.verifyProviderOutcome?.({
      target: { agentId: 'ohMyPi' },
      selections: exactSelections.map((selection, index) => index === 4
        ? { ...selection, credentialRevision: undefined }
        : selection),
      outcome: { kind: 'provider_activity', event: 'assistant_message_end' },
    })).resolves.toMatchObject({ status: 'unavailable', reason: 'ohmypi_exact_epoch_required' });
    await expect(adapter.verifyProviderOutcome?.({
      target: { agentId: 'ohMyPi' },
      selections: exactSelections,
      outcome: { kind: 'provider_activity', event: 'task_started' },
    })).resolves.toMatchObject({ status: 'unavailable' });
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
      connectedAccountMaterializationAuthority: 'legacy_unfenced_one_shot',
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
      connectedAccountMaterializationAuthority: 'legacy_unfenced_one_shot',
      claudeSubscription: claudeOauth,
    })).rejects.toThrow(/Claude subscription OAuth credentials are not supported/i);
  });

  it('exports provider-owned resume reachability through connectedServices', async () => {
    const connectedServices = readConnectedServices();
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

  it('declares restart/rematerialize policy for every supported service', () => {
    const connectedServices = readConnectedServices();
    for (const serviceId of connectedServices.serviceIds) {
      expect(connectedServices.shouldRestartForServiceSwitch(serviceId), serviceId).toBe(true);
    }
    expect(connectedServices.shouldRestartForServiceSwitch('unsupported')).toBe(false);
    expect(connectedServices.restartRematerializeRequiredReason)
      .toBe('ohmypi_restart_rematerialize_required');
    expect(connectedServices.sameAuthGroupRequiresResumeReachability).toBe(true);
  });
});

describe('OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION external-session host adapters', () => {
  it('does not retain the migrated internal external-session carrier', () => {
    expect(OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION).not.toHaveProperty('externalSessions');
  });
});
