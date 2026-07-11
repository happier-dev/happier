import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/plugin-sdk/experimental/cloud/auth';

import {
  buildOpenCodeAuthContent,
  materializeOpenCodeAuthEnvironment,
} from './materialize.js';
import {
  OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV,
  OPEN_CODE_BROKER_PLUGIN_VERSION,
  OPEN_CODE_BROKER_PLUGIN_VERSION_ENV,
  OPEN_CODE_BROKER_REFRESH_TOKEN_PATH_ENV,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  buildOpenCodeBrokerMarker,
  parseOpenCodeBrokerSelections,
  resolveOpenCodeConnectedConfigHomeDir,
} from './broker/index.js';
import { OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV } from '../../runtime/server/managedServerState.js';

const ROOT_DIR = '/srv/connected/home';
const DAEMON_STATE = '/srv/active/daemon.state.json';
const ACCESS_TOKEN_SENTINEL = 'access-token-MUST-NOT-LEAK';
const REFRESH_TOKEN_SENTINEL = 'refresh-token-MUST-NOT-LEAK';
const MASTER_CONTROL_TOKEN_SENTINEL = 'daemon-master-control-token-MUST-NOT-LEAK';

function buildOpenAiCodexOauth(now = 1000) {
  return buildConnectedServiceCredentialRecord({
    now,
    serviceId: 'openai-codex',
    profileId: 'default',
    kind: 'oauth',
    expiresAt: now + 60_000,
    oauth: {
      accessToken: ACCESS_TOKEN_SENTINEL,
      refreshToken: REFRESH_TOKEN_SENTINEL,
      idToken: null,
      scope: null,
      tokenType: null,
      providerAccountId: 'acct_123',
      providerEmail: null,
    },
  });
}

function buildClaudeSubscriptionOauth(now = 1000) {
  return buildConnectedServiceCredentialRecord({
    now,
    serviceId: 'claude-subscription',
    profileId: 'claude-oauth',
    kind: 'oauth',
    expiresAt: now + 60_000,
    oauth: {
      accessToken: ACCESS_TOKEN_SENTINEL,
      refreshToken: REFRESH_TOKEN_SENTINEL,
      idToken: null,
      scope: null,
      tokenType: null,
      providerAccountId: 'claude-account',
      providerEmail: null,
    },
  });
}

function buildClaudeSubscriptionSetupToken(now = 1000) {
  return buildConnectedServiceCredentialRecord({
    now,
    serviceId: 'claude-subscription',
    profileId: 'claude-setup',
    kind: 'token',
    token: {
      token: 'sk-ant-oat01-setup',
      providerAccountId: null,
      providerEmail: null,
    },
  });
}

