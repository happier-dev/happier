import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/plugin-sdk/experimental/cloud/auth';

import { formatPiSessionDirectoryForCwd } from '../sessionFiles.js';
import {
  PI_BROKER_DAEMON_STATE_PATH_ENV,
  PI_BROKER_EXTENSION_VERSION,
  PI_BROKER_EXTENSION_VERSION_ENV,
  PI_BROKER_REFRESH_TOKEN_ENV,
  PI_BROKER_SELECTIONS_ENV,
  PI_BROKER_SELECTION_IDENTITY_ENV,
  derivePiBrokerRefreshToken,
  resolvePiBrokerExtensionPath,
} from '../auth/services/broker/index.js';
import { PI_AGENT_RUNTIME_CONTRIBUTION } from './runtime.js';

const DAEMON_CONTROL_TOKEN = 'pi-daemon-master-control-token-MUST-NOT-LEAK';
const DAEMON_STATE_FILE_PATH = '/tmp/happier-pi-broker-daemon.state.json';

/**
 * No-leak guard: the provider's single-use OAuth refresh token must NEVER appear in the materialized
 * auth, broker extension, or emitted env. The daemon is the sole refresher; Pi only holds a non-secret
 * broker marker plus the current short-lived access token for synchronous first-turn getApiKey calls.
 */
async function expectNoProviderRefreshTokenLeak(params: Readonly<{
  agentDir: string;
  authJson: string;
  env: Readonly<Record<string, string>>;
  sentinels: readonly string[];
}>): Promise<void> {
  const extensionSource = await readFile(resolvePiBrokerExtensionPath(params.agentDir), 'utf8').catch(() => '');
  for (const sentinel of params.sentinels) {
    expect(params.authJson).not.toContain(sentinel);
    expect(extensionSource).not.toContain(sentinel);
    for (const value of Object.values(params.env)) {
      expect(value).not.toContain(sentinel);
    }
  }
}

type RuntimeControlReachabilityCall = Readonly<Record<string, unknown>>;

function readRuntimeConnectedServices() {
  return PI_AGENT_RUNTIME_CONTRIBUTION.runtimeControl?.connectedServices;
}

function readConnectedServicesContribution() {
  return (PI_AGENT_RUNTIME_CONTRIBUTION as {
    connectedServices?: {
      serviceIds?: readonly string[];
      readConnectedServiceId?: (selection: unknown) => string | null;
      createAuthMaterializationInput?: (serviceId: string, record: unknown) => Record<string, unknown>;
      materializeAuthEnvironment?: (input: Readonly<Record<string, unknown>>) => Promise<{
        env: Readonly<Record<string, string>>;
      }> | { env: Readonly<Record<string, string>> };
      stateSharingDescriptor?: unknown;
      recoveryCapabilities?: unknown;
      usageLimitRecovery?: unknown;
    };
  }).connectedServices;
}

