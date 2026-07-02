import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import type { ApiClient } from '@/api/api';

type RegisterPlainCredentialParams = Parameters<ApiClient['registerConnectedServiceCredentialPlain']>[0];
type RegisterSealedCredentialParams = Parameters<ApiClient['registerConnectedServiceCredentialSealed']>[0];

const {
  promptInputMock,
  promptSecretInputMock,
  registerPlainMock,
  registerSealedMock,
  getAccountEncryptionModeMock,
  cloudAuthenticateMock,
} = vi.hoisted(() => ({
  promptInputMock: vi.fn(async () => 'github_pat_123'),
  promptSecretInputMock: vi.fn(async () => 'github_pat_123'),
  registerPlainMock: vi.fn<(params: RegisterPlainCredentialParams) => Promise<void>>(async () => {}),
  registerSealedMock: vi.fn<(params: RegisterSealedCredentialParams) => Promise<void>>(async () => {}),
  getAccountEncryptionModeMock: vi.fn<() => Promise<'plain' | 'e2ee'>>(async () => 'plain'),
  cloudAuthenticateMock: vi.fn(async () => ({})),
}));

vi.mock('@/persistence', () => ({
  readCredentials: vi.fn(async () => ({
    token: 'test-token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array([1, 2, 3]),
    },
  })),
}));

vi.mock('@/terminal/prompts/promptInput', () => ({
  promptInput: promptInputMock,
  promptSecretInput: promptSecretInputMock,
}));

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: vi.fn(async () => ({
      listConnectedServiceProfiles: vi.fn(async () => ({
        profiles: [
          {
            status: 'connected',
            providerEmail: 'plugin@example.com',
          },
        ],
      })),
      getAccountEncryptionMode: getAccountEncryptionModeMock,
      registerConnectedServiceCredentialPlain: registerPlainMock,
      registerConnectedServiceCredentialSealed: registerSealedMock,
    })),
  },
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/projection/registry/createResolvedContributionRegistry')>();
  return {
    ...actual,
    resolveMergedContributionRegistry: vi.fn(async () => ({
      catalogEntriesById: {
        'plugin-target': {
          id: 'plugin-target',
          cliSubcommand: 'plugin-target',
          vendorResumeSupport: 'unsupported',
          getCloudConnectTarget: async () => ({
            id: 'plugin-target',
            displayName: 'Plugin Target',
            vendorDisplayName: 'Plugin Target',
            vendorKey: 'openai',
            status: 'wired',
            authenticate: cloudAuthenticateMock,
          }),
        },
      },
      providerDefinitionsById: new Map([
        [
          'plugin-target',
          {
            definition: {
              id: 'plugin-target',
              auth: {
                connectedServiceCompatibility: ['openai'],
              },
            },
          },
        ],
      ]),
      connectedAccountDescriptors: [
        {
          definition: {
            id: 'bitbucket',
            kind: 'auth.connectedAccount',
            version: '1',
            displayKey: 'connectedServices.serviceNames.bitbucket',
            aliases: ['bitbucket'],
            credentialKinds: ['token'],
            defaultCredentialKind: 'token',
            connectModes: [
              {
                targetId: 'bitbucket',
                mode: 'token',
                credentialKind: 'token',
                default: true,
                tokenKind: 'api-token',
              },
            ],
            tokenSetup: {
              tokenKind: 'api-token',
              promptLabelKey: 'connectedServices.tokenPrompts.bitbucketApiToken',
              missingValueErrorKey: 'connectedServices.tokenPrompts.errors.missingApiToken',
              setupUrl: 'https://bitbucket.org/account/settings/app-passwords/',
              credentialPayloadKind: 'bitbucket_basic_auth',
              identity: {
                kind: 'email_or_username',
                promptLabelKey: 'connectedServices.tokenPrompts.bitbucketEmailOrUsername',
                missingValueErrorKey: 'connectedServices.tokenPrompts.errors.missingBitbucketEmailOrUsername',
              },
            },
            ui: {
              connectCommand: 'happier connect bitbucket --token',
              oauthAddActionModes: [],
            },
            materialization: {
              materializationKinds: ['scm_hosting_basic_auth'],
              hookKey: 'connectedServices.materialization.bitbucketScmHostingBasicAuth',
            },
            quota: { capabilityIds: [] },
          },
        },
        {
          definition: {
            id: 'openai',
            kind: 'auth.connectedAccount',
            version: '1',
            displayKey: 'connectedServices.serviceNames.openai',
            aliases: ['openai'],
            credentialKinds: ['oauth'],
            defaultCredentialKind: 'oauth',
            connectModes: [
              {
                targetId: 'plugin-target',
                mode: 'oauth',
                credentialKind: 'oauth',
                default: true,
              },
            ],
            oauth: {
              publicClientId: { envKey: 'TEST_OPENAI_CLIENT_ID', defaultValue: 'test-client' },
              tokenUrl: { envKey: 'TEST_OPENAI_TOKEN_URL', defaultValue: 'https://example.test/token' },
              authorization: {
                endpointUrl: 'https://example.test/authorize',
                defaultRedirectUri: 'http://localhost/callback',
                scopes: ['openid'],
                pkce: true,
                query: { responseType: 'code', extraParams: {} },
              },
              refresh: { body: 'json', hookKey: 'test.refresh' },
              payloadMapping: {
                accessTokenField: 'access_token',
                refreshTokenField: 'refresh_token',
              },
            },
            ui: {
              connectCommand: 'happier connect plugin-target',
              oauthAddActionModes: [],
            },
            materialization: { materializationKinds: [] },
            quota: { capabilityIds: [] },
          },
        },
      ],
    })),
  };
});

