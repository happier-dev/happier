import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import type { Credentials } from '@/persistence';

import type { AnthropicModelEntry } from '@/backends/claude/models/fetchAnthropicModels';

const {
  createConnectedServiceCredentialApiMock,
  fetchAnthropicModelsMock,
  getConnectedServiceCredentialPlainMock,
  readClaudeCodeNativeCredentialMock,
} = vi.hoisted(() => ({
  createConnectedServiceCredentialApiMock: vi.fn(),
  fetchAnthropicModelsMock: vi.fn<(...args: unknown[]) => Promise<AnthropicModelEntry[] | null>>(),
  getConnectedServiceCredentialPlainMock: vi.fn(),
  readClaudeCodeNativeCredentialMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('@/api/connectedServices/connectedServiceCredentialApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/connectedServices/connectedServiceCredentialApi')>();
  return { ...actual, createConnectedServiceCredentialApi: createConnectedServiceCredentialApiMock };
});

vi.mock('@/backends/claude/models/fetchAnthropicModels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backends/claude/models/fetchAnthropicModels')>();
  return { ...actual, fetchAnthropicModels: fetchAnthropicModelsMock };
});

vi.mock('@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialFile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialFile')>();
  return { ...actual, readClaudeCodeNativeCredential: readClaudeCodeNativeCredentialMock };
});

import { claudePreflightModelsProbeAdapter } from './claudePreflightModelsProbeAdapter';
import { resetClaudeModelCatalogCacheForTests } from '@/backends/claude/models/resolveClaudeModelCatalog';

const envKeys = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const;
let envScope = createEnvKeyScope(envKeys);
const probeCredentials: Credentials = {
  token: 'account-token',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(5) },
};

function setConnectedCredentialRecord(record: ConnectedServiceCredentialRecordV1): void {
  getConnectedServiceCredentialPlainMock.mockResolvedValue({
    content: { t: 'plain', v: record },
    revisionSemantics: 'revisioned',
    credentialRevision: 1,
  });
}

function buildConnectedOauthRecord(params: Readonly<{
  serviceId: 'claude-subscription';
  profileId: string;
  accessToken: string;
}>): ConnectedServiceCredentialRecordV1 {
  return {
    v: 1,
    serviceId: params.serviceId,
    profileId: params.profileId,
    kind: 'oauth',
    oauth: {
      accessToken: params.accessToken,
      refreshToken: 'refresh-token',
      idToken: null,
      scope: null,
      tokenType: null,
      providerAccountId: null,
      providerEmail: null,
      raw: null,
    },
    token: null,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: Date.now() + 60_000,
  };
}

function buildConnectedTokenRecord(params: Readonly<{
  serviceId: 'anthropic';
  profileId: string;
  token: string;
}>): ConnectedServiceCredentialRecordV1 {
  return {
    v: 1,
    serviceId: params.serviceId,
    profileId: params.profileId,
    kind: 'token',
    oauth: null,
    token: {
      token: params.token,
      providerAccountId: null,
      providerEmail: null,
      raw: null,
    },
    createdAt: 1,
    updatedAt: 1,
    expiresAt: null,
  };
}

function fullEffort(): AnthropicModelEntry['capabilities'] {
  return {
    effort: {
      supported: true,
      low: { supported: true },
      medium: { supported: true },
      high: { supported: true },
      xhigh: { supported: true },
      max: { supported: true },
    },
  };
}

async function runProbe() {
  return claudePreflightModelsProbeAdapter.probeModelsRaw?.({
    cwd: '/tmp',
    timeoutMs: 1_500,
    backendTarget: undefined,
    accountSettings: null,
  }) as Promise<Array<Record<string, unknown>> | null>;
}

beforeEach(() => {
  resetClaudeModelCatalogCacheForTests();
  fetchAnthropicModelsMock.mockReset();
  getConnectedServiceCredentialPlainMock.mockReset();
  getConnectedServiceCredentialPlainMock.mockResolvedValue(null);
  createConnectedServiceCredentialApiMock.mockReset();
  createConnectedServiceCredentialApiMock.mockReturnValue({
    getAccountEncryptionMode: async () => 'plain',
    getConnectedServiceCredentialSealed: async () => null,
    getConnectedServiceCredentialPlain: getConnectedServiceCredentialPlainMock,
    listConnectedServiceAuthGroups: async () => [],
    getConnectedServiceAuthGroup: async () => null,
  });
  readClaudeCodeNativeCredentialMock.mockReset();
  readClaudeCodeNativeCredentialMock.mockResolvedValue(null);
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
});

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
});

