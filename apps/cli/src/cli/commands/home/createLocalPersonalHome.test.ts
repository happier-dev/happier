import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { SystemTaskJsonObject, SystemTaskResult, SystemTaskSpec } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

const boundaries = vi.hoisted(() => ({
  prepareArtifact: vi.fn(),
  fetchFeatures: vi.fn(),
  getRunner: vi.fn(),
}));

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/firstPartyRuntime')>();
  return {
    ...actual,
    prepareFirstPartyComponentPayloadFromGitHubRelease: boundaries.prepareArtifact,
  };
});

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: boundaries.fetchFeatures,
}));

vi.mock('@/capabilities/systemTasks/liveSystemTasksRunner', () => ({
  getLiveSystemTasksRunnerAdapter: boundaries.getRunner,
}));

type RuntimeState = {
  installed: boolean;
  healthy: boolean;
  dataPresent: boolean;
  anonymousSignupEnabled: boolean | null;
};

const canonicalServerUrl = 'http://127.0.0.1:43123';
const serverIdentityId = 'srv_personal_home_boundary';
const descriptor = {
  v: 1 as const,
  homeServerIdentityId: serverIdentityId,
  canonicalServerUrl,
  revision: 1,
  endpoints: [{
    kind: 'iroh' as const,
    endpointId: 'c'.repeat(64),
    relayUrls: ['https://relay.example.test/'],
  }],
};

function success(taskId: string, data: unknown): SystemTaskResult {
  return {
    protocolVersion: 1,
    taskId,
    ok: true,
    data: data as never,
  };
}

function statusResult(taskId: string, state: RuntimeState): SystemTaskResult {
  return success(taskId, {
    channel: 'dev',
    mode: 'user',
    installed: state.installed,
    dataPresent: state.dataPresent,
    version: state.installed ? '0.3.0-dev' : null,
    relayUrl: canonicalServerUrl,
    healthy: state.healthy,
    purpose: state.installed ? { kind: 'personal-home', canonicalServerUrl } : null,
    anonymousSignupEnabled: state.anonymousSignupEnabled,
    service: { active: state.healthy, enabled: state.installed },
  });
}

function installRunner(params: Readonly<{
  homeDir: string;
  state: RuntimeState;
  mutations: string[];
  rejectPersonalHomeArtifact?: boolean;
}>) {
  let taskSequence = 0;
  const results = new Map<string, SystemTaskResult>();
  const start = vi.fn(async ({ spec }: Readonly<{ spec: SystemTaskSpec }>) => {
    const taskId = `task-${++taskSequence}`;
    if (spec.kind === 'relay.runtime.status.v1') {
      results.set(taskId, statusResult(taskId, params.state));
    } else if (spec.kind === 'relay.runtime.installOrUpdate.v1') {
      if (params.rejectPersonalHomeArtifact) {
        results.set(taskId, {
          protocolVersion: 1,
          taskId,
          ok: false,
          error: {
            code: 'personal_home_artifact_update_required',
            message: 'The selected Happier server artifact does not support local Personal Home creation. Update Happier and try again.',
          },
        });
        return { taskId };
      }
      const taskParams = spec.params;
      if (!taskParams || typeof taskParams !== 'object' || Array.isArray(taskParams)) {
        throw new Error('Personal Home install task must carry object parameters.');
      }
      const taskParamsObject = taskParams as SystemTaskJsonObject;
      if (typeof taskParamsObject.anonymousSignupEnabled !== 'boolean') {
        throw new Error('Personal Home install task must carry its signup policy.');
      }
      const anonymousSignupEnabled = taskParamsObject.anonymousSignupEnabled;
      if (!params.state.installed) {
        const custodyDir = join(params.homeDir, 'personal-home-bootstrap');
        const custodyFiles = await readdir(custodyDir);
        expect(custodyFiles).toHaveLength(1);
        expect(custodyFiles[0]).toMatch(/\.seed$/u);
        if (process.platform !== 'win32') {
          expect((await stat(join(custodyDir, String(custodyFiles[0])))).mode & 0o777).toBe(0o600);
        }
      }
      params.mutations.push(`install:${String(anonymousSignupEnabled)}`);
      params.state.installed = true;
      params.state.healthy = true;
      params.state.dataPresent = anonymousSignupEnabled === false;
      params.state.anonymousSignupEnabled = anonymousSignupEnabled;
      results.set(taskId, success(taskId, null));
    } else {
      throw new Error(`Unexpected Personal Home task: ${spec.kind}`);
    }
    return { taskId };
  });
  boundaries.getRunner.mockReturnValue({
    start,
    poll: async ({ taskId }: Readonly<{ taskId: string; cursor: number }>) => ({
      events: [],
      nextCursor: 0,
      result: results.get(taskId) ?? null,
      pendingPrompt: null,
    }),
    respond: async () => undefined,
  });
  return start;
}