describe('OpenCode auth materialization (brokered)', () => {
  it('brokers OpenAI Codex subscription OAuth (stable marker, no refresh token) and keeps a direct Anthropic key', () => {
    const openaiCodex = buildOpenAiCodexOauth();
    const anthropic = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'anthropic',
      profileId: 'api-key',
      kind: 'token',
      token: { token: 'anthropic-token', providerAccountId: null, providerEmail: null },
    });

    const content = JSON.parse(buildOpenCodeAuthContent({ openaiCodex, anthropic }));
    // Codex subscription => stable broker marker (NOT a real oauth entry; no refresh token).
    expect(content.openai).toEqual({ type: 'api', key: buildOpenCodeBrokerMarker('openai', OPEN_CODE_BROKER_PLUGIN_VERSION) });
    // Anthropic Console key => real direct x-api-key.
    expect(content.anthropic).toEqual({ type: 'api', key: 'anthropic-token' });
    expect(JSON.stringify(content)).not.toContain(REFRESH_TOKEN_SENTINEL);
    expect(JSON.stringify(content)).not.toContain(ACCESS_TOKEN_SENTINEL);
  });

  it('brokers Claude subscription OAuth (was previously rejected) into a stable non-refreshable marker', () => {
    const claudeSubscription = buildClaudeSubscriptionOauth();
    const content = JSON.parse(buildOpenCodeAuthContent({ claudeSubscription }));
    expect(content.anthropic).toEqual({ type: 'api', key: buildOpenCodeBrokerMarker('anthropic', OPEN_CODE_BROKER_PLUGIN_VERSION) });
    expect(JSON.stringify(content)).not.toContain(REFRESH_TOKEN_SENTINEL);
    expect(JSON.stringify(content)).not.toContain(ACCESS_TOKEN_SENTINEL);
  });

  it('brokers a Claude subscription setup-token (Bearer+beta via broker, not x-api-key)', () => {
    const claudeSubscription = buildClaudeSubscriptionSetupToken();
    const content = JSON.parse(buildOpenCodeAuthContent({ claudeSubscription }));
    expect(content.anthropic).toEqual({ type: 'api', key: buildOpenCodeBrokerMarker('anthropic', OPEN_CODE_BROKER_PLUGIN_VERSION) });
    // The setup-token value never appears in the auth content (brokered).
    expect(JSON.stringify(content)).not.toContain('sk-ant-oat01-setup');
  });

  it('emits config isolation, broker selections, daemon-state path, and a token-free selection identity', async () => {
    const openaiCodex = buildOpenAiCodexOauth();
    const { env } = await materializeOpenCodeAuthEnvironment({
      openaiCodex,
      rootDir: ROOT_DIR,
      daemonStateFilePath: DAEMON_STATE,
      managedServerStatePath: '/tmp/opencode-state.json',
    });

    // Config isolation: XDG_CONFIG_HOME redirected to the Happier-owned config home; empty config content.
    expect(env.XDG_CONFIG_HOME).toBe(resolveOpenCodeConnectedConfigHomeDir(ROOT_DIR));
    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{}');
    expect(env.HAPPIER_OPENCODE_SERVER_STATE_PATH).toBe('/tmp/opencode-state.json');

    // Broker wiring (NO tokens; daemon-state PATH only).
    expect(env[OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV]).toBe(DAEMON_STATE);
    expect(env[OPEN_CODE_BROKER_PLUGIN_VERSION_ENV]).toBe(OPEN_CODE_BROKER_PLUGIN_VERSION);
    const selections = parseOpenCodeBrokerSelections(env[OPEN_CODE_BROKER_SELECTIONS_ENV]);
    expect(selections.openai).toEqual({ serviceId: 'openai-codex', profileId: 'default', accountId: 'acct_123', planType: null });

    // Selection identity keys the managed-server fingerprint and carries NO token bytes.
    const identity = env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];
    expect(identity).toMatch(/^happier-broker-selection:v1:sha256:[a-f0-9]{64}$/);
    expect(identity).not.toContain(ACCESS_TOKEN_SENTINEL);
    expect(identity).not.toContain(REFRESH_TOKEN_SENTINEL);
  });

  it('mints a private per-materialization capability and injects only its path', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-opencode-materialized-'));
    try {
      const materialized = await materializeOpenCodeAuthEnvironment({
        openaiCodex: buildOpenAiCodexOauth(),
        rootDir,
        materializationId: 'mat-opencode',
        daemonStateFilePath: DAEMON_STATE,
      });
      const { env } = materialized;

      const capabilityPath = join(rootDir, 'broker', 'capability.json');
      expect(env[OPEN_CODE_BROKER_REFRESH_TOKEN_PATH_ENV]).toBe(capabilityPath);
      expect((materialized as { brokerCapability?: unknown }).brokerCapability).toMatchObject({
        path: capabilityPath,
        materializationId: 'mat-opencode',
        selectionIdentityDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        capabilityDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(JSON.parse(await readFile(capabilityPath, 'utf8'))).toMatchObject({
        v: 1,
        materializationId: 'mat-opencode',
      });
      for (const value of Object.values(env)) {
        expect(value).not.toContain(MASTER_CONTROL_TOKEN_SENTINEL);
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('omits broker capability auth when no capability path is available', async () => {
    const { env } = await materializeOpenCodeAuthEnvironment({
      openaiCodex: buildOpenAiCodexOauth(),
      rootDir: ROOT_DIR,
      daemonStateFilePath: DAEMON_STATE,
    });
    // No control token ⇒ no scoped token emitted (the broker fails closed at request time).
    expect(env[OPEN_CODE_BROKER_REFRESH_TOKEN_PATH_ENV]).toBeUndefined();
  });

  it('keeps a same-account token rotation on a STABLE selection identity (no managed-server churn)', async () => {
    const first = (await materializeOpenCodeAuthEnvironment({
      openaiCodex: buildOpenAiCodexOauth(1000),
      rootDir: ROOT_DIR,
      daemonStateFilePath: DAEMON_STATE,
    })).env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];
    // Same account + profile, rotated tokens (different access/refresh, later expiry).
    const rotated = buildConnectedServiceCredentialRecord({
      now: 9999,
      serviceId: 'openai-codex',
      profileId: 'default',
      kind: 'oauth',
      expiresAt: 9999 + 120_000,
      oauth: {
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct_123',
        providerEmail: null,
      },
    });
    const second = (await materializeOpenCodeAuthEnvironment({
      openaiCodex: rotated,
      rootDir: ROOT_DIR,
      daemonStateFilePath: DAEMON_STATE,
    })).env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];
    expect(second).toBe(first);
  });

  it('gives two different accounts different selection identities', async () => {
    const a = (await materializeOpenCodeAuthEnvironment({
      openaiCodex: buildOpenAiCodexOauth(1000),
      rootDir: ROOT_DIR,
      daemonStateFilePath: DAEMON_STATE,
    })).env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];
    const other = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'openai-codex',
      profileId: 'default',
      kind: 'oauth',
      expiresAt: 60_000,
      oauth: {
        accessToken: 'a',
        refreshToken: 'b',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct_OTHER',
        providerEmail: null,
      },
    });
    const b = (await materializeOpenCodeAuthEnvironment({
      openaiCodex: other,
      rootDir: ROOT_DIR,
      daemonStateFilePath: DAEMON_STATE,
    })).env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];
    expect(b).not.toBe(a);
  });

  it('does not collide when opaque profile and account ids contain delimiters', async () => {
    const record = (profileId: string, providerAccountId: string) => buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'openai-codex',
      profileId,
      kind: 'oauth',
      expiresAt: 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId,
        providerEmail: null,
      },
    });
    const first = (await materializeOpenCodeAuthEnvironment({
      openaiCodex: record('work:us', 'acct'),
      rootDir: ROOT_DIR,
    })).env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];
    const second = (await materializeOpenCodeAuthEnvironment({
      openaiCodex: record('work', 'us:acct'),
      rootDir: ROOT_DIR,
    })).env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];

    expect(first).not.toBe(second);
  });

  it('never leaks a token across any emitted env value (no-leak)', async () => {
    const { env } = await materializeOpenCodeAuthEnvironment({
      openaiCodex: buildOpenAiCodexOauth(),
      claudeSubscription: buildClaudeSubscriptionOauth(),
      rootDir: ROOT_DIR,
      daemonStateFilePath: DAEMON_STATE,
    });
    for (const value of Object.values(env)) {
      expect(value).not.toContain(ACCESS_TOKEN_SENTINEL);
      expect(value).not.toContain(REFRESH_TOKEN_SENTINEL);
      // F2: the master control token is used ONLY to derive the scoped token; it never reaches the env.
      expect(value).not.toContain(MASTER_CONTROL_TOKEN_SENTINEL);
    }
  });

  it('emits direct API keys without broker wiring or config isolation for a platform OpenAI key', async () => {
    const openai = buildConnectedServiceCredentialRecord({
      now: 2000,
      serviceId: 'openai',
      profileId: 'api-key',
      kind: 'token',
      token: { token: 'openai-token', providerAccountId: null, providerEmail: null },
    });
    const { env } = await materializeOpenCodeAuthEnvironment({
      openai,
      rootDir: ROOT_DIR,
      daemonStateFilePath: DAEMON_STATE,
      managedServerStatePath: '/tmp/opencode-state.json',
    });
    expect(JSON.parse(env.OPENCODE_AUTH_CONTENT)).toEqual({ openai: { type: 'api', key: 'openai-token' } });
    expect(env.HAPPIER_OPENCODE_SERVER_STATE_PATH).toBe('/tmp/opencode-state.json');
    // Direct keys still get config isolation (identity present) but NO broker selections.
    expect(env.XDG_CONFIG_HOME).toBe(resolveOpenCodeConnectedConfigHomeDir(ROOT_DIR));
    expect(env[OPEN_CODE_BROKER_SELECTIONS_ENV]).toBeUndefined();
    expect(env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]).toMatch(/^happier-broker-selection:v1:sha256:[a-f0-9]{64}$/);
  });

  it('NATIVE-equivalent: no connected credential ⇒ no config isolation / broker / identity env', async () => {
    const { env } = await materializeOpenCodeAuthEnvironment({ rootDir: ROOT_DIR, daemonStateFilePath: DAEMON_STATE });
    expect(env.OPENCODE_AUTH_CONTENT).toBe('{}');
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(env[OPEN_CODE_BROKER_SELECTIONS_ENV]).toBeUndefined();
    expect(env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]).toBeUndefined();
  });

  // R3-6/R4-4 (F3): the selection identity is GROUP-scoped WITHOUT generation. Two distinct pools
  // sharing one active profile must mint DISTINCT identities (registry/authz + managed-server
  // fingerprint stay per-pool), while a generation-only bump keeps ONE stable identity (no churn).
  it('scopes the selection identity by groupId (no generation) when the service selection is a group', async () => {
    const openaiCodex = buildOpenAiCodexOauth();
    const buildEnvForGroup = async (groupId: string) => (await materializeOpenCodeAuthEnvironment({
      openaiCodex,
      rootDir: ROOT_DIR,
      daemonStateFilePath: DAEMON_STATE,
      connectedServiceGroupIdsByServiceId: { 'openai-codex': groupId },
    })).env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];

    const identityPoolA = await buildEnvForGroup('pool-A');
    const identityPoolB = await buildEnvForGroup('pool-B');
    expect(identityPoolA).toMatch(/^happier-broker-selection:v1:sha256:[a-f0-9]{64}$/);
    expect(identityPoolB).toMatch(/^happier-broker-selection:v1:sha256:[a-f0-9]{64}$/);
    expect(identityPoolA).not.toBe(identityPoolB);
    // F3: NO generation in the identity — a generation-only bump must not re-mint.

    // Profile-only selection remains stable but distinct from either group tuple.
    const profileOnly = (await materializeOpenCodeAuthEnvironment({
      openaiCodex,
      rootDir: ROOT_DIR,
      daemonStateFilePath: DAEMON_STATE,
    })).env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];
    expect(profileOnly).toMatch(/^happier-broker-selection:v1:sha256:[a-f0-9]{64}$/);
    expect(profileOnly).not.toBe(identityPoolA);
    expect(profileOnly).not.toBe(identityPoolB);
  });

  it('fails closed when a service is provided with an unsupported credential kind', () => {
    const invalid = buildConnectedServiceCredentialRecord({
      now: 1,
      serviceId: 'openai',
      profileId: 'api-key',
      kind: 'oauth',
      expiresAt: 2,
      oauth: {
        accessToken: 'a',
        refreshToken: 'b',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });
    expect(() => buildOpenCodeAuthContent({ openai: invalid })).toThrow(/token/i);
  });
});
