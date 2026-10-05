import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createHomeCredentialDestinationDigestV1,
  decodeBase64,
  encodeBase64,
  type AccountDirectoryHomeEntryV1,
} from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { libsodiumEncryptForPublicKey } from '@/api/encryption';
import { configuration, reloadConfiguration } from '@/configuration';
import { updateSettings, type StoredCredentials } from '@/persistence';
import { captureConsoleText } from '@/testkit/logger/captureOutput';
import { setStdioTtyForTest } from '@/testkit/process/stdio';
import {
  adoptServerProfileHomeConnectionDescriptor,
  listServerProfiles,
} from '@/server/serverProfiles';
import {
  createCliAccountServiceSessionOwner,
  resolveCliAccountServiceSessionRecordPath,
  type CliAccountServiceSelection,
} from './cliAccountServiceSession';
import type { CliAuthEntryFetchResult, fetchCliHomeAuthEntry } from './cliAuthEntryClient';
import type {
  CliAccountServiceHomeEntryInput,
  CliAccountServiceHomeEntryPorts,
} from './cliAccountServiceHomeEntry';
import { runCliAccountServiceSetupEntry } from './cliAccountServiceSetupEntry';

const fetchServerFeaturesSnapshotMock = vi.hoisted(() => vi.fn());
const fetchCliHomeAuthEntryMock = vi.hoisted(() => vi.fn(
  async (_input: Parameters<typeof fetchCliHomeAuthEntry>[0]): Promise<CliAuthEntryFetchResult> => ({
    kind: 'unsupported',
  }),
));
const acquireTerminalAuthEnrollmentRuntimeMock = vi.hoisted(() => vi.fn());
const authAndSetupMachineIfNeededMock = vi.hoisted(() => vi.fn(async (_opts?: unknown) => {}));
const registerMachineWithAuthenticatedHomeRuntimeMock = vi.hoisted(() => vi.fn(async (_opts?: unknown) => ({
  machineId: 'machine-account-service',
})));
const closeHomeTransportMock = vi.hoisted(() => vi.fn(async () => {}));
const promptMultipleChoiceMock = vi.hoisted(() => vi.fn(async (
  _message: string,
  _choices: unknown,
  _options: unknown,
) => 'key:login:keyed'));
const authenticateCliAccountServiceMock = vi.hoisted(() => vi.fn(
  async (_input: unknown, _deps?: unknown): Promise<unknown> => ({ kind: 'failed' }),
));
const authenticateCliAccountServiceActual = vi.hoisted(() => ({
  fn: undefined as undefined | typeof import('./cliAccountServiceAuth')['authenticateCliAccountService'],
}));
const runCliAccountServiceHomeEntryActual = vi.hoisted(() => ({
  fn: undefined as undefined | typeof import('./cliAccountServiceHomeEntry')['runCliAccountServiceHomeEntry'],
}));
const runCliAccountServiceHomeEntryMock = vi.hoisted(() => vi.fn(
  (input: CliAccountServiceHomeEntryInput, ports: CliAccountServiceHomeEntryPorts) =>
    runCliAccountServiceHomeEntryActual.fn!(input, ports),
));
const writeCredentialsTokenOnlyForServerIdMock = vi.hoisted(() => vi.fn(
  async (_serverId: string, _credentials: StoredCredentials) => {},
));
const settingsReadFault = vi.hoisted(() => ({
  failReads: false,
  failAfterNextActiveServerChange: false,
  afterNextActiveServerChange: null as (() => void) | null,
}));

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: (...args: unknown[]) => fetchServerFeaturesSnapshotMock(...args),
}));
vi.mock('./cliAuthEntryClient', () => ({
  fetchCliHomeAuthEntry: (input: Parameters<typeof fetchCliHomeAuthEntry>[0]) => fetchCliHomeAuthEntryMock(input),
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
vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: (opts?: unknown) => authAndSetupMachineIfNeededMock(opts),
  registerMachineWithAuthenticatedHomeRuntime: (opts?: unknown) =>
    registerMachineWithAuthenticatedHomeRuntimeMock(opts),
}));
vi.mock('@/terminal/prompts/promptMultipleChoice', () => ({
  promptMultipleChoice: (message: string, choices: unknown, options: unknown) => promptMultipleChoiceMock(
    message,
    choices,
    options,
  ),
}));
vi.mock('./cliAccountServiceAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cliAccountServiceAuth')>();
  authenticateCliAccountServiceActual.fn = actual.authenticateCliAccountService;
  return {
    ...actual,
    authenticateCliAccountService: (input: unknown, deps?: unknown) => authenticateCliAccountServiceMock(input, deps),
  };
});
vi.mock('./cliAccountServiceHomeEntry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cliAccountServiceHomeEntry')>();
  runCliAccountServiceHomeEntryActual.fn = actual.runCliAccountServiceHomeEntry;
  return {
    ...actual,
    runCliAccountServiceHomeEntry: (
      input: CliAccountServiceHomeEntryInput,
      ports: CliAccountServiceHomeEntryPorts,
    ) => runCliAccountServiceHomeEntryMock(input, ports),
  };
});
vi.mock('@/persistence', async (importOriginal) => {
  const persistence = await importOriginal<typeof import('@/persistence')>();
  return {
    ...persistence,
    readSettings: async () => {
      if (settingsReadFault.failReads) throw new Error('injected post-commit settings read failure');
      return await persistence.readSettings();
    },
    updateSettings: async (updater: Parameters<typeof persistence.updateSettings>[0]) => {
      let activeServerChanged = false;
      const updated = await persistence.updateSettings(async (current) => {
        const next = await updater(current);
        activeServerChanged = next.activeServerId !== current.activeServerId;
        return next;
      });
      if (settingsReadFault.failAfterNextActiveServerChange && activeServerChanged) {
        settingsReadFault.failAfterNextActiveServerChange = false;
        settingsReadFault.failReads = true;
        settingsReadFault.afterNextActiveServerChange?.();
        settingsReadFault.afterNextActiveServerChange = null;
      }
      return updated;
    },
    writeCredentialsTokenOnlyForServerId: (
      serverId: string,
      credentials: StoredCredentials,
    ) => Promise.all([
      writeCredentialsTokenOnlyForServerIdMock(serverId, credentials),
      persistence.writeCredentialsTokenOnlyForServerId(serverId, credentials),
    ]).then(() => undefined),
    writeStoredCredentialsForServerId: (
      serverId: string,
      credentials: StoredCredentials,
    ) => Promise.all([
      writeCredentialsTokenOnlyForServerIdMock(serverId, credentials),
      persistence.writeStoredCredentialsForServerId(serverId, credentials),
    ]).then(() => undefined),
  };
});

const nowMs = 1_700_000_000_000;
const accountService = {
  endpoint: 'https://accounts.example.test',
  serverIdentityId: 'srv_account_service',
  canonicalServerUrl: 'https://accounts.example.test',
  advertisedMethods: {
    keyLoginAvailable: true,
    oauthProviderIds: [],
    preferredProvisionProviderId: null,
  },
} as const;

const accountServiceAuthority = {
  endpoint: accountService.endpoint,
  serverIdentityId: accountService.serverIdentityId,
  canonicalServerUrl: accountService.canonicalServerUrl,
} as const;
const home: AccountDirectoryHomeEntryV1 = {
  v: 1,
  homeServerIdentityId: 'srv_home_a',
  canonicalServerUrl: 'https://home-a.example.test',
  label: 'Home A',
  preferred: true,
  connectionDescriptor: {
    v: 1,
    homeServerIdentityId: 'srv_home_a',
    canonicalServerUrl: 'https://home-a.example.test',
    revision: 1,
    endpoints: [{ kind: 'https', url: 'https://home-a.example.test' }],
  },
  createdAtMs: nowMs - 10_000,
  updatedAtMs: nowMs - 5_000,
};
const preferredOtherHome: AccountDirectoryHomeEntryV1 = {
  ...home,
  homeServerIdentityId: 'srv_home_b',
  canonicalServerUrl: 'https://home-b.example.test',
  label: 'Home B',
  connectionDescriptor: {
    ...home.connectionDescriptor,
    homeServerIdentityId: 'srv_home_b',
    canonicalServerUrl: 'https://home-b.example.test',
    endpoints: [{ kind: 'https', url: 'https://home-b.example.test' }],
  },
};

function readyAccountServiceFeatures(
  service: CliAccountServiceSelection,
  serverIdentityId: string = service.serverIdentityId,
  keyAction: 'login' | 'provision' = 'login',
) {
  return {
    status: 'ready' as const,
    provenance: 'authenticated' as const,
    features: {
      features: {},
      capabilities: {
        accountDirectory: {
          version: 1,
          homeDirectory: true,
          homeEnrollment: true,
          deviceApproval: true,
          homeLoginAssertion: {
            keyId: 'a'.repeat(64),
            publicKeyBase64Url: 'A'.repeat(43),
          },
        },
        server: { canonicalServerUrl: service.canonicalServerUrl },
        serverIdentity: { serverIdentityId },
        auth: { methods: [{ id: 'key_challenge', actions: [{ id: keyAction, enabled: true, mode: 'keyed' }] }], keyChallenge: { v2: true } },
        oauth: { providers: {} },
      },
    },
  };
}

function createJwtWithSub(sub: string, marker: string): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub, marker })).toString('base64url'),
    'signature',
  ].join('.');
}

const roots: string[] = [];
const originalHome = process.env.HAPPIER_HOME_DIR;

function setStderrTtyForTest(isTTY: boolean): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  Object.defineProperty(process.stderr, 'isTTY', { value: isTTY, configurable: true });
  return () => {
    if (descriptor) Object.defineProperty(process.stderr, 'isTTY', descriptor);
    else delete (process.stderr as { isTTY?: boolean }).isTTY;
  };
}

