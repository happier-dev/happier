import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

const {
  authenticateMock,
  controlMock,
  createClientMock,
  ensureMachineIdMock,
  openBrowserMock,
  promptInputMock,
  promptSecretInputMock,
} = vi.hoisted(() => {
  const authenticate = vi.fn();
  const control = vi.fn();
  return {
    authenticateMock: authenticate,
    controlMock: control,
    createClientMock: vi.fn(() => ({
      authenticate,
      control,
      // Contribution discovery reads the same catalog fixture the command projects.
      readContributions: async () => (await import('@/plugins/projection/registry/createResolvedContributionRegistry'))
        .resolveMergedContributionRegistry({}),
      dispose: async () => undefined,
    })),
    ensureMachineIdMock: vi.fn(async () => ({ machineId: 'machine-1' })),
    openBrowserMock: vi.fn(async () => true),
    promptInputMock: vi.fn(),
    promptSecretInputMock: vi.fn(),
  };
});

vi.mock('@/persistence', () => ({
  readStoredCredentials: vi.fn(async () => ({
    token: 'test-token',
    encryption: null,
  })),
}));

vi.mock('@/ui/auth', () => ({
  ensureMachineIdForCredentials: ensureMachineIdMock,
}));

vi.mock('@/ui/openBrowser', () => ({
  openBrowser: openBrowserMock,
}));

vi.mock('@/terminal/prompts/promptInput', () => ({
  promptInput: promptInputMock,
  promptSecretInput: promptSecretInputMock,
}));

vi.mock('@/utils/time', () => ({
  delay: vi.fn(async () => undefined),
}));

vi.mock('./connect/connectedAccountDaemonClient', () => ({
  createConnectedAccountDaemonClient: createClientMock,
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  resolveMergedContributionRegistry: vi.fn(async () => ({
    catalogEntriesById: {},
    agentDefinitionsById: new Map(),
    connectedAccountDescriptors: [
      {
        pluginId: 'happier.scm.forge.github',
        provenance: 'first_party',
        source: { kind: 'bundled' },
        definition: {
          id: 'github-account',
          title: 'GitHub account',
          authentication: {
            defaultModeId: 'fine-grained-pat',
            modes: [{
              id: 'fine-grained-pat',
              kind: 'manual',
              outcomeReconciliation: 'none',
              fields: [{
                id: 'token',
                title: 'Fine-grained personal access token',
                schema: { type: 'string', minLength: 1 },
                secret: true,
              }],
            }],
          },
          capabilities: ['scmHostingToken'],
        },
      },
      {
        pluginId: 'happier.agent.codex',
        provenance: 'first_party',
        source: { kind: 'bundled' },
        definition: {
          id: 'openai-codex',
          title: 'Codex',
          authentication: {
            defaultModeId: 'oauth',
            modes: [{
              id: 'oauth',
              kind: 'oauthAuthorizationCode',
              callbackUrl: 'http://127.0.0.1:1455/callback',
              scopes: ['openid'],
              pkce: 'required',
              outcomeReconciliation: 'none',
            }],
          },
        },
      },
    ],
  })),
}));

const GITHUB_SERVICE = Object.freeze({
  pluginId: 'happier.scm.forge.github',
  localId: 'github-account',
});
const CODEX_SERVICE = Object.freeze({
  pluginId: 'happier.agent.codex',
  localId: 'openai-codex',
});

function describedGithub(accounts: readonly unknown[] = []) {
  return {
    status: 'described' as const,
    service: GITHUB_SERVICE,
    descriptor: {
      id: 'github-account',
      title: 'GitHub account',
      authentication: {
        defaultModeId: 'fine-grained-pat',
        modes: [{
          id: 'fine-grained-pat',
          kind: 'manual',
          outcomeReconciliation: 'none',
          fields: [{
            id: 'token',
            title: 'Fine-grained personal access token',
            schema: { type: 'string', minLength: 1 },
            secret: true,
          }],
        }],
      },
      capabilities: ['scmHostingToken'],
    },
    generation: 'generation-1',
    immutableGenerationId: 'artifact-1',
    accounts,
  };
}

