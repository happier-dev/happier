import { artifactListResponse } from '@/testkit/http/artifactHome';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuthTokenProvenanceSchema,
  parseTerminalConnectLinkV4Parameters,
  sealTerminalProvisioningV3Payload,
  sealTerminalProvisioningV3TokenOnlyPayload,
} from '@happier-dev/protocol';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const homeBoundary = vi.hoisted(() => ({
  origin: 'https://api.happier.dev',
  accountMode: 'plain' as 'plain' | 'e2ee',
  descriptor: null as import('@happier-dev/protocol').HomeConnectionDescriptorV1 | null,
  response: '',
  approvedToken: '',
  requests: [] as Array<{ method: string; path: string; body: unknown }>,
  events: [] as string[],
  activeTunnel: false,
}));

vi.mock('@happier-dev/iroh-native/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/iroh-native/node')>();
  type Native = NonNullable<Parameters<typeof actual.createNodeIrohHomeTunnelSession>[0]['native']>;
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected native operation'); };
  // Inject only the native addon boundary; the session, carrier and enrollment owners stay real.
  const native = {
    getAvailability: (): never => { throw new Error('Unexpected availability read'); },
    startHomeAcceptor: unexpected, stopHomeAcceptor: unexpected,
    getEndpointStatus: unexpected, getTunnelStatus: unexpected,
    startMachineAcceptor: unexpected, stopMachineAcceptor: unexpected,
    getMachineAcceptorStatus: unexpected, startMachineTunnel: unexpected,
    startMachineHttpTunnel: unexpected, stopMachineTunnel: unexpected,
    getMachineTunnelStatus: unexpected,
    createEndpoint: async () => ({ endpointHandle: 'auth-helper', endpointId: 'b'.repeat(64),
      relayPolicy: 'automatic' as const, relayMode: 'custom' as const,
      capProfile: 'account_client', relayUrls: [] }),
    ensureHomeTunnel: async (request) => {
      homeBoundary.activeTunnel = true;
      return { tunnelId: 'auth-tunnel', endpointHandle: request.endpointHandle,
        homeServerIdentityId: request.homeServerIdentityId, homeEndpointId: request.endpointId,
        runtimeOrigin: homeBoundary.origin, observedPath: 'relay' as const,
        carrier: 'iroh' as const, startedAtMs: 1 };
    },
    releaseHomeTunnel: async () => { homeBoundary.activeTunnel = false; },
    shutdownEndpoint: async () => { homeBoundary.events.push('close'); },
  } satisfies Native;
  return {
    ...actual,
    createNodeIrohHomeTunnelSession: async (input: Parameters<typeof actual.createNodeIrohHomeTunnelSession>[0]) =>
      await actual.createNodeIrohHomeTunnelSession({ ...input, native }),
  };
});