async function configureProductionJourney(options: Readonly<{
  mode?: 'plain' | 'e2ee';
  modeStatus?: number;
  modeTransportFailure?: boolean;
  homeToken?: string;
  selection?: 'explicit' | 'preferred' | 'sole' | 'chooser';
  authenticatedObservationProvenance?: 'authenticated' | 'public';
  /** Redeem on the first attempt instead of requiring Home approval first. */
  immediateRedemption?: boolean;
}> = {}): Promise<Readonly<{
  redemptionCount(): number;
  assertionRequestCount(): number;
  redeemedAssertions(): readonly unknown[];
  waitForApproval(): Promise<void>;
  readPersistedSession(): Promise<Record<string, unknown>>;
  continueMachineAndService: ReturnType<typeof vi.fn>;
  activeServerIdBeforeJourney: string;
  modeRequests: readonly Readonly<{
    url: string;
    authorization: string | null;
    activeServerId: string;
  }>[];
  setModeStatus(status: number): void;
  setAuthenticatedObservationProvenance(provenance: 'authenticated' | 'public'): void;
}>> {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-service-approval-'));
  roots.push(happyHomeDir);
  process.env.HAPPIER_HOME_DIR = happyHomeDir;
  reloadConfiguration();
  const activeServerIdBeforeJourney = configuration.activeServerId;
  const session = createCliAccountServiceSessionOwner({ happyHomeDir });
  await session.selectService(accountService);
  await session.replaceCredential({ service: accountService, credential: { token: 'account-service-token' } });

  let authenticatedObservationProvenance = options.authenticatedObservationProvenance ?? 'authenticated';
  fetchServerFeaturesSnapshotMock.mockImplementation(async (input: Readonly<{ serverUrl: string; token?: string }>) => {
    if (input.serverUrl === accountService.endpoint) {
      return {
        status: 'ready',
        provenance: 'authenticated',
        serverIdentityId: accountService.serverIdentityId,
        features: {
          features: {},
          capabilities: {
            accountDirectory: {
              version: 1,
              homeDirectory: true,
              homeEnrollment: true,
              deviceApproval: true,
              homeLoginAssertion: {
                keyId: 'a'.repeat(64),
                publicKeyBase64Url: 'A'.repeat(43),
              },
            },
            server: { canonicalServerUrl: accountService.canonicalServerUrl },
            serverIdentity: { serverIdentityId: accountService.serverIdentityId },
            auth: { methods: [{ id: 'key_challenge', actions: [{ id: 'provision', enabled: true, mode: 'keyed' }] }], keyChallenge: { v2: true } },
            oauth: { providers: {} },
          },
        },
      };
    }
    return {
      status: 'ready',
      provenance: input.token ? authenticatedObservationProvenance : 'public',
      serverIdentityId: home.homeServerIdentityId,
      features: {
        features: {},
        capabilities: { serverIdentity: { serverIdentityId: home.homeServerIdentityId } },
        homeConnectionDescriptor: home.connectionDescriptor,
      },
    };
  });
  acquireTerminalAuthEnrollmentRuntimeMock.mockResolvedValue({
    ok: true,
    runtime: {
      runtimeOrigin: home.canonicalServerUrl,
      authenticatedCredentialDestination: {
        kind: 'https',
        applicationUrl: home.canonicalServerUrl,
      },
    },
    close: closeHomeTransportMock,
  });

  let requesterPublicKeyBase64 = '';
  let assertionRequests = 0;
  const redeemedAssertions: unknown[] = [];
  const directoryHome = options.selection === 'sole' || options.selection === 'explicit' || options.selection === 'chooser'
    ? { ...home, preferred: false }
    : home;
  let redemptions = 0;
  let modeStatus = options.modeStatus ?? 200;
  let resolveApproval!: () => void;
  const approvalIssued = new Promise<void>((resolve) => { resolveApproval = resolve; });
  const modeRequests: Array<Readonly<{
    url: string;
    authorization: string | null;
    activeServerId: string;
  }>> = [];
  vi.stubGlobal('fetch', vi.fn(async (urlInput: string | URL | Request, init?: RequestInit) => {
    const url = String(urlInput);
    if (url.endsWith('/v1/account-directory/me')) return Response.json({});
    if (url.endsWith('/v1/account-directory/homes')) {
      return Response.json({
        v: 1,
        homes: options.selection === 'explicit'
          ? [directoryHome, preferredOtherHome]
          : options.selection === 'chooser'
            ? [directoryHome, { ...preferredOtherHome, preferred: false }]
            : [directoryHome],
        preferredHomeServerIdentityId: options.selection === 'sole' || options.selection === 'chooser'
          ? null
          : options.selection === 'explicit'
            ? preferredOtherHome.homeServerIdentityId
            : home.homeServerIdentityId,
      });
    }
    if (url.endsWith(`/v1/account-directory/homes/${home.homeServerIdentityId}/login-assertion`)) {
      assertionRequests += 1;
      const body = JSON.parse(String(init?.body)) as { clientBoxPublicKeyBase64: string };
      requesterPublicKeyBase64 = body.clientBoxPublicKeyBase64;
      return Response.json({
        v: 1,
        purpose: 'happier.home-login',
        issuerServerIdentityId: accountService.serverIdentityId,
        issuerSubjectId: 'account-1',
        audienceHomeServerIdentityId: home.homeServerIdentityId,
        credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1(home.connectionDescriptor),
        clientBoxPublicKeyBase64: requesterPublicKeyBase64,
        issuedAtMs: nowMs,
        expiresAtMs: nowMs + 120_000,
        keyId: 'a'.repeat(64),
        signatureBase64Url: 'A'.repeat(86),
      });
    }
    if (url.endsWith('/v1/auth/home-login')) {
      redemptions += 1;
      redeemedAssertions.push((JSON.parse(String(init?.body)) as { assertion: unknown }).assertion);
      if (redemptions === 1 && !options.immediateRedemption) {
        resolveApproval();
        return Response.json({
          v: 1,
          outcome: 'approval_required',
          homeServerIdentityId: home.homeServerIdentityId,
          approvalId: 'approval-1',
          deviceLabel: null,
          expiresAtMs: nowMs + 60_000,
        });
      }
      const plaintext = new TextEncoder().encode(JSON.stringify({ token: options.homeToken ?? 'home-token' }));
      return Response.json({
        v: 1,
        homeServerIdentityId: home.homeServerIdentityId,
        sealedHomeTokenBase64Url: encodeBase64(
          libsodiumEncryptForPublicKey(plaintext, decodeBase64(requesterPublicKeyBase64, 'base64')),
          'base64url',
        ),
        issuedAtMs: nowMs + 1_000,
        expiresAtMs: nowMs + 30_000,
      });
    }
    if (url.endsWith('/v1/account/encryption')) {
      if (options.modeTransportFailure) throw new TypeError('Home mode transport unavailable');
      modeRequests.push({
        url,
        authorization: new Headers(init?.headers).get('Authorization'),
        activeServerId: configuration.activeServerId,
      });
      return Response.json(
        { mode: options.mode ?? 'plain', updatedAt: nowMs },
        { status: modeStatus },
      );
    }
    return new Response(null, { status: 404 });
  }));

  return {
    redemptionCount: () => redemptions,
    assertionRequestCount: () => assertionRequests,
    redeemedAssertions: () => redeemedAssertions,
    waitForApproval: async () => await approvalIssued,
    readPersistedSession: async () => JSON.parse(
      await readFile(resolveCliAccountServiceSessionRecordPath(happyHomeDir), 'utf8'),
    ) as Record<string, unknown>,
    continueMachineAndService: vi.fn(async () => ({ kind: 'continued' as const })),
    activeServerIdBeforeJourney,
    modeRequests,
    setModeStatus: (status) => { modeStatus = status; },
    setAuthenticatedObservationProvenance: (provenance) => {
      authenticatedObservationProvenance = provenance;
    },
  };
}

async function createDuplicateStoredHomeIdentity(
  entry: AccountDirectoryHomeEntryV1,
): Promise<void> {
  await updateSettings((current) => {
    const now = Date.now();
    const firstId = `${entry.homeServerIdentityId}-duplicate-1`;
    const secondId = `${entry.homeServerIdentityId}-duplicate-2`;
    const profile = (id: string, descriptor: AccountDirectoryHomeEntryV1['connectionDescriptor']) => ({
      id,
      name: entry.label,
      serverUrl: descriptor.canonicalServerUrl,
      webappUrl: descriptor.canonicalServerUrl,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: 0,
      homeConnectionDescriptor: descriptor,
    });
    const alternateUrl = `${entry.canonicalServerUrl}/alternate`;
    const alternateDescriptor = {
      ...entry.connectionDescriptor,
      canonicalServerUrl: alternateUrl,
      endpoints: [{ kind: 'https' as const, url: alternateUrl }],
    };
    return {
      ...current,
      servers: {
        ...current.servers,
        [firstId]: profile(firstId, entry.connectionDescriptor),
        [secondId]: profile(secondId, alternateDescriptor),
      },
    };
  });
}

