import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  parseTerminalConnectLinkV4Parameters,
  sealTerminalProvisioningV3TokenOnlyPayload,
  type HomeConnectionDescriptorV1,
} from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { setStdioTtyForTest } from '@/testkit/process/stdio';

const runTailscaleServeStatusMock = vi.fn<
  (params: Readonly<{ timeoutMs: number; env: NodeJS.ProcessEnv; tailscaleBin: string }>) => Promise<string>
>();

const displayQRCodeMock = vi.fn<(url: string) => void>();
const acquireTerminalAuthEnrollmentRuntimeMock = vi.fn();
const machineRegistrationMocks = vi.hoisted(() => ({
  apiCreate: vi.fn(async () => ({})),
  ensure: vi.fn(async ({ machineId }: { machineId: string }) => ({
    machine: { id: machineId },
    machineId,
    didRotateMachineId: false,
  })),
}));
const deterministicRandomByte = 7;
type ServerFeaturesSnapshotMock =
  | Readonly<{
      status: 'ready';
      provenance?: 'authenticated' | 'public';
      features: Readonly<{
        capabilities: Readonly<{
          serverIdentity: Readonly<{ serverIdentityId: string }>;
        }>;
        homeConnectionDescriptor?: HomeConnectionDescriptorV1;
      }>;
    }>
  | Readonly<{ status: 'unsupported'; reason: 'endpoint_missing' }>;
const fetchServerFeaturesSnapshotMock = vi.fn<
  (params: Readonly<{ serverUrl: string; token?: string }>) => Promise<ServerFeaturesSnapshotMock>
>(async () => ({
  status: 'ready' as const,
  features: {
    capabilities: {
      serverIdentity: { serverIdentityId: 'srv_interactive_auth_home' },
    },
  },
}));
vi.mock('@/integrations/tailscale/tailscaleCommand', () => ({
  runTailscaleServeStatus: (params: Readonly<{ timeoutMs: number; env: NodeJS.ProcessEnv; tailscaleBin: string }>) =>
    runTailscaleServeStatusMock(params),
}));

vi.mock('./qrcode', () => ({
  displayQRCode: (url: string) => displayQRCodeMock(url),
}));

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: fetchServerFeaturesSnapshotMock,
}));

vi.mock('@/auth/terminalAuthEnrollmentRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/auth/terminalAuthEnrollmentRuntime')>();
  return {
    acquireTerminalAuthEnrollmentRuntime: (...args: Parameters<typeof actual.acquireTerminalAuthEnrollmentRuntime>) =>
      'descriptor' in args[0] && !args[0].descriptor
        ? actual.acquireTerminalAuthEnrollmentRuntime(...args)
        : acquireTerminalAuthEnrollmentRuntimeMock(...args),
  };
});
vi.mock('@/api/api', () => ({
  ApiClient: { create: machineRegistrationMocks.apiCreate },
}));
vi.mock('@/api/machine/ensureMachineRegistered', () => ({
  ensureMachineRegistered: machineRegistrationMocks.ensure,
}));

// This suite exercises the real profile/target/adoption owner.
vi.unmock('@/server/serverProfiles');

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: (length: number) => Buffer.alloc(length, 7),
  };
});

type AxiosRequestResponse = { state: 'requested' };
type AxiosClaimResponse = { state: 'authorized'; token: string; response: string };
type AxiosStatusResponse = { status: 'authorized' };
type AxiosResponse<T> = { data: T };

type AxiosLike = {
  post: (url: string, body?: unknown) => Promise<AxiosResponse<AxiosRequestResponse | AxiosClaimResponse | unknown>>;
  get: (url: string) => Promise<AxiosResponse<AxiosStatusResponse | unknown>>;
};

let capturedPublicKeyBase64: string | null = null;
let claimServerIdentityId = 'srv_interactive_auth_home';
let beforeStatusResponse: (() => Promise<void>) | null = null;

