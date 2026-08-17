import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import {
  OPEN_CODE_BROKER_STATE_PATH_ENV,
  OPEN_CODE_BROKER_PLUGIN_VERSION,
  OPEN_CODE_BROKER_PLUGIN_VERSION_ENV,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  buildOpenCodeBrokerMarker,
  parseOpenCodeBrokerSelections,
} from '@/backends/opencode/brokerPlugin';
import { OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV } from '@/backends/opencode/server/openCodeManagedServerEnv';
import { HAPPIER_SESSION_CONNECTED_SERVICE_BROKER_SELECTION_IDENTITY_ENV_KEY } from '@/agent/runtime/sessionConnectedServiceBrokerSelectionIdentityEnv';
import { configuration } from '@/configuration';

import { materializeOpenCodeConnectedServiceAuth } from './materializeOpenCodeConnectedServiceAuth';

const ACCESS_SENTINEL = 'access-token-MUST-NOT-LEAK';
const REFRESH_SENTINEL = 'refresh-token-MUST-NOT-LEAK';

function assertNoTokenLeak(env: Record<string, string>): void {
  for (const value of Object.values(env)) {
    expect(value).not.toContain(ACCESS_SENTINEL);
    expect(value).not.toContain(REFRESH_SENTINEL);
  }
}