describe('handleConnectCommand help', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    promptInputMock.mockClear();
    promptSecretInputMock.mockClear();
    registerPlainMock.mockClear();
    registerSealedMock.mockClear();
    getAccountEncryptionModeMock.mockClear();
    cloudAuthenticateMock.mockReset();
    cloudAuthenticateMock.mockResolvedValue({});
  });

  it('renders merged-registry connect targets in help output', async () => {
    const output = captureConsoleLogAndMuteStdout();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { handleConnectCommand } = await import('./connect');
      await handleConnectCommand(['help']);

      const rendered = output.logs.join('\n');
      expect(rendered).toContain('happier connect plugin-target');
      expect(rendered).not.toContain('happier connect codex --device');
      expect(rendered).not.toContain('happier connect claude --setup-token');
      expect(rendered).not.toContain('happier connect gemini --oauth');
    } finally {
      errorSpy.mockRestore();
      output.restore();
    }
  });

  it('uses merged-registry provider metadata for plugin target status', async () => {
    const output = captureConsoleLogAndMuteStdout();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { handleConnectCommand } = await import('./connect');
      await handleConnectCommand(['status']);

      const rendered = output.logs.join('\n');
      expect(rendered).toContain('Plugin Target: connected');
      expect(rendered).not.toContain('Plugin Target: not supported');
      expect(rendered).toContain('To connect a vendor, run: happier connect <vendor>');
      expect(rendered).not.toContain('Example: happier connect gemini');
    } finally {
      errorSpy.mockRestore();
      output.restore();
    }
  });

  it('connects descriptor-only GitHub token target through plaintext credential storage', async () => {
    const output = captureConsoleLogAndMuteStdout();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    try {
      const { handleConnectCommand } = await import('./connect');
      await expect(handleConnectCommand(['github', '--token', '--profile', 'work'])).rejects.toThrow('exit:0');

      expect(promptInputMock).not.toHaveBeenCalled();
      expect(promptSecretInputMock).toHaveBeenCalled();
      expect(getAccountEncryptionModeMock).toHaveBeenCalled();
      expect(registerPlainMock).toHaveBeenCalledWith(expect.objectContaining({
        serviceId: 'github',
        profileId: 'work',
        content: {
          t: 'plain',
          v: expect.objectContaining({
            serviceId: 'github',
            profileId: 'work',
            kind: 'token',
            expiresAt: null,
            token: expect.objectContaining({ token: 'github_pat_123' }),
          }),
        },
      }));
      const storedRecord = registerPlainMock.mock.calls[0]?.[0]?.content?.v;
      expect(storedRecord && typeof storedRecord === 'object' && 'oauth' in storedRecord).toBe(false);
      expect(registerSealedMock).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      output.restore();
    }
  });

  it('connects descriptor-only Bitbucket API token target with email metadata', async () => {
    promptInputMock.mockResolvedValueOnce('dev@example.com');
    promptSecretInputMock.mockResolvedValueOnce('bitbucket-token-secret');
    const output = captureConsoleLogAndMuteStdout();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    try {
      const { handleConnectCommand } = await import('./connect');
      await expect(handleConnectCommand(['bitbucket', '--token', '--profile', 'work'])).rejects.toThrow('exit:0');

      expect(promptInputMock).toHaveBeenCalledWith(expect.stringMatching(/Bitbucket/i));
      expect(promptSecretInputMock).toHaveBeenCalledWith(expect.stringMatching(/Bitbucket/i));
      expect(registerPlainMock).toHaveBeenCalledWith(expect.objectContaining({
        serviceId: 'bitbucket',
        profileId: 'work',
        content: {
          t: 'plain',
          v: expect.objectContaining({
            serviceId: 'bitbucket',
            profileId: 'work',
            kind: 'token',
            expiresAt: null,
            token: expect.objectContaining({
              token: 'bitbucket-token-secret',
              providerEmail: 'dev@example.com',
              providerAccountId: 'dev@example.com',
            }),
          }),
        },
      }));
      const rendered = output.logs.join('\n');
      expect(rendered).not.toContain('bitbucket-token-secret');
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      output.restore();
    }
  });

  it('accepts typed plugin custom-auth success without treating it as a raw OAuth payload', async () => {
    cloudAuthenticateMock.mockResolvedValueOnce({
      ok: true,
      credentialRef: 'openai/work',
      diagnostics: [
        {
          code: 'stored-by-plugin',
          message: 'accessToken=secret-plugin-token',
        },
      ],
    });
    const output = captureConsoleLogAndMuteStdout();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    try {
      const { handleConnectCommand } = await import('./connect');
      await expect(handleConnectCommand(['plugin-target', '--profile', 'work'])).rejects.toThrow('exit:0');

      expect(cloudAuthenticateMock).toHaveBeenCalledWith(expect.objectContaining({
        profileId: 'work',
        serviceId: 'openai',
      }));
      expect(registerPlainMock).not.toHaveBeenCalled();
      expect(registerSealedMock).not.toHaveBeenCalled();
      expect(output.logs.join('\n')).not.toContain('secret-plugin-token');
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      output.restore();
    }
  });

  it('connects descriptor-only GitHub token target through sealed credential storage for E2EE accounts', async () => {
    getAccountEncryptionModeMock.mockResolvedValueOnce('e2ee');
    promptSecretInputMock.mockResolvedValueOnce('github_pat_secret');
    const output = captureConsoleLogAndMuteStdout();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    try {
      const { handleConnectCommand } = await import('./connect');
      await expect(handleConnectCommand(['github', '--token', '--profile', 'work'])).rejects.toThrow('exit:0');

      expect(promptSecretInputMock).toHaveBeenCalled();
      expect(getAccountEncryptionModeMock).toHaveBeenCalled();
      expect(registerSealedMock).toHaveBeenCalledWith(expect.objectContaining({
        serviceId: 'github',
        profileId: 'work',
        sealed: expect.objectContaining({
          format: 'account_scoped_v1',
          ciphertext: expect.any(String),
        }),
        metadata: expect.objectContaining({
          kind: 'token',
        }),
      }));
      expect(registerPlainMock).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      output.restore();
    }
  });
});