function sealCurrentTerminalResponse(recipientPublicKeyBase64: string): string {
  const renderedPairingLink = vi.mocked(console.log).mock.calls
    .flat()
    .map((value) => String(value))
    .reverse()
    .find((value) => value.includes('pairingSecret=') && value.includes('createdAt=') && value.includes('expiresAt='));
  const opaqueLink = vi.mocked(console.log).mock.calls
    .flat()
    .map((value) => String(value))
    .reverse()
    .find((value) => value.includes('v4='));
  const opaqueParameters = opaqueLink
    ? new URL(opaqueLink).hash.replace(/^#/u, '') || new URL(opaqueLink).search.replace(/^\?/u, '')
    : '';
  const opaquePairing = opaqueParameters
    ? parseTerminalConnectLinkV4Parameters(opaqueParameters)?.pairing
    : undefined;
  const createdAtMs = opaquePairing?.createdAtMs
    ?? Number(renderedPairingLink?.match(/[?&#]createdAt=(\d+)/u)?.[1]);
  const expiresAtMs = opaquePairing?.expiresAtMs
    ?? Number(renderedPairingLink?.match(/[?&#]expiresAt=(\d+)/u)?.[1]);
  const pairingSecretB64Url = opaquePairing?.secretB64Url
    ?? renderedPairingLink?.match(/[?&#]pairingSecret=([^&#]+)/u)?.[1];
  if (!Number.isSafeInteger(createdAtMs) || !Number.isSafeInteger(expiresAtMs) || !pairingSecretB64Url) {
    throw new Error('Expected authentication to render its pairing context before the claim');
  }
  return Buffer.from(sealTerminalProvisioningV3TokenOnlyPayload({
    terminalEphemeralPublicKey: new Uint8Array(Buffer.from(recipientPublicKeyBase64, 'base64')),
    pairingSecret: new Uint8Array(Buffer.from(decodeURIComponent(pairingSecretB64Url), 'base64url')),
    createdAtMs,
    expiresAtMs,
    randomBytes: (length) => new Uint8Array(length).fill(9),
  })).toString('base64');
}

vi.mock('axios', async () => {
  const axios: AxiosLike = {
    post: vi.fn(async (url: string, body?: unknown) => {
      if (url.endsWith('/v1/auth/request')) {
        const publicKey = (body as { publicKey?: unknown } | undefined)?.publicKey;
        capturedPublicKeyBase64 = typeof publicKey === 'string' ? publicKey : '';
        return { data: { state: 'requested' } };
      }
      if (url.endsWith('/v1/auth/request/claim')) {
        const claimBody = body as { publicKey?: unknown } | undefined;
        const publicKey = typeof claimBody?.publicKey === 'string' ? claimBody.publicKey : capturedPublicKeyBase64 ?? '';
        return {
          data: {
            state: 'authorized',
            token: 'tok',
            response: sealCurrentTerminalResponse(publicKey),
            serverIdentityId: claimServerIdentityId,
          },
        };
      }
      throw new Error(`Unexpected axios.post URL: ${url}`);
    }),
    get: vi.fn(async (url: string) => {
      if (url.endsWith('/v1/auth/request/status')) {
        await beforeStatusResponse?.();
        return { data: { status: 'authorized' } };
      }
      throw new Error(`Unexpected axios.get URL: ${url}`);
    }),
  };
  return { default: axios };
});

describe.sequential('doAuth (non-interactive)', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_NO_BROWSER_OPEN',
    'HAPPIER_AUTH_POLL_INTERVAL_MS',
    'HAPPIER_AUTH_METHOD',
    'HAPPIER_TAILSCALE_AUTO_PUBLIC_URL',
  ] as const;

  beforeEach(() => {
    claimServerIdentityId = 'srv_interactive_auth_home';
    capturedPublicKeyBase64 = null;
    beforeStatusResponse = null;
    displayQRCodeMock.mockClear();
    fetchServerFeaturesSnapshotMock.mockClear();
    acquireTerminalAuthEnrollmentRuntimeMock.mockReset();
    machineRegistrationMocks.apiCreate.mockClear();
    machineRegistrationMocks.ensure.mockClear();
    runTailscaleServeStatusMock.mockReset();
  });

  it('turns Ctrl-C during setup-managed auth wait into typed cancellation without exiting zero', async () => {
    const home = await createTempDir('happier-cli-auth-setup-cancel-');
    const envScope = createEnvKeyScope(envKeys);
    const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    const output = captureConsoleLogAndMuteStdout();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${String(code ?? '')}`);
    }) as typeof process.exit);
    beforeStatusResponse = async () => {
      beforeStatusResponse = null;
      process.emit('SIGINT');
    };

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'https://server.example.test',
        HAPPIER_WEBAPP_URL: 'https://webapp.example.test',
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_AUTH_METHOD: undefined,
      });
      vi.resetModules();
      const { doAuth } = await import('./auth');

      await expect(doAuth({ callerIntent: 'setup-managed' })).rejects.toMatchObject({
        code: 'authentication_cancelled',
      });
      expect(exitSpy).not.toHaveBeenCalled();
      expect(output.logs.join('\n')).toContain('Authentication cancelled.');
    } finally {
      exitSpy.mockRestore();
      output.restore();
      restoreTty();
      envScope.restore();
      await removeTempDir(home);
    }
  }, 15_000);

  it('keeps descriptor-first Iroh through credential issuance and machine registration, then emits only V4 links', async () => {
    const home = await createTempDir('happier-cli-auth-descriptor-iroh-');
    const envScope = createEnvKeyScope(envKeys);
    const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    const output = captureConsoleLogAndMuteStdout();
    const events: string[] = [];
    const close = vi.fn(async () => { events.push('close'); });
    machineRegistrationMocks.ensure.mockImplementationOnce(async ({ machineId }: { machineId: string }) => {
      events.push('register');
      return { machine: { id: machineId }, machineId, didRotateMachineId: false };
    });
    const descriptor: HomeConnectionDescriptorV1 = {
      v: 1,
      homeServerIdentityId: 'srv_interactive_auth_home',
      canonicalServerUrl: 'http://localhost:3010',
      revision: 7,
      endpoints: [{ kind: 'iroh', endpointId: 'd'.repeat(64) }],
    };
    acquireTerminalAuthEnrollmentRuntimeMock.mockResolvedValue({
      ok: true,
      runtime: {
        runtimeOrigin: 'http://127.0.0.1:48123',
        carrier: 'iroh',
        authenticatedCredentialDestination: { kind: 'iroh', endpointId: 'd'.repeat(64) },
      },
      close,
    });
    fetchServerFeaturesSnapshotMock.mockResolvedValue({
      status: 'ready',
      features: {
        capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } },
        homeConnectionDescriptor: descriptor,
      },
    });

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: 'https://webapp.example.test',
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
      });
      vi.resetModules();
      const { addServerProfile, adoptServerProfileHomeConnectionDescriptor } = await import('@/server/serverProfiles');
      const profile = await addServerProfile({
        name: 'iroh-home',
        serverUrl: descriptor.canonicalServerUrl,
        webappUrl: 'https://webapp.example.test',
        use: true,
      });
      await adoptServerProfileHomeConnectionDescriptor({
        descriptor,
        expectedProfileId: profile.id,
        observation: 'exact',
      });
      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      const { authAndSetupMachineIfNeeded } = await import('./auth');
      await expect(authAndSetupMachineIfNeeded({ callerIntent: 'setup-managed' })).resolves.toMatchObject({
        credentials: { token: 'tok' },
        machineId: expect.any(String),
      });

      expect(acquireTerminalAuthEnrollmentRuntimeMock).toHaveBeenCalledOnce();
      expect(acquireTerminalAuthEnrollmentRuntimeMock.mock.calls[0]?.[0]).toEqual(descriptor);
      expect(acquireTerminalAuthEnrollmentRuntimeMock.mock.calls[0]?.[1]).toBe('iroh');
      expect(runTailscaleServeStatusMock).not.toHaveBeenCalled();
      expect(fetchServerFeaturesSnapshotMock).toHaveBeenCalledWith({ serverUrl: 'http://127.0.0.1:48123' });
      expect(output.logs.join('\n')).toContain('v4=');
      expect(output.logs.join('\n')).not.toContain('pairingSecret=');
      expect(events).toEqual(['register', 'close']);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      output.restore();
      restoreTty();
      envScope.restore();
      await removeTempDir(home);
    }
  }, 30_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints both web + mobile instructions when method is not specified', async () => {
    const home = await createTempDir('happier-cli-auth-noninteractive-');
    const envScope = createEnvKeyScope(envKeys);
    const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    const output = captureConsoleLogAndMuteStdout();
    displayQRCodeMock.mockClear();
    fetchServerFeaturesSnapshotMock.mockClear();

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'https://server.example.test',
        HAPPIER_WEBAPP_URL: 'https://webapp.example.test',
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_AUTH_METHOD: undefined,
      });

      vi.resetModules();
      const { doAuth } = await import('./auth');

      const creds = await doAuth();
      expect(creds?.token).toBe('tok');

      const out = output.logs.join('\n');
      expect(out.toLowerCase()).toContain('terminal is connected to: https://server.example.test');
      expect(out).toContain('Web app URL: https://webapp.example.test');
      expect(out.toLowerCase()).toContain('recommended: use the mobile app first');
      expect(out).toContain('Authenticated pairing v3 is required.');
      expect(out.toLowerCase()).toContain('already have a happier account on another device');
      expect(out).toContain('webapp.example.test/terminal/connect#key=');
      expect(out).toContain('happier://terminal?');
      expect(displayQRCodeMock).toHaveBeenCalledTimes(1);
      expect(displayQRCodeMock).toHaveBeenCalledWith(expect.stringContaining(
        'serverIdentityId=srv_interactive_auth_home',
      ));
      expect(fetchServerFeaturesSnapshotMock).toHaveBeenCalledTimes(2);
      expect(fetchServerFeaturesSnapshotMock).toHaveBeenNthCalledWith(1, {
        serverUrl: 'https://server.example.test',
      });
      expect(fetchServerFeaturesSnapshotMock).toHaveBeenNthCalledWith(2, {
        serverUrl: 'https://server.example.test',
        token: 'tok',
      });
    } finally {
      output.restore();
      restoreTty();
      envScope.restore();
      await removeTempDir(home);
    }
  }, 15_000);

  it('fetches and persists the authenticated exact Home descriptor only after authentication succeeds', async () => {
    const home = await createTempDir('happier-cli-auth-home-descriptor-');
    const envScope = createEnvKeyScope(envKeys);
    const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    const output = captureConsoleLogAndMuteStdout();
    const descriptor: HomeConnectionDescriptorV1 = {
      v: 1,
      homeServerIdentityId: 'srv_interactive_auth_home',
      canonicalServerUrl: 'https://server.example.test',
      revision: 3,
      endpoints: [{ kind: 'iroh', endpointId: 'c'.repeat(64) }],
    };
    fetchServerFeaturesSnapshotMock.mockResolvedValueOnce({
      status: 'ready',
      features: {
        capabilities: { serverIdentity: { serverIdentityId: 'srv_interactive_auth_home' } },
      },
    }).mockResolvedValueOnce({
      status: 'ready',
      provenance: 'authenticated',
      features: {
        capabilities: { serverIdentity: { serverIdentityId: 'srv_interactive_auth_home' } },
        homeConnectionDescriptor: descriptor,
      },
    });

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: 'https://webapp.example.test',
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
      });
      vi.resetModules();
      const { addServerProfile, listServerProfiles } = await import('@/server/serverProfiles');
      await addServerProfile({
        name: 'auth-home',
        serverUrl: 'https://server.example.test',
        webappUrl: 'https://webapp.example.test',
        use: true,
      });
      const configurationModule = await import('@/configuration');
      const { reloadConfiguration } = configurationModule;
      reloadConfiguration();
      expect(configurationModule.configuration.activeServerId).toBe('auth-home');
      const { doAuth } = await import('./auth');
      expect((await doAuth())?.token).toBe('tok');
      expect(fetchServerFeaturesSnapshotMock).toHaveBeenLastCalledWith({
        serverUrl: 'https://server.example.test',
        token: 'tok',
      });
      expect((await listServerProfiles()).map((profile) => ({
        id: profile.id,
        descriptor: profile.homeConnectionDescriptor,
      }))).toContainEqual({ id: 'auth-home', descriptor });
    } finally {
      output.restore();
      restoreTty();
      envScope.restore();
      await removeTempDir(home);
    }
  }, 30_000);

  it('does not exact-adopt a public fallback descriptor after successful authentication', async () => {
    const home = await createTempDir('happier-cli-auth-public-descriptor-');
    const envScope = createEnvKeyScope(envKeys);
    const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    const output = captureConsoleLogAndMuteStdout();
    const publicDescriptor: HomeConnectionDescriptorV1 = {
      v: 1,
      homeServerIdentityId: 'srv_interactive_auth_home',
      canonicalServerUrl: 'https://server.example.test',
      revision: 3,
      endpoints: [{ kind: 'iroh', endpointId: 'c'.repeat(64) }],
    };
    fetchServerFeaturesSnapshotMock.mockResolvedValueOnce({
      status: 'ready',
      provenance: 'public',
      features: {
        capabilities: { serverIdentity: { serverIdentityId: 'srv_interactive_auth_home' } },
      },
    }).mockResolvedValueOnce({
      status: 'ready',
      provenance: 'public',
      features: {
        capabilities: { serverIdentity: { serverIdentityId: 'srv_interactive_auth_home' } },
        homeConnectionDescriptor: publicDescriptor,
      },
    });

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: 'https://webapp.example.test',
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
      });
      vi.resetModules();
      const { addServerProfile, getServerProfile } = await import('@/server/serverProfiles');
      const profile = await addServerProfile({
        name: 'auth-home',
        serverUrl: 'https://server.example.test',
        webappUrl: 'https://webapp.example.test',
        use: true,
      });
      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();
      const { doAuth } = await import('./auth');

      expect((await doAuth())?.token).toBe('tok');
      expect((await getServerProfile(profile.id)).homeConnectionDescriptor).toBeUndefined();
    } finally {
      output.restore();
      restoreTty();
      envScope.restore();
      await removeTempDir(home);
    }
  }, 30_000);

  it('keeps prior credentials when an authenticated descriptor contradicts the selected Home', async () => {
    const home = await createTempDir('happier-cli-auth-contradictory-descriptor-');
    const envScope = createEnvKeyScope(envKeys);
    const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    const output = captureConsoleLogAndMuteStdout();
    const contradictoryDescriptor: HomeConnectionDescriptorV1 = {
      v: 1,
      homeServerIdentityId: 'srv_other_home',
      canonicalServerUrl: 'https://other.example.test',
      revision: 1,
      endpoints: [{ kind: 'https', url: 'https://other.example.test' }],
    };
    fetchServerFeaturesSnapshotMock.mockResolvedValueOnce({
      status: 'ready',
      provenance: 'public',
      features: {
        capabilities: { serverIdentity: { serverIdentityId: 'srv_interactive_auth_home' } },
      },
    }).mockResolvedValueOnce({
      status: 'ready',
      provenance: 'authenticated',
      features: {
        capabilities: { serverIdentity: { serverIdentityId: 'srv_interactive_auth_home' } },
        homeConnectionDescriptor: contradictoryDescriptor,
      },
    });

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'https://server.example.test',
        HAPPIER_WEBAPP_URL: 'https://webapp.example.test',
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_AUTH_METHOD: undefined,
      });
      vi.resetModules();
      const configurationModule = await import('@/configuration');
      configurationModule.reloadConfiguration();
      const persistence = await import('@/persistence');
      await persistence.writeCredentialsTokenOnly({ token: 'prior-token' });
      const priorCredentialBytes = await readFile(configurationModule.configuration.privateKeyFile);
      const { doAuth } = await import('./auth');

      let result: Awaited<ReturnType<typeof doAuth>> | undefined;
      let failure: unknown;
      try {
        result = await doAuth();
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeUndefined();
      expect(result).toBeNull();
      expect(await readFile(configurationModule.configuration.privateKeyFile)).toEqual(priorCredentialBytes);
      await expect(persistence.readStoredCredentials()).resolves.toMatchObject({ token: 'prior-token' });
    } finally {
      output.restore();
      restoreTty();
      envScope.restore();
      await removeTempDir(home);
    }
  }, 30_000);

  it('rejects a claimed credential from a different stable Home before persistence', async () => {
    const home = await createTempDir('happier-cli-auth-wrong-home-');
    const envScope = createEnvKeyScope(envKeys);
    const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    const output = captureConsoleLogAndMuteStdout();
    claimServerIdentityId = 'srv_other_home';

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'https://server.example.test',
        HAPPIER_WEBAPP_URL: 'https://webapp.example.test',
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_AUTH_METHOD: undefined,
      });

      vi.resetModules();
      const { doAuth } = await import('./auth');

      await expect(doAuth()).resolves.toBeNull();
      expect(output.logs.join('\n')).toContain('different Home identity');

      const { readStoredCredentials } = await import('@/persistence');
      await expect(readStoredCredentials()).resolves.toBeNull();
    } finally {
      output.restore();
      restoreTty();
      envScope.restore();
      await removeTempDir(home);
    }
  }, 15_000);

  it('does not create or publish an authentication request when the Home identity is unavailable', async () => {
    const home = await createTempDir('happier-cli-auth-no-home-identity-');
    const envScope = createEnvKeyScope(envKeys);
    const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    const output = captureConsoleLogAndMuteStdout();
    capturedPublicKeyBase64 = null;
    displayQRCodeMock.mockClear();
    fetchServerFeaturesSnapshotMock.mockResolvedValueOnce({
      status: 'unsupported',
      reason: 'endpoint_missing',
    });

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'https://server.example.test',
        HAPPIER_WEBAPP_URL: 'https://webapp.example.test',
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_AUTH_METHOD: undefined,
      });

      vi.resetModules();
      const { doAuth } = await import('./auth');

      await expect(doAuth()).resolves.toBeNull();
      expect(output.logs.join('\n')).toContain('authentication request was not created');
      expect(capturedPublicKeyBase64).toBeNull();
      expect(displayQRCodeMock).not.toHaveBeenCalled();
      expect(fetchServerFeaturesSnapshotMock).toHaveBeenCalledTimes(1);
    } finally {
      output.restore();
      restoreTty();
      envScope.restore();
      await removeTempDir(home);
    }
  }, 15_000);

  it('prefers Tailscale Serve https:// URL for QR/deep links when serverUrl is loopback and public url is unset', async () => {
    const home = await createTempDir('happier-cli-auth-noninteractive-tailscale-');
    const envScope = createEnvKeyScope(envKeys);
    const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    const output = captureConsoleLogAndMuteStdout();
    displayQRCodeMock.mockClear();

    runTailscaleServeStatusMock.mockResolvedValueOnce(
      [
        'https://my-machine.tailnet.ts.net',
        '|-- / proxy http://127.0.0.1:53545',
        '',
      ].join('\n'),
    );

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:53545',
        HAPPIER_WEBAPP_URL: 'https://webapp.example.test',
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_AUTH_METHOD: undefined,
      });

      vi.resetModules();
      const { doAuth } = await import('./auth');

      const creds = await doAuth();
      expect(creds?.token).toBe('tok');

      const out = output.logs.join('\n');
      expect(out).toContain(encodeURIComponent('https://my-machine.tailnet.ts.net'));
      expect(out).not.toContain(encodeURIComponent('http://127.0.0.1:53545'));
      expect(displayQRCodeMock).toHaveBeenCalledTimes(1);
    } finally {
      output.restore();
      restoreTty();
      envScope.restore();
      await removeTempDir(home);
      runTailscaleServeStatusMock.mockReset();
    }
  }, 15_000);

  it('refuses legacy LAN HTTP terminal authentication before creating a request', async () => {
    const home = await createTempDir('happier-cli-auth-noninteractive-lan-');
    const envScope = createEnvKeyScope(envKeys);
    const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    const output = captureConsoleLogAndMuteStdout();
    displayQRCodeMock.mockClear();

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'http://192.168.1.10:3005',
        HAPPIER_WEBAPP_URL: 'https://webapp.example.test',
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_AUTH_METHOD: undefined,
      });

      vi.resetModules();
      const { doAuth } = await import('./auth');

      const creds = await doAuth();
      expect(creds).toBeNull();

      const out = output.logs.join('\n').toLowerCase();
      expect(out).toContain('use https or loopback http');
      expect(displayQRCodeMock).not.toHaveBeenCalled();
    } finally {
      output.restore();
      restoreTty();
      envScope.restore();
      await removeTempDir(home);
    }
  }, 15_000);

  it('describes a loopback mobile-link server URL as same-machine only', async () => {
    const home = await createTempDir('happier-cli-auth-noninteractive-loopback-');
    const envScope = createEnvKeyScope(envKeys);
    const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    const output = captureConsoleLogAndMuteStdout();
    displayQRCodeMock.mockClear();

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:53545',
        HAPPIER_WEBAPP_URL: 'https://webapp.example.test',
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_TAILSCALE_AUTO_PUBLIC_URL: '0',
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_AUTH_METHOD: undefined,
      });

      vi.resetModules();
      const { doAuth } = await import('./auth');

      const creds = await doAuth();
      expect(creds?.token).toBe('tok');

      const out = output.logs.join('\n').toLowerCase();
      expect(out).toContain('server url');
      expect(out).toContain('same machine');
      expect(displayQRCodeMock).toHaveBeenCalledTimes(1);
    } finally {
      output.restore();
      restoreTty();
      envScope.restore();
      await removeTempDir(home);
    }
  }, 15_000);

  it('keeps localhost in web auth links and describes it as same-machine only', async () => {
    const home = await createTempDir('happier-cli-auth-noninteractive-web-loopback-');
    const envScope = createEnvKeyScope(envKeys);
    const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    const output = captureConsoleLogAndMuteStdout();
    displayQRCodeMock.mockClear();

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'http://localhost:3010',
        HAPPIER_WEBAPP_URL: 'http://happier-dev-auth.localhost:8082',
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_TAILSCALE_AUTO_PUBLIC_URL: '0',
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_AUTH_METHOD: 'web',
      });

      vi.resetModules();
      const { doAuth } = await import('./auth');

      const creds = await doAuth();
      expect(creds?.token).toBe('tok');

      const out = output.logs.join('\n').toLowerCase();
      expect(out).toContain(encodeURIComponent('http://localhost:3010').toLowerCase());
      expect(out).toContain('same machine');
      expect(out).not.toContain('same lan');
      expect(out).toContain('server url');
    } finally {
      output.restore();
      restoreTty();
      envScope.restore();
      await removeTempDir(home);
    }
  }, 15_000);

  it('uses apiServerUrl for auth API calls when HAPPIER_PUBLIC_SERVER_URL is set', async () => {
    const home = await createTempDir('happier-cli-auth-noninteractive-apiServerUrl-');
    const envScope = createEnvKeyScope(envKeys);
    const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    const output = captureConsoleLogAndMuteStdout();
    displayQRCodeMock.mockClear();

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:53545',
        HAPPIER_PUBLIC_SERVER_URL: 'https://my-stack.example.test',
        HAPPIER_WEBAPP_URL: 'https://webapp.example.test',
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_AUTH_METHOD: 'web',
      });

      vi.resetModules();
      const axiosModule = await import('axios');
      const axiosDefault = axiosModule.default as AxiosLike;
      (axiosDefault.post as unknown as { mockClear: () => void }).mockClear();
      (axiosDefault.get as unknown as { mockClear: () => void }).mockClear();

      const { doAuth } = await import('./auth');
      const creds = await doAuth();
      expect(creds?.token).toBe('tok');

      const postMock = axiosDefault.post as unknown as { mock: { calls: unknown[][] } };
      const getMock = axiosDefault.get as unknown as { mock: { calls: unknown[][] } };
      const postUrls = postMock.mock.calls.map((c) => String(c[0]));
      const getUrls = getMock.mock.calls.map((c) => String(c[0]));
      expect(postUrls.join('\n')).toContain('http://127.0.0.1:53545/v1/auth/request');
      expect(getUrls.join('\n')).toContain('http://127.0.0.1:53545/v1/auth/request/status');
      expect(postUrls.join('\n')).not.toContain('https://my-stack.example.test');
      expect(getUrls.join('\n')).not.toContain('https://my-stack.example.test');

      const out = output.logs.join('\n');
      expect(out).toContain(encodeURIComponent('https://my-stack.example.test'));
      expect(out).not.toContain(encodeURIComponent('http://127.0.0.1:53545'));
    } finally {
      output.restore();
      restoreTty();
      envScope.restore();
      await removeTempDir(home);
    }
  }, 15_000);

  it('does not let a daemon-published runtime origin control first-contact enrollment', async () => {
    const home = await createTempDir('happier-cli-auth-runtime-origin-');
    const envScope = createEnvKeyScope(envKeys);
    const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    const output = captureConsoleLogAndMuteStdout();
    let releaseRuntimeOrigin: (() => void) | null = null;

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'https://canonical-home.example.test',
        HAPPIER_WEBAPP_URL: 'https://webapp.example.test',
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_AUTH_METHOD: 'web',
      });

      vi.resetModules();
      const runtimeOrigin = 'http://127.0.0.1:48123';
      const httpBase = await import('@/api/client/serverHttpBaseUrl');
      releaseRuntimeOrigin = httpBase.publishServerHttpRuntimeOrigin(runtimeOrigin, 'iroh');
      const axiosModule = await import('axios');
      const axiosDefault = axiosModule.default as AxiosLike;
      (axiosDefault.post as unknown as { mockClear: () => void }).mockClear();
      (axiosDefault.get as unknown as { mockClear: () => void }).mockClear();

      const { doAuth } = await import('./auth');
      expect((await doAuth())?.token).toBe('tok');

      expect(fetchServerFeaturesSnapshotMock).toHaveBeenCalledWith({
        serverUrl: 'https://canonical-home.example.test',
      });
      const postUrls = (axiosDefault.post as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .map((call) => String(call[0]));
      const getUrls = (axiosDefault.get as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .map((call) => String(call[0]));
      expect([...postUrls, ...getUrls].every((url) => url.startsWith('https://canonical-home.example.test'))).toBe(true);
      expect([...postUrls, ...getUrls].some((url) => url.startsWith(runtimeOrigin))).toBe(false);
      expect(output.logs.join('\n')).toContain('https://canonical-home.example.test');
    } finally {
      releaseRuntimeOrigin?.();
      output.restore();
      restoreTty();
      envScope.restore();
      await removeTempDir(home);
    }
  }, 30_000);

  it('fails fast with a clear message when claim response token/response are invalid', async () => {
    const home = await createTempDir('happier-cli-auth-noninteractive-invalid-claim-');
    const envScope = createEnvKeyScope(envKeys);
    const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    const output = captureConsoleLogAndMuteStdout();

    const axiosModule = await import('axios');
    const axiosDefault = axiosModule.default as AxiosLike;
    const originalPost = axiosDefault.post;

    try {
      axiosDefault.post = vi.fn(async (url: string, body?: unknown) => {
        if (url.endsWith('/v1/auth/request')) {
          const publicKey = (body as { publicKey?: unknown } | undefined)?.publicKey;
          capturedPublicKeyBase64 = typeof publicKey === 'string' ? publicKey : '';
          return { data: { state: 'requested' } };
        }
        if (url.endsWith('/v1/auth/request/claim')) {
          return {
            data: {
              state: 'authorized',
              token: 123,
              response: null,
            },
          };
        }
        throw new Error(`Unexpected axios.post URL: ${url}`);
      }) as AxiosLike['post'];

      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'https://server.example.test',
        HAPPIER_WEBAPP_URL: 'https://webapp.example.test',
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_AUTH_METHOD: undefined,
      });

      vi.resetModules();
      const { doAuth } = await import('./auth');
      const creds = await doAuth();

      expect(creds).toBeNull();
      expect(output.logs.join('\n')).toContain('Unexpected response from server. Please try again.');
    } finally {
      axiosDefault.post = originalPost;
      output.restore();
      restoreTty();
      envScope.restore();
      await removeTempDir(home);
    }
  }, 15_000);

  it('prints only the mobile link when mobile is explicitly selected', async () => {
    const home = await createTempDir('happier-cli-auth-mobile-');
    const envScope = createEnvKeyScope(envKeys);
    const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    const output = captureConsoleLogAndMuteStdout();
    displayQRCodeMock.mockClear();

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'https://server.example.test',
        HAPPIER_WEBAPP_URL: 'https://webapp.example.test',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_AUTH_METHOD: 'mobile',
      });
      vi.resetModules();
      const { doAuth } = await import('./auth');

      expect((await doAuth())?.token).toBe('tok');
      expect(displayQRCodeMock).toHaveBeenCalledTimes(1);
      const out = output.logs.join('\n');
      expect(out).toContain('Connect this computer');
      expect(out).toContain('happier://terminal?');
      expect(out).not.toContain('webapp.example.test/terminal/connect#key=');
    } finally {
      output.restore();
      restoreTty();
      envScope.restore();
      await removeTempDir(home);
    }
  }, 15_000);

  it('does not print a QR code when method is web', async () => {
    const home = await createTempDir('happier-cli-auth-noninteractive-web-');
    const envScope = createEnvKeyScope(envKeys);
    const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    const output = captureConsoleLogAndMuteStdout();
    displayQRCodeMock.mockClear();

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'https://server.example.test',
        HAPPIER_WEBAPP_URL: 'https://webapp.example.test',
        HAPPIER_NO_BROWSER_OPEN: undefined,
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_AUTH_METHOD: 'web',
      });

      vi.resetModules();
      const { doAuth } = await import('./auth');

      const creds = await doAuth();
      expect(creds?.token).toBe('tok');
      expect(displayQRCodeMock).not.toHaveBeenCalled();

      const out = output.logs.join('\n');
      expect(out).toContain('Connect this computer');
      expect(out).toContain('normal on a headless or remote computer');
      expect(out).toContain('Copy this link into any browser');
      expect(out).toContain('webapp.example.test/terminal/connect#key=');
      expect(out).not.toContain('happier://terminal?');
      expect(out.match(/Authentication successful/gu) ?? []).toHaveLength(0);
    } finally {
      output.restore();
      restoreTty();
      envScope.restore();
      await removeTempDir(home);
    }
  }, 15_000);
});