function makeJwtWithSub(sub: string, signature = 'signature'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const provenance = AuthTokenProvenanceSchema.parse({ v: 1, kind: 'terminal', authority: 'account_automation' });
  const payload = Buffer.from(JSON.stringify({ sub, provenance })).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

describe('authAndSetupMachineIfNeeded (machine id binding)', () => {
  const envScope = createEnvKeyScope(['HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_API_TOKEN', 'HAPPIER_HOME_CARRIER_POLICY', 'HAPPIER_SESSION_AUTOSTART_DAEMON',
    'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE', 'HAPPIER_SESSION_REQUESTER_SESSION_ID']);
  const previousHomeDir = process.env.HAPPIER_HOME_DIR;
  const previousActiveServerId = process.env.HAPPIER_ACTIVE_SERVER_ID;
  const previousServerUrl = process.env.HAPPIER_SERVER_URL;
  const previousWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const previousAutostart = process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
  const previousAuthMethod = process.env.HAPPIER_AUTH_METHOD;
  const previousNoBrowser = process.env.HAPPIER_NO_BROWSER_OPEN;
  const previousPollInterval = process.env.HAPPIER_AUTH_POLL_INTERVAL_MS;
  let app: FastifyInstance;
  let restoreAxios: (() => void) | undefined;

  beforeEach(async () => {
    vi.resetModules();
    homeBoundary.origin = 'https://api.happier.dev';
    homeBoundary.accountMode = 'plain';
    homeBoundary.descriptor = null;
    homeBoundary.response = '';
    homeBoundary.approvedToken = '';
    homeBoundary.requests = [];
    homeBoundary.events = [];
    homeBoundary.activeTunnel = false;
    process.env.HAPPIER_SERVER_URL = homeBoundary.origin;
    envScope.patch({ HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_LOCAL_SERVER_URL: undefined,
      HAPPIER_API_TOKEN: undefined, HAPPIER_HOME_CARRIER_POLICY: undefined, HAPPIER_SESSION_AUTOSTART_DAEMON: '0',
      HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined, HAPPIER_SESSION_REQUESTER_SESSION_ID: undefined });
    app = Fastify();
    app.addHook('preHandler', async (request) => {
      homeBoundary.requests.push({ method: request.method, path: request.url.split('?')[0]!, body: request.body });
    });
    app.get('/v1/account/encryption', async () => ({ mode: homeBoundary.accountMode, updatedAt: 1 }));
    const readFeatures = async () => ({
      features: {},
      capabilities: homeBoundary.descriptor ? { serverIdentity: { serverIdentityId: homeBoundary.descriptor.homeServerIdentityId } } : {},
      ...(homeBoundary.descriptor ? { homeConnectionDescriptor: homeBoundary.descriptor } : {}),
    });
    app.get('/v1/features', readFeatures);
    app.get('/v1/features/authenticated', readFeatures);
    app.post<{ Body: { id: string; metadata: string; daemonState?: string } }>('/v1/machines', async (request) => {
      if (homeBoundary.descriptor?.endpoints.some((endpoint) => endpoint.kind === 'iroh')) {
        expect(homeBoundary.activeTunnel).toBe(true);
      }
      homeBoundary.events.push('register');
      return { machine: { ...request.body, daemonState: request.body.daemonState ?? null,
        metadataVersion: 1, daemonStateVersion: 0 } };
    });
    app.post('/v1/auth/request', async () => ({ state: 'requested' }));
    app.get('/v1/auth/request/status', async () => ({ status: homeBoundary.response ? 'authorized' : 'pending', supportsV2: true }));
    app.post('/v1/auth/request/claim', async () => ({ state: 'authorized', token: homeBoundary.approvedToken,
      response: homeBoundary.response, serverIdentityId: homeBoundary.descriptor?.homeServerIdentityId }));
    const { installAxiosFastifyAdapter } = await import('@/testkit/http/axiosAdapter');
    restoreAxios = installAxiosFastifyAdapter({ app, get origin() { return homeBoundary.origin; } });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(homeBoundary.origin);
      const response = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return new Response(response.payload, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
    }));
  });

  afterEach(async () => {
    restoreAxios?.();
    await app.close();
    envScope.restore();
    if (previousHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHomeDir;
    if (previousActiveServerId === undefined) delete process.env.HAPPIER_ACTIVE_SERVER_ID;
    else process.env.HAPPIER_ACTIVE_SERVER_ID = previousActiveServerId;
    if (previousServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = previousServerUrl;
    if (previousWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = previousWebappUrl;
    if (previousAutostart === undefined) delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
    else process.env.HAPPIER_SESSION_AUTOSTART_DAEMON = previousAutostart;
    if (previousAuthMethod === undefined) delete process.env.HAPPIER_AUTH_METHOD;
    else process.env.HAPPIER_AUTH_METHOD = previousAuthMethod;
    if (previousNoBrowser === undefined) delete process.env.HAPPIER_NO_BROWSER_OPEN;
    else process.env.HAPPIER_NO_BROWSER_OPEN = previousNoBrowser;
    if (previousPollInterval === undefined) delete process.env.HAPPIER_AUTH_POLL_INTERVAL_MS;
    else process.env.HAPPIER_AUTH_POLL_INTERVAL_MS = previousPollInterval;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each(['agent:happier.agent.custom-acp/custom-acp:definition:chosen', 'agent:com.acme.review/reviewer'])(
    'selects a custom profile default after real first login in the same invocation: %s', async (preferredAgentTargetKey) => {
      const homeDir = mkdtempSync(join(tmpdir(), 'happier-profile-first-login-'));
      process.env.HAPPIER_HOME_DIR = homeDir;
      process.env.HAPPIER_ACTIVE_SERVER_ID = 'profile-home';
      process.env.HAPPIER_SERVER_URL = 'https://profile-home.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.happier.dev';
      process.env.HAPPIER_AUTH_METHOD = 'web';
      process.env.HAPPIER_NO_BROWSER_OPEN = '1';
      process.env.HAPPIER_AUTH_POLL_INTERVAL_MS = '1';
      homeBoundary.origin = process.env.HAPPIER_SERVER_URL;
      homeBoundary.approvedToken = makeJwtWithSub('profile-account');
      homeBoundary.descriptor = { v: 1, homeServerIdentityId: 'srv_profile_home', canonicalServerUrl: homeBoundary.origin,
        revision: 1, endpoints: [{ kind: 'https', url: homeBoundary.origin }] };
      const profile = { v: 2, id: 'work', name: 'Work', preferredAgentTargetKey,
        extraEnvironmentVariables: [{ name: 'TEAM_FLAG', value: 'selected' }], createdAt: 1, updatedAt: 1 };
      const control = { status: 'present', revision: 1, content: { t: 'plain', v: {
        v: 1, phase: 'active', sourceSettingsVersion: 1, migratedLogicalRevision: 1, inventory: [] } } };
      app.get('/v1/artifacts', async (request) => artifactListResponse(request.url, []));
      app.get('/v2/account/settings', async () => ({ version: 1, content: { t: 'plain', v: {} } }));
      app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
      app.get('/v1/account/entity-rows/profiles', async () => ({ status: 'listed', complete: true, nextCursor: null,
        diagnostics: [], referenceGuardRevision: 1, transferControl: control, rows: [{ id: profile.id, revision: 1,
          content: { t: 'plain', v: { v: 1, id: profile.id, enabled: true, promptStack: [], secretBindings: {},
            definition: { kind: 'inline', profile } } } }] }));
      app.get('/v1/account/entity-rows/profiles/reference-guard', async () => ({ status: 'ready', revision: 1 }));
      app.get('/v1/account/entity-rows/profiles/transfer', async () => control);
      app.get('/v1/account/authoring-memory/lastUsedProfile', async () => ({ status: 'present', revision: 1, content: { t: 'plain', v: null } }));
      let disposePluginFixture: (() => Promise<void>) | undefined;
      if (preferredAgentTargetKey === 'agent:com.acme.review/reviewer') {
        const { createAuthoredAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
        const { createPluginManifestV2Fixture } = await import('@/plugins/testkit/manifestV2Fixture');
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: homeDir, plugins: [{
          manifest: createPluginManifestV2Fixture({ id: 'com.acme.review', contributes: { agents: [{
            id: 'reviewer', title: 'Review', runtime: { kind: 'custom' }, primary: 'sessions',
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
          }] } }), files: {
            'runtime.mjs': 'export function createRuntime() { throw new Error("Normalization must not execute the Agent"); }',
            'daemon.mjs': 'import { createRuntime } from "./runtime.mjs"; export function activate(api) { api.agents.register("reviewer", createRuntime, { sessionRunnerFactory: { module: "./runtime.mjs", export: "createRuntime", runtimeApiVersion: 1 } }); }',
          },
        }] });
        disposePluginFixture = () => fixture.dispose();
      }
      const output = captureConsoleLogAndMuteStdout();
      try {
        const { prepareProfileSessionStart } = await import('@/cli/profileSessionStart');
        const preparing = prepareProfileSessionStart({ profileQuery: profile.id, refreshRequested: true });
        await vi.waitFor(() => expect(output.logs.some((line) => line.includes('/terminal/connect#'))).toBe(true));
        const link = output.logs.find((line) => line.includes('/terminal/connect#'));
        if (!link) throw new Error('Expected terminal connect link');
        const parameters = new URLSearchParams(new URL(link).hash.slice(1));
        const envelope = parseTerminalConnectLinkV4Parameters(parameters);
        // A fresh Home has URL-bound pairing until authentication learns its descriptor.
        const publicKey = envelope?.publicKeyB64Url ?? parameters.get('key');
        const pairing = envelope?.pairing ?? { secretB64Url: parameters.get('pairingSecret'),
          createdAtMs: Number(parameters.get('createdAt')), expiresAtMs: Number(parameters.get('expiresAt')) };
        if (!publicKey || !pairing.secretB64Url) throw new Error('Expected authenticated terminal pairing context');
        homeBoundary.response = Buffer.from(sealTerminalProvisioningV3TokenOnlyPayload({
          terminalEphemeralPublicKey: new Uint8Array(Buffer.from(publicKey, 'base64url')),
          pairingSecret: new Uint8Array(Buffer.from(pairing.secretB64Url, 'base64url')),
          createdAtMs: pairing.createdAtMs, expiresAtMs: pairing.expiresAtMs,
          randomBytes: (length) => new Uint8Array(length).fill(31),
        })).toString('base64');
        const prepared = await preparing;
        const { buildBackendTargetKeyV2 } = await import('@happier-dev/protocol/backends/targets/backendTargetRefV2');
        expect(prepared.backendTarget && buildBackendTargetKeyV2(prepared.backendTarget)).toBe(preferredAgentTargetKey);
        expect(prepared.sessionStart).toMatchObject({ credentials: { token: homeBoundary.approvedToken },
          selectedProfile: { id: profile.id, extraEnvironmentVariables: [{ name: 'TEAM_FLAG', value: 'selected' }] },
          accountSettingsContext: { source: 'network', settingsVersion: 1, whenRefreshed: null,
            profileCatalog: { status: 'ready', source: 'destination' } } });
        const { normalizeSessionCreateSpawnRequest } = await import('@/cli/commands/session/create/normalizeSessionCreateSpawnRequest');
        const normalized = await normalizeSessionCreateSpawnRequest({ directory: '/workspace', backendTargetKey: null,
          machineId: 'profile-machine', profileId: profile.id });
        expect(normalized.input).toMatchObject({ profileId: profile.id, agentTarget: prepared.backendTarget });
        const explicit = await normalizeSessionCreateSpawnRequest({ directory: '/workspace', backendTargetKey: 'agent:claude',
          machineId: 'profile-machine', profileId: profile.id });
        expect(explicit.input.agentTarget).toEqual({ kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } });
        expect(homeBoundary.requests.filter(request => request.path === '/v1/auth/request')).toHaveLength(1);
        const { readStoredCredentials } = await import('@/persistence');
        expect((await readStoredCredentials())?.token).toBe(homeBoundary.approvedToken);
      } finally {
        output.restore();
        await disposePluginFixture?.();
        const { resetInMemoryAccountSettingsContextForTests } = await import('@/settings/accountSettings/bootstrapAccountSettingsContext');
        resetInMemoryAccountSettingsContextForTests();
        const { logger } = await import('./logger'); logger.flushSync();
        rmSync(homeDir, { recursive: true, force: true });
      }
    }, 120_000);

  it('hydrates canonical Provider migration facts for a retained profile during Session creation', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-profile-create-migration-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'profile-home';
    process.env.HAPPIER_SERVER_URL = 'https://profile-home.example.test';
    homeBoundary.origin = process.env.HAPPIER_SERVER_URL;
    const { AIBackendProfileSchema } = await import('@happier-dev/protocol/profiles/backendProfileSchema');
    const profile = AIBackendProfileSchema.parse({ id: 'deepseek', name: 'Retained DeepSeek', environmentVariables: [],
      defaultBackendTargetKey: 'acpBackend:chosen', createdAt: 1, updatedAt: 1 });
    const control = { status: 'present', revision: 1, content: { t: 'plain', v: {
      v: 1, phase: 'active', sourceSettingsVersion: 1, migratedLogicalRevision: 1, inventory: [] } } };
    app.get('/v2/account/settings', async () => ({ version: 1, content: { t: 'plain', v: {} } }));
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v1/account/entity-rows/profiles', async () => ({ status: 'listed', complete: true, nextCursor: null,
      diagnostics: [], referenceGuardRevision: 1, transferControl: control, rows: [{ id: profile.id, revision: 1,
        content: { t: 'plain', v: { v: 1, id: profile.id, enabled: true, promptStack: [], secretBindings: {},
          definition: { kind: 'legacy', profile } } } }] }));
    app.get('/v1/account/entity-rows/profiles/reference-guard', async () => ({ status: 'ready', revision: 1 }));
    app.get('/v1/account/entity-rows/profiles/transfer', async () => control);
    app.get('/v1/account/authoring-memory/lastUsedProfile', async () => ({ status: 'present', revision: 1, content: { t: 'plain', v: null } }));
    app.get('/v1/artifacts', async request => artifactListResponse(request.url, []));
    app.get('/v1/account/entity-rows/provider-connections', async () => {
      const { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } = await import('@happier-dev/protocol/providers/connections/connectionRowsV1');
      return { status: 'present', revision: 1, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } };
    });
    try {
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: makeJwtWithSub('profile-account') });
      const { normalizeSessionCreateSpawnRequest } = await import('@/cli/commands/session/create/normalizeSessionCreateSpawnRequest');
      const normalized = await normalizeSessionCreateSpawnRequest({ directory: '/workspace', backendTargetKey: null,
        machineId: 'profile-machine', profileId: profile.id });
      expect(normalized.input).toMatchObject({ profileId: profile.id, agentTarget: { kind: 'agent',
        identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'chosen' } });
      expect(homeBoundary.requests).toContainEqual(expect.objectContaining({ method: 'GET', path: '/v1/account/entity-rows/provider-connections' }));
    } finally {
      const { resetInMemoryAccountSettingsContextForTests } = await import('@/settings/accountSettings/bootstrapAccountSettingsContext');
      resetInMemoryAccountSettingsContextForTests();
      const { logger } = await import('./logger'); logger.flushSync(); rmSync(homeDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('keeps a descriptor carrier open through machine registration and closes it afterward', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-auth-machine-iroh-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'iroh-home';
    process.env.HAPPIER_SERVER_URL = 'http://localhost:3010';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.happier.dev';
    delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
    const descriptor = {
      v: 1 as const,
      homeServerIdentityId: 'srv_iroh_machine_home',
      canonicalServerUrl: 'http://localhost:3010',
      revision: 1,
      endpoints: [{ kind: 'iroh' as const, endpointId: 'd'.repeat(64) }],
    };
    homeBoundary.origin = 'http://127.0.0.1:48123';
    homeBoundary.descriptor = descriptor;

    try {
      writeFileSync(join(homeDir, 'settings.json'), JSON.stringify({
        schemaVersion: 6,
        activeServerId: 'iroh-home',
        servers: {
          'iroh-home': {
            id: 'iroh-home',
            name: 'Iroh Home',
            serverUrl: descriptor.canonicalServerUrl,
            webappUrl: 'https://app.happier.dev',
            homeConnectionDescriptor: descriptor,
            homeConnectionDescriptorAuthority: 'exact',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
        },
      }), 'utf8');
      const serverDir = join(homeDir, 'servers', 'iroh-home');
      mkdirSync(serverDir, { recursive: true });
      writeFileSync(join(serverDir, 'access.key'), JSON.stringify({ token: makeJwtWithSub('acct-iroh') }), 'utf8');

      const { authAndSetupMachineIfNeeded } = await import('./auth');
      await expect(authAndSetupMachineIfNeeded({ callerIntent: 'setup-managed' })).resolves.toMatchObject({
        credentials: { token: expect.any(String) },
        machineId: expect.any(String),
      });

      expect(homeBoundary.events).toEqual(['register', 'close']);
      expect(homeBoundary.activeTunnel).toBe(false);
    } finally {
      const { logger } = await import('./logger');
      logger.flushSync();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('keeps requester child startup on its admitted machine without selecting or registering a requester machine', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-auth-requester-machine-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'cloud';
    const settingsPath = join(homeDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 6, onboardingCompleted: true,
      activeServerId: 'cloud', servers: { cloud: { id: 'cloud', name: 'cloud', serverUrl: homeBoundary.origin,
        webappUrl: 'https://app.happier.dev', createdAt: 0, updatedAt: 0, lastUsedAt: 0 } },
      machineIdByServerId: { cloud: 'custodian-machine' }, lastTokenSubByServerId: { cloud: 'custodian' },
      machineIdByServerIdByAccountId: { cloud: { custodian: 'custodian-machine' } },
      machineIdConfirmedByServerByServerId: { cloud: true },
    }));
    try {
      const { createRequesterSessionCredentialCustody } = await import('@/daemon/sessionEncryption/requesterSessionCredentials');
      const custody = await createRequesterSessionCredentialCustody({ happyHomeDir: homeDir, sessionId: 'requester-session',
        attribution: { serverId: 'cloud', accountId: 'requester', machineId: 'custodian-machine', installationId: 'installation' },
        credentials: { token: makeJwtWithSub('requester'), encryption: null } });
      envScope.patch({ HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: custody.path,
        HAPPIER_SESSION_REQUESTER_SESSION_ID: 'requester-session' });
      const { authAndSetupMachineIfNeeded } = await import('./auth');
      const result = await authAndSetupMachineIfNeeded();
      expect(result.machineId).toBe('custodian-machine');
      expect(result.credentials.token).toBe(makeJwtWithSub('requester'));
      expect(homeBoundary.requests.filter(request => request.method === 'POST' && request.path === '/v1/machines')).toEqual([]);
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(settings).toMatchObject({ machineIdByServerId: { cloud: 'custodian-machine' },
        lastTokenSubByServerId: { cloud: 'custodian' }, machineIdConfirmedByServerByServerId: { cloud: true } });
      expect(settings.machineIdByServerIdByAccountId.cloud).toEqual({ custodian: 'custodian-machine' });
      await custody.cleanup();
      await expect(authAndSetupMachineIfNeeded()).rejects.toThrow('requester_session_credentials_unavailable');
      expect(homeBoundary.requests).toEqual([]);
    } finally {
      const { logger } = await import('./logger');
      logger.flushSync();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('selects machine id based on decoded token sub', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-auth-machine-id-sub-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'cloud';
    delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;

    try {
      const settingsPath = join(homeDir, 'settings.json');
      writeFileSync(
        settingsPath,
        JSON.stringify(
          {
            schemaVersion: 6,
            onboardingCompleted: true,
            activeServerId: 'cloud',
            servers: {
              cloud: {
                id: 'cloud',
                name: 'cloud',
                serverUrl: 'https://api.happier.dev',
                webappUrl: 'https://app.happier.dev',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
              },
            },
            machineIdByServerId: { cloud: 'machine-acct-a' },
            lastTokenSubByServerId: { cloud: 'acct-a' },
            machineIdByServerIdByAccountId: {
              cloud: {
                'acct-a': 'machine-acct-a',
                'acct-b': 'machine-acct-b',
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const serverDir = join(homeDir, 'servers', 'cloud');
      mkdirSync(serverDir, { recursive: true });
      writeFileSync(
        join(serverDir, 'access.key'),
        JSON.stringify({ token: makeJwtWithSub('acct-b') }, null, 2),
        'utf8',
      );

      const { authAndSetupMachineIfNeeded } = await import('./auth');
      const result = await authAndSetupMachineIfNeeded();

      expect(result.machineId).toBe('machine-acct-b');
      expect(result.credentials.token).toContain('.');
      expect(homeBoundary.requests).toContainEqual(expect.objectContaining({
        method: 'POST', path: '/v1/machines', body: expect.objectContaining({ id: 'machine-acct-b' }),
      }));

      const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(raw.machineIdByServerId.cloud).toBe('machine-acct-b');
      expect(raw.lastTokenSubByServerId.cloud).toBe('acct-b');
    } finally {
      const { logger } = await import('./logger');
      logger.flushSync();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('prepares an existing token-only credential for daemon startup without synchronous registration', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-auth-token-only-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'cloud';
    delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;

    try {
      const settingsPath = join(homeDir, 'settings.json');
      writeFileSync(
        settingsPath,
        JSON.stringify({
          schemaVersion: 6,
          onboardingCompleted: true,
          activeServerId: 'cloud',
          servers: {
            cloud: {
              id: 'cloud',
              name: 'cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
              createdAt: 0,
              updatedAt: 0,
              lastUsedAt: 0,
            },
          },
          machineIdByServerId: { cloud: 'machine-token-only' },
        }, null, 2),
        'utf8',
      );

      const serverDir = join(homeDir, 'servers', 'cloud');
      mkdirSync(serverDir, { recursive: true });
      writeFileSync(
        join(serverDir, 'access.key'),
        JSON.stringify({ token: makeJwtWithSub('acct-plain') }, null, 2),
        'utf8',
      );

      const { authAndPrepareDaemonMachineIfNeeded, authAndSetupMachineIfNeeded } = await import('./auth');
      const result = await authAndPrepareDaemonMachineIfNeeded();

      expect(result.credentials).toEqual({
        token: makeJwtWithSub('acct-plain'),
        encryption: null,
        credentialProvenance: 'stored_session',
      });
      expect(result.machineId).toBe('machine-token-only');
      expect(homeBoundary.requests).toEqual([]);
      await expect(authAndSetupMachineIfNeeded()).resolves.toMatchObject({
        machineId: 'machine-token-only',
      });
      expect(homeBoundary.requests).toContainEqual(expect.objectContaining({
        method: 'POST', path: '/v1/machines', body: expect.objectContaining({ id: 'machine-token-only' }),
      }));
    } finally {
      const { logger } = await import('./logger');
      logger.flushSync();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('does not request Account material for a plaintext Home when setup asks to recheck readiness', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-auth-plain-material-readiness-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'plain-home';
    process.env.HAPPIER_SERVER_URL = 'https://plain-home.example.test';
    homeBoundary.origin = process.env.HAPPIER_SERVER_URL;
    const token = makeJwtWithSub('acct-plain-material-readiness');

    try {
      writeFileSync(join(homeDir, 'settings.json'), JSON.stringify({
        schemaVersion: 6,
        activeServerId: 'plain-home',
        servers: {
          'plain-home': {
            id: 'plain-home',
            name: 'Plain Home',
            serverUrl: 'https://plain-home.example.test',
            webappUrl: 'https://app.happier.dev',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
        },
      }), 'utf8');
      const serverDir = join(homeDir, 'servers', 'plain-home');
      mkdirSync(serverDir, { recursive: true });
      writeFileSync(join(serverDir, 'access.key'), JSON.stringify({ token }), 'utf8');

      const { authAndSetupMachineIfNeeded } = await import('./auth');
      await expect(authAndSetupMachineIfNeeded({
        callerIntent: 'setup-managed',
        requireAccountMaterial: true,
      })).resolves.toMatchObject({ credentials: { token, encryption: null } });

      expect(homeBoundary.requests.filter((request) => request.path === '/v1/auth/request')).toEqual([]);
      expect(homeBoundary.requests.filter((request) => request.path === '/v1/machines')).toHaveLength(1);

      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new TypeError('Home mode transport unavailable');
      }));
      await expect(authAndSetupMachineIfNeeded({
        callerIntent: 'setup-managed',
        requireAccountMaterial: true,
      })).rejects.toThrow('Home mode transport unavailable');
      expect(homeBoundary.requests.filter((request) => request.path === '/v1/auth/request')).toEqual([]);
    } finally {
      const { logger } = await import('./logger');
      logger.flushSync();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('accepts supported legacy Account material when the selected Home remains E2EE', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-auth-legacy-material-readiness-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'legacy-home';
    process.env.HAPPIER_SERVER_URL = 'https://legacy-home.example.test';
    homeBoundary.origin = process.env.HAPPIER_SERVER_URL;
    homeBoundary.accountMode = 'e2ee';
    const token = makeJwtWithSub('acct-legacy-material-readiness');

    try {
      writeFileSync(join(homeDir, 'settings.json'), JSON.stringify({
        schemaVersion: 6,
        activeServerId: 'legacy-home',
        servers: {
          'legacy-home': {
            id: 'legacy-home',
            name: 'Legacy Home',
            serverUrl: 'https://legacy-home.example.test',
            webappUrl: 'https://app.happier.dev',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
        },
      }), 'utf8');
      const serverDir = join(homeDir, 'servers', 'legacy-home');
      mkdirSync(serverDir, { recursive: true });
      writeFileSync(join(serverDir, 'access.key'), JSON.stringify({
        token,
        secret: Buffer.from(new Uint8Array(32).fill(17)).toString('base64'),
      }), 'utf8');

      const { authAndSetupMachineIfNeeded } = await import('./auth');
      await expect(authAndSetupMachineIfNeeded({
        callerIntent: 'setup-managed',
        requireAccountMaterial: true,
      })).resolves.toMatchObject({
        credentials: { token, encryption: { type: 'legacy' } },
      });

      expect(homeBoundary.requests.filter((request) => request.path === '/v1/auth/request')).toEqual([]);
      expect(homeBoundary.requests.filter((request) => request.path === '/v1/machines')).toHaveLength(1);
    } finally {
      const { logger } = await import('./logger');
      logger.flushSync();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('recovers missing E2EE material for the exact Home while retaining its committed bearer', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-auth-material-recovery-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'material-home';
    process.env.HAPPIER_SERVER_URL = 'https://material-home.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.happier.dev';
    process.env.HAPPIER_AUTH_METHOD = 'web';
    process.env.HAPPIER_NO_BROWSER_OPEN = '1';
    process.env.HAPPIER_AUTH_POLL_INTERVAL_MS = '1';
    const accountId = 'acct-material-recovery';
    const retainedToken = makeJwtWithSub(accountId, 'retained');
    homeBoundary.approvedToken = makeJwtWithSub(accountId, 'approved');
    const descriptor = {
      v: 1 as const,
      homeServerIdentityId: 'srv_material_home',
      canonicalServerUrl: 'https://material-home.example.test',
      revision: 1,
      endpoints: [{ kind: 'https' as const, url: 'https://material-home.example.test' }],
    };
    homeBoundary.origin = descriptor.canonicalServerUrl;
    homeBoundary.descriptor = descriptor;

    try {
      writeFileSync(join(homeDir, 'settings.json'), JSON.stringify({
        schemaVersion: 6,
        activeServerId: 'material-home',
        servers: {
          'material-home': {
            id: 'material-home',
            name: 'Material Home',
            serverUrl: descriptor.canonicalServerUrl,
            webappUrl: 'https://app.happier.dev',
            homeConnectionDescriptor: descriptor,
            homeConnectionDescriptorAuthority: 'exact',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
        },
      }), 'utf8');
      const serverDir = join(homeDir, 'servers', 'material-home');
      mkdirSync(serverDir, { recursive: true });
      writeFileSync(join(serverDir, 'access.key'), JSON.stringify({ token: retainedToken }), 'utf8');

      const output = captureConsoleLogAndMuteStdout();
      try {
        const { doAuth } = await import('./auth');
        const recovery = doAuth({
          callerIntent: 'setup-managed',
          retainedCredentialForMaterialRecovery: { token: retainedToken, encryption: null },
        });
        await vi.waitFor(() => {
          expect(output.logs.some((line) => line.includes('/terminal/connect#'))).toBe(true);
        });
        const link = output.logs.find((line) => line.includes('/terminal/connect#'));
        if (!link) throw new Error('Expected exact-Home material-recovery link');
        const envelope = parseTerminalConnectLinkV4Parameters(new URL(link).hash.slice(1));
        if (!envelope) throw new Error('Expected descriptor-bound terminal connect V4 link');
        const freshMachineKey = new Uint8Array(32).fill(29);
        homeBoundary.response = Buffer.from(sealTerminalProvisioningV3Payload({
          terminalEphemeralPublicKey: new Uint8Array(Buffer.from(envelope.publicKeyB64Url, 'base64url')),
          contentPrivateKey: freshMachineKey,
          pairingSecret: new Uint8Array(Buffer.from(envelope.pairing.secretB64Url, 'base64url')),
          createdAtMs: envelope.pairing.createdAtMs,
          expiresAtMs: envelope.pairing.expiresAtMs,
          randomBytes: (length) => new Uint8Array(length).fill(31),
        })).toString('base64');

        await expect(recovery).resolves.toMatchObject({
          token: retainedToken,
          encryption: { type: 'dataKey', machineKey: freshMachineKey },
        });
        const { readStoredCredentials } = await import('@/persistence');
        await expect(readStoredCredentials()).resolves.toMatchObject({
          token: retainedToken,
          encryption: { type: 'dataKey', machineKey: freshMachineKey },
        });
      } finally {
        output.restore();
      }
    } finally {
      const { logger } = await import('./logger');
      logger.flushSync();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('falls back to server-scoped machine ids when the token payload cannot be decoded', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-auth-machine-id-invalid-token-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'cloud';
    delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;

    try {
      const settingsPath = join(homeDir, 'settings.json');
      writeFileSync(
        settingsPath,
        JSON.stringify(
          {
            schemaVersion: 6,
            onboardingCompleted: true,
            activeServerId: 'cloud',
            servers: {
              cloud: {
                id: 'cloud',
                name: 'cloud',
                serverUrl: 'https://api.happier.dev',
                webappUrl: 'https://app.happier.dev',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
              },
            },
            machineIdByServerId: { cloud: 'machine-server-scoped' },
            machineIdConfirmedByServerByServerId: { cloud: true },
            lastTokenSubByServerId: { cloud: 'acct-a' },
          },
          null,
          2,
        ),
        'utf8',
      );

      const serverDir = join(homeDir, 'servers', 'cloud');
      mkdirSync(serverDir, { recursive: true });
      writeFileSync(
        join(serverDir, 'access.key'),
        JSON.stringify({ token: 'not-a-jwt', secret: Buffer.from('x').toString('base64') }, null, 2),
        'utf8',
      );

      const { ensureMachineIdForCredentials } = await import('./auth');
      const result = await ensureMachineIdForCredentials({ token: 'not-a-jwt', encryption: null });

      expect(result.machineId).toBe('machine-server-scoped');

      const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(raw.machineIdConfirmedByServerByServerId?.cloud).toBeUndefined();
      expect(raw.lastTokenSubByServerId?.cloud).toBeUndefined();
    } finally {
      const { logger } = await import('./logger');
      logger.flushSync();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('rotates the machine id when credentials are freshly issued but the token is opaque', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-auth-machine-id-new-opaque-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'cloud';
    delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;

    try {
      const settingsPath = join(homeDir, 'settings.json');
      writeFileSync(
        settingsPath,
        JSON.stringify(
          {
            schemaVersion: 6,
            onboardingCompleted: true,
            activeServerId: 'cloud',
            servers: {
              cloud: {
                id: 'cloud',
                name: 'cloud',
                serverUrl: 'https://api.happier.dev',
                webappUrl: 'https://app.happier.dev',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
              },
            },
            machineIdByServerId: { cloud: 'machine-before-login' },
            machineIdConfirmedByServerByServerId: { cloud: true },
            lastTokenSubByServerId: { cloud: 'acct-a' },
          },
          null,
          2,
        ),
        'utf8',
      );

      const { ensureMachineIdForCredentials } = await import('./auth');
      const result = await ensureMachineIdForCredentials({
        token: 'opaque-token',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      }, { forceNew: true });

      expect(result.machineId).not.toBe('machine-before-login');

      const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(raw.machineIdByServerId.cloud).toBe(result.machineId);
      expect(raw.machineIdConfirmedByServerByServerId?.cloud).toBeUndefined();
      expect(raw.lastTokenSubByServerId?.cloud).toBeUndefined();
    } finally {
      const { logger } = await import('./logger');
      logger.flushSync();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('clears machine confirmation when the account changes without changing the machine id', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-auth-machine-id-confirmation-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'cloud';

    try {
      const settingsPath = join(homeDir, 'settings.json');
      writeFileSync(
        settingsPath,
        JSON.stringify(
          {
            schemaVersion: 6,
            onboardingCompleted: true,
            activeServerId: 'cloud',
            servers: {
              cloud: {
                id: 'cloud',
                name: 'cloud',
                serverUrl: 'https://api.happier.dev',
                webappUrl: 'https://app.happier.dev',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
              },
            },
            machineIdByServerId: { cloud: 'machine-shared' },
            machineIdByServerIdByAccountId: {
              cloud: {
                'acct-a': 'machine-shared',
                'acct-b': 'machine-shared',
              },
            },
            machineIdConfirmedByServerByServerId: { cloud: true },
            lastTokenSubByServerId: { cloud: 'acct-a' },
          },
          null,
          2,
        ),
        'utf8',
      );

      const serverDir = join(homeDir, 'servers', 'cloud');
      mkdirSync(serverDir, { recursive: true });
      writeFileSync(
        join(serverDir, 'access.key'),
        JSON.stringify({ token: makeJwtWithSub('acct-b'), secret: Buffer.from('x').toString('base64') }, null, 2),
        'utf8',
      );

      const output = captureConsoleLogAndMuteStdout();
      let result: { machineId: string };
      try {
        const { ensureMachineIdForCredentials } = await import('./auth');
        result = await ensureMachineIdForCredentials({ token: makeJwtWithSub('acct-b'), encryption: null });
      } finally {
        output.restore();
      }

      expect(result.machineId).toBe('machine-shared');

      const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(raw.machineIdConfirmedByServerByServerId.cloud).toBeUndefined();
      expect(raw.lastTokenSubByServerId.cloud).toBe('acct-b');

      const identityChangeLogs = output.logs.filter((line) => line.includes('[AUTH] tokenSub changed'));
      expect(identityChangeLogs).toContainEqual(expect.stringContaining('server=cloud machineId=machine-shared'));
      expect(identityChangeLogs.join('\n')).not.toContain('acct-a');
      expect(identityChangeLogs.join('\n')).not.toContain('acct-b');
    } finally {
      const { logger } = await import('./logger');
      logger.flushSync();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('rehydrates relay scope env from the active relay profile before any post-auth daemon autostart', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-auth-relay-scope-env-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = 'http://127.0.0.1:24541';
    homeBoundary.origin = process.env.HAPPIER_SERVER_URL;
    process.env.HAPPIER_WEBAPP_URL = 'http://happier-stack.localhost:24541';
    delete process.env.HAPPIER_ACTIVE_SERVER_ID;
    delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;

    try {
      const settingsPath = join(homeDir, 'settings.json');
      writeFileSync(
        settingsPath,
        JSON.stringify(
          {
            schemaVersion: 6,
            onboardingCompleted: true,
            activeServerId: 'stack_main__id_default',
            servers: {
              stack_main__id_default: {
                id: 'stack_main__id_default',
                name: 'stack',
                serverUrl: 'http://127.0.0.1:24541',
                publicServerUrl: 'http://localhost:24541',
                webappUrl: 'http://happier-stack.localhost:24541',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
              },
            },
            machineIdByServerId: { stack_main__id_default: 'machine-stack' },
            lastTokenSubByServerId: { stack_main__id_default: 'acct-a' },
          },
          null,
          2,
        ),
        'utf8',
      );

      const serverDir = join(homeDir, 'servers', 'stack_main__id_default');
      mkdirSync(serverDir, { recursive: true });
      const accessKeyPayload = JSON.stringify(
        { token: makeJwtWithSub('acct-a') },
        null,
        2,
      );
      writeFileSync(join(serverDir, 'access.key'), accessKeyPayload, 'utf8');
      writeFileSync(join(homeDir, 'access.key'), accessKeyPayload, 'utf8');

      const { authAndSetupMachineIfNeeded } = await import('./auth');
      const result = await authAndSetupMachineIfNeeded();

      expect(result.machineId).toBe('machine-stack');
      expect(process.env.HAPPIER_ACTIVE_SERVER_ID).toBe('stack_main__id_default');
      expect(process.env.HAPPIER_WEBAPP_URL).toBe('http://happier-stack.localhost:24541');
    } finally {
      const { logger } = await import('./logger');
      logger.flushSync();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