function readyFeatures(state: RuntimeState) {
  return {
    status: 'ready' as const,
    features: {
      features: {},
      capabilities: {
        serverIdentity: { serverIdentityId },
        auth: { signup: { methods: [{ id: 'anonymous', enabled: state.anonymousSignupEnabled !== false }] } },
        encryption: { storagePolicy: 'plaintext_only' as const },
      },
      homeConnectionDescriptor: descriptor,
    },
  };
}

// Settle the release boundary's partial mock and the startup graph during
// collection, before starting the first case's bootstrap clock.
const { writePersonalHomeServerArtifactCapability: writeInitialArtifactCapability } =
  await import('@happier-dev/cli-common/firstPartyRuntime');
const { createLocalPersonalHome: createInitialPersonalHome } = await import('./createLocalPersonalHome');

describe('createLocalPersonalHome production adapter', () => {
  const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL'] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.unstubAllGlobals();
    vi.resetModules();
    boundaries.prepareArtifact.mockReset();
    boundaries.fetchFeatures.mockReset();
    boundaries.getRunner.mockReset();
  });

  it('admits the artifact, protects seed custody before runtime mutation, and moves credentials to the identity profile before cleanup', async () => {
    await withTempDir('happier-local-home-adapter-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });
      const payloadRoot = join(homeDir, 'artifact');
      await mkdir(payloadRoot, { recursive: true });
      const cleanup = vi.fn(async () => undefined);
      boundaries.prepareArtifact.mockResolvedValue({
        componentId: 'happier-server',
        channel: 'publicdev',
        versionId: 'server-v0.3.0-dev',
        payloadRoot,
        source: 'https://release.example.test/server.tar.gz',
        cleanup,
      });
      const [
        { adoptServerProfileHomeConnectionDescriptor },
        { readStoredCredentialCustodyForServerId, readStoredCredentialsForServerId },
      ] = await Promise.all([
        import('@/server/serverProfiles'),
        import('@/persistence'),
      ]);
      (await import('@/configuration')).reloadConfiguration();
      await writeInitialArtifactCapability(payloadRoot);

      const preexisting = await adoptServerProfileHomeConnectionDescriptor({
        descriptor,
        suggestedName: 'My Personal Home',
        observation: 'exact',
        use: false,
      });
      expect(preexisting.profile.id).not.toBe(serverIdentityId);

      const state: RuntimeState = { installed: false, healthy: false, dataPresent: false, anonymousSignupEnabled: null };
      const mutations: string[] = [];
      const start = installRunner({ homeDir, state, mutations });
      boundaries.fetchFeatures.mockImplementation(async () => readyFeatures(state));
      const payload = Buffer.from(JSON.stringify({ sub: 'personal-home-account', provenance: {
        v: 1, kind: 'account', authority: 'present_user',
      } })).toString('base64url');
      const legacyAccountToken = `hdr.${payload}.sig`;
      let authRequests = 0;
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/v1/auth/ping')) return new Response(null, { status: 200 });
        if (url.endsWith('/v1/auth')) {
          authRequests += 1;
          return authRequests === 1
            ? new Response(JSON.stringify({ token: legacyAccountToken }), { status: 200 })
            : new Response(JSON.stringify({ error: 'signup-disabled' }), { status: 403 });
        }
        throw new Error(`Unexpected network request: ${url}`);
      }));

      const result = await createInitialPersonalHome({ channel: 'dev', mode: 'user' });

      expect(result).toEqual({
        profileId: preexisting.profile.id,
        homeServerIdentityId: serverIdentityId,
        canonicalServerUrl,
        accountCreated: true,
        descriptor,
      });
      expect(mutations).toEqual(['install:true', 'install:false']);
      expect(start).toHaveBeenCalled();
      await expect(readStoredCredentialCustodyForServerId(preexisting.profile.id))
        .resolves.toMatchObject({ token: legacyAccountToken, encryption: null });
      await expect(readStoredCredentialCustodyForServerId(serverIdentityId)).resolves.toBeNull();
      await expect(readStoredCredentialsForServerId(preexisting.profile.id))
        .rejects.toMatchObject({ code: 'cli_relogin_required' });
      await expect(readdir(join(homeDir, 'personal-home-bootstrap'))).resolves.toEqual([]);

      const repeated = await createInitialPersonalHome({ channel: 'dev', mode: 'user' });
      expect(repeated).toEqual({
        profileId: preexisting.profile.id,
        homeServerIdentityId: serverIdentityId,
        canonicalServerUrl,
        accountCreated: false,
        descriptor,
      });
      expect(authRequests).toBe(3);
      await expect(readStoredCredentialCustodyForServerId(preexisting.profile.id))
        .resolves.toMatchObject({ token: legacyAccountToken, encryption: null });
      await expect(readStoredCredentialCustodyForServerId(serverIdentityId)).resolves.toBeNull();
      expect(cleanup).toHaveBeenCalledTimes(2);
    });
  }, 90_000);

  it('surfaces shared runtime artifact admission before runtime, network, credential, or profile mutation', async () => {
    await withTempDir('happier-local-home-admission-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
      const payloadRoot = join(homeDir, 'incompatible-artifact');
      await mkdir(payloadRoot, { recursive: true });
      const cleanup = vi.fn(async () => undefined);
      boundaries.prepareArtifact.mockResolvedValue({
        componentId: 'happier-server', channel: 'stable', versionId: 'server-v0.2.11', payloadRoot, source: null, cleanup,
      });
      const start = installRunner({
        homeDir,
        state: { installed: false, healthy: false, dataPresent: false, anonymousSignupEnabled: null },
        mutations: [],
        rejectPersonalHomeArtifact: true,
      });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const { listServerProfiles } = await import('@/server/serverProfiles');
      const { readStoredCredentialsForServerId } = await import('@/persistence');
      const { createLocalPersonalHome } = await import('./createLocalPersonalHome');
      const previousProfiles = await listServerProfiles();
      await expect(createLocalPersonalHome({ channel: 'stable', mode: 'user' })).rejects.toMatchObject({
        code: 'personal_home_artifact_update_required',
      });

      expect(start).not.toHaveBeenCalled();
      expect(boundaries.fetchFeatures).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await listServerProfiles()).toEqual(previousProfiles);
      await expect(readStoredCredentialsForServerId(serverIdentityId)).resolves.toBeNull();
      await expect(readdir(join(homeDir, 'personal-home-bootstrap'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(cleanup).toHaveBeenCalledOnce();
    });
  }, 90_000);

  it('passes cancellation into the local system-task bootstrap before starting runtime mutation', async () => {
    await withTempDir('happier-local-home-cancel-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
      const payloadRoot = join(homeDir, 'artifact');
      await mkdir(payloadRoot, { recursive: true });
      const cleanup = vi.fn(async () => undefined);
      boundaries.prepareArtifact.mockResolvedValue({
        componentId: 'happier-server', channel: 'publicdev', versionId: 'server-v0.3.0-dev', payloadRoot, source: null, cleanup,
      });
      const [{ writePersonalHomeServerArtifactCapability }, { createLocalPersonalHome }] = await Promise.all([
        import('@happier-dev/cli-common/firstPartyRuntime'),
        import('./createLocalPersonalHome'),
      ]);
      await writePersonalHomeServerArtifactCapability(payloadRoot);
      const start = installRunner({
        homeDir,
        state: { installed: false, healthy: false, dataPresent: false, anonymousSignupEnabled: null },
        mutations: [],
      });
      const controller = new AbortController();
      controller.abort();

      await expect(createLocalPersonalHome(
        { channel: 'dev', mode: 'user' },
        { allowErasedRuntimeRecreate: true, signal: controller.signal },
      )).rejects.toMatchObject({ code: 'cancelled' });

      expect(start).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledOnce();
    });
  }, 90_000);

  it('keeps credential and profile authority unchanged when account creation fails after runtime admission', async () => {
    await withTempDir('happier-local-home-account-failure-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
      const payloadRoot = join(homeDir, 'artifact');
      await mkdir(payloadRoot, { recursive: true });
      const cleanup = vi.fn(async () => undefined);
      boundaries.prepareArtifact.mockResolvedValue({
        componentId: 'happier-server', channel: 'publicdev', versionId: 'server-v0.3.0-dev', payloadRoot, source: null, cleanup,
      });
      const [
        { writePersonalHomeServerArtifactCapability },
        { createLocalPersonalHome },
        { listServerProfiles },
        { readStoredCredentialsForServerId },
      ] = await Promise.all([
        import('@happier-dev/cli-common/firstPartyRuntime'),
        import('./createLocalPersonalHome'),
        import('@/server/serverProfiles'),
        import('@/persistence'),
      ]);
      await writePersonalHomeServerArtifactCapability(payloadRoot);

      const state: RuntimeState = { installed: false, healthy: false, dataPresent: false, anonymousSignupEnabled: null };
      const mutations: string[] = [];
      const start = installRunner({ homeDir, state, mutations });
      boundaries.fetchFeatures.mockImplementation(async () => readyFeatures(state));
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/v1/auth')) {
          return new Response(JSON.stringify({ error: 'account-creation-failed' }), { status: 500 });
        }
        throw new Error(`Unexpected network request: ${url}`);
      }));

      const previousProfiles = await listServerProfiles();
      await expect(createLocalPersonalHome({ channel: 'dev', mode: 'user' })).rejects.toThrow('account-creation-failed');

      expect(start).toHaveBeenCalled();
      expect(mutations).toEqual(['install:true']);
      expect(await listServerProfiles()).toEqual(previousProfiles);
      await expect(readStoredCredentialsForServerId(serverIdentityId)).resolves.toBeNull();
      // Pending seed custody intentionally remains retryable; it is not profile or credential authority.
      expect((await readdir(join(homeDir, 'personal-home-bootstrap'))).length).toBeGreaterThan(0);
      expect(cleanup).toHaveBeenCalledOnce();
    });
  });
});
