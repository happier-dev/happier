import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import {
  PI_BROKER_STATE_PATH_ENV,
  PI_BROKER_SELECTIONS_ENV,
  PI_BROKER_SELECTION_IDENTITY_ENV,
  isPiBrokerMarker,
  parsePiBrokerSelections,
  resolvePiBrokerExtensionPath,
} from '@/backends/pi/brokerExtension';
import { configuration } from '@/configuration';
import { HAPPIER_SESSION_CONNECTED_SERVICE_BROKER_SELECTION_IDENTITY_ENV_KEY } from '@/agent/runtime/sessionConnectedServiceBrokerSelectionIdentityEnv';

import {
  applyPiCodingAgentDirChildEnvFormatting,
  formatPiCodingAgentDirForChildEnv,
  materializePiConnectedServiceAuth,
} from './materializePiConnectedServiceAuth';

/**
 * No-leak invariant for brokered Pi OAuth (the dual-refresher fix). The provider refresh token must
 * appear in NONE of: the materialized `auth.json`, the broker extension source on disk, or the emitted
 * child env. Brokered Pi may receive the current short-lived access token for its synchronous
 * `getApiKey` path, but it never receives a provider refresh token and therefore cannot become a second
 * refresher.
 */
async function assertNoRefreshTokenLeak(params: Readonly<{
  agentDir: string;
  env: Record<string, string>;
  sentinels: readonly string[];
}>): Promise<void> {
  const authRaw = await readFile(join(params.agentDir, 'auth.json'), 'utf8');
  for (const sentinel of params.sentinels) {
    expect(authRaw).not.toContain(sentinel);
    for (const [, value] of Object.entries(params.env)) {
      expect(value).not.toContain(sentinel);
    }
  }
  // The broker extension file (if written) must also be free of the secrets — it embeds NO tokens.
  const extensionRaw = await readFile(resolvePiBrokerExtensionPath(params.agentDir), 'utf8').catch(() => '');
  for (const sentinel of params.sentinels) {
    expect(extensionRaw).not.toContain(sentinel);
  }
}