function describedCodex(
  outcomeReconciliation: 'none' | 'providerCheck' = 'none',
) {
  return {
    status: 'described' as const,
    service: CODEX_SERVICE,
    descriptor: {
      id: 'openai-codex',
      title: 'Codex',
      authentication: {
        defaultModeId: 'oauth',
        modes: [{
          id: 'oauth',
          kind: 'oauthAuthorizationCode',
          callbackUrl: 'http://127.0.0.1:1455/callback',
          scopes: ['openid'],
          pkce: 'required',
          outcomeReconciliation,
        }],
      },
    },
    generation: 'generation-1',
    immutableGenerationId: 'artifact-1',
    accounts: [],
  };
}

describe('handleConnectCommand daemon facade', () => {
  beforeEach(() => {
    authenticateMock.mockResolvedValue({ status: 'cancelled', attemptId: 'attempt-1' });
  });
  afterEach(() => {
    authenticateMock.mockReset();
    controlMock.mockReset();
    createClientMock.mockClear();
    ensureMachineIdMock.mockClear();
    openBrowserMock.mockClear();
    promptInputMock.mockReset();
    promptSecretInputMock.mockReset();
    vi.restoreAllMocks();
  });

  it('reconnects one exact qualified account without sending a mode id', async () => {
    controlMock.mockResolvedValueOnce(describedGithub([{
      ref: { service: GITHUB_SERVICE, accountId: 'account-7' },
      status: 'needs_reauth',
      authenticationModeId: 'fine-grained-pat',
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      configurationReady: true,
      configurationRevision: null,
      scopes: [],
    }]));
    authenticateMock
      .mockResolvedValueOnce({ status: 'awaitingManual', attemptId: 'attempt-7' })
      .mockResolvedValueOnce({
        status: 'connected',
        attemptId: 'attempt-7',
        account: { service: GITHUB_SERVICE, accountId: 'account-7' },
      });
    promptSecretInputMock.mockResolvedValueOnce('replacement-secret');
    const output = captureConsoleLogAndMuteStdout();
    try {
      const { handleConnectCommand } = await import('./connect');
      await handleConnectCommand(['github', '--account', 'account-7']);

      expect(authenticateMock).toHaveBeenNthCalledWith(1, {
        operation: 'beginReconnect',
        account: { service: GITHUB_SERVICE, accountId: 'account-7' },
      });
      expect(authenticateMock.mock.calls[0]?.[0]).not.toHaveProperty('modeId');
    } finally {
      output.restore();
    }
  });

  it('prompts fields from the explicitly selected manual mode', async () => {
    const described = describedGithub();
    controlMock.mockResolvedValueOnce({
      ...described,
      descriptor: {
        ...described.descriptor,
        authentication: {
          defaultModeId: 'fine-grained-pat',
          modes: [
            ...described.descriptor.authentication.modes,
            {
              id: 'service-account',
              kind: 'manual',
              outcomeReconciliation: 'none',
              fields: [{
                id: 'credentialsJson',
                title: 'Service-account JSON',
                schema: { type: 'string', minLength: 1 },
                secret: true,
              }],
            },
          ],
        },
      },
    });
    authenticateMock
      .mockResolvedValueOnce({ status: 'awaitingManual', attemptId: 'attempt-mode' })
      .mockResolvedValueOnce({
        status: 'connected',
        attemptId: 'attempt-mode',
        account: { service: GITHUB_SERVICE, accountId: 'account-mode' },
      });
    promptSecretInputMock.mockResolvedValueOnce('{"client_email":"agent@example.com"}');
    const output = captureConsoleLogAndMuteStdout();
    try {
      const { handleConnectCommand } = await import('./connect');
      await handleConnectCommand(['github', '--mode', 'service-account']);

      expect(authenticateMock).toHaveBeenNthCalledWith(2, {
        operation: 'submitManual',
        attemptId: 'attempt-mode',
        fields: {
          credentialsJson: '{"client_email":"agent@example.com"}',
        },
      });
    } finally {
      output.restore();
    }
  });

  it('continues a pending OAuth provider check through reconciliation rather than device polling', async () => {
    controlMock.mockResolvedValueOnce(describedCodex('providerCheck'));
    authenticateMock
      .mockResolvedValueOnce({
        status: 'awaitingOAuth',
        attemptId: 'attempt-oauth',
        authorizationUrl: 'https://auth.example.test/authorize',
        callbackUrl: 'http://127.0.0.1:1455/callback',
      })
      .mockResolvedValueOnce({
        status: 'outcomeUnknown',
        attemptId: 'attempt-oauth',
        diagnostic: { code: 'provider_response_lost' },
      })
      .mockResolvedValueOnce({
        status: 'pending',
        attemptId: 'attempt-oauth',
        retryAfterMs: 250,
      })
      .mockResolvedValueOnce({
        status: 'connected',
        attemptId: 'attempt-oauth',
        account: { service: CODEX_SERVICE, accountId: 'account-oauth' },
      });
    promptInputMock.mockResolvedValueOnce(
      'http://127.0.0.1:1455/callback?code=oauth-code&state=oauth-state',
    );
    const output = captureConsoleLogAndMuteStdout();
    try {
      const { handleConnectCommand } = await import('./connect');
      await handleConnectCommand(['openai-codex', '--oauth']);

      expect(authenticateMock).toHaveBeenNthCalledWith(3, {
        operation: 'reconcile',
        attemptId: 'attempt-oauth',
      });
      expect(authenticateMock).toHaveBeenNthCalledWith(4, {
        operation: 'reconcile',
        attemptId: 'attempt-oauth',
      });
    } finally {
      output.restore();
    }
  });

  it('continues device authorization through pending results to the connected account', async () => {
    vi.stubEnv('HAPPIER_NO_ANIMATION', '1');
    const described = describedCodex();
    controlMock.mockResolvedValueOnce({
      ...described,
      descriptor: {
        ...described.descriptor,
        authentication: {
          defaultModeId: 'device',
          modes: [{ id: 'device', kind: 'oauthDeviceCode', scopes: ['openid'], outcomeReconciliation: 'none' }],
        },
      },
    });
    authenticateMock
      .mockResolvedValueOnce({
        status: 'awaitingDeviceAuthorization',
        attemptId: 'attempt-device',
        userCode: 'ABCD-1234',
        verificationUri: 'https://auth.example.test/device',
        pollIntervalMs: 250,
      })
      .mockResolvedValueOnce({ status: 'pending', attemptId: 'attempt-device', retryAfterMs: 250 })
      .mockResolvedValueOnce({
        status: 'connected',
        attemptId: 'attempt-device',
        account: { service: CODEX_SERVICE, accountId: 'account-device' },
      });
    const output = captureConsoleLogAndMuteStdout();
    try {
      const { handleConnectCommand } = await import('./connect');
      await handleConnectCommand(['openai-codex', '--device', '--no-open']);

      const rendered = output.logs.join('\n').replace(/\u001b\[[0-9;]*m/gu, '');
      expect(rendered).toContain('ABCD-1234');
      expect(rendered).toContain('account-device');
      expect(authenticateMock).toHaveBeenNthCalledWith(3, {
        operation: 'pollDevice',
        attemptId: 'attempt-device',
      });
      expect(authenticateMock).not.toHaveBeenCalledWith(expect.objectContaining({ operation: 'cancel' }));
    } finally {
      output.restore();
      vi.unstubAllEnvs();
    }
  });

  it('reads status from daemon-described qualified accounts', async () => {
    controlMock
      .mockResolvedValueOnce(describedGithub([{
        ref: { service: GITHUB_SERVICE, accountId: 'account-1' },
        status: 'connected',
        authenticationModeId: 'fine-grained-pat',
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        configurationReady: true,
        configurationRevision: null,
        scopes: [],
        providerIdentity: { email: 'dev@example.com' },
      }]))
      .mockResolvedValueOnce(describedCodex());
    const output = captureConsoleLogAndMuteStdout();
    try {
      const { handleConnectCommand } = await import('./connect');
      await handleConnectCommand(['status']);

      const rendered = output.logs.join('\n');
      expect(rendered).toContain('GitHub account: connected');
      expect(rendered).toContain('dev@example.com');
      expect(rendered).toContain('Codex: not connected');
    } finally {
      output.restore();
    }
  });
});
