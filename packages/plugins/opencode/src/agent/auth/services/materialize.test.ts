import { describe, expect, it } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/plugin-sdk/experimental/cloud/auth';

import {
  buildOpenCodeAuthContent,
  materializeOpenCodeAuthEnvironment,
} from './materialize.js';
import {
  OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV,
  OPEN_CODE_BROKER_PLUGIN_VERSION,
  OPEN_CODE_BROKER_PLUGIN_VERSION_ENV,
  OPEN_CODE_BROKER_REFRESH_TOKEN_ENV,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  buildOpenCodeBrokerMarker,
  deriveOpenCodeBrokerRefreshToken,
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

  it('emits config isolation, broker selections, daemon-state path, and a token-free selection identity', () => {
    const openaiCodex = buildOpenAiCodexOauth();
    const { env } = materializeOpenCodeAuthEnvironment({
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
    expect(identity).toContain('opencode|connected');
    expect(identity).toContain(`broker:${OPEN_CODE_BROKER_PLUGIN_VERSION}`);
    expect(identity).toContain('openai-codex:default:acct_123');
    expect(identity).not.toContain(ACCESS_TOKEN_SENTINEL);
    expect(identity).not.toContain(REFRESH_TOKEN_SENTINEL);
  });

  it('injects ONLY the scoped broker-refresh token when a daemon control token is provided (F2 least privilege)', () => {
    const { env } = materializeOpenCodeAuthEnvironment({
      openaiCodex: buildOpenAiCodexOauth(),
      rootDir: ROOT_DIR,
      daemonStateFilePath: DAEMON_STATE,
      daemonControlToken: MASTER_CONTROL_TOKEN_SENTINEL,
    });

    // The broker env carries the DERIVED scoped token, never the master control token.
    expect(env[OPEN_CODE_BROKER_REFRESH_TOKEN_ENV]).toBe(
      deriveOpenCodeBrokerRefreshToken(MASTER_CONTROL_TOKEN_SENTINEL),
    );
    // The MASTER token must not appear in ANY emitted env value (it is used only to derive).
    for (const value of Object.values(env)) {
      expect(value).not.toContain(MASTER_CONTROL_TOKEN_SENTINEL);
    }
  });

  it('omits the scoped broker-refresh token when no daemon control token is available (fail-closed; no master)', () => {
    const { env } = materializeOpenCodeAuthEnvironment({
      openaiCodex: buildOpenAiCodexOauth(),
      rootDir: ROOT_DIR,
      daemonStateFilePath: DAEMON_STATE,
    });
    // No control token ⇒ no scoped token emitted (the broker fails closed at request time).
    expect(env[OPEN_CODE_BROKER_REFRESH_TOKEN_ENV]).toBeUndefined();
  });

  it('keeps a same-account token rotation on a STABLE selection identity (no managed-server churn)', () => {
    const first = materializeOpenCodeAuthEnvironment({
      openaiCodex: buildOpenAiCodexOauth(1000),
      rootDir: ROOT_DIR,
      daemonStateFilePath: DAEMON_STATE,
    }).env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];
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
    const second = materializeOpenCodeAuthEnvironment({
      openaiCodex: rotated,
      rootDir: ROOT_DIR,
      daemonStateFilePath: DAEMON_STATE,
    }).env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];
    expect(second).toBe(first);
  });

  it('gives two different accounts different selection identities', () => {
    const a = materializeOpenCodeAuthEnvironment({
      openaiCodex: buildOpenAiCodexOauth(1000),
      rootDir: ROOT_DIR,
      daemonStateFilePath: DAEMON_STATE,
    }).env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];
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
    const b = materializeOpenCodeAuthEnvironment({
      openaiCodex: other,
      rootDir: ROOT_DIR,
      daemonStateFilePath: DAEMON_STATE,
    }).env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];
    expect(b).not.toBe(a);
  });

  it('never leaks a token across any emitted env value (no-leak)', () => {
    const { env } = materializeOpenCodeAuthEnvironment({
      openaiCodex: buildOpenAiCodexOauth(),
      claudeSubscription: buildClaudeSubscriptionOauth(),
      rootDir: ROOT_DIR,
      daemonStateFilePath: DAEMON_STATE,
      daemonControlToken: MASTER_CONTROL_TOKEN_SENTINEL,
    });
    for (const value of Object.values(env)) {
      expect(value).not.toContain(ACCESS_TOKEN_SENTINEL);
      expect(value).not.toContain(REFRESH_TOKEN_SENTINEL);
      // F2: the master control token is used ONLY to derive the scoped token; it never reaches the env.
      expect(value).not.toContain(MASTER_CONTROL_TOKEN_SENTINEL);
    }
  });

  it('emits direct API keys without broker wiring or config isolation for a platform OpenAI key', () => {
    const openai = buildConnectedServiceCredentialRecord({
      now: 2000,
      serviceId: 'openai',
      profileId: 'api-key',
      kind: 'token',
      token: { token: 'openai-token', providerAccountId: null, providerEmail: null },
    });
    const { env } = materializeOpenCodeAuthEnvironment({
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
    expect(env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]).toContain('openai:api-key:');
  });

  it('NATIVE-equivalent: no connected credential ⇒ no config isolation / broker / identity env', () => {
    const { env } = materializeOpenCodeAuthEnvironment({ rootDir: ROOT_DIR, daemonStateFilePath: DAEMON_STATE });
    expect(env.OPENCODE_AUTH_CONTENT).toBe('{}');
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(env[OPEN_CODE_BROKER_SELECTIONS_ENV]).toBeUndefined();
    expect(env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]).toBeUndefined();
  });

  // R3-6/R4-4 (F3): the selection identity is GROUP-scoped WITHOUT generation. Two distinct pools
  // sharing one active profile must mint DISTINCT identities (registry/authz + managed-server
  // fingerprint stay per-pool), while a generation-only bump keeps ONE stable identity (no churn).
  it('scopes the selection identity by groupId (no generation) when the service selection is a group', () => {
    const openaiCodex = buildOpenAiCodexOauth();
    const buildEnvForGroup = (groupId: string) => materializeOpenCodeAuthEnvironment({
      openaiCodex,
      rootDir: ROOT_DIR,
      daemonStateFilePath: DAEMON_STATE,
      connectedServiceGroupIdsByServiceId: { 'openai-codex': groupId },
    }).env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];

    const identityPoolA = buildEnvForGroup('pool-A');
    const identityPoolB = buildEnvForGroup('pool-B');
    expect(identityPoolA).toContain('openai-codex:default:acct_123:group:pool-A');
    expect(identityPoolB).toContain('openai-codex:default:acct_123:group:pool-B');
    expect(identityPoolA).not.toBe(identityPoolB);
    // F3: NO generation in the identity — a generation-only bump must not re-mint.
    expect(identityPoolA).not.toMatch(/group:pool-A:\d/);

    // Profile-only selection stays byte-for-byte unchanged (no ':group:' fragment).
    const profileOnly = materializeOpenCodeAuthEnvironment({
      openaiCodex,
      rootDir: ROOT_DIR,
      daemonStateFilePath: DAEMON_STATE,
    }).env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];
    expect(profileOnly).toContain('openai-codex:default:acct_123');
    expect(profileOnly).not.toContain(':group:');
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