describe('PI_AGENT_RUNTIME_CONTRIBUTION connected-service materialization', () => {
  it('declares the Pi CLI catalog residuals handled through projection', () => {
    expect(PI_AGENT_RUNTIME_CONTRIBUTION).toMatchObject({
      builtInAcpCatalog: true,
      checklists: {},
      cliSessionCommand: {
        backendIdForSessionRuntime: 'pi',
        agentIdForAccountSettings: 'pi',
      },
    });
  });

  it('declares Pi connected-service ids and restart/rematerialize recovery capabilities', () => {
    const connectedServices = readConnectedServicesContribution();

    expect(connectedServices?.serviceIds).toEqual([
      'openai-codex',
      'openai',
      'claude-subscription',
      'anthropic',
    ]);
    expect(connectedServices?.readConnectedServiceId?.({ serviceId: 'openai' })).toBe('openai');
    expect(connectedServices?.readConnectedServiceId?.({ serviceId: 'gemini' })).toBeNull();
    expect(connectedServices?.stateSharingDescriptor).toMatchObject({
      providerId: 'pi',
      providerSupportStatus: 'supported',
      authIsolation: {
        mode: 'materialized_home',
        secretEntries: ['auth.json'],
      },
    });
    expect(connectedServices?.recoveryCapabilities).toEqual({
      predictiveSoftSwitch: { mode: 'unsupported' },
    });
    expect(connectedServices?.usageLimitRecovery).toMatchObject({
      agentId: 'pi',
      fallbackBackoffEnvKey: 'HAPPIER_PI_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_MS',
      maxAttemptsEnvKey: 'HAPPIER_PI_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS',
    });
  });

  it('materializes Pi auth.json in the same agent-dir layout as the retired host hook', async () => {
    const connectedServices = readConnectedServicesContribution();
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-contribution-auth-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1,
      serviceId: 'anthropic',
      profileId: 'default',
      kind: 'token',
      token: {
        token: 'sk-ant-plugin',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    try {
      const input = connectedServices?.createAuthMaterializationInput?.('anthropic', record);
      const materialized = await connectedServices?.materializeAuthEnvironment?.({
        rootDir: root,
        ...(input ?? {}),
      });

      expect(materialized?.env.PI_CODING_AGENT_DIR).toBe(join(root, 'pi-agent-dir'));
      expect(materialized?.env).not.toHaveProperty('PI_CODING_AGENT_SESSION_DIR');
      await expect(readFile(join(root, 'pi-agent-dir', 'auth.json'), 'utf8')).resolves.toBe(
        JSON.stringify({
          anthropic: {
            type: 'api_key',
            key: 'sk-ant-plugin',
          },
        }, null, 2) + '\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('brokers Claude subscription OAuth (NO refresh-token leak: marker cred + daemon-brokered access)', async () => {
    const connectedServices = readConnectedServicesContribution();
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-contribution-claude-oauth-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1_700_000_000_000,
      serviceId: 'claude-subscription',
      profileId: 'claude-oauth',
      kind: 'oauth',
      expiresAt: 1_700_003_600_000,
      oauth: {
        accessToken: 'claude-access-token',
        refreshToken: 'claude-refresh-token',
        idToken: null,
        scope: 'user:profile user:inference user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'claude-account',
        providerEmail: 'claude@example.com',
      },
    });

    try {
      const input = connectedServices?.createAuthMaterializationInput?.('claude-subscription', record);
      const materialized = await connectedServices?.materializeAuthEnvironment?.({
        rootDir: root,
        daemonControlToken: DAEMON_CONTROL_TOKEN,
        daemonStateFilePath: DAEMON_STATE_FILE_PATH,
        ...(input ?? {}),
      });
      const env = materialized?.env ?? {};

      expect(env.PI_CODING_AGENT_DIR).toBe(join(root, 'pi-agent-dir'));
      const authJson = await readFile(join(root, 'pi-agent-dir', 'auth.json'), 'utf8');
      // The auth.json cred carries a NON-secret broker marker as `refresh` (NOT the provider refresh
      // token), plus the current short-lived access token and real expiry for Pi's synchronous
      // first-turn getApiKey path. Later refreshes still flow through the marker + daemon bridge.
      expect(authJson).toBe(
        JSON.stringify({
          anthropic: {
            type: 'oauth',
            refresh: `happier-pi-broker:anthropic:${PI_BROKER_EXTENSION_VERSION}`,
            access: 'claude-access-token',
            expires: 1_700_003_600_000,
            accountId: 'claude-account',
          },
        }, null, 2) + '\n',
      );

      // The broker extension is written into the agent dir's auto-load `extensions/` dir.
      await expect(readFile(resolvePiBrokerExtensionPath(join(root, 'pi-agent-dir')), 'utf8'))
        .resolves.toContain('registerProvider');

      // Broker env is emitted (selections keyed by the SHARED bridge tag + daemon-state path + version +
      // selection identity + the SCOPED capability token derived from the daemon master control token).
      expect(JSON.parse(env[PI_BROKER_SELECTIONS_ENV]!)).toEqual({
        anthropic: { serviceId: 'claude-subscription', profileId: 'claude-oauth', accountId: 'claude-account', planType: null },
      });
      expect(env[PI_BROKER_DAEMON_STATE_PATH_ENV]).toBe(DAEMON_STATE_FILE_PATH);
      expect(env[PI_BROKER_EXTENSION_VERSION_ENV]).toBe(PI_BROKER_EXTENSION_VERSION);
      expect(env[PI_BROKER_SELECTION_IDENTITY_ENV]).toBe(`pi|connected|broker:${PI_BROKER_EXTENSION_VERSION}|anthropic:claude-oauth:claude-account`);
      // F2: the SCOPED broker-refresh token (NOT the master) is injected for the broker to present.
      expect(env[PI_BROKER_REFRESH_TOKEN_ENV]).toBe(derivePiBrokerRefreshToken(DAEMON_CONTROL_TOKEN));
      expect(env[PI_BROKER_REFRESH_TOKEN_ENV]).not.toBe(DAEMON_CONTROL_TOKEN);

      // No-leak: neither the provider refresh token nor the master control token appear anywhere.
      await expectNoProviderRefreshTokenLeak({
        agentDir: join(root, 'pi-agent-dir'),
        authJson,
        env,
        sentinels: ['claude-refresh-token', DAEMON_CONTROL_TOKEN],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('brokers OpenAI Codex subscription OAuth (NO refresh-token leak: marker cred + daemon-brokered access)', async () => {
    const connectedServices = readConnectedServicesContribution();
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-contribution-codex-oauth-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1_700_000_000_000,
      serviceId: 'openai-codex',
      profileId: 'codex-pro',
      kind: 'oauth',
      expiresAt: 1_700_003_600_000,
      oauth: {
        accessToken: 'codex-access-token',
        refreshToken: 'codex-refresh-token',
        idToken: null,
        scope: 'openid profile email',
        tokenType: 'Bearer',
        providerAccountId: 'chatgpt-account',
        providerEmail: 'codex@example.com',
      },
    });

    try {
      const input = connectedServices?.createAuthMaterializationInput?.('openai-codex', record);
      const materialized = await connectedServices?.materializeAuthEnvironment?.({
        rootDir: root,
        daemonControlToken: DAEMON_CONTROL_TOKEN,
        daemonStateFilePath: DAEMON_STATE_FILE_PATH,
        ...(input ?? {}),
      });
      const env = materialized?.env ?? {};

      const authJson = await readFile(join(root, 'pi-agent-dir', 'auth.json'), 'utf8');
      expect(authJson).toBe(
        JSON.stringify({
          'openai-codex': {
            type: 'oauth',
            refresh: `happier-pi-broker:openai-codex:${PI_BROKER_EXTENSION_VERSION}`,
            access: 'codex-access-token',
            expires: 1_700_003_600_000,
            accountId: 'chatgpt-account',
          },
        }, null, 2) + '\n',
      );
      expect(JSON.parse(env[PI_BROKER_SELECTIONS_ENV]!)).toEqual({
        openai: { serviceId: 'openai-codex', profileId: 'codex-pro', accountId: 'chatgpt-account', planType: null },
      });
      expect(env[PI_BROKER_SELECTION_IDENTITY_ENV]).toBe(`pi|connected|broker:${PI_BROKER_EXTENSION_VERSION}|openai:codex-pro:chatgpt-account`);
      expect(env[PI_BROKER_REFRESH_TOKEN_ENV]).toBe(derivePiBrokerRefreshToken(DAEMON_CONTROL_TOKEN));
      await expectNoProviderRefreshTokenLeak({
        agentDir: join(root, 'pi-agent-dir'),
        authJson,
        env,
        sentinels: ['codex-refresh-token', DAEMON_CONTROL_TOKEN],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // R3-6/R4-4 (F3): the broker selection identity is GROUP-scoped WITHOUT generation, so two pools
  // sharing one active profile mint DISTINCT identities and a generation-only bump does not re-mint.
  it('scopes the broker selection identity by groupId (no generation) for group-bound services', async () => {
    const connectedServices = readConnectedServicesContribution();
    const record = buildConnectedServiceCredentialRecord({
      now: 1_700_000_000_000,
      serviceId: 'claude-subscription',
      profileId: 'claude-oauth',
      kind: 'oauth',
      expiresAt: 1_700_003_600_000,
      oauth: {
        accessToken: 'claude-access-token',
        refreshToken: 'claude-refresh-token',
        idToken: null,
        scope: 'user:profile user:inference user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'claude-account',
        providerEmail: null,
      },
    });

    const materializeForGroup = async (groupIds: Readonly<Record<string, string>> | null) => {
      const root = await mkdtemp(join(tmpdir(), 'happier-pi-contribution-group-identity-'));
      try {
        const input = connectedServices?.createAuthMaterializationInput?.('claude-subscription', record);
        const materialized = await connectedServices?.materializeAuthEnvironment?.({
          rootDir: root,
          daemonControlToken: DAEMON_CONTROL_TOKEN,
          daemonStateFilePath: DAEMON_STATE_FILE_PATH,
          ...(groupIds ? { connectedServiceGroupIdsByServiceId: groupIds } : {}),
          ...(input ?? {}),
        });
        return materialized?.env?.[PI_BROKER_SELECTION_IDENTITY_ENV];
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    };

    const identityPoolA = await materializeForGroup({ 'claude-subscription': 'pool-A' });
    const identityPoolB = await materializeForGroup({ 'claude-subscription': 'pool-B' });
    expect(identityPoolA).toBe(`pi|connected|broker:${PI_BROKER_EXTENSION_VERSION}|anthropic:claude-oauth:claude-account:group:pool-A`);
    expect(identityPoolB).toBe(`pi|connected|broker:${PI_BROKER_EXTENSION_VERSION}|anthropic:claude-oauth:claude-account:group:pool-B`);

    // Profile-only selection stays byte-for-byte unchanged (no ':group:' fragment).
    const profileOnly = await materializeForGroup(null);
    expect(profileOnly).toBe(`pi|connected|broker:${PI_BROKER_EXTENSION_VERSION}|anthropic:claude-oauth:claude-account`);
  });

  it('omits the scoped broker token (fail-closed) when no daemon control token is available', async () => {
    const connectedServices = readConnectedServicesContribution();
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-contribution-claude-noctl-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1_700_000_000_000,
      serviceId: 'claude-subscription',
      profileId: 'claude-oauth',
      kind: 'oauth',
      expiresAt: 1_700_003_600_000,
      oauth: {
        accessToken: 'claude-access-token',
        refreshToken: 'claude-refresh-token',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'claude-account',
        providerEmail: null,
      },
    });

    try {
      const input = connectedServices?.createAuthMaterializationInput?.('claude-subscription', record);
      const materialized = await connectedServices?.materializeAuthEnvironment?.({
        rootDir: root,
        // No daemonControlToken supplied.
        daemonStateFilePath: DAEMON_STATE_FILE_PATH,
        ...(input ?? {}),
      });
      const env = materialized?.env ?? {};
      // Broker env is still emitted, but the scoped token is omitted (the preflight reports it; the
      // broker fails closed at request time rather than presenting any token).
      expect(env[PI_BROKER_SELECTION_IDENTITY_ENV]).toBeDefined();
      expect(env[PI_BROKER_REFRESH_TOKEN_ENV]).toBeUndefined();
      const authJson = await readFile(join(root, 'pi-agent-dir', 'auth.json'), 'utf8');
      await expectNoProviderRefreshTokenLeak({
        agentDir: join(root, 'pi-agent-dir'),
        authJson,
        env,
        sentinels: ['claude-refresh-token'],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps Claude subscription setup-token materialized as Pi api_key credentials', async () => {
    const connectedServices = readConnectedServicesContribution();
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-contribution-claude-token-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1,
      serviceId: 'claude-subscription',
      profileId: 'claude-token',
      kind: 'token',
      token: {
        token: 'claude-setup-token',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    try {
      const input = connectedServices?.createAuthMaterializationInput?.('claude-subscription', record);
      await connectedServices?.materializeAuthEnvironment?.({
        rootDir: root,
        ...(input ?? {}),
      });

      await expect(readFile(join(root, 'pi-agent-dir', 'auth.json'), 'utf8')).resolves.toBe(
        JSON.stringify({
          anthropic: {
            type: 'api_key',
            key: 'claude-setup-token',
          },
        }, null, 2) + '\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('PI_AGENT_RUNTIME_CONTRIBUTION connected-service runtime-control hooks', () => {
  it('exports provider-owned resume reachability through the public runtime-control contribution', async () => {
    const connectedServices = readRuntimeConnectedServices();
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-contribution-reachable-'));

    try {
      const piAgentDir = join(root, 'pi-agent-dir');
      const finalDir = join(piAgentDir, 'sessions', formatPiSessionDirectoryForCwd('/tmp/project'));
      const sessionFile = join(finalDir, '2026-05-27T00-00-00-000Z_pi-session-1.jsonl');
      await mkdir(finalDir, { recursive: true });
      await writeFile(sessionFile, '{}\n');

      await expect(connectedServices?.verifyResumeReachable?.({
        targetMaterializedRoot: root,
        targetMaterializedEnv: { PI_CODING_AGENT_DIR: piAgentDir },
        vendorResumeId: 'pi-session-1',
        cwd: '/tmp/project',
        targetStrict: true,
      })).resolves.toEqual({ ok: true, resolvedPath: sessionFile });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exports provider-owned persisted session-file metadata resolution', () => {
    const connectedServices = readRuntimeConnectedServices();

    expect(connectedServices?.resolveCandidatePersistedSessionFile?.({
      metadata: { piSessionFile: ' /tmp/pi-session.jsonl ' },
    })).toBe('/tmp/pi-session.jsonl');
    expect(connectedServices?.resolveCandidatePersistedSessionFile?.({
      metadata: { piSessionFile: '   ' },
    })).toBeNull();
  });

  it('exports same-home switch continuity through host-mediated reachability', async () => {
    const connectedServices = readRuntimeConnectedServices();
    const verifyMaterializedState = vi.fn(async (_input: RuntimeControlReachabilityCall) => ({
      ok: true,
      value: { ok: true },
    }));

    const binding = {
      source: 'connected' as const,
      selection: 'profile' as const,
      serviceId: 'anthropic',
      profileId: 'primary',
      groupId: null,
    };
    const params = {
      sessionId: 'sess_1',
      providerId: 'pi',
      serviceId: 'anthropic',
      previousBinding: binding,
      nextBinding: binding,
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'mat_pi_primary',
        createdAt: 1,
      },
      vendorResumeId: 'pi-session-1',
      targetMaterializedRoot: '/tmp/materialized',
      targetMaterializedEnv: { PI_CODING_AGENT_DIR: '/tmp/materialized/pi-agent-dir' },
      cwd: '/tmp/project',
      candidatePersistedSessionFile: '/tmp/pi-session.jsonl',
    };

    await expect(connectedServices?.resolveSwitchContinuity?.({
      runtimeControl: {
        context: { providerId: 'pi' },
        reachability: { verifyMaterializedState },
      } as never,
      params,
    })).resolves.toEqual({ mode: 'restart_same_home' });
    expect(verifyMaterializedState).toHaveBeenCalledWith({
      agentId: 'pi',
      serviceId: 'anthropic',
      targetMaterializedRoot: '/tmp/materialized',
      targetMaterializedEnv: { PI_CODING_AGENT_DIR: '/tmp/materialized/pi-agent-dir' },
      requestedStateMode: 'isolated',
      effectiveStateMode: 'isolated',
      materializationIdentity: {
        v: 1,
        id: 'mat_pi_primary',
        createdAt: 1,
      },
      vendorResumeId: 'pi-session-1',
      cwd: '/tmp/project',
      candidatePersistedSessionFile: '/tmp/pi-session.jsonl',
    });
  });
});