describe('production CLI Account Service approval continuation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fetchServerFeaturesSnapshotMock.mockReset();
    fetchCliHomeAuthEntryMock.mockReset().mockResolvedValue({ kind: 'unsupported' });
    acquireTerminalAuthEnrollmentRuntimeMock.mockReset();
    authAndSetupMachineIfNeededMock.mockClear();
    registerMachineWithAuthenticatedHomeRuntimeMock.mockClear();
    closeHomeTransportMock.mockClear();
    promptMultipleChoiceMock.mockClear();
    authenticateCliAccountServiceMock.mockClear();
    runCliAccountServiceHomeEntryMock.mockReset().mockImplementation(
      (...args) => runCliAccountServiceHomeEntryActual.fn!(...args),
    );
    writeCredentialsTokenOnlyForServerIdMock.mockClear();
    settingsReadFault.failReads = false;
    settingsReadFault.failAfterNextActiveServerChange = false;
    settingsReadFault.afterNextActiveServerChange = null;
    if (originalHome === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHome;
    reloadConfiguration();
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  it('polls an approval-required Home to completion before focusing and continuing setup', async () => {
    const harness = await configureProductionJourney();
    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
      continueMachineAndService: harness.continueMachineAndService,
    });

    await harness.waitForApproval();
    const persistedWhilePending = await harness.readPersistedSession();
    expect(persistedWhilePending).not.toHaveProperty('approval');
    expect(persistedWhilePending).not.toHaveProperty('requesterSecretKey');
    expect(persistedWhilePending).not.toHaveProperty('continuation');
    await vi.advanceTimersByTimeAsync(1_250);

    await expect(result).resolves.toMatchObject({
      kind: 'home_entered',
      homeServerIdentityId: home.homeServerIdentityId,
    });
    expect(harness.redemptionCount()).toBe(2);
    expect(writeCredentialsTokenOnlyForServerIdMock).toHaveBeenCalledWith(
      expect.any(String),
      { token: 'home-token', encryption: null },
    );
    expect(registerMachineWithAuthenticatedHomeRuntimeMock).toHaveBeenCalledWith({
      credentials: expect.objectContaining({ token: 'home-token', encryption: null }),
      forceNew: true,
      runtimeOrigin: home.canonicalServerUrl,
    });
    expect(closeHomeTransportMock).toHaveBeenCalledTimes(2);
    expect(registerMachineWithAuthenticatedHomeRuntimeMock.mock.invocationCallOrder[0])
      .toBeLessThan(closeHomeTransportMock.mock.invocationCallOrder.at(-1)!);
    expect(authAndSetupMachineIfNeededMock).not.toHaveBeenCalled();
    expect((await listServerProfiles()).find(
      (profile) => profile.homeConnectionDescriptor?.homeServerIdentityId === home.homeServerIdentityId,
    )?.homeConnectionDescriptorAuthority).toBe('exact');
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.continueMachineAndService).toHaveBeenCalledOnce();
  });

  it('preserves committed Home focus when the next settings read fails and caller cancellation races', async () => {
    const harness = await configureProductionJourney();
    const controller = new AbortController();
    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
      signal: controller.signal,
      continueMachineAndService: harness.continueMachineAndService,
    });

    await harness.waitForApproval();
    settingsReadFault.failAfterNextActiveServerChange = true;
    settingsReadFault.afterNextActiveServerChange = () => controller.abort();
    await vi.advanceTimersByTimeAsync(1_250);

    const outcome = await result;
    expect(outcome).toMatchObject({
      kind: 'home_entered',
      homeServerIdentityId: home.homeServerIdentityId,
      selection: 'preferred',
    });
    expect(harness.continueMachineAndService).toHaveBeenCalledOnce();

    settingsReadFault.failReads = false;
    expect(configuration.activeServerId).toBe(harness.activeServerIdBeforeJourney);
    await expect((await import('@/persistence')).readSettings()).resolves.toMatchObject({
      activeServerId: outcome.kind === 'home_entered' ? outcome.profileId : expect.any(String),
    });
  });

  it('does not request or redeem an assertion when selected-Home profile adoption fails', async () => {
    const harness = await configureProductionJourney();
    await createDuplicateStoredHomeIdentity(home);

    await expect(runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
      continueMachineAndService: harness.continueMachineAndService,
    })).resolves.toMatchObject({
      kind: 'failure',
      stage: 'refresh',
      homeServerIdentityId: home.homeServerIdentityId,
      homeCredentialCommitted: false,
    });

    expect(harness.redemptionCount()).toBe(0);
    expect(acquireTerminalAuthEnrollmentRuntimeMock).not.toHaveBeenCalled();
    expect(harness.continueMachineAndService).not.toHaveBeenCalled();
  });

  it('enters an explicit selected Home and reports another Home adoption failure', async () => {
    const harness = await configureProductionJourney({ selection: 'explicit' });
    await createDuplicateStoredHomeIdentity(preferredOtherHome);
    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      intent: {
        kind: 'enter',
        target: { kind: 'explicit', homeServerIdentityId: home.homeServerIdentityId },
      },
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
      continueMachineAndService: harness.continueMachineAndService,
    });

    await harness.waitForApproval();
    await vi.advanceTimersByTimeAsync(1_250);

    await expect(result).resolves.toMatchObject({
      kind: 'home_entered',
      homeServerIdentityId: home.homeServerIdentityId,
      directoryAdoptionFailures: [{
        homeServerIdentityId: preferredOtherHome.homeServerIdentityId,
        label: preferredOtherHome.label,
      }],
    });
    expect(harness.redemptionCount()).toBe(2);
    expect(harness.continueMachineAndService).toHaveBeenCalledOnce();
  });

  it('does not report Home entry when the post-focus machine/service continuation fails', async () => {
    const harness = await configureProductionJourney();
    const continuation = vi.fn(async () => ({ kind: 'failed' as const }));
    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
      continueMachineAndService: continuation,
    });

    await harness.waitForApproval();
    await vi.advanceTimersByTimeAsync(1_250);

    await expect(result).resolves.toMatchObject({
      kind: 'failure',
      stage: 'enter',
      homeServerIdentityId: home.homeServerIdentityId,
      homeCredentialCommitted: true,
      recovery: 'retry_stage',
    });
    expect(continuation).toHaveBeenCalledWith(expect.objectContaining({
      homeServerIdentityId: home.homeServerIdentityId,
      profileId: expect.any(String),
    }));
  });

  it('rejects a public fallback after redemption before reconciling or committing the credential', async () => {
    const harness = await configureProductionJourney({ authenticatedObservationProvenance: 'public' });
    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
      continueMachineAndService: harness.continueMachineAndService,
    });

    await harness.waitForApproval();
    await vi.advanceTimersByTimeAsync(1_250);

    await expect(result).resolves.toMatchObject({
      kind: 'failure',
      stage: 'enter',
      homeServerIdentityId: home.homeServerIdentityId,
      homeCredentialCommitted: false,
      recovery: 'retry_stage',
    });
    expect(writeCredentialsTokenOnlyForServerIdMock).not.toHaveBeenCalled();
    const persisted = (await listServerProfiles()).find(
      (profile) => profile.homeConnectionDescriptor?.homeServerIdentityId === home.homeServerIdentityId,
    );
    expect(persisted?.homeConnectionDescriptorAuthority).toBe('advisory');
  });

  it('retries a post-redemption observation failure with the same bounded invocation and commits once', async () => {
    const harness = await configureProductionJourney({
      authenticatedObservationProvenance: 'public',
      immediateRedemption: true,
    });
    const controller = new AbortController();
    const failed = await runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      signal: controller.signal,
      timeoutMs: 10_000,
      continueMachineAndService: harness.continueMachineAndService,
    });

    expect(failed).toMatchObject({
      kind: 'failure',
      stage: 'enter',
      homeServerIdentityId: home.homeServerIdentityId,
      homeCredentialCommitted: false,
      recovery: 'retry_stage',
      retry: expect.any(Function),
    });
    expect(harness.assertionRequestCount()).toBe(1);
    expect(harness.redemptionCount()).toBe(1);
    expect(writeCredentialsTokenOnlyForServerIdMock).not.toHaveBeenCalled();
    if (failed.kind !== 'failure' || !failed.retry) throw new Error('Expected post-redemption retry');

    harness.setAuthenticatedObservationProvenance('authenticated');
    const retried = await failed.retry();

    expect(retried).toMatchObject({
      kind: 'home_entered',
      homeServerIdentityId: home.homeServerIdentityId,
    });
    expect(harness.assertionRequestCount()).toBe(1);
    expect(harness.redemptionCount()).toBe(2);
    expect(harness.redeemedAssertions()[1]).toEqual(harness.redeemedAssertions()[0]);
    expect(writeCredentialsTokenOnlyForServerIdMock).toHaveBeenCalledOnce();
    expect(harness.continueMachineAndService).toHaveBeenCalledOnce();
  });

  it('does not re-enter a retained post-redemption invocation after caller cancellation', async () => {
    const harness = await configureProductionJourney({
      authenticatedObservationProvenance: 'public',
      immediateRedemption: true,
    });
    const controller = new AbortController();
    const failed = await runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    if (failed.kind !== 'failure' || !failed.retry) throw new Error('Expected post-redemption retry');

    controller.abort();
    await expect(failed.retry()).resolves.toEqual({ kind: 'cancelled' });
    expect(harness.assertionRequestCount()).toBe(1);
    expect(harness.redemptionCount()).toBe(1);
    expect(writeCredentialsTokenOnlyForServerIdMock).not.toHaveBeenCalled();
  });

  it('uses the exact self Home carrier for discovery, authentication, and Directory requests', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-service-self-carrier-'));
    roots.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    const descriptor = {
      v: 1 as const,
      homeServerIdentityId: accountService.serverIdentityId,
      canonicalServerUrl: accountService.canonicalServerUrl,
      revision: 1,
      endpoints: [{ kind: 'iroh' as const, endpointId: 'b'.repeat(64) }],
    };
    const runtimeOrigin = 'http://127.0.0.1:47831';
    acquireTerminalAuthEnrollmentRuntimeMock.mockResolvedValue({
      ok: true,
      runtime: {
        runtimeOrigin,
        carrier: 'iroh',
        authenticatedCredentialDestination: { kind: 'iroh', endpointId: 'b'.repeat(64) },
      },
      close: closeHomeTransportMock,
    });
    fetchServerFeaturesSnapshotMock.mockImplementation(async (request: Readonly<{ serverUrl: string }>) => {
      expect(request.serverUrl).toBe(runtimeOrigin);
      const ready = readyAccountServiceFeatures(accountService);
      return {
        ...ready,
        features: { ...ready.features, homeConnectionDescriptor: descriptor },
      };
    });
    authenticateCliAccountServiceMock.mockImplementation(async (_authInput, depsValue) => {
      const deps = depsValue as Readonly<{ request(path: string, init?: RequestInit): Promise<Response> }>;
      await deps.request('/v1/auth/probe');
      return { kind: 'authenticated', credential: { token: 'account-service-token' } };
    });
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (urlInput: string | URL | Request) => {
      const url = String(urlInput);
      requestedUrls.push(url);
      if (url.endsWith('/v1/auth/probe')) return Response.json({});
      if (url.endsWith('/v1/account-directory/homes')) {
        return Response.json({ v: 1, homes: [], preferredHomeServerIdentityId: null });
      }
      return new Response(null, { status: 404 });
    }));
    promptMultipleChoiceMock.mockResolvedValueOnce('service');

    await expect(runCliAccountServiceSetupEntry({
      context: {
        kind: 'explicit',
        target: { kind: 'descriptor', descriptor, authority: 'current_connection' },
        policy: { v: 1, mode: 'self' },
      },
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
    })).resolves.toEqual({
      kind: 'explicit_target_not_linked',
      homeServerIdentityId: descriptor.homeServerIdentityId,
    });

    expect(requestedUrls).toEqual([
      `${runtimeOrigin}/v1/auth/probe`,
      `${runtimeOrigin}/v1/account-directory/homes`,
    ]);
    expect(requestedUrls.every((url) => !url.startsWith(accountService.endpoint))).toBe(true);
    expect(closeHomeTransportMock).toHaveBeenCalledOnce();
  });

  it('does not probe a named service when the exact Home policy disables it', async () => {
    await expect(runCliAccountServiceSetupEntry({
      context: {
        kind: 'explicit',
        target: { kind: 'descriptor', descriptor: home.connectionDescriptor, authority: 'current_connection' },
        policy: { v: 1, mode: 'disabled' },
      },
      timeoutMs: 10_000,
    })).resolves.toEqual({ kind: 'account_service_unavailable' });

    expect(fetchServerFeaturesSnapshotMock).not.toHaveBeenCalled();
    expect(acquireTerminalAuthEnrollmentRuntimeMock).not.toHaveBeenCalled();
    expect(authenticateCliAccountServiceMock).not.toHaveBeenCalled();
  });

  it('requires an explicit targeted choice before reading a valid stored service credential', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-service-target-choice-'));
    roots.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    const session = createCliAccountServiceSessionOwner({ happyHomeDir });
    await session.selectService(accountService);
    await session.replaceCredential({ service: accountService, credential: { token: 'stored-service-token' } });
    promptMultipleChoiceMock.mockResolvedValueOnce('direct');

    await expect(runCliAccountServiceSetupEntry({
      context: {
        kind: 'explicit',
        target: { kind: 'descriptor', descriptor: home.connectionDescriptor, authority: 'current_connection' },
        policy: {
          v: 1,
          mode: 'external',
          endpoint: accountService.endpoint,
          expectedServerIdentityId: accountService.serverIdentityId,
        },
      },
      promptInputFn: async () => 'd',
      timeoutMs: 10_000,
    })).resolves.toEqual({ kind: 'direct_home_selected' });

    expect(fetchServerFeaturesSnapshotMock).not.toHaveBeenCalled();
    expect(authenticateCliAccountServiceMock).not.toHaveBeenCalled();
  });

  it('derives an external service only from the exact Home policy and releases its carrier before probing it', async () => {
    const serviceEndpoint = 'https://accounts.home-policy.example.test';
    const observedEndpoints: string[] = [];
    acquireTerminalAuthEnrollmentRuntimeMock.mockResolvedValue({
      ok: true,
      runtime: {
        runtimeOrigin: home.canonicalServerUrl,
        carrier: 'https',
        authenticatedCredentialDestination: {
          kind: 'https',
          applicationUrl: home.canonicalServerUrl,
        },
      },
      close: closeHomeTransportMock,
    });
    fetchServerFeaturesSnapshotMock.mockImplementation(async (input: Readonly<{ serverUrl: string }>) => {
      observedEndpoints.push(input.serverUrl);
      if (input.serverUrl === home.canonicalServerUrl) {
        return {
          status: 'ready',
          provenance: 'authenticated',
          serverIdentityId: home.homeServerIdentityId,
          features: {
            features: {},
            capabilities: { serverIdentity: { serverIdentityId: home.homeServerIdentityId } },
            homeConnectionDescriptor: home.connectionDescriptor,
            signInService: { v: 1, mode: 'external', endpoint: serviceEndpoint },
          },
        };
      }
      return { status: 'error', reason: 'network' };
    });
    promptMultipleChoiceMock.mockResolvedValueOnce('service');

    await expect(runCliAccountServiceSetupEntry({
      context: {
        kind: 'explicit',
        target: { kind: 'descriptor', descriptor: home.connectionDescriptor, authority: 'current_connection' },
      },
      promptInputFn: async () => 's',
      timeoutMs: 10_000,
    })).resolves.toEqual({ kind: 'account_service_unavailable' });

    expect(observedEndpoints).toEqual([home.canonicalServerUrl, serviceEndpoint]);
    expect(closeHomeTransportMock).toHaveBeenCalledOnce();
    expect(authenticateCliAccountServiceMock).not.toHaveBeenCalled();
  });

  it('does not replace the device-selected service when an exact Home offers another service', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-service-home-policy-selection-'));
    roots.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    const session = createCliAccountServiceSessionOwner({ happyHomeDir });
    await session.selectService(accountService);
    await session.replaceCredential({ service: accountService, credential: { token: 'device-service-token' } });
    const homeService = {
      ...accountService,
      endpoint: 'https://accounts.exact-home.example.test',
      canonicalServerUrl: 'https://canonical.accounts.exact-home.example.test',
      serverIdentityId: 'srv_exact_home_account_service',
    };
    fetchServerFeaturesSnapshotMock.mockResolvedValue(readyAccountServiceFeatures(homeService));
    authenticateCliAccountServiceMock.mockResolvedValue({
      kind: 'authenticated',
      credential: { token: 'transient-home-service-token' },
    });
    vi.stubGlobal('fetch', vi.fn(async (urlInput: string | URL | Request) => {
      const url = String(urlInput);
      if (url.endsWith('/v1/account-directory/homes')) {
        return Response.json({ v: 1, homes: [], preferredHomeServerIdentityId: null });
      }
      return new Response(null, { status: 404 });
    }));
    promptMultipleChoiceMock.mockResolvedValueOnce('service');

    await expect(runCliAccountServiceSetupEntry({
      context: {
        kind: 'explicit',
        target: { kind: 'descriptor', descriptor: home.connectionDescriptor, authority: 'current_connection' },
        policy: {
          v: 1,
          mode: 'external',
          endpoint: homeService.endpoint,
          expectedServerIdentityId: homeService.serverIdentityId,
        },
      },
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
    })).resolves.toEqual({
      kind: 'explicit_target_not_linked',
      homeServerIdentityId: home.homeServerIdentityId,
    });

    await expect(session.readSelection()).resolves.toEqual(accountServiceAuthority);
    await expect(session.readCredential(accountService)).resolves.toEqual({ token: 'device-service-token' });
  });

  it('reads the selected Home mode through its exact transport with only the Home bearer', async () => {
    const harness = await configureProductionJourney();
    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
      continueMachineAndService: harness.continueMachineAndService,
    });
    await harness.waitForApproval();
    await vi.advanceTimersByTimeAsync(1_250);

    await expect(result).resolves.toMatchObject({ kind: 'home_entered' });
    expect(harness.modeRequests).toEqual([{
      url: `${home.canonicalServerUrl}/v1/account/encryption`,
      authorization: 'Bearer home-token',
      activeServerId: harness.activeServerIdBeforeJourney,
    }]);
  });

  it('enters the sole eligible Home even when it is offline and not preferred', async () => {
    const harness = await configureProductionJourney({ selection: 'sole' });
    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
      continueMachineAndService: harness.continueMachineAndService,
    });
    await harness.waitForApproval();
    await vi.advanceTimersByTimeAsync(1_250);

    await expect(result).resolves.toMatchObject({
      kind: 'home_entered',
      homeServerIdentityId: home.homeServerIdentityId,
      selection: 'sole',
    });
  });

  it('enters an explicit linked Home instead of the different preferred Home', async () => {
    const harness = await configureProductionJourney({ selection: 'explicit' });
    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      intent: { kind: 'enter', target: { kind: 'explicit', homeServerIdentityId: home.homeServerIdentityId } },
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
      continueMachineAndService: harness.continueMachineAndService,
    });
    await harness.waitForApproval();
    await vi.advanceTimersByTimeAsync(1_250);

    await expect(result).resolves.toMatchObject({
      kind: 'home_entered',
      homeServerIdentityId: home.homeServerIdentityId,
      selection: 'explicit',
    });
  });

  it('retains the Home bearer and returns material recovery for an E2EE Home without material', async () => {
    const harness = await configureProductionJourney({ mode: 'e2ee' });
    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
      continueMachineAndService: harness.continueMachineAndService,
    });
    await harness.waitForApproval();
    await vi.advanceTimersByTimeAsync(1_250);

    await expect(result).resolves.toEqual({
      kind: 'home_material_required',
      homeServerIdentityId: home.homeServerIdentityId,
      profileId: expect.any(String),
      reason: 'missing_material',
    });
    expect(writeCredentialsTokenOnlyForServerIdMock).toHaveBeenCalledWith(expect.any(String), {
      token: 'home-token',
      encryption: null,
    });
    expect(registerMachineWithAuthenticatedHomeRuntimeMock).not.toHaveBeenCalled();
  });

  it('preserves existing encryption material only for the same exact Home Account', async () => {
    const oldToken = createJwtWithSub('account-a', 'old');
    const refreshedToken = createJwtWithSub('account-a', 'new');
    const harness = await configureProductionJourney({ mode: 'e2ee', homeToken: refreshedToken });
    const adopted = await adoptServerProfileHomeConnectionDescriptor({
      descriptor: home.connectionDescriptor,
      suggestedName: home.label,
      observation: 'exact',
    });
    const serverDir = join(process.env.HAPPIER_HOME_DIR!, 'servers', adopted.profile.id);
    await mkdir(serverDir, { recursive: true });
    await writeFile(join(serverDir, 'access.key'), JSON.stringify({
      token: oldToken,
      secret: encodeBase64(new Uint8Array(32).fill(7)),
    }));
    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
      continueMachineAndService: harness.continueMachineAndService,
    });
    await harness.waitForApproval();
    await vi.advanceTimersByTimeAsync(1_250);

    await expect(result).resolves.toMatchObject({ kind: 'home_entered' });
    expect(writeCredentialsTokenOnlyForServerIdMock).toHaveBeenCalledWith(adopted.profile.id, {
      token: refreshedToken,
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    });
  });

  it('rejects inconsistent same-Account data-key material before machine registration', async () => {
    const oldToken = createJwtWithSub('account-a', 'old');
    const refreshedToken = createJwtWithSub('account-a', 'new');
    const machineKey = new Uint8Array(32).fill(7);
    const mismatchedPublicKey = new Uint8Array(32).fill(9);
    const harness = await configureProductionJourney({ mode: 'e2ee', homeToken: refreshedToken });
    const adopted = await adoptServerProfileHomeConnectionDescriptor({
      descriptor: home.connectionDescriptor,
      suggestedName: home.label,
      observation: 'exact',
    });
    const serverDir = join(process.env.HAPPIER_HOME_DIR!, 'servers', adopted.profile.id);
    await mkdir(serverDir, { recursive: true });
    await writeFile(join(serverDir, 'access.key'), JSON.stringify({
      token: oldToken,
      encryption: {
        publicKey: encodeBase64(mismatchedPublicKey),
        machineKey: encodeBase64(machineKey),
      },
    }));
    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
    });
    await harness.waitForApproval();
    await vi.advanceTimersByTimeAsync(1_250);

    await expect(result).resolves.toEqual({
      kind: 'home_material_required',
      homeServerIdentityId: home.homeServerIdentityId,
      profileId: adopted.profile.id,
      reason: 'invalid_material',
    });
    expect(writeCredentialsTokenOnlyForServerIdMock).toHaveBeenCalledWith(adopted.profile.id, {
      token: refreshedToken,
      encryption: { type: 'dataKey', publicKey: mismatchedPublicKey, machineKey },
    });
    expect(registerMachineWithAuthenticatedHomeRuntimeMock).not.toHaveBeenCalled();
  });

  it('does not reuse same-Home encryption material for a different Account', async () => {
    const oldToken = createJwtWithSub('account-a', 'old');
    const differentAccountToken = createJwtWithSub('account-b', 'new');
    const harness = await configureProductionJourney({ mode: 'e2ee', homeToken: differentAccountToken });
    const adopted = await adoptServerProfileHomeConnectionDescriptor({
      descriptor: home.connectionDescriptor,
      suggestedName: home.label,
      observation: 'exact',
    });
    const serverDir = join(process.env.HAPPIER_HOME_DIR!, 'servers', adopted.profile.id);
    await mkdir(serverDir, { recursive: true });
    await writeFile(join(serverDir, 'access.key'), JSON.stringify({
      token: oldToken,
      secret: encodeBase64(new Uint8Array(32).fill(9)),
    }));
    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
    });
    await harness.waitForApproval();
    await vi.advanceTimersByTimeAsync(1_250);

    await expect(result).resolves.toEqual({
      kind: 'home_material_required',
      homeServerIdentityId: home.homeServerIdentityId,
      profileId: adopted.profile.id,
      reason: 'invalid_material',
    });
    expect(writeCredentialsTokenOnlyForServerIdMock).toHaveBeenCalledWith(adopted.profile.id, {
      token: differentAccountToken,
      encryption: null,
    });
    expect(registerMachineWithAuthenticatedHomeRuntimeMock).not.toHaveBeenCalled();
  });

  it('commits the verified Home bearer before a failed mode read and retries only material readiness', async () => {
    const harness = await configureProductionJourney({ modeStatus: 503 });
    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
      continueMachineAndService: harness.continueMachineAndService,
    });
    await harness.waitForApproval();
    await vi.advanceTimersByTimeAsync(1_250);

    const failed = await result;
    expect(failed).toMatchObject({
      kind: 'failure',
      stage: 'material',
      homeServerIdentityId: home.homeServerIdentityId,
      homeCredentialCommitted: true,
      recovery: 'retry_stage',
    });
    expect(writeCredentialsTokenOnlyForServerIdMock).toHaveBeenCalledWith(expect.any(String), {
      token: 'home-token',
      encryption: null,
    });
    expect(registerMachineWithAuthenticatedHomeRuntimeMock).not.toHaveBeenCalled();
    expect(harness.continueMachineAndService).not.toHaveBeenCalled();

    harness.setModeStatus(200);
    if (failed.kind !== 'failure' || !failed.retry) throw new Error('Expected material retry continuation');
    const acquisitionsBeforeRetry = acquireTerminalAuthEnrollmentRuntimeMock.mock.calls.length;
    const retried = await failed.retry();
    expect(acquireTerminalAuthEnrollmentRuntimeMock).toHaveBeenCalledTimes(acquisitionsBeforeRetry + 1);
    expect(harness.modeRequests).toHaveLength(2);
    expect(harness.continueMachineAndService).toHaveBeenCalledTimes(1);
    expect(harness.continueMachineAndService).toHaveBeenCalledWith(expect.objectContaining({
      homeServerIdentityId: home.homeServerIdentityId,
      profileId: expect.any(String),
    }));
    expect(retried).toMatchObject({
      kind: 'home_entered',
      homeServerIdentityId: home.homeServerIdentityId,
      profileId: (failed as { profileId?: string }).profileId,
    });
    expect(harness.redemptionCount()).toBe(2);
    expect(registerMachineWithAuthenticatedHomeRuntimeMock).toHaveBeenCalledOnce();
  });

  it('returns the continuation outcome instead of home_entered when material retry continuation fails', async () => {
    const harness = await configureProductionJourney({ modeStatus: 503 });
    harness.continueMachineAndService.mockResolvedValueOnce({ kind: 'failed' as const });
    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
      continueMachineAndService: harness.continueMachineAndService,
    });
    await harness.waitForApproval();
    await vi.advanceTimersByTimeAsync(1_250);

    const failed = await result;
    expect(failed).toMatchObject({ kind: 'failure', stage: 'material', homeCredentialCommitted: true });
    expect(harness.continueMachineAndService).not.toHaveBeenCalled();

    harness.setModeStatus(200);
    if (failed.kind !== 'failure' || !failed.retry) throw new Error('Expected material retry continuation');
    await expect(failed.retry()).resolves.toMatchObject({
      kind: 'failure',
      stage: 'enter',
      homeServerIdentityId: home.homeServerIdentityId,
      homeCredentialCommitted: true,
      recovery: 'retry_stage',
    });
    expect(harness.continueMachineAndService).toHaveBeenCalledTimes(1);
  });

  it('maps a selected Home mode transport exception to material recovery after credential commitment', async () => {
    const harness = await configureProductionJourney({ modeTransportFailure: true });
    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
    });
    await harness.waitForApproval();
    await vi.advanceTimersByTimeAsync(1_250);

    await expect(result).resolves.toMatchObject({
      kind: 'failure',
      stage: 'material',
      homeCredentialCommitted: true,
      recovery: 'retry_stage',
    });
    expect(writeCredentialsTokenOnlyForServerIdMock).toHaveBeenCalledWith(expect.any(String), {
      token: 'home-token',
      encryption: null,
    });
    expect(registerMachineWithAuthenticatedHomeRuntimeMock).not.toHaveBeenCalled();
  });

  it('keeps material retry recovery for a Home chosen from the directory chooser', async () => {
    const harness = await configureProductionJourney({ selection: 'chooser', modeTransportFailure: true });
    promptMultipleChoiceMock.mockImplementation(async (message: string) => (
      message.startsWith('Choose a Home') ? home.homeServerIdentityId : 'key:login:keyed'
    ));
    try {
      const result = runCliAccountServiceSetupEntry({
        endpoint: accountService.endpoint,
        promptInputFn: async () => 'k',
        promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
        timeoutMs: 10_000,
      });
      await harness.waitForApproval();
      await vi.advanceTimersByTimeAsync(1_250);

      await expect(result).resolves.toMatchObject({
        kind: 'failure',
        stage: 'material',
        homeServerIdentityId: home.homeServerIdentityId,
        homeCredentialCommitted: true,
        recovery: 'retry_stage',
      });
      expect(promptMultipleChoiceMock.mock.calls.some(([message]) => String(message).startsWith('Choose a Home'))).toBe(true);
      expect(writeCredentialsTokenOnlyForServerIdMock).toHaveBeenCalledWith(expect.any(String), {
        token: 'home-token',
        encryption: null,
      });
    } finally {
      promptMultipleChoiceMock.mockImplementation(async () => 'key:login:keyed');
    }
  });

  it('keeps committed material recovery when a chooser-selected Home fails before approval', async () => {
    const harness = await configureProductionJourney({ selection: 'chooser', immediateRedemption: true, modeStatus: 503 });
    promptMultipleChoiceMock.mockImplementation(async (message: string) => (
      message.startsWith('Choose a Home') ? home.homeServerIdentityId : 'key:login:keyed'
    ));
    try {
      const result = runCliAccountServiceSetupEntry({
        endpoint: accountService.endpoint,
        promptInputFn: async () => 'k',
        promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
        timeoutMs: 10_000,
        continueMachineAndService: harness.continueMachineAndService,
      });
      await vi.advanceTimersByTimeAsync(1_250);

      const failed = await result;
      expect(failed).toMatchObject({
        kind: 'failure',
        stage: 'material',
        homeServerIdentityId: home.homeServerIdentityId,
        homeCredentialCommitted: true,
        recovery: 'retry_stage',
      });
      expect(promptMultipleChoiceMock.mock.calls.some(([message]) => String(message).startsWith('Choose a Home'))).toBe(true);
      expect(writeCredentialsTokenOnlyForServerIdMock).toHaveBeenCalledWith(expect.any(String), {
        token: 'home-token',
        encryption: null,
      });
      expect(harness.continueMachineAndService).not.toHaveBeenCalled();

      harness.setModeStatus(200);
      if (failed.kind !== 'failure' || !failed.retry) throw new Error('Expected material retry continuation');
      await expect(failed.retry()).resolves.toMatchObject({
        kind: 'home_entered',
        homeServerIdentityId: home.homeServerIdentityId,
      });
      expect(harness.continueMachineAndService).toHaveBeenCalledTimes(1);
    } finally {
      promptMultipleChoiceMock.mockImplementation(async () => 'key:login:keyed');
    }
  });

  it('preserves a valid Home credential when machine registration must be retried', async () => {
    registerMachineWithAuthenticatedHomeRuntimeMock.mockRejectedValueOnce(new Error('registration unavailable'));
    const harness = await configureProductionJourney();
    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
    });
    await harness.waitForApproval();
    await vi.advanceTimersByTimeAsync(1_250);

    await expect(result).resolves.toMatchObject({
      kind: 'failure',
      stage: 'enter',
      homeCredentialCommitted: true,
      recovery: 'retry_stage',
    });
    expect(writeCredentialsTokenOnlyForServerIdMock).toHaveBeenCalledOnce();
  });

  it('shows planet activity while the selected Account Service journey is pending and clears it on cancellation', async () => {
    const harness = await configureProductionJourney();
    const controller = new AbortController();
    const restoreStdio = setStdioTtyForTest({ stdin: false, stdout: true });
    const restoreStderr = setStderrTtyForTest(true);
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('NO_COLOR', '1');
    vi.stubEnv('HAPPIER_NO_ANIMATION', '');
    const output = captureConsoleText();
    try {
      const result = runCliAccountServiceSetupEntry({
        endpoint: accountService.endpoint,
        promptInputFn: async () => 'k',
        promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
        signal: controller.signal,
        timeoutMs: 10_000,
      });

      await harness.waitForApproval();
      expect(output.text()).toContain('Signing in and finding linked Homes');

      controller.abort();
      await expect(result).resolves.toEqual({ kind: 'cancelled' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      output.restore();
      restoreStderr();
      restoreStdio();
    }
  });

  it('keeps redirected Account Service activity linear and free of terminal controls', async () => {
    const harness = await configureProductionJourney();
    const controller = new AbortController();
    const restoreStdio = setStdioTtyForTest({ stdin: false, stdout: false });
    const restoreStderr = setStderrTtyForTest(false);
    const output = captureConsoleText();
    try {
      const result = runCliAccountServiceSetupEntry({
        endpoint: accountService.endpoint,
        promptInputFn: async () => 'k',
        promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
        signal: controller.signal,
        timeoutMs: 10_000,
      });

      await harness.waitForApproval();
      expect(output.text()).toContain('- [..] Signing in and finding linked Homes');
      expect(output.text()).not.toMatch(/[\x1b\r]/u);

      controller.abort();
      await expect(result).resolves.toEqual({ kind: 'cancelled' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      output.restore();
      restoreStderr();
      restoreStdio();
    }
  });

  it('does not commit an enrolled Home credential when authenticated reconciliation is stale', async () => {
    const harness = await configureProductionJourney();
    const newerDescriptor = {
      ...home.connectionDescriptor,
      revision: home.connectionDescriptor.revision + 1,
      endpoints: [{ kind: 'https' as const, url: 'https://newer-home-a.example.test' }],
    };
    const existing = await adoptServerProfileHomeConnectionDescriptor({
      descriptor: newerDescriptor,
      suggestedName: home.label,
      observation: 'exact',
    });

    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
    });
    await harness.waitForApproval();
    await vi.advanceTimersByTimeAsync(1_250);

    await expect(result).resolves.toMatchObject({
      kind: 'failure',
      stage: 'enter',
      homeServerIdentityId: home.homeServerIdentityId,
      homeCredentialCommitted: false,
      recovery: 'retry_stage',
      retry: expect.any(Function),
    });
    expect(writeCredentialsTokenOnlyForServerIdMock).not.toHaveBeenCalled();
    expect(authAndSetupMachineIfNeededMock).not.toHaveBeenCalled();
    const retained = (await listServerProfiles()).find((profile) => profile.id === existing.profile.id);
    expect(retained).toMatchObject({
      homeConnectionDescriptorAuthority: 'exact',
      homeConnectionDescriptor: newerDescriptor,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels approval polling without redeeming or committing a late Home credential', async () => {
    const harness = await configureProductionJourney();
    const controller = new AbortController();
    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    await harness.waitForApproval();
    controller.abort();

    await expect(result).resolves.toEqual({ kind: 'cancelled' });
    expect(harness.redemptionCount()).toBe(1);
    expect(writeCredentialsTokenOnlyForServerIdMock).not.toHaveBeenCalled();
    expect(authAndSetupMachineIfNeededMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('binds resumed approval work to the resume signal at the Home transport boundary', async () => {
    const harness = await configureProductionJourney();
    const initialAttempt = new AbortController();
    const resumedAttempt = new AbortController();
    let resolveBoundaryStarted!: () => void;
    const boundaryStarted = new Promise<void>((resolve) => { resolveBoundaryStarted = resolve; });
    let observedBoundarySignal: AbortSignal | undefined;
    let releaseBoundary: (() => void) | undefined;
    let acquisitionCount = 0;
    const opened = {
      ok: true as const,
      runtime: {
        runtimeOrigin: home.canonicalServerUrl,
        authenticatedCredentialDestination: {
          kind: 'https' as const,
          applicationUrl: home.canonicalServerUrl,
        },
      },
      close: closeHomeTransportMock,
    };
    acquireTerminalAuthEnrollmentRuntimeMock.mockImplementation(async (
      _descriptor: unknown,
      _preferredTransport: unknown,
      boundarySignal?: AbortSignal,
    ) => {
      acquisitionCount += 1;
      if (acquisitionCount === 1) return opened;
      observedBoundarySignal = boundarySignal;
      return await new Promise((resolve) => {
        const finish = (): void => resolve({
          ok: false as const,
          error: new DOMException('Aborted', 'AbortError'),
        });
        boundarySignal?.addEventListener('abort', finish, { once: true });
        releaseBoundary = (): void => resolve(opened);
        resolveBoundaryStarted();
      });
    });
    runCliAccountServiceHomeEntryMock.mockImplementationOnce(async (input, ports) => {
      if (!input.existingAuthentication) throw new Error('stored Account Service authentication expected');
      const first = await ports.runDirectoryJourney({
        target: input.existingAuthentication.target,
        credential: input.existingAuthentication.credential,
        signal: initialAttempt.signal,
      });
      if (first.kind !== 'awaiting_approval') throw new Error('approval continuation expected');
      return await first.resume({ signal: resumedAttempt.signal });
    });

    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
    });
    await harness.waitForApproval();
    await boundaryStarted;
    resumedAttempt.abort();
    releaseBoundary?.();

    expect(observedBoundarySignal).toBe(resumedAttempt.signal);
    await expect(result).resolves.toEqual({ kind: 'cancelled' });
    expect(harness.redemptionCount()).toBe(1);
    expect(writeCredentialsTokenOnlyForServerIdMock).not.toHaveBeenCalled();
  });

  it('times out approval polling without a second redemption or Home credential commit', async () => {
    const harness = await configureProductionJourney();
    const result = runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10,
    });

    await harness.waitForApproval();
    await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toEqual({ kind: 'timed_out' });
    expect(harness.redemptionCount()).toBe(1);
    expect(writeCredentialsTokenOnlyForServerIdMock).not.toHaveBeenCalled();
    expect(authAndSetupMachineIfNeededMock).not.toHaveBeenCalled();
  });

  it('rejects a selected method that the Account Service did not advertise before authentication', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-service-method-selection-'));
    roots.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    fetchServerFeaturesSnapshotMock.mockResolvedValue({
      status: 'ready',
      provenance: 'authenticated',
      serverIdentityId: accountService.serverIdentityId,
      features: {
        features: {},
        capabilities: {
          accountDirectory: {
            version: 1,
            homeDirectory: true,
            homeEnrollment: true,
            deviceApproval: true,
            homeLoginAssertion: {
              keyId: 'a'.repeat(64),
              publicKeyBase64Url: 'A'.repeat(43),
            },
          },
          server: { canonicalServerUrl: accountService.canonicalServerUrl },
          serverIdentity: { serverIdentityId: accountService.serverIdentityId },
          auth: {
            methods: [{ id: 'github', actions: [{ id: 'provision', enabled: true, mode: 'keyed' }] }],
            keyChallenge: { v2: false },
          },
          oauth: { providers: { github: { configured: true, enabled: true } } },
        },
      },
    });
    const secretPrompt = vi.fn(async () => encodeBase64(new Uint8Array(32), 'base64url'));

    await expect(runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: secretPrompt,
      timeoutMs: 10_000,
    })).resolves.toEqual({ kind: 'cancelled' });

    expect(secretPrompt).not.toHaveBeenCalled();
    expect(authenticateCliAccountServiceMock).not.toHaveBeenCalled();
  });

  it('presents only catalog-admitted Account Service tuples with their verified display names', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-service-method-presentation-'));
    roots.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    fetchServerFeaturesSnapshotMock.mockResolvedValue({
      status: 'ready',
      provenance: 'authenticated',
      serverIdentityId: accountService.serverIdentityId,
      features: {
        features: {},
        capabilities: {
          accountDirectory: {
            version: 1,
            homeDirectory: true,
            homeEnrollment: true,
            deviceApproval: true,
            homeLoginAssertion: {
              keyId: 'a'.repeat(64),
              publicKeyBase64Url: 'A'.repeat(43),
            },
          },
          server: { canonicalServerUrl: accountService.canonicalServerUrl },
          serverIdentity: { serverIdentityId: accountService.serverIdentityId },
          auth: {
            methods: [
              {
                id: 'github',
                actions: [
                  { id: 'login', enabled: true, mode: 'keyless' },
                  { id: 'provision', enabled: true, mode: 'keyed' },
                ],
                ui: { displayName: 'GitHub Enterprise' },
              },
              { id: 'key_challenge', actions: [{ id: 'login', enabled: true, mode: 'keyed' }] },
              { id: 'google', actions: [{ id: 'login', enabled: true, mode: 'keyless' }], ui: { displayName: 'Google Workspace' } },
              { id: 'mtls', actions: [{ id: 'provision', enabled: true, mode: 'keyless' }], ui: { displayName: 'Home certificate' } },
            ],
            keyChallenge: { v2: false },
          },
          oauth: { providers: { github: { configured: true, enabled: true } } },
        },
      },
    });
    authenticateCliAccountServiceMock.mockResolvedValue({ kind: 'failed' });
    promptMultipleChoiceMock.mockImplementationOnce(async (message: string) => {
      expect(message).toContain('Continue with GitHub Enterprise');
      expect(message).toContain('New here? Continue with GitHub Enterprise');
      expect(message).toContain('Use an account key');
      expect(message).toContain('Continue with Google Workspace');
      expect(message.indexOf('Continue with GitHub Enterprise')).toBeLessThan(message.indexOf('Use an account key'));
      expect(message.indexOf('Use an account key')).toBeLessThan(message.indexOf('Continue with Google Workspace'));
      expect(message).not.toContain('Home certificate');
      return 'provider:github:login:keyless';
    });

    await expect(runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => '',
      timeoutMs: 10_000,
    })).resolves.toEqual({ kind: 'failed' });

    expect(authenticateCliAccountServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: { kind: 'provider', providerId: 'github', action: 'login', mode: 'keyless' },
      }),
      expect.anything(),
    );
  });

  it('routes the catalog key-provision tuple without asking for an existing recovery key', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-service-key-provision-'));
    roots.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    fetchServerFeaturesSnapshotMock.mockResolvedValue(
      readyAccountServiceFeatures(accountService, accountService.serverIdentityId, 'provision'),
    );
    authenticateCliAccountServiceMock.mockResolvedValue({ kind: 'failed' });
    const promptSecretInputFn = vi.fn(async () => encodeBase64(new Uint8Array(32), 'base64url'));
    promptMultipleChoiceMock.mockImplementationOnce(async (message: string) => {
      expect(message).toContain('New here? Create an account key');
      return 'key:provision:keyed';
    });

    await expect(runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => '',
      promptSecretInputFn,
      timeoutMs: 10_000,
    })).resolves.toEqual({ kind: 'failed' });

    expect(promptSecretInputFn).not.toHaveBeenCalled();
    expect(authenticateCliAccountServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: { kind: 'key', action: 'provision', mode: 'keyed' } }),
      expect.anything(),
    );
  });

  it('reuses the persisted custom Account Service when setup supplies no explicit override', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-service-persisted-selection-'));
    roots.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    const session = createCliAccountServiceSessionOwner({ happyHomeDir });
    const previouslyAdvertisedService = {
      ...accountService,
      advertisedMethods: {
        keyLoginAvailable: false,
        oauthProviderIds: ['github'],
        preferredProvisionProviderId: 'github',
      },
    } as const;
    await session.selectService(previouslyAdvertisedService);
    await session.replaceCredential({
      service: previouslyAdvertisedService,
      credential: { token: 'account-service-token' },
    });

    const observedEndpoints: string[] = [];
    fetchServerFeaturesSnapshotMock.mockImplementation(async (input: Readonly<{ serverUrl: string }>) => {
      observedEndpoints.push(input.serverUrl);
      if (input.serverUrl === accountService.endpoint) return readyAccountServiceFeatures(accountService);
      throw new Error(`Unexpected Account Service contact: ${input.serverUrl}`);
    });
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (urlInput: string | URL | Request) => {
      const url = String(urlInput);
      requestedUrls.push(url);
      if (url.endsWith('/v1/account-directory/me')) return Response.json({});
      if (url.endsWith('/v1/account-directory/homes')) {
        return Response.json({ v: 1, homes: [], preferredHomeServerIdentityId: null });
      }
      return new Response(null, { status: 404 });
    }));

    await expect(runCliAccountServiceSetupEntry({
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
    })).resolves.toMatchObject({ kind: 'account_connected_no_homes' });

    expect(observedEndpoints).toEqual([accountService.endpoint]);
    expect(requestedUrls).not.toEqual([]);
    expect(requestedUrls.every((url) => url.startsWith(`${accountService.endpoint}/`))).toBe(true);
    await expect(session.readSelection()).resolves.toEqual(accountServiceAuthority);
  });

  it('validates and reuses a stored restricted credential before prompting for an auth method', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-service-session-reuse-'));
    roots.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    const session = createCliAccountServiceSessionOwner({ happyHomeDir });
    await session.selectService(accountService);
    await session.replaceCredential({
      service: accountService,
      credential: { token: 'account-service-token' },
    });

    fetchServerFeaturesSnapshotMock.mockResolvedValue(readyAccountServiceFeatures(accountService));
    const promptInputFn = vi.fn(async () => 'k');
    const promptSecretInputFn = vi.fn(async () => encodeBase64(new Uint8Array(32), 'base64url'));
    vi.stubGlobal('fetch', vi.fn(async (urlInput: string | URL | Request) => {
      const url = String(urlInput);
      if (url.endsWith('/v1/account-directory/me')) return Response.json({});
      if (url.endsWith('/v1/account-directory/homes')) {
        return Response.json({ v: 1, homes: [], preferredHomeServerIdentityId: null });
      }
      return new Response(null, { status: 404 });
    }));

    await expect(runCliAccountServiceSetupEntry({
      promptInputFn,
      promptSecretInputFn,
      timeoutMs: 10_000,
    })).resolves.toMatchObject({ kind: 'account_connected_no_homes' });

    expect(promptMultipleChoiceMock).not.toHaveBeenCalled();
    expect(promptInputFn).not.toHaveBeenCalled();
    expect(promptSecretInputFn).not.toHaveBeenCalled();
    expect(authenticateCliAccountServiceMock).not.toHaveBeenCalled();
    await expect(session.readSelection()).resolves.toEqual(accountServiceAuthority);
    await expect(session.readCredential(accountService)).resolves.toEqual({
      token: 'account-service-token',
    });
  });

  it('returns exact-Home recovery when an explicit Home is not linked instead of substituting a preferred Home', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-service-explicit-missing-'));
    roots.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    const session = createCliAccountServiceSessionOwner({ happyHomeDir });
    await session.selectService(accountService);
    await session.replaceCredential({ service: accountService, credential: { token: 'account-service-token' } });
    fetchServerFeaturesSnapshotMock.mockResolvedValue(readyAccountServiceFeatures(accountService));
    vi.stubGlobal('fetch', vi.fn(async (urlInput: string | URL | Request) => {
      const url = String(urlInput);
      if (url.endsWith('/v1/account-directory/me')) return Response.json({});
      if (url.endsWith('/v1/account-directory/homes')) {
        return Response.json({ v: 1, homes: [home], preferredHomeServerIdentityId: home.homeServerIdentityId });
      }
      return new Response(null, { status: 404 });
    }));

    await expect(runCliAccountServiceSetupEntry({
      intent: { kind: 'enter', target: { kind: 'explicit', homeServerIdentityId: 'srv_missing_home' } },
      timeoutMs: 10_000,
    })).resolves.toEqual({
      kind: 'explicit_target_not_linked',
      homeServerIdentityId: 'srv_missing_home',
    });
    expect(acquireTerminalAuthEnrollmentRuntimeMock).not.toHaveBeenCalled();
  });

  it('uses the existing method flow only after a stored credential is definitively rejected', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-service-session-replacement-'));
    roots.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    const session = createCliAccountServiceSessionOwner({ happyHomeDir });
    await session.selectService(accountService);
    await session.replaceCredential({
      service: accountService,
      credential: { token: 'rejected-account-service-token' },
    });

    fetchServerFeaturesSnapshotMock.mockResolvedValue(readyAccountServiceFeatures(accountService));
    authenticateCliAccountServiceMock.mockResolvedValue({
      kind: 'authenticated',
      credential: { token: 'replacement-account-service-token' },
    });
    const promptInputFn = vi.fn(async () => 'k');
    const promptSecretInputFn = vi.fn(async () => encodeBase64(new Uint8Array(32), 'base64url'));
    vi.stubGlobal('fetch', vi.fn(async (urlInput: string | URL | Request) => {
      const url = String(urlInput);
      if (url.endsWith('/v1/account-directory/me')) {
        return new Response(null, { status: 401 });
      }
      if (url.endsWith('/v1/account-directory/homes')) {
        return Response.json({ v: 1, homes: [], preferredHomeServerIdentityId: null });
      }
      return new Response(null, { status: 404 });
    }));

    await expect(runCliAccountServiceSetupEntry({
      promptInputFn,
      promptSecretInputFn,
      timeoutMs: 10_000,
    })).resolves.toMatchObject({ kind: 'account_connected_no_homes' });

    expect(promptMultipleChoiceMock).toHaveBeenCalledOnce();
    expect(promptSecretInputFn).toHaveBeenCalledOnce();
    expect(authenticateCliAccountServiceMock).toHaveBeenCalledOnce();
    await expect(session.readCredential(accountService)).resolves.toEqual({
      token: 'replacement-account-service-token',
    });
  });

  it('signs in and stops before the Home directory when only sign-in is requested', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-service-sign-in-only-'));
    roots.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    reloadConfiguration();
    const activeServerIdBefore = configuration.activeServerId;
    const session = createCliAccountServiceSessionOwner({ happyHomeDir });

    fetchServerFeaturesSnapshotMock.mockResolvedValue(readyAccountServiceFeatures(accountService));
    authenticateCliAccountServiceMock.mockResolvedValue({
      kind: 'authenticated',
      credential: { token: 'signed-in-account-service-token' },
    });
    const fetchMock = vi.fn(async (urlInput: string | URL | Request) => {
      const url = String(urlInput);
      // A sole preferred Home is linked: a journey that kept going would enter and focus it.
      if (url.endsWith('/v1/account-directory/homes')) {
        return Response.json({ v: 1, homes: [home], preferredHomeServerIdentityId: home.homeServerIdentityId });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      stopAfter: 'sign_in',
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
    })).resolves.toEqual({ kind: 'signed_in', endpoint: accountService.endpoint });

    expect(fetchMock.mock.calls.map(([url]) => String(url)))
      .not.toContainEqual(expect.stringContaining('/v1/account-directory/homes'));
    expect(configuration.activeServerId).toBe(activeServerIdBefore);
    await expect(session.readSelection()).resolves.toEqual(accountServiceAuthority);
    await expect(session.readCredential(accountService)).resolves.toEqual({
      token: 'signed-in-account-service-token',
    });
  });

  it('retains a stored restricted credential when validation is temporarily unavailable', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-service-session-unavailable-'));
    roots.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    const session = createCliAccountServiceSessionOwner({ happyHomeDir });
    await session.selectService(accountService);
    await session.replaceCredential({
      service: accountService,
      credential: { token: 'retained-account-service-token' },
    });

    fetchServerFeaturesSnapshotMock.mockResolvedValue(readyAccountServiceFeatures(accountService));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));

    await expect(runCliAccountServiceSetupEntry({
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
    })).resolves.toEqual({ kind: 'account_service_unavailable' });

    expect(promptMultipleChoiceMock).not.toHaveBeenCalled();
    expect(authenticateCliAccountServiceMock).not.toHaveBeenCalled();
    await expect(session.readCredential(accountService)).resolves.toEqual({
      token: 'retained-account-service-token',
    });
  });

  it('keeps an unavailable persisted Account Service selected without contacting Cloud', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-service-persisted-unavailable-'));
    roots.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    const session = createCliAccountServiceSessionOwner({ happyHomeDir });
    await session.selectService(accountService);

    const observedEndpoints: string[] = [];
    fetchServerFeaturesSnapshotMock.mockImplementation(async (input: Readonly<{ serverUrl: string }>) => {
      observedEndpoints.push(input.serverUrl);
      return { status: 'error' as const, reason: 'network' as const };
    });

    await expect(runCliAccountServiceSetupEntry({
      promptInputFn: async () => 'k',
      timeoutMs: 10_000,
    })).resolves.toEqual({ kind: 'account_service_unavailable' });

    expect(observedEndpoints).toEqual([accountService.endpoint]);
    await expect(session.readSelection()).resolves.toEqual(accountServiceAuthority);
  });

  it('uses the build-owned Account Service default injected by setup composition', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-service-default-selection-'));
    roots.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;

    const observedEndpoints: string[] = [];
    fetchServerFeaturesSnapshotMock.mockImplementation(async (input: Readonly<{ serverUrl: string }>) => {
      observedEndpoints.push(input.serverUrl);
      return { status: 'error' as const, reason: 'network' as const };
    });

    await expect(runCliAccountServiceSetupEntry({
      builtInNoTargetDefault: { endpoint: 'https://api.happier.dev' },
      promptInputFn: async () => 'k',
      timeoutMs: 10_000,
    })).resolves.toEqual({ kind: 'account_service_unavailable' });

    expect(observedEndpoints).toEqual(['https://api.happier.dev']);
  });

  it('returns the canonical cancellation outcome when caller aborts Account Service discovery', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-service-policy-cancel-'));
    roots.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    const controller = new AbortController();
    fetchServerFeaturesSnapshotMock.mockImplementation(async () => {
      controller.abort();
      return { status: 'error' as const, reason: 'timeout' as const };
    });
    await expect(runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      signal: controller.signal,
      timeoutMs: 10_000,
    })).resolves.toEqual({ kind: 'cancelled' });
  });

  it('fails closed when the persisted Account Service endpoint presents another identity', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-service-persisted-identity-'));
    roots.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    const session = createCliAccountServiceSessionOwner({ happyHomeDir });
    await session.selectService(accountService);

    fetchServerFeaturesSnapshotMock.mockResolvedValue(
      readyAccountServiceFeatures(accountService, 'srv_another_account_service'),
    );

    await expect(runCliAccountServiceSetupEntry({
      promptInputFn: async () => 'k',
      timeoutMs: 10_000,
    })).resolves.toEqual({ kind: 'identity_mismatch' });

    await expect(session.readSelection()).resolves.toEqual(accountServiceAuthority);
  });

  it('uses the contextual auth-entry catalog instead of the incomplete feature projection', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-service-auth-entry-'));
    roots.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    fetchServerFeaturesSnapshotMock.mockResolvedValue(readyAccountServiceFeatures(accountService, undefined, 'provision'));
    fetchCliHomeAuthEntryMock.mockResolvedValue({
      kind: 'ready',
      projection: {
        v: 1,
        scope: { kind: 'home' },
        state: 'ready',
        actions: [{
          kind: 'authenticate',
          methodId: 'key_challenge',
          action: 'login',
          mode: 'keyed',
          origin: 'home',
          presentation: { displayName: 'Account key' },
        }],
        autoRedirect: null,
      },
    });
    authenticateCliAccountServiceMock.mockResolvedValue({ kind: 'failed' });

    await expect(runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => encodeBase64(new Uint8Array(32), 'base64url'),
      timeoutMs: 10_000,
    })).resolves.toEqual({ kind: 'failed' });

    expect(authenticateCliAccountServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: { kind: 'key', action: 'login', mode: 'keyed' } }),
      expect.anything(),
    );
  });

  it('does not downgrade to feature methods when auth-entry fails with a supported-endpoint error', async () => {
    fetchServerFeaturesSnapshotMock.mockResolvedValue(readyAccountServiceFeatures(accountService));
    fetchCliHomeAuthEntryMock.mockResolvedValue({ kind: 'unavailable' });

    await expect(runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      timeoutMs: 10_000,
    })).resolves.toEqual({ kind: 'account_service_unavailable' });
    expect(authenticateCliAccountServiceMock).not.toHaveBeenCalled();
  });
});

