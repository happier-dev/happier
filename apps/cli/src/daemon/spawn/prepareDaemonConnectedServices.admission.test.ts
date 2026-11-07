import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { ApiClient } from '@/api/api';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { ForegroundAgentRuntimeAdmissionRequestV1Schema } from '@/daemon/agentRuntime/foregroundAdmissionContract';

import { prepareDaemonConnectedServices } from './prepareDaemonConnectedServices';
import { createAgentIsolationMemberPreparationBoundary } from '../agentIsolation/agentIsolationEffects.testkit';
import { createUnixAgentIdentityLaunch } from '../agentIsolation/unixAgentIdentityAdapter';
import { readAgentLaunchFrame } from '../agentIsolation/agentLaunchFrame';
import { requireAgentIsolationMaterialNativeIdentity } from '../agentIsolation/agentLaunchMaterials';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolveRunnerAgentSessionDescriptorForLease } from './prepareAgentRuntimeSessionBridge';
import { createRunnerAgentSessionBootstrapAuthorization } from '../agentRuntime/sessionBridgeAuthorization';
import { readRunnerAgentSessionBootstrap } from '@/agent/runtime/session/process/runnerAgentSessionBootstrap';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { createProjectSessionRuntimeFixture } from '@/daemon/testkit/projectSessionRuntimeFixture';
import { createSessionAgentIsolationMemberPreparation, type SessionAgentIsolationAccountSource } from '../agentIsolation/sessionPreparation';
import { readAgentIsolationSnapshot } from '../agentIsolation/agentIsolationPolicy';
import { readHostAccountExecutionIdentity } from '../agentIsolation/agentIsolationAccountCustody';
import { readOrdinaryRequesterSessionAccountCustodyForHost } from '../sessionEncryption/ordinaryRequesterSessionAccountCustody';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Native process creation is an OS boundary. Keep the actual implementation
// beneath the spy instead of attempting to redefine an ESM namespace export.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const nativeHomes = vi.hoisted(() => new Map<string, Readonly<{
  backingDirectory: string; uid: number; gid: number;
}>>());
// Only native home metadata is simulated. Member admission, Action/setup
// CHECK/APPLY and the daemon-private reverse binding remain real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    lstat: async (path: Parameters<typeof actual.lstat>[0]) => {
      const home = nativeHomes.get(String(path));
      return home ? Object.assign(await actual.lstat(home.backingDirectory), {
        uid: home.uid, gid: home.gid, mode: 0o40700,
      }) : actual.lstat(path);
    },
    realpath: async (path: Parameters<typeof actual.realpath>[0]) => nativeHomes.has(String(path))
      ? String(path) : actual.realpath(path),
  };
});
vi.mock('@happier-dev/cli-common/process', async importOriginal => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/process')>();
  return { ...actual, execFileWithDeadline: async (...args: Parameters<typeof actual.execFileWithDeadline>) => {
    if (args[0] === 'getent' && args[1]?.at(-1) === 'happier-agent') {
      return { stdout: 'happier-agent:x:2403:2403::/var/lib/happier-agent:/usr/sbin/nologin\n', stderr: '' };
    }
    return actual.execFileWithDeadline(...args);
  } };
});

const malformedBindings = {
  v: 1,
  bindingsByServiceId: {
    'happier.agent.codex/openai-codex': {
      source: 'connected', selection: 'group', groupId: '../invalid', profileId: 'work',
    },
  },
};