describe('materializeOpenCodeConnectedServiceAuth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('brokers OpenAI Codex subscription OAuth as a non-refreshable marker (no token bytes in env)', async () => {
    const now = Date.now();
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-opencode-connected-auth-'));
    const openaiCodex = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'default',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: ACCESS_SENTINEL,
        refreshToken: REFRESH_SENTINEL,
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct_123',
        providerEmail: 'alice@example.com',
      },
    });

    const fetchMock = vi.fn(async () => {
      throw new TypeError('offline');
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await materializeOpenCodeConnectedServiceAuth({
      rootDir,
      openaiCodex,
      openai: null,
      claudeSubscription: null,
      anthropic: null,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(result.env.OPENCODE_AUTH_CONTENT ?? '{}')).toEqual({
      openai: { type: 'api', key: buildOpenCodeBrokerMarker('openai', OPEN_CODE_BROKER_PLUGIN_VERSION) },
    });
    // Broker plugin loads from the config-home auto-load dir (NOT registered via
    // OPENCODE_CONFIG_CONTENT.plugin — an absolute path there does not load); bridge wiring present;
    // no token bytes anywhere. OPENCODE_CONFIG_CONTENT is the empty isolation marker.
    expect(JSON.parse(result.env.OPENCODE_CONFIG_CONTENT ?? 'null')).toEqual({});
    const selections = parseOpenCodeBrokerSelections(result.env[OPEN_CODE_BROKER_SELECTIONS_ENV]);
    expect(selections.openai).toMatchObject({ serviceId: 'openai-codex', profileId: 'default', accountId: 'acct_123' });
    expect(result.env[OPEN_CODE_BROKER_STATE_PATH_ENV]).toBe(configuration.connectedServiceBrokerStateFile);
    expect(result.env[OPEN_CODE_BROKER_STATE_PATH_ENV]).not.toBe(configuration.daemonStateFile);
    expect(result.env[OPEN_CODE_BROKER_PLUGIN_VERSION_ENV]).toBe(OPEN_CODE_BROKER_PLUGIN_VERSION);
    expect(result.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]).toContain('openai-codex:default:acct_123');
    // Config isolation: connected sessions get a Happier-owned config home.
    expect(result.env.XDG_CONFIG_HOME).toContain('connected-config');
    assertNoTokenLeak(result.env);
  });

  it('keeps the selection identity stable across token rotation (no fingerprint churn)', async () => {
    const now = Date.now();
    const build = (access: string, refresh: string, expiresAt: number) => buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'default',
      kind: 'oauth',
      expiresAt,
      oauth: { accessToken: access, refreshToken: refresh, idToken: null, scope: null, tokenType: null, providerAccountId: 'acct_123', providerEmail: null },
    });
    const first = await materializeOpenCodeConnectedServiceAuth({ rootDir: '', openaiCodex: build('a1', 'r1', now + 1000), openai: null, claudeSubscription: null, anthropic: null });
    const rotated = await materializeOpenCodeConnectedServiceAuth({ rootDir: '', openaiCodex: build('a2', 'r2', now + 9999), openai: null, claudeSubscription: null, anthropic: null });
    expect(first.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]).toBe(rotated.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]);
    expect(first.env[HAPPIER_SESSION_CONNECTED_SERVICE_BROKER_SELECTION_IDENTITY_ENV_KEY]).toBe(
      first.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV],
    );
    // A different account yields a DIFFERENT identity.
    const otherAccount = await materializeOpenCodeConnectedServiceAuth({ rootDir: '', openaiCodex: buildConnectedServiceCredentialRecord({ now, serviceId: 'openai-codex', profileId: 'work', kind: 'oauth', expiresAt: now + 1000, oauth: { accessToken: 'a', refreshToken: 'r', idToken: null, scope: null, tokenType: null, providerAccountId: 'acct_999', providerEmail: null } }), openai: null, claudeSubscription: null, anthropic: null });
    expect(otherAccount.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]).not.toBe(first.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]);
  });

  it('R4-4: mints DISTINCT selection identities for two pools that share one active profile', async () => {
    const now = Date.now();
    const openaiCodex = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'default',
      kind: 'oauth',
      expiresAt: now + 1000,
      oauth: { accessToken: 'a', refreshToken: 'r', idToken: null, scope: null, tokenType: null, providerAccountId: 'acct_123', providerEmail: null },
    });
    const groupSelections = (groupId: string) => new Map([[
      'openai-codex',
      {
        kind: 'group' as const,
        serviceId: 'openai-codex' as const,
        groupId,
        activeProfileId: 'default',
        fallbackProfileId: 'default',
        generation: 1,
        record: openaiCodex,
        policy: null,
      },
    ]]);

    const resA = await materializeOpenCodeConnectedServiceAuth({ rootDir: '', openaiCodex, openai: null, claudeSubscription: null, anthropic: null, selectionsByServiceId: groupSelections('pool-A') as any });
    const resB = await materializeOpenCodeConnectedServiceAuth({ rootDir: '', openaiCodex, openai: null, claudeSubscription: null, anthropic: null, selectionsByServiceId: groupSelections('pool-B') as any });

    expect(resA.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]).not.toBe(resB.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]);
    expect(resA.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]).toContain('pool-A');
  });

  it('F3: keeps ONE pool identity stable across a generation-only bump (no re-registration churn)', async () => {
    const now = Date.now();
    const openaiCodex = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'default',
      kind: 'oauth',
      expiresAt: now + 1000,
      oauth: { accessToken: 'a', refreshToken: 'r', idToken: null, scope: null, tokenType: null, providerAccountId: 'acct_123', providerEmail: null },
    });
    const poolSelection = (generation: number) => new Map([[
      'openai-codex',
      {
        kind: 'group' as const,
        serviceId: 'openai-codex' as const,
        groupId: 'pool-A',
        activeProfileId: 'default',
        fallbackProfileId: 'default',
        generation,
        record: openaiCodex,
        policy: null,
      },
    ]]);

    const gen1 = await materializeOpenCodeConnectedServiceAuth({ rootDir: '', openaiCodex, openai: null, claudeSubscription: null, anthropic: null, selectionsByServiceId: poolSelection(1) as any });
    const gen2 = await materializeOpenCodeConnectedServiceAuth({ rootDir: '', openaiCodex, openai: null, claudeSubscription: null, anthropic: null, selectionsByServiceId: poolSelection(2) as any });

    // Same pool + same active profile at a bumped generation must mint the SAME identity: the string
    // is an opaque equality key, generation flows as a separate payload field, so baking it in only
    // churns the runtime registry into re-registering a live target that never changed its binding.
    expect(gen1.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]).toBe(gen2.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]);
  });

  it('R4-4: leaves the profile-only selection identity unchanged (no group suffix)', async () => {
    const now = Date.now();
    const openaiCodex = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'default',
      kind: 'oauth',
      expiresAt: now + 1000,
      oauth: { accessToken: 'a', refreshToken: 'r', idToken: null, scope: null, tokenType: null, providerAccountId: 'acct_123', providerEmail: null },
    });
    const withoutSelections = await materializeOpenCodeConnectedServiceAuth({ rootDir: '', openaiCodex, openai: null, claudeSubscription: null, anthropic: null });
    const withProfileSelection = await materializeOpenCodeConnectedServiceAuth({ rootDir: '', openaiCodex, openai: null, claudeSubscription: null, anthropic: null, selectionsByServiceId: new Map([[
      'openai-codex',
      { kind: 'profile' as const, serviceId: 'openai-codex' as const, profileId: 'default', record: openaiCodex },
    ]]) as any });

    expect(withoutSelections.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]).not.toContain(':group:');
    expect(withProfileSelection.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]).toBe(withoutSelections.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]);
  });

  it('keeps OpenAI platform + Anthropic Console API keys as direct x-api-key credentials', async () => {
    const now = Date.now();
    const openai = buildConnectedServiceCredentialRecord({ now, serviceId: 'openai', profileId: 'openai-key', kind: 'token', token: { token: 'sk-openai-test', providerAccountId: null, providerEmail: null } });
    const anthropic = buildConnectedServiceCredentialRecord({ now, serviceId: 'anthropic', profileId: 'anthropic-key', kind: 'token', token: { token: 'sk-ant-api-test', providerAccountId: null, providerEmail: null } });

    const result = await materializeOpenCodeConnectedServiceAuth({ rootDir: '', openaiCodex: null, openai, claudeSubscription: null, anthropic });

    expect(JSON.parse(result.env.OPENCODE_AUTH_CONTENT ?? '{}')).toEqual({
      openai: { type: 'api', key: 'sk-openai-test' },
      anthropic: { type: 'api', key: 'sk-ant-api-test' },
    });
    // Direct keys: no broker plugin registered, but still config-isolated.
    expect(JSON.parse(result.env.OPENCODE_CONFIG_CONTENT ?? 'null')).toEqual({});
    expect(result.env[OPEN_CODE_BROKER_SELECTIONS_ENV]).toBeUndefined();
    expect(result.env.XDG_CONFIG_HOME).toContain('connected-config');
  });

  it('brokers Claude subscription setup-tokens through the Bearer broker path (NOT x-api-key)', async () => {
    const now = Date.now();
    const claudeSubscription = buildConnectedServiceCredentialRecord({ now, serviceId: 'claude-subscription', profileId: 'claude-pro', kind: 'token', token: { token: 'sk-ant-oat01-pro', providerAccountId: null, providerEmail: null } });

    const result = await materializeOpenCodeConnectedServiceAuth({ rootDir: '', openaiCodex: null, openai: null, claudeSubscription, anthropic: null });

    // OQ-1: setup-tokens must NOT be written as {type:'api', key:'sk-ant-oat...'} (would 401 via x-api-key).
    const auth = JSON.parse(result.env.OPENCODE_AUTH_CONTENT ?? '{}');
    expect(auth.anthropic).toEqual({ type: 'api', key: buildOpenCodeBrokerMarker('anthropic', OPEN_CODE_BROKER_PLUGIN_VERSION) });
    expect(JSON.stringify(result.env)).not.toContain('sk-ant-oat01-pro');
    // Brokered via the config-home auto-load dir (selections wired), not OPENCODE_CONFIG_CONTENT.plugin.
    expect(JSON.parse(result.env.OPENCODE_CONFIG_CONTENT ?? 'null')).toEqual({});
    expect(parseOpenCodeBrokerSelections(result.env[OPEN_CODE_BROKER_SELECTIONS_ENV]).anthropic).toMatchObject({ serviceId: 'claude-subscription', profileId: 'claude-pro' });
  });

  it('accepts Claude subscription OAuth and brokers it (UNBLOCKED per user decision; no refresh token in env)', async () => {
    const now = Date.now();
    const claudeSubscription = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-oauth',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: { accessToken: ACCESS_SENTINEL, refreshToken: REFRESH_SENTINEL, idToken: null, scope: null, tokenType: null, providerAccountId: 'claude-account', providerEmail: 'claude@example.com' },
    });

    const result = await materializeOpenCodeConnectedServiceAuth({ rootDir: '', openaiCodex: null, openai: null, claudeSubscription, anthropic: null });

    const auth = JSON.parse(result.env.OPENCODE_AUTH_CONTENT ?? '{}');
    expect(auth.anthropic).toEqual({ type: 'api', key: buildOpenCodeBrokerMarker('anthropic', OPEN_CODE_BROKER_PLUGIN_VERSION) });
    expect(parseOpenCodeBrokerSelections(result.env[OPEN_CODE_BROKER_SELECTIONS_ENV]).anthropic).toMatchObject({ serviceId: 'claude-subscription', profileId: 'claude-oauth', accountId: 'claude-account' });
    assertNoTokenLeak(result.env);
  });

  it('returns only an empty auth envelope when no connected credential is present (native passthrough)', async () => {
    const result = await materializeOpenCodeConnectedServiceAuth({ rootDir: '', openaiCodex: null, openai: null, claudeSubscription: null, anthropic: null });
    expect(result.env.OPENCODE_AUTH_CONTENT).toBe('{}');
    expect(result.env.XDG_CONFIG_HOME).toBeUndefined();
    expect(result.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]).toBeUndefined();
  });
});