describe('CLI named-account key login accepts the displayed recovery-key form', () => {
  afterEach(async () => {
    authenticateCliAccountServiceMock.mockReset();
    authenticateCliAccountServiceMock.mockImplementation(async () => ({ kind: 'failed' }));
    fetchServerFeaturesSnapshotMock.mockReset();
    fetchCliHomeAuthEntryMock.mockReset().mockResolvedValue({ kind: 'unsupported' });
    vi.unstubAllGlobals();
    if (originalHome === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHome;
    reloadConfiguration();
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  it('authenticates a displayed dashed recovery key through the real parser and real auth owner', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-service-dashed-key-'));
    roots.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    reloadConfiguration();
    fetchServerFeaturesSnapshotMock.mockResolvedValue(readyAccountServiceFeatures(accountService));
    authenticateCliAccountServiceMock.mockImplementation(async (input: unknown) =>
      await authenticateCliAccountServiceActual.fn!(
        input as Parameters<NonNullable<typeof authenticateCliAccountServiceActual.fn>>[0],
      ));

    // Exactly what the UI backup surface displays for the seed bytes 0..31.
    const displayedDashedKey = 'AAAQE-AYEAU-DAOCA-JBIFQ-YDIOB-4IBCE-QTCQK-RMFYY-DENBW-HA5DY-PQ';
    const expectedSeed = Uint8Array.from({ length: 32 }, (_, index) => index);
    const authBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (urlInput: string | URL | Request, init?: RequestInit) => {
      const url = String(urlInput);
      if (url.endsWith('/v1/auth/account-directory/challenge')) {
        return Response.json({
          challengeId: 'challenge_123',
          nonce: 'bm9uY2U',
          audience: {
            origin: accountService.canonicalServerUrl,
            serverIdentityId: accountService.serverIdentityId,
          },
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      if (url.endsWith('/v1/auth/account-directory')) {
        authBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ token: 'restricted-directory-token' });
      }
      if (url.endsWith('/v1/account-directory/me')) return Response.json({});
      if (url.endsWith('/v1/account-directory/homes')) {
        return Response.json({ v: 1, homes: [], preferredHomeServerIdentityId: null });
      }
      return new Response(null, { status: 404 });
    }));

    await expect(runCliAccountServiceSetupEntry({
      endpoint: accountService.endpoint,
      promptInputFn: async () => 'k',
      promptSecretInputFn: async () => displayedDashedKey,
      timeoutMs: 10_000,
    })).resolves.toEqual({ kind: 'account_connected_no_homes' });

    expect(promptMultipleChoiceMock).toHaveBeenCalledOnce();
    expect(authBodies).toHaveLength(1);
    const expectedPublicKey = encodeBase64(tweetnacl.sign.keyPair.fromSeed(expectedSeed).publicKey);
    expect(authBodies[0]).toMatchObject({ challengeId: 'challenge_123', publicKey: expectedPublicKey });
  });
});