describe('connected-account spawn admission', () => {
  it('returns the closed launch refusal before material or payload when installed member setup is unavailable', async () => {
    const installed = await createInstalledFilesystemMachineFixture();
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
    try {
      const nativeSpawn = vi.mocked(spawn);
      nativeSpawn.mockClear();
      const materialized = join(installed.directory, 'refused-materialized');
      const birth = installed.bootstrap.attribution;
      const api = new Proxy({} as ApiClient, { get() { throw new Error('Refused launch must not read credentials'); } });
      const result = await prepareDaemonConnectedServices({
        options: { directory: installed.directory, requesterWorkAttributionV1: birth },
        normalizedExistingSessionId: '', requestedSessionId: 'refused-session', effectiveResume: '',
        catalogAgentId: 'codex', credentials: installed.bootstrap.credentials, api,
        activeServerDir: join(installed.directory, 'server'),
        connectedServicesMaterializationBaseDir: materialized, connectedServiceRefreshCoordinator: null,
        processEnv: {}, pluginRuntimeRegistry: runtime.registry,
        prepareAgentIsolationMember: async input => ({ kind: 'member', snapshot: undefined, requesterIdentity: { kind: 'isolated', requester: birth, separationRequired: true, homeServerIdentityId: installed.homeServerIdentityId }, ...await installed.machine.prepareAgentIsolationMember({
          requesterIdentity: { kind: 'isolated', requester: birth, separationRequired: true,
            homeServerIdentityId: installed.homeServerIdentityId }, signal: input.signal,
        }) }),
      });
      expect(result).toMatchObject({ ok: false, result: { type: 'error',
        errorCode: 'SPAWN_VALIDATION_FAILED', errorDetail: { kind: 'launch_error', code: 'agent_isolation_unavailable' } } });
      expect(nativeSpawn).not.toHaveBeenCalled();
      await expect(stat(materialized)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await runtime.dispose(); }
  });

  it.skipIf(process.platform !== 'linux')('keeps admitted member homes and native identities through fresh and recovered private runner launch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'member-session-material-'));
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
    const cleanups: Array<() => void | Promise<void>> = [];
    try {
      await mkdir(join(root, 'server'), { mode: 0o700 });
      const descriptor = await resolveRunnerAgentSessionDescriptorForLease({
        target: { kind: 'backend', backendId: 'codex' }, lease: runtime.lease,
      });
      if (!descriptor) throw new Error('Admitted Agent descriptor unavailable');
      const api = new Proxy({} as ApiClient, { get() { throw new Error('Native home must not read Account credentials'); } });
      const homes = new Map<string, string>();
      for (const accountId of ['member-a', 'member-b']) {
        const birth = { serverId: 'saved-home-profile', accountId, machineId: 'machine', installationId: 'installation' };
        const member = createAgentIsolationMemberPreparationBoundary({ activeServerDir: join(root, 'server'),
          requesterIdentity: { kind: 'isolated', requester: birth, separationRequired: true,
            homeServerIdentityId: 'canonical-home' },
          uid: accountId === 'member-a' ? 2401 : 2402, custodianAccountId: 'owner', encryptionMode: 'plain' });
        nativeHomes.set(member.filesystemHome.path, member.filesystemHome);
        for (const recovered of [false, true]) {
          if (recovered) { member.resetObservations(); member.mutations.length = 0; member.launches.length = 0; }
          const sessionId = `session-${accountId}`;
          const prepared = await prepareDaemonConnectedServices({
            options: { directory: root, requesterWorkAttributionV1: birth },
            normalizedExistingSessionId: recovered ? sessionId : '', requestedSessionId: sessionId,
            effectiveResume: '', catalogAgentId: 'codex',
            credentials: { token: 'synthetic-native-session', encryption: null }, api,
            activeServerDir: join(root, 'server'), connectedServicesMaterializationBaseDir: join(root, 'materialized'),
            connectedServiceRefreshCoordinator: null, processEnv: {}, pluginRuntimeRegistry: runtime.registry,
            prepareAgentIsolationMember: async input => {
              expect(input.requesterWorkAttributionV1).toEqual(birth);
              const preparation = await member.prepare({ signal: input.signal });
              if (preparation.kind !== 'ready') throw new Error('Real member preparation refused');
              return { kind: 'member', snapshot: undefined, requesterIdentity: { kind: 'isolated', requester: birth, separationRequired: true, homeServerIdentityId: 'canonical-home' }, identity: preparation.identity };
            },
          });
          expect(prepared.ok).toBe(true);
          if (!prepared.ok) throw new Error('Member preparation refused');
          if (prepared.auth?.cleanupOnExit) cleanups.push(prepared.auth.cleanupOnExit);
          const material = prepared.agentLaunchMaterials;
          const native = material?.memberIdentity;
          expect(native).toMatchObject({ requester: birth, homeServerIdentityId: 'canonical-home',
            agentUid: member.filesystemHome.uid, agentGid: member.filesystemHome.gid });
          if (!native) throw new Error('Member native observation unavailable');
          if (!material) throw new Error('Member material unavailable');
          expect(material.environment.CODEX_HOME?.startsWith(`${native.home}/`)).toBe(true);
          if (recovered) expect(material.runtimeHome).toBe(homes.get(accountId));
          else homes.set(accountId, material.runtimeHome);
          const authorization = await createRunnerAgentSessionBootstrapAuthorization({ happyHomeDir: root,
            publicReleaseRing: 'stable', descriptor,
            launch: { runtimeDescriptorV1: { v: 1, agentId: descriptor.agentId, agent: {} },
              agentIsolationMemberIdentity: material.memberIdentity, agentIsolationRuntimeHome: material.runtimeHome },
          });
          cleanups.push(authorization.cleanupBootstrapFile);
          const bootstrap = await readRunnerAgentSessionBootstrap(authorization.authorization.bootstrapFilePath);
          const retainedIdentity = bootstrap.launch?.agentIsolationMemberIdentity;
          if (!retainedIdentity) throw new Error('Protected runner native identity unavailable');
          expect(bootstrap.launch?.agentIsolationRuntimeHome).toBe(material.runtimeHome);
          const qualifiedRequester = { kind: 'isolated' as const, requester: birth,
            separationRequired: true, homeServerIdentityId: 'canonical-home' };
          expect(requireAgentIsolationMaterialNativeIdentity(retainedIdentity, qualifiedRequester)).toEqual(native);
          // A schema-valid recovered carrier cannot grant another member or
          // Home access to this Session's socket/material lifetime.
          expect(() => requireAgentIsolationMaterialNativeIdentity(retainedIdentity, {
            ...qualifiedRequester, requester: { ...birth,
              accountId: accountId === 'member-a' ? 'member-b' : 'member-a' },
          })).toThrowError(expect.objectContaining({ code: 'agent_isolation_unavailable' }));
          expect(() => requireAgentIsolationMaterialNativeIdentity(retainedIdentity, {
            ...qualifiedRequester, homeServerIdentityId: 'different-canonical-home',
          })).toThrowError(expect.objectContaining({ code: 'agent_isolation_unavailable' }));
          const launch = createUnixAgentIdentityLaunch({ ...material,
            memberIdentity: retainedIdentity,
            managedHappierBinaryPath: '/opt/happier/cli/current/happier', executable: '/opt/agent', args: [], cwd: root,
            selectedEnvironmentKeys: Object.keys(material.environment),
          });
          const payload = await readAgentLaunchFrame(Readable.from([launch.stdinPreamble], { objectMode: false }));
          expect(launch.args.slice(0, 4)).toEqual(['-n', '-u', native.username, '--']);
          expect(payload.nativeIdentity).toEqual({ username: native.username, agentUid: native.agentUid,
            agentGid: native.agentGid, home: native.home });
          expect(payload.environment.CODEX_HOME).toBe(material.environment.CODEX_HOME);
          if (recovered) {
            // Retained native identity and effective RunAs qualify locally;
            // unchanged setup needs no elevated effect or mutation.
            expect(member.launches).toHaveLength(0);
            expect(member.permissionQueries).toHaveLength(1);
            expect(member.mutations).toEqual([]);
          } else {
            expect(member.launches).toHaveLength(1);
            expect(member.mutations).toContain('agent-account');
          }
          expect(member.boundaryFailures).toEqual([]);
        }
      }
      expect(homes.get('member-a')).not.toBe(homes.get('member-b'));
      const owner = await prepareDaemonConnectedServices({
        options: { directory: root }, normalizedExistingSessionId: '', requestedSessionId: 'owner-session',
        effectiveResume: '', catalogAgentId: 'codex', credentials: { token: 'synthetic-owner', encryption: null }, api,
        connectedServicesMaterializationBaseDir: join(root, 'materialized'), connectedServiceRefreshCoordinator: null,
        processEnv: {}, pluginRuntimeRegistry: runtime.registry,
        prepareAgentIsolationMember: createSessionAgentIsolationMemberPreparation({ machineId: 'machine',
          custodianAccountId: 'owner' })(null, new AbortController().signal),
      });
      expect(owner).toMatchObject({ ok: true, auth: null });
      expect('agentLaunchMaterials' in owner).toBe(false);
      const legacyOwner = await prepareDaemonConnectedServices({
        options: { directory: root }, normalizedExistingSessionId: '', requestedSessionId: 'owner-isolated-session',
        effectiveResume: '', catalogAgentId: 'codex', credentials: { token: 'synthetic-owner', encryption: null }, api,
        activeServerDir: join(root, 'server'), connectedServicesMaterializationBaseDir: join(root, 'materialized'),
        connectedServiceRefreshCoordinator: null, processEnv: {}, pluginRuntimeRegistry: runtime.registry,
        // Canonical owner admission intentionally selects the supported legacy
        // shared account, without inventing member provisioning consent.

        prepareAgentIsolationMember: createSessionAgentIsolationMemberPreparation({ machineId: 'machine',
          custodianAccountId: 'owner', agentIsolation: { read: () => ({ enabled: true, status: { kind: 'effective', platform: 'linux' }, workspaceRoots: [] }) },
        })(null, new AbortController().signal, { kind: 'freshAccount', origin: { machineId: 'machine', serverIdentityId: 'canonical-home' },
          hostAccountAgent: { accountId: 'owner', custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation' } }),
      });
      expect(legacyOwner.ok).toBe(true);
      if (!legacyOwner.ok) throw new Error('Existing owner shared identity refused');
      if (legacyOwner.auth?.cleanupOnExit) cleanups.push(legacyOwner.auth.cleanupOnExit);
      expect(legacyOwner.agentLaunchMaterials?.runtimeHome.startsWith('/var/lib/happier-agent/')).toBe(true);
      expect(legacyOwner.agentLaunchMaterials?.environment.CODEX_HOME?.startsWith('/var/lib/happier-agent/')).toBe(true);
      expect(legacyOwner.agentLaunchMaterials?.memberIdentity).toBeUndefined();
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
      nativeHomes.clear();
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform !== 'linux').each(['birth', 'freshAccount', 'ordinarySession'] as const)(
    'uses the real Session preparation producer for the owner Agent under explicit reviewed member provisioning (%s)', async sourceKind => {
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester' })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const };
    const admitted = await createProjectSessionRuntimeFixture({ serverId: 'owner-profile',
      homeServerIdentityId: 'srv_canonical_owner_home', credentials: { ...credentials } });
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
    const birth = admitted.bootstrap.attribution;
    const origin = { machineId: birth.machineId, serverIdentityId: admitted.bootstrap.homeServerIdentityId! };
    let accountSource: SessionAgentIsolationAccountSource | undefined;
    let expectedRequester = birth;
    if (sourceKind !== 'birth') {
      // These are the real incumbent custody producers. Only their Home/OS
      // boundaries are supplied by createProjectSessionRuntimeFixture.
      const identity = await readHostAccountExecutionIdentity({ credentials, catalogCredentials: credentials,
        kind: 'agent', machineId: birth.machineId, hostHomeServerIdentityId: origin.serverIdentityId,
        serverHttpBaseUrl: admitted.bootstrap.serverHttpBaseUrl, isCurrent: admitted.isHomeCurrent });
      expect(identity).toMatchObject({ kind: 'isolated', separationRequired: false });
      if (identity.kind !== 'isolated') throw new Error('Authenticated owner custody unavailable');
      if (sourceKind === 'freshAccount') {
        expectedRequester = identity.requester;
        accountSource = { kind: sourceKind, origin, hostAccountAgent: {
          accountId: identity.requester.accountId, custodianAccountId: birth.accountId,
          machineId: identity.requester.machineId, installationId: identity.requester.installationId } };
      } else {
        const custody = await readOrdinaryRequesterSessionAccountCustodyForHost({ happyHomeDir: admitted.directory,
          serverId: birth.serverId, serverHttpBaseUrl: admitted.bootstrap.serverHttpBaseUrl,
          sessionId: 'owner-private-session', machineId: birth.machineId,
          hostHomeServerIdentityId: origin.serverIdentityId, sessionCustodianAccountId: birth.accountId,
          credentials, attribution: birth, isCurrent: admitted.isHomeCurrent });
        expect(custody).not.toBeNull();
        if (!custody) throw new Error('Exact ordinary owner custody unavailable');
        accountSource = { kind: sourceKind, origin, custody };
      }
    }
    const requesterIdentity = { kind: 'isolated' as const, requester: expectedRequester, separationRequired: false,
      homeServerIdentityId: admitted.bootstrap.homeServerIdentityId! };
    const member = createAgentIsolationMemberPreparationBoundary({ activeServerDir: admitted.directory, requesterIdentity,
      uid: 2401, custodianAccountId: birth.accountId, encryptionMode: 'plain' });
    nativeHomes.set(member.filesystemHome.path, member.filesystemHome);
    const policy = readAgentIsolationSnapshot({
      metadata: { status: 'ready', metadata: { agentIsolation: { enabled: true, memberProvisioning: 'linuxUsersV1' } }, metadataVersion: 1 },
      daemonState: { runtimeId: 'current', agentIsolation: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } },
      runtimeId: 'current', platform: 'linux' });
    const prepareMember = createSessionAgentIsolationMemberPreparation({ machineId: birth.machineId,
      custodianAccountId: birth.accountId,
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: birth.machineId,
        serverIdentityId: requesterIdentity.homeServerIdentityId }),
      agentIsolation: { read: () => ({ ...policy, workspaceRoots: [] }), prepareMember: async input => {
        const result = await member.members.prepare(input);
        if (result.kind !== 'ready') throw new Error('Real owner native preparation refused');
        return result;
      } },
    })(sourceKind === 'birth' ? { bootstrap: admitted.bootstrap } : null, new AbortController().signal, accountSource);
    const api = new Proxy({} as ApiClient, { get() { throw new Error('Native owner material must not read host Account credentials'); } });
    const cleanups: Array<() => void | Promise<void>> = [];
    try {
      for (const recovered of sourceKind === 'freshAccount' ? [false] : sourceKind === 'ordinarySession' ? [true] : [false, true]) {
        member.resetObservations(); member.mutations.length = 0; member.launches.length = 0;
        const prepared = await prepareDaemonConnectedServices({ options: { directory: admitted.directory,
            ...(sourceKind === 'freshAccount' ? {} : { requesterWorkAttributionV1: birth }) },
          normalizedExistingSessionId: recovered ? 'owner-private-session' : '', requestedSessionId: 'owner-private-session',
          effectiveResume: '', catalogAgentId: 'codex', credentials: admitted.bootstrap.credentials, api,
          activeServerDir: admitted.directory, connectedServicesMaterializationBaseDir: join(admitted.directory, 'materialized'),
          connectedServiceRefreshCoordinator: null, processEnv: {}, pluginRuntimeRegistry: runtime.registry,
          prepareAgentIsolationMember: prepareMember });
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) throw new Error('Owner Agent preparation refused');
        if (prepared.auth?.cleanupOnExit) cleanups.push(prepared.auth.cleanupOnExit);
        expect(prepared.agentLaunchMaterials?.memberIdentity).toMatchObject({ requester: expectedRequester,
          homeServerIdentityId: requesterIdentity.homeServerIdentityId, agentUid: 2401 });
        expect(prepared.agentLaunchMaterials?.runtimeHome.startsWith(`${member.filesystemHome.path}/`)).toBe(true);
        const warm = sourceKind === 'birth' && recovered;
        expect(member.launches).toHaveLength(warm ? 0 : 1);
        if (warm) {
          expect(member.permissionQueries).toHaveLength(1);
          expect(member.mutations).toEqual([]);
        } else expect(member.mutations).toContain('agent-account');
      }
      expect(member.boundaryFailures).toEqual([]);
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
      nativeHomes.clear(); await runtime.dispose();
    }
  });
  it('refuses reviewed owner preparation when ordinary requester proof is missing or belongs to another Account', async () => {
    const admitted = await createProjectSessionRuntimeFixture({ serverId: 'owner-profile',
      homeServerIdentityId: 'srv_canonical_owner_home' });
    const birth = admitted.bootstrap.attribution;
    const member = createAgentIsolationMemberPreparationBoundary({ activeServerDir: admitted.directory,
      requesterIdentity: { kind: 'isolated', requester: birth, separationRequired: false,
        homeServerIdentityId: admitted.bootstrap.homeServerIdentityId! },
      uid: 2401, custodianAccountId: birth.accountId, encryptionMode: 'plain' });
    const prepare = createSessionAgentIsolationMemberPreparation({ machineId: birth.machineId,
      custodianAccountId: birth.accountId, agentIsolation: {
        read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1', workspaceRoots: [],
          status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } }),
        prepareMember: async input => {
          const result = await member.members.prepare(input);
          if (result.kind !== 'ready') throw new Error('Unexpected native setup attempt');
          return result;
        },
      } });
    const signal = new AbortController().signal;
    // Null recovery cannot adopt the currently signed-in owner, even when the
    // retained attribution happens to name that Account.
    await expect(prepare(null, signal)({ requesterWorkAttributionV1: birth }))
      .rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    await expect(prepare(null, signal, { kind: 'freshAccount',
      origin: { machineId: birth.machineId, serverIdentityId: admitted.bootstrap.homeServerIdentityId! },
      hostAccountAgent: { accountId: 'other-account', custodianAccountId: birth.accountId,
        machineId: birth.machineId, installationId: birth.installationId },
    })({})).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    expect(member.launches).toEqual([]);
    expect(member.mutations).toEqual([]);
  });
  it('uses the same binding admission for foreground launches', () => {
    const request = {
      v: 1, attemptId: 'attempt', sessionId: 'session', foregroundPid: 123,
      directory: '/synthetic/workspace', agentId: 'codex',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    };
    expect(ForegroundAgentRuntimeAdmissionRequestV1Schema.safeParse({
      ...request, connectedServices: malformedBindings,
    }).success).toBe(false);
    const connectedServices = { v: 1, bindingsByServiceId: {
      'openai-codex': { source: 'connected', profileId: 'work' },
    } };
    expect(ForegroundAgentRuntimeAdmissionRequestV1Schema.parse({
      ...request, connectedServices,
    }).connectedServices).toEqual(SpawnDaemonSessionRequestSchema.parse({
      directory: request.directory, connectedServices,
    }).connectedServices);
  });

  async function prepare(connectedServices: unknown, existingSessionId = '') {
    const credentials = { token: 'synthetic-admission-test', encryption: null };
    const apiAccess = vi.fn(() => {
      throw new Error('Credential and network API must not be reached');
    });
    // This API boundary must be wholly unused; the proxy rejects every access, including credential reads.
    const api = new Proxy({} as ApiClient, { get: apiAccess });
    const repair = vi.fn(async () => null);
    const result = await prepareDaemonConnectedServices({
      options: {
        directory: '/synthetic/workspace', connectedServices,
        get connectedServiceMaterializationIdentityV1() {
          if (connectedServices === malformedBindings) throw new Error('Identity must not be read before admission');
          return undefined;
        },
      },
      normalizedExistingSessionId: existingSessionId,
      requestedSessionId: 'synthetic-session',
      effectiveResume: '',
      catalogAgentId: 'codex',
      credentials,
      api,
      qualifiedConnectedAccountApi: { listAccounts: apiAccess, readGroup: apiAccess },
      connectedServiceRefreshCoordinator: null,
      processEnv: {},
      connectedServicesMaterializationBaseDir: '/synthetic/materialization',
      pluginRuntimeRegistry: { contributes: { agentDefinitionsById: new Map() } },
      repairMissingMaterializationIdentity: repair,
    });
    expect(apiAccess).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
    return result;
  }

  it.each(['', 'existing-session'])('refuses malformed intent before fresh/resume materialization (%s)', async (existingSessionId) => {
    expect(await prepare(malformedBindings, existingSessionId)).toEqual({
      ok: false,
      result: {
        type: 'error',
        errorCode: 'SPAWN_VALIDATION_FAILED',
        errorMessage: 'connected_service_bindings_invalid',
      },
    });
  });

  it('refuses an unsupported Connected Account at qualified-purpose admission before credential access', async () => {
    expect(await prepare({ v: 2, bindingsByServiceId: {
      'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'unsupported-profile' },
    } })).toMatchObject({ ok: false, result: { type: 'error', errorCode: 'SPAWN_VALIDATION_FAILED',
      errorDetail: { kind: 'launch_error', code: 'connected_service_qualified_purpose_authority_unavailable' } } });
  });

  it.each([
    undefined,
    { v: 1, bindingsByServiceId: {} },
    { v: 1, bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'native' } } },
    { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'native' } } },
  ])('keeps absent and native ingress free of connected authentication (%j)', async (connectedServices) => {
    const admitted = SpawnDaemonSessionRequestSchema.parse({ directory: '/synthetic/workspace', connectedServices });
    expect(await prepare(admitted.connectedServices)).toMatchObject({
      ok: true, auth: null, materializationIdentity: null,
    });
  });
});