describe('materializePiConnectedServiceAuth', () => {
  it('keeps Windows child agent dirs non-namespaced because Pi auth storage locks auth.json', () => {
    const agentDir = win32.join(
      'C:\\',
      'Users',
      'test_qa',
      'AppData',
      'Local',
      'Temp',
      'happier-windows-provider-codex-pi-qa-20260626T2055Z',
      'happier-home',
      'daemon',
      'connected-services',
      'materialized',
      'csm_0e41d1c24f1de526058d59c0a42e58ff',
      'pi',
      'pi-agent-dir',
    );

    expect(formatPiCodingAgentDirForChildEnv(agentDir, 'win32')).toBe(agentDir);
    expect(formatPiCodingAgentDirForChildEnv(`\\\\?\\${agentDir}`, 'win32')).toBe(`\\\\?\\${agentDir}`);
    expect(formatPiCodingAgentDirForChildEnv('/tmp/happier/pi-agent-dir', 'darwin')).toBe('/tmp/happier/pi-agent-dir');
  });

  it('formats only the promoted Pi session dir with the Win32 namespace after final-root rewrite', () => {
    const agentDir = win32.join(
      'C:\\',
      'Users',
      'test_qa',
      'AppData',
      'Local',
      'Temp',
      'happier-windows-provider-codex-pi-qa-20260626T2055Z',
      'happier-home',
      'daemon',
      'connected-services',
      'materialized',
      'csm_0e41d1c24f1de526058d59c0a42e58ff',
      'pi',
      'pi-agent-dir',
    );
    const sessionDir = win32.join(agentDir, 'sessions', '--tmp-project--');
    const env = {
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      OTHER_PATH: agentDir,
    };

    applyPiCodingAgentDirChildEnvFormatting(env, 'win32');

    expect(env.PI_CODING_AGENT_DIR).toBe(agentDir);
    expect(env.PI_CODING_AGENT_SESSION_DIR).toBe(`\\\\?\\${sessionDir}`);
    expect(env.OTHER_PATH).toBe(agentDir);
  });

  it('writes Anthropic token credentials to auth.json for Pi hot reload', async () => {
    const now = Date.now();
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-auth-'));
    const anthropic = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'anthropic',
      profileId: 'default',
      kind: 'token',
      token: { token: 'sk-ant-test', providerAccountId: null, providerEmail: null },
    });

    const res = await materializePiConnectedServiceAuth({
      rootDir,
      openaiCodex: null,
      openai: null,
      claudeSubscription: null,
      anthropic,
    });

    expect(res.env.PI_CODING_AGENT_DIR).toContain('pi-agent-dir');
    expect(res.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(res.env).not.toHaveProperty('ANTHROPIC_OAUTH_TOKEN');
    // Direct API key ⇒ NOT brokered ⇒ no broker env.
    expect(res.env).not.toHaveProperty(PI_BROKER_SELECTIONS_ENV);

    const authPath = join(res.env.PI_CODING_AGENT_DIR, 'auth.json');
    const authRaw = await readFile(authPath, 'utf8');
    expect(JSON.parse(authRaw)).toEqual({
      anthropic: {
        type: 'api_key',
        key: 'sk-ant-test',
      },
    });
  });

  it('does not emit PI_CODING_AGENT_SESSION_DIR in the target child env', async () => {
    const now = Date.now();
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-auth-'));
    const anthropic = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'anthropic',
      profileId: 'default',
      kind: 'token',
      token: { token: 'sk-ant-test', providerAccountId: null, providerEmail: null },
    });

    const res = await materializePiConnectedServiceAuth({
      rootDir,
      openaiCodex: null,
      openai: null,
      claudeSubscription: null,
      anthropic,
    });

    expect(res.env.PI_CODING_AGENT_DIR).toContain('pi-agent-dir');
    expect(res.env).not.toHaveProperty('PI_CODING_AGENT_SESSION_DIR');
  });

  it('writes Claude subscription setup-token credentials to auth.json for Pi hot reload (direct, not brokered)', async () => {
    const now = Date.now();
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-auth-'));
    const claudeSubscription = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'default',
      kind: 'token',
      token: { token: 'sk-ant-oat01-abc', providerAccountId: null, providerEmail: null },
    });

    const res = await materializePiConnectedServiceAuth({
      rootDir,
      openaiCodex: null,
      openai: null,
      claudeSubscription,
      anthropic: null,
    });

    expect(res.env.PI_CODING_AGENT_DIR).toContain('pi-agent-dir');
    expect(res.env).not.toHaveProperty('ANTHROPIC_OAUTH_TOKEN');
    expect(res.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    // Setup-token is a long-lived secret used directly (no provider refresh) ⇒ NOT brokered.
    expect(res.env).not.toHaveProperty(PI_BROKER_SELECTIONS_ENV);

    const authPath = join(res.env.PI_CODING_AGENT_DIR, 'auth.json');
    const authRaw = await readFile(authPath, 'utf8');
    expect(JSON.parse(authRaw)).toEqual({
      anthropic: {
        type: 'api_key',
        key: 'sk-ant-oat01-abc',
      },
    });
  });

  it('brokers Claude subscription OAuth: NO refresh token reaches Pi (auth.json/env/extension)', async () => {
    const now = Date.now();
    const providerExpiresAt = now + 60_000;
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-auth-'));
    const claudeSubscription = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-pro-oauth',
      kind: 'oauth',
      expiresAt: providerExpiresAt,
      oauth: {
        accessToken: 'claude-access-token-SECRET',
        refreshToken: 'claude-refresh-token-MUST-NOT-LEAK',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'claude-account-id',
        providerEmail: 'claude@example.com',
      },
    });

    const res = await materializePiConnectedServiceAuth({
      rootDir,
      openaiCodex: null,
      openai: null,
      claudeSubscription,
      anthropic: null,
    });

    const agentDir = res.env.PI_CODING_AGENT_DIR;
    const authRaw = await readFile(join(agentDir, 'auth.json'), 'utf8');
    const auth = JSON.parse(authRaw) as Record<string, { type: string; refresh?: string; access?: string; expires?: number; accountId?: string }>;

    // The brokered anthropic entry keeps the current access token for Pi's synchronous first-turn
    // getApiKey path, but the refresh value is only a non-secret broker marker.
    expect(auth.anthropic.type).toBe('oauth');
    expect(isPiBrokerMarker(auth.anthropic.refresh)).toBe(true);
    expect(auth.anthropic.refresh).not.toBe('claude-refresh-token-MUST-NOT-LEAK');
    expect(auth.anthropic.access).toBe('claude-access-token-SECRET');
    const anthropicExpires = auth.anthropic.expires;
    expect(typeof anthropicExpires).toBe('number');
    if (typeof anthropicExpires !== 'number') throw new Error('expected_brokered_anthropic_expiry');
    expect(anthropicExpires).toBeGreaterThanOrEqual(now);
    expect(anthropicExpires).toBeLessThanOrEqual(now + 11_000);
    expect(anthropicExpires).toBeLessThan(providerExpiresAt);
    expect(auth.anthropic.accountId).toBe('claude-account-id');

    // Broker env: selections + minimal broker-state path + selection identity present; the capability
    // itself is never copied into the child environment.
    const selections = parsePiBrokerSelections(res.env[PI_BROKER_SELECTIONS_ENV]);
    expect(selections.anthropic).toMatchObject({ serviceId: 'claude-subscription', profileId: 'claude-pro-oauth' });
    expect(res.env[PI_BROKER_STATE_PATH_ENV]).toBe(configuration.connectedServiceBrokerStateFile);
    expect(res.env[PI_BROKER_STATE_PATH_ENV]).not.toBe(configuration.daemonStateFile);
    expect(typeof res.env[PI_BROKER_SELECTION_IDENTITY_ENV]).toBe('string');
    expect(res.env[HAPPIER_SESSION_CONNECTED_SERVICE_BROKER_SELECTION_IDENTITY_ENV_KEY]).toBe(
      res.env[PI_BROKER_SELECTION_IDENTITY_ENV],
    );

    await assertNoRefreshTokenLeak({
      agentDir,
      env: res.env,
      sentinels: ['claude-refresh-token-MUST-NOT-LEAK'],
    });
  });

  it('R4-4: mints DISTINCT selection identities for two pools that share one active profile', async () => {
    const now = Date.now();
    const claudeSubscription = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-pro-oauth',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'claude-access-token',
        refreshToken: 'claude-refresh-token',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'claude-account-id',
        providerEmail: 'claude@example.com',
      },
    });
    const groupSelections = (groupId: string) => new Map([[
      'claude-subscription',
      {
        kind: 'group' as const,
        serviceId: 'claude-subscription' as const,
        groupId,
        activeProfileId: 'claude-pro-oauth',
        fallbackProfileId: 'claude-pro-oauth',
        generation: 1,
        record: claudeSubscription,
        policy: null,
      },
    ]]);

    const resA = await materializePiConnectedServiceAuth({
      rootDir: await mkdtemp(join(tmpdir(), 'happier-pi-auth-')),
      openaiCodex: null,
      openai: null,
      claudeSubscription,
      anthropic: null,
      selectionsByServiceId: groupSelections('pool-A') as any,
    });
    const resB = await materializePiConnectedServiceAuth({
      rootDir: await mkdtemp(join(tmpdir(), 'happier-pi-auth-')),
      openaiCodex: null,
      openai: null,
      claudeSubscription,
      anthropic: null,
      selectionsByServiceId: groupSelections('pool-B') as any,
    });

    // Two distinct pools sharing profile `claude-pro-oauth` must NOT collapse to one identity key.
    expect(resA.env[PI_BROKER_SELECTION_IDENTITY_ENV]).not.toBe(resB.env[PI_BROKER_SELECTION_IDENTITY_ENV]);
    expect(resA.env[PI_BROKER_SELECTION_IDENTITY_ENV]).toContain('pool-A');
    expect(resB.env[PI_BROKER_SELECTION_IDENTITY_ENV]).toContain('pool-B');
  });

  it('F3: keeps ONE pool identity stable across a generation-only bump (no re-registration churn)', async () => {
    const now = Date.now();
    const claudeSubscription = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-pro-oauth',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'claude-access-token',
        refreshToken: 'claude-refresh-token',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'claude-account-id',
        providerEmail: 'claude@example.com',
      },
    });
    const poolSelection = (generation: number) => new Map([[
      'claude-subscription',
      {
        kind: 'group' as const,
        serviceId: 'claude-subscription' as const,
        groupId: 'pool-A',
        activeProfileId: 'claude-pro-oauth',
        fallbackProfileId: 'claude-pro-oauth',
        generation,
        record: claudeSubscription,
        policy: null,
      },
    ]]);

    const gen1 = await materializePiConnectedServiceAuth({
      rootDir: await mkdtemp(join(tmpdir(), 'happier-pi-auth-')),
      openaiCodex: null,
      openai: null,
      claudeSubscription,
      anthropic: null,
      selectionsByServiceId: poolSelection(1) as any,
    });
    const gen2 = await materializePiConnectedServiceAuth({
      rootDir: await mkdtemp(join(tmpdir(), 'happier-pi-auth-')),
      openaiCodex: null,
      openai: null,
      claudeSubscription,
      anthropic: null,
      selectionsByServiceId: poolSelection(2) as any,
    });

    // Same pool + same active profile at a bumped generation must mint the SAME identity (opaque
    // equality key); baking generation in only churns the runtime registry into re-registering a
    // live target whose broker binding never changed.
    expect(gen1.env[PI_BROKER_SELECTION_IDENTITY_ENV]).toBe(gen2.env[PI_BROKER_SELECTION_IDENTITY_ENV]);
  });

  it('R4-4: leaves the profile-only selection identity unchanged (no group suffix)', async () => {
    const now = Date.now();
    const claudeSubscription = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-pro-oauth',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'claude-access-token',
        refreshToken: 'claude-refresh-token',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'claude-account-id',
        providerEmail: 'claude@example.com',
      },
    });

    const withoutSelections = await materializePiConnectedServiceAuth({
      rootDir: await mkdtemp(join(tmpdir(), 'happier-pi-auth-')),
      openaiCodex: null,
      openai: null,
      claudeSubscription,
      anthropic: null,
    });
    const withProfileSelection = await materializePiConnectedServiceAuth({
      rootDir: await mkdtemp(join(tmpdir(), 'happier-pi-auth-')),
      openaiCodex: null,
      openai: null,
      claudeSubscription,
      anthropic: null,
      selectionsByServiceId: new Map([[
        'claude-subscription',
        {
          kind: 'profile' as const,
          serviceId: 'claude-subscription' as const,
          profileId: 'claude-pro-oauth',
          record: claudeSubscription,
        },
      ]]) as any,
    });

    expect(withoutSelections.env[PI_BROKER_SELECTION_IDENTITY_ENV]).not.toContain(':group:');
    expect(withProfileSelection.env[PI_BROKER_SELECTION_IDENTITY_ENV]).toBe(
      withoutSelections.env[PI_BROKER_SELECTION_IDENTITY_ENV],
    );
  });

  it('continues to reject Anthropic OAuth credentials for Pi', async () => {
    const now = Date.now();
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-auth-'));
    const anthropic = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'anthropic',
      profileId: 'anthropic-oauth',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'anthropic-access-token',
        refreshToken: 'anthropic-refresh-token',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'anthropic-account-id',
        providerEmail: 'anthropic@example.com',
      },
    });

    await expect(materializePiConnectedServiceAuth({
      rootDir,
      openaiCodex: null,
      openai: null,
      claudeSubscription: null,
      anthropic,
    })).rejects.toThrow(/Anthropic OAuth credentials are not supported/);
  });

  it('prefers Claude subscription credentials over Anthropic API keys for Pi anthropic auth', async () => {
    const now = Date.now();
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-auth-'));
    const claudeSubscription = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-pro',
      kind: 'token',
      token: { token: 'sk-ant-oat01-pro', providerAccountId: null, providerEmail: null },
    });
    const anthropic = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'anthropic',
      profileId: 'anthropic-key',
      kind: 'token',
      token: { token: 'sk-ant-api-key', providerAccountId: null, providerEmail: null },
    });

    const res = await materializePiConnectedServiceAuth({
      rootDir,
      openaiCodex: null,
      openai: null,
      claudeSubscription,
      anthropic,
    });

    const authPath = join(res.env.PI_CODING_AGENT_DIR, 'auth.json');
    const authRaw = await readFile(authPath, 'utf8');
    expect(JSON.parse(authRaw)).toMatchObject({
      anthropic: {
        type: 'api_key',
        key: 'sk-ant-oat01-pro',
      },
    });
  });

  it('writes OpenAI API key credentials to auth.json (direct, not brokered)', async () => {
    const now = Date.now();
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-auth-'));
    const openai = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai',
      profileId: 'default',
      kind: 'token',
      token: { token: 'sk-openai-test', providerAccountId: null, providerEmail: null },
    });

    const res = await materializePiConnectedServiceAuth({
      rootDir,
      openaiCodex: null,
      openai,
      claudeSubscription: null,
      anthropic: null,
    });

    expect(res.env).not.toHaveProperty(PI_BROKER_SELECTIONS_ENV);
    const authPath = join(res.env.PI_CODING_AGENT_DIR, 'auth.json');
    const authRaw = await readFile(authPath, 'utf8');
    expect(JSON.parse(authRaw)).toEqual({
      openai: {
        type: 'api_key',
        key: 'sk-openai-test',
      },
    });
  });

  it('brokers Codex OAuth + keeps a direct Anthropic key: NO Codex refresh token reaches Pi', async () => {
    const now = Date.now();
    const providerExpiresAt = now + 60_000;
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-auth-'));
    const openaiCodex = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'codex-p2',
      kind: 'oauth',
      expiresAt: providerExpiresAt,
      oauth: {
        accessToken: 'codex-access-p2-SECRET',
        refreshToken: 'codex-refresh-p2-MUST-NOT-LEAK',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'acct-codex-p2',
        providerEmail: null,
      },
    });
    const anthropic = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'anthropic',
      profileId: 'anthropic-p1',
      kind: 'token',
      token: { token: 'sk-ant-p1', providerAccountId: null, providerEmail: null },
    });

    const res = await materializePiConnectedServiceAuth({
      rootDir,
      openaiCodex,
      openai: null,
      claudeSubscription: null,
      anthropic,
    });

    expect(res.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    const agentDir = res.env.PI_CODING_AGENT_DIR;
    const authRaw = await readFile(join(agentDir, 'auth.json'), 'utf8');
    const auth = JSON.parse(authRaw) as Record<string, Record<string, unknown>>;

    // Codex (OAuth) ⇒ brokered marker (no refresh leak); anthropic (token) ⇒ direct api_key.
    expect(auth['openai-codex'].type).toBe('oauth');
    expect(isPiBrokerMarker(auth['openai-codex'].refresh)).toBe(true);
    expect(auth['openai-codex'].refresh).not.toBe('codex-refresh-p2-MUST-NOT-LEAK');
    expect(auth['openai-codex'].access).toBe('codex-access-p2-SECRET');
    const codexExpires = auth['openai-codex'].expires;
    expect(typeof codexExpires).toBe('number');
    if (typeof codexExpires !== 'number') throw new Error('expected_brokered_codex_expiry');
    expect(codexExpires).toBeGreaterThanOrEqual(now);
    expect(codexExpires).toBeLessThanOrEqual(now + 11_000);
    expect(codexExpires).toBeLessThan(providerExpiresAt);
    expect(auth['openai-codex'].accountId).toBe('acct-codex-p2');
    expect(auth.anthropic).toEqual({ type: 'api_key', key: 'sk-ant-p1' });

    const selections = parsePiBrokerSelections(res.env[PI_BROKER_SELECTIONS_ENV]);
    // Selections key by the SHARED bridge tag (openai), while the auth.json entry keys by Pi's id.
    expect(selections.openai).toMatchObject({ serviceId: 'openai-codex', profileId: 'codex-p2' });
    // Only the Codex lane is brokered; the direct anthropic key is NOT a broker selection.
    expect(selections.anthropic).toBeUndefined();

    await assertNoRefreshTokenLeak({
      agentDir,
      env: res.env,
      sentinels: ['codex-refresh-p2-MUST-NOT-LEAK'],
    });
  });

  it('does not inject the scoped broker-refresh token value as the master control token (no env carries the master)', async () => {
    // The scoped token is derived from the daemon master control token but the master itself must NEVER
    // appear in any emitted env value (least privilege). In this unit env there is typically no daemon
    // control token, so the scoped token env is simply absent — assert it is never the raw master.
    const now = Date.now();
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-auth-'));
    const claudeSubscription = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-pro-oauth',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'a',
        refreshToken: 'r',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const res = await materializePiConnectedServiceAuth({
      rootDir,
      openaiCodex: null,
      openai: null,
      claudeSubscription,
      anthropic: null,
    });

    // The scoped capability follows daemon replacement through broker-state; it is not frozen into
    // the long-lived Pi child environment.
    expect(res.env.HAPPIER_CONNECTED_SERVICE_BROKER_REFRESH_TOKEN).toBeUndefined();
  });
});