describe('claudePreflightModelsProbeAdapter', () => {
  it('augments the static catalog with discovered models, preserving curation and collapsing dated dupes', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchAnthropicModelsMock.mockResolvedValue([
      { id: 'claude-opus-5', displayName: 'Claude Opus 5', maxInputTokens: 1_000_000, capabilities: fullEffort() },
      // Dated snapshot of a curated alias — must collapse onto static `claude-opus-4-5`.
      { id: 'claude-opus-4-5-20251101', displayName: 'Claude Opus 4.5', capabilities: fullEffort() },
      // Genuinely new model — must appear with derived options.
      { id: 'claude-opus-9', displayName: 'Opus 9', maxInputTokens: 1_000_000, capabilities: fullEffort() },
    ]);

    const raw = await runProbe();
    if (!raw) throw new Error('expected augmented model list');

    expect(fetchAnthropicModelsMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-ant-key' }));

    // Curated static model keeps its hand-authored effort default.
    const opus48 = raw.find((m) => m.id === 'claude-opus-4-8');
    const opus48Effort = (opus48?.modelOptions as Array<Record<string, unknown>> | undefined)
      ?.find((o) => o.id === 'reasoning_effort');
    expect(opus48Effort?.currentValue).toBe('high');

    // Discovered model appears with derived options + context window.
    const opus9 = raw.find((m) => m.id === 'claude-opus-9');
    expect(opus9?.name).toBe('Opus 9');
    expect(opus9?.contextWindowTokens).toBe(1_000_000);
    expect((opus9?.modelOptions as Array<Record<string, unknown>> | undefined)?.some((o) => o.id === 'reasoning_effort')).toBe(true);

    // Dated dupe collapsed: the alias stays, the dated id is not added.
    expect(raw.some((m) => m.id === 'claude-opus-4-5')).toBe(true);
    expect(raw.some((m) => m.id === 'claude-opus-4-5-20251101')).toBe(false);
  });

  it('resolves the on-disk Claude credentials when no env token is set', async () => {
    readClaudeCodeNativeCredentialMock.mockResolvedValue({
      payload: { claudeAiOauth: { accessToken: 'sk-ant-oat01-disk', scopes: [] } },
      updatedAtMs: 0,
      source: 'file',
    });
    fetchAnthropicModelsMock.mockResolvedValue([{ id: 'claude-opus-9', displayName: 'Opus 9' }]);

    const raw = await runProbe();
    if (!raw) throw new Error('expected model list');

    expect(fetchAnthropicModelsMock).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'sk-ant-oat01-disk' }));
    expect(raw.some((m) => m.id === 'claude-opus-9')).toBe(true);
  });

  it('returns null when no credential is available', async () => {
    readClaudeCodeNativeCredentialMock.mockResolvedValue(null);

    const raw = await runProbe();

    expect(raw).toBeNull();
    expect(fetchAnthropicModelsMock).not.toHaveBeenCalled();
  });

  it('routes the request at the configured base url instead of the Anthropic host', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic';
    process.env.ANTHROPIC_AUTH_TOKEN = 'zai-gateway-token';
    fetchAnthropicModelsMock.mockResolvedValue([{ id: 'glm-4.6', displayName: 'GLM 4.6' }]);

    await runProbe();

    expect(fetchAnthropicModelsMock).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://api.z.ai/api/anthropic',
      accessToken: 'zai-gateway-token',
    }));
  });

  it('never sends the on-disk Claude credential to a non-Anthropic base url', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
    readClaudeCodeNativeCredentialMock.mockResolvedValue({
      payload: { claudeAiOauth: { accessToken: 'sk-ant-oat01-disk', scopes: [] } },
      updatedAtMs: 0,
      source: 'file',
    });

    const raw = await runProbe();

    expect(raw).toBeNull();
    expect(fetchAnthropicModelsMock).not.toHaveBeenCalled();
  });

  it('still uses the on-disk Claude credential when the base url is Anthropic', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
    readClaudeCodeNativeCredentialMock.mockResolvedValue({
      payload: { claudeAiOauth: { accessToken: 'sk-ant-oat01-disk', scopes: [] } },
      updatedAtMs: 0,
      source: 'file',
    });
    fetchAnthropicModelsMock.mockResolvedValue([{ id: 'claude-opus-9', displayName: 'Opus 9' }]);

    const raw = await runProbe();

    expect(raw).not.toBeNull();
    expect(fetchAnthropicModelsMock).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'sk-ant-oat01-disk' }));
  });

  it('drops discovered models from generations the curated catalog no longer covers', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchAnthropicModelsMock.mockResolvedValue([
      { id: 'claude-opus-9', displayName: 'Opus 9', capabilities: fullEffort() },
      { id: 'claude-3-5-sonnet-20241022', displayName: 'Claude 3.5 Sonnet' },
      { id: 'claude-3-5-sonnet-20240620', displayName: 'Claude 3.5 Sonnet' },
      { id: 'claude-3-haiku-20240307', displayName: 'Claude 3 Haiku' },
      { id: 'claude-2.1', displayName: 'Claude 2.1' },
      { id: 'claude-instant-1.2', displayName: 'Claude Instant' },
    ]);

    const raw = await runProbe();
    if (!raw) throw new Error('expected augmented model list');

    expect(raw.some((m) => m.id === 'claude-opus-9')).toBe(true);
    for (const legacyId of [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-20240620',
      'claude-3-haiku-20240307',
      'claude-2.1',
      'claude-instant-1.2',
    ]) {
      expect(raw.some((m) => m.id === legacyId)).toBe(false);
    }
  });

  it('reads the selected connected account credential instead of the daemon own config dir', async () => {
    setConnectedCredentialRecord(buildConnectedOauthRecord({
      serviceId: 'claude-subscription',
      profileId: 'profile-a',
      accessToken: 'sk-ant-oat01-profile',
    }));
    fetchAnthropicModelsMock.mockResolvedValue([{ id: 'claude-opus-9', displayName: 'Opus 9' }]);

    await claudePreflightModelsProbeAdapter.probeModelsRaw?.({
      cwd: '/tmp',
      timeoutMs: 1_500,
      backendTarget: undefined,
      accountSettings: null,
      credentials: probeCredentials,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'profile-a' },
        },
      },
    });

    expect(fetchAnthropicModelsMock).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'sk-ant-oat01-profile',
    }));
    expect(readClaudeCodeNativeCredentialMock).not.toHaveBeenCalled();
  });

  it('ignores ambient env auth when the session is bound to a Claude subscription account', async () => {
    // The spawn path strips every CLAUDE_AUTH_ENV_KEY for a bound claude-subscription session
    // (isolateClaudeRuntimeAuthEnv), so probing with an ambient token would report one account's
    // models while the session runs as another — cached under the bound account's variant key.
    process.env.ANTHROPIC_AUTH_TOKEN = 'ambient-token-other-account';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-ambient';
    setConnectedCredentialRecord(buildConnectedOauthRecord({
      serviceId: 'claude-subscription',
      profileId: 'profile-a',
      accessToken: 'sk-ant-oat01-bound',
    }));
    fetchAnthropicModelsMock.mockResolvedValue([{ id: 'claude-opus-9', displayName: 'Opus 9' }]);

    await claudePreflightModelsProbeAdapter.probeModelsRaw?.({
      cwd: '/tmp',
      timeoutMs: 1_500,
      backendTarget: undefined,
      accountSettings: null,
      credentials: probeCredentials,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'profile-a' },
        },
      },
    });

    expect(fetchAnthropicModelsMock).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'sk-ant-oat01-bound',
    }));
    const sent = fetchAnthropicModelsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent.apiKey).toBeUndefined();
  });

  it('keeps ANTHROPIC_API_KEY for a bound anthropic account, matching the spawn allow-list', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-bound-key';
    process.env.ANTHROPIC_AUTH_TOKEN = 'ambient-token-other-account';
    setConnectedCredentialRecord(buildConnectedTokenRecord({
      serviceId: 'anthropic',
      profileId: 'profile-a',
      token: 'sk-ant-bound-key',
    }));
    fetchAnthropicModelsMock.mockResolvedValue([{ id: 'claude-opus-9', displayName: 'Opus 9' }]);

    await claudePreflightModelsProbeAdapter.probeModelsRaw?.({
      cwd: '/tmp',
      timeoutMs: 1_500,
      backendTarget: undefined,
      accountSettings: null,
      credentials: probeCredentials,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          anthropic: { source: 'connected', selection: 'profile', profileId: 'profile-a' },
        },
      },
    });

    expect(fetchAnthropicModelsMock).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'sk-ant-bound-key',
    }));
  });

  it('returns null when the models fetch fails', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchAnthropicModelsMock.mockResolvedValue(null);

    const raw = await runProbe();

    expect(raw).toBeNull();
  });
});
