import { afterEach, describe, expect, it, vi } from 'vitest';

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
    })),
    ensureMachineIdMock: vi.fn(async () => ({ machineId: 'machine-1' })),
    openBrowserMock: vi.fn(async () => true),
    promptInputMock: vi.fn(),
    promptSecretInputMock: vi.fn(),
  };
});

vi.mock('@/persistence', () => ({
  readCredentials: vi.fn(async () => ({
    token: 'test-token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array([1, 2, 3]),
    },
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
        pluginId: 'happier.scm.hosting.github',
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
  pluginId: 'happier.scm.hosting.github',
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

  it('submits manual fields through the machine-owned attempt without a direct credential write', async () => {
    controlMock.mockResolvedValueOnce(describedGithub());
    authenticateMock
      .mockResolvedValueOnce({ status: 'awaitingManual', attemptId: 'attempt-1' })
      .mockResolvedValueOnce({
        status: 'connected',
        attemptId: 'attempt-1',
        account: { service: GITHUB_SERVICE, accountId: 'account-1' },
      });
    promptSecretInputMock.mockResolvedValueOnce('github_pat_secret');
    const output = captureConsoleLogAndMuteStdout();
    try {
      const { handleConnectCommand } = await import('./connect');
      await handleConnectCommand(['github', '--token']);

      expect(controlMock).toHaveBeenCalledWith({
        operation: 'describeService',
        service: GITHUB_SERVICE,
      });
      expect(authenticateMock).toHaveBeenNthCalledWith(1, {
        operation: 'beginConnect',
        service: GITHUB_SERVICE,
        modeId: 'fine-grained-pat',
      });
      expect(authenticateMock).toHaveBeenNthCalledWith(2, {
        operation: 'submitManual',
        attemptId: 'attempt-1',
        fields: { token: 'github_pat_secret' },
      });
      expect(output.logs.join('\n')).not.toContain('github_pat_secret');
    } finally {
      output.restore();
    }
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

  it('returns only callback facts for OAuth and never accepts PKCE custody', async () => {
    controlMock.mockResolvedValueOnce(describedCodex());
    authenticateMock
      .mockResolvedValueOnce({
        status: 'awaitingOAuth',
        attemptId: 'attempt-oauth',
        authorizationUrl: 'https://auth.example.test/authorize',
        callbackUrl: 'http://127.0.0.1:1455/callback',
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

      expect(openBrowserMock).toHaveBeenCalledWith(
        'https://auth.example.test/authorize',
      );
      expect(authenticateMock).toHaveBeenNthCalledWith(2, {
        operation: 'completeOAuth',
        attemptId: 'attempt-oauth',
        completion: {
          code: 'oauth-code',
          callbackUrl: 'http://127.0.0.1:1455/callback',
          state: 'oauth-state',
        },
      });
      expect(authenticateMock.mock.calls[1]?.[0]).not.toHaveProperty(
        'completion.verifier',
      );
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
