import { describe, expect, it, onTestFinished, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';
import tweetnacl from 'tweetnacl';
import { MachineAdminAccessInspectResultV1Schema, MachineAdminAccessMutationResultV1Schema,
  presentMachineAuthorityV1, MachineSudoPasswordPromptV1Schema, ActionOperationSnapshotV1Schema,
  ActionOperationListV1ResponseSchema, ActionOperationGetV1ResponseSchema,
  ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2, MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
  FeaturesResponseSchema, type ActionOperationSnapshotV1, type MachineAdminAccessV1 } from '@happier-dev/protocol';
import { MachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandlerContext } from './rpc/types';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { ApiMachineClient } from './apiMachine';
import { ApiClient } from './api';
import { createDaemonMachineRpcRouteAttachmentCache } from '@/daemon/machineRpcRouteAttachments';
import { createDaemonMachineAdminAccessRoutes } from '@/machines/adminAccess/createDaemonMachineAdminAccessRoutes';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import type { Machine } from './types';
import { verifyMachineRpcAdmissionCurrent } from './machine/machineRpcAuthorization';
import { createMachineContentCodec } from './machine/machineStoredContent';
import { configuration, reloadConfiguration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor, useServerProfile } from '@/server/serverProfiles';
import { readStoredCredentials, writeCredentialsTokenOnly } from '@/persistence';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { createDeferred } from '@/testkit/async/deferred';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { createInterface } from 'node:readline';
import { runMachineSetupEffectInternal } from '@/machines/setup/effectInternal';
import { buildManagedSudoersSteps, MANAGED_SUDOERS_PATH } from '@/machines/adminAccess/managedSudoers';
import type { MachineElevationSpawn } from '@/machines/adminAccess/runElevatedEffect';
import type { MachineAdminAccessNativeDependencies } from '@/machines/adminAccess/observeMachineAdminAccess';
import { createMachineSetupPlanAction } from '@/machines/setup/machineSetupAction';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';

const protectedFiles = vi.hoisted(() => ({ directory: '' }));
// Redirect only protected OS filesystem syscalls. Parser, root CHECK/APPLY,
// canonical digest, sudoers builder and file backend execute unchanged.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const protectedPath = (value: unknown) => typeof value === 'string'
    && (value === '/etc/sudoers.d' || value.startsWith('/etc/sudoers.d/'));
  const ownedPath = (value: unknown) => protectedPath(value) || typeof value === 'string'
    && protectedFiles.directory !== '' && (value === protectedFiles.directory || value.startsWith(protectedFiles.directory + '/'));
  const path = <T,>(value: T): T => protectedPath(value)
    ? (protectedFiles.directory + String(value).slice('/etc/sudoers.d'.length)) as T : value;
  return { ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stat = await actual.lstat(path(args[0]), args[1]);
      return ownedPath(args[0]) ? Object.assign(stat, { uid: 0, gid: 0 }) : stat;
    },
    readFile: (...args: Parameters<typeof actual.readFile>) => actual.readFile(path(args[0]), args[1]),
    writeFile: (...args: Parameters<typeof actual.writeFile>) => actual.writeFile(path(args[0]), args[1], args[2]),
    chmod: (...args: Parameters<typeof actual.chmod>) => actual.chmod(path(args[0]), args[1]),
    chown: async (...args: Parameters<typeof actual.chown>) => {
      if (ownedPath(args[0])) { await actual.lstat(path(args[0])); return; }
      await actual.chown(...args);
    },
    mkdtemp: (...args: Parameters<typeof actual.mkdtemp>) => actual.mkdtemp(path(args[0]), args[1]),
    rename: (...args: Parameters<typeof actual.rename>) => actual.rename(path(args[0]), path(args[1])),
    unlink: (...args: Parameters<typeof actual.unlink>) => actual.unlink(path(args[0])),
    rm: (...args: Parameters<typeof actual.rm>) => actual.rm(path(args[0]), args[1]),
  };
});

const metadata = { host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: '/users/worker', happyHomeDir: '/users/worker/.happier' };
const none = { version: 1, mode: 'none' } as const;
const preauthorized = { version: 1, mode: 'preauthorized' } as const;

type InstalledAdminHarness = Readonly<{
  api: ApiClient;
  token: string;
  installation: Awaited<ReturnType<typeof readOrCreateInstallationIdentity>>;
  onOperation(snapshot: ActionOperationSnapshotV1): void;
}>;

async function createDesiredPolicyHarness(encryptionMode: 'plain' | 'e2ee', options?: Readonly<{
  spawnElevation?: MachineElevationSpawn; nativeDependencies?: MachineAdminAccessNativeDependencies; initialPolicy?: MachineAdminAccessV1;
  installed?: InstalledAdminHarness;
}>) {
  let target = { serverId: configuration.activeServerId, machineId: 'machine',
    installationId: options?.installed?.installation.installationId ?? 'installation', custodianAccountId: 'owner' };
  const machine: Machine = { id: 'machine', ...(encryptionMode === 'plain' ? { encryptionMode } : {
    encryptionMode, encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'dataKey', dataEncryptionKey: 'owner-envelope',
  }), metadata: { ...metadata, adminAccess: options?.initialPolicy ?? none }, metadataVersion: 1, daemonState: { status: 'running' }, daemonStateVersion: 0 };
  let refreshed = machine;
  let writes = 0;
  let probes = 0;
  let admissionChecks = 0;
  let loads = 0;
  let statePublications = 0;
  const signing = tweetnacl.sign.keyPair();
  const codec = createMachineContentCodec(machine);
  const home = vi.spyOn(axios, 'post').mockImplementation(async () => {
    admissionChecks += 1;
    return { status: 200, data: { v: 1, ok: true }, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
  });
  const loadMachine = async () => { loads += 1; return refreshed; };
  const client = options?.installed ? await options.installed.api.machineSyncClient(machine, undefined, { loadMachine })
    : new ApiMachineClient('desired-policy-token', machine, undefined, {
      loadMachine,
    });
  const refresh = async (row: Machine) => {
    refreshed = row;
    // Exercise the incumbent refresh; only its remote row load is substituted.
    await Reflect.apply(Reflect.get(client, 'refreshMachineFromServer'), client, []);
  };
  type Write = Readonly<{ metadata: string; expectedVersion: number; expectedDataEncryptionKey: string | null }>;
  let onWrite: (request: Write, candidate: Machine['metadata']) => Promise<unknown> = async request => ({
    result: 'success', version: request.expectedVersion + 1, metadata: request.metadata,
  });
  const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async (event, raw) => {
    if (options?.installed && event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) return { v: 1, result: 'success', revision: 1 };
    if (event === 'machine-update-state') {
      statePublications += 1;
      const state = raw as { daemonState: string; expectedVersion: number };
      return { result: 'success', version: state.expectedVersion + 1, daemonState: state.daemonState };
    }
    if (event !== 'machine-update-metadata') throw new Error('Desired-only changes must not publish daemon state');
    writes += 1;
    const request = raw as Write; // Socket transport is the untyped system boundary.
    expect(request.expectedDataEncryptionKey).toBe(encryptionMode === 'plain' ? null : 'owner-envelope');
    const candidate = codec.decodeStored(request.metadata) as Machine['metadata'];
    expect(candidate).toMatchObject(metadata);
    return onWrite(request, candidate);
  }, emit: (event, args) => {
    if (!options?.installed || event !== 'action-operation-updated') return;
    const envelope = args[0];
    if (!envelope || typeof envelope !== 'object' || !('content' in envelope)) return;
    const content = envelope.content;
    if (!content || typeof content !== 'object' || !('t' in content) || content.t !== 'plain' || !('v' in content)) return;
    options.installed.onOperation(ActionOperationSnapshotV1Schema.parse(content.v));
  } });
  Reflect.set(client, 'socket', socket);
  client.registerMachineAdminAccessRoutes(createDaemonMachineAdminAccessRoutes({ getMachineClient: () => client,
    target: () => target, ...(options?.spawnElevation ? { spawnElevation: options.spawnElevation } : {}),
    nativeDependencies: { platform: 'linux', ...options?.nativeDependencies, execFile: async (file, args) => {
      probes += 1;
      if (options?.nativeDependencies?.execFile) return options.nativeDependencies.execFile(file, args);
      throw new Error('A desired-only write must not inspect or elevate');
    } },
  }));
  const context = (): RpcHandlerContext => {
    const signal = new AbortController().signal;
    const machineAdmission = { machineId: target.machineId, installationId: target.installationId,
      custodianAccountId: target.custodianAccountId, actorAccountId: 'owner', role: 'manage' as const, encryptionMode };
    return { signal, machineAdmission, verifyMachineAdmissionCurrent: () => verifyMachineRpcAdmissionCurrent({
      context: machineAdmission, method: `${machineAdmission.machineId}:${RPC_METHODS.MACHINE_ADMIN_ACCESS_SET}`,
      privateKey: options?.installed ? Buffer.from(options.installed.installation.privateKey, 'base64url') : signing.secretKey,
      daemonToken: options?.installed?.token ?? 'desired-policy-token', serverHttpBaseUrl: 'https://home.invalid', signal,
    }) };
  };
  return { client, machine, codec, refresh, context,
    counts: () => ({ writes, probes, admissionChecks, loads, statePublications }),
    onWrite: (handler: typeof onWrite) => { onWrite = handler; },
    denyNextAdmission: () => home.mockResolvedValueOnce({ status: 403, data: { v: 1, ok: false }, statusText: 'Forbidden',
      headers: {}, config: { headers: new AxiosHeaders() } }),
    replaceInstallation: () => { target = { ...target, installationId: 'replacement-installation' }; },
    rebindMachine: () => { target = { ...target, machineId: 'replacement-machine' }; },
    rebindHome: () => { target = { ...target, serverId: `${target.serverId}-replacement` }; },
    set: async (input: { serverId?: string; expectedMetadataVersion?: number; expectedAdminAccess?: MachineAdminAccessV1;
      adminAccess?: MachineAdminAccessV1; comparison?: 'field' | 'revision' } = {}, current = context()) =>
      MachineAdminAccessMutationResultV1Schema.parse(await client.invokeLocalMachineAction(RPC_METHODS.MACHINE_ADMIN_ACCESS_SET,
        { serverId: target.serverId, machineId: target.machineId, expectedMetadataVersion: 1, expectedAdminAccess: none,
          adminAccess: preauthorized, comparison: 'field', ...input }, { signal: current.signal, rpcContext: current,
          ...(current.localActionContext ? { localActionContext: current.localActionContext } : {}) })),
    close: async () => { await client.shutdown(); home.mockRestore(); },
  };
}

async function createHostBoundary(encryptionMode: 'plain' | 'e2ee', initialPolicy: MachineAdminAccessV1 = none,
  daemonUsername: string | null = 'happier', installed?: InstalledAdminHarness) {
  const directory = await mkdtemp(join(tmpdir(), 'happier-admin-action-'));
  protectedFiles.directory = directory;
  if (initialPolicy.mode !== 'none' && !daemonUsername) throw new Error('Previous grant fixture needs a known daemon');
  const [previous] = initialPolicy.mode === 'none' ? []
    : buildManagedSudoersSteps({ daemonUsername: daemonUsername!, previousPolicy: none, policy: initialPolicy });
  if (previous?.content?.kind === 'literal') {
    await writeFile(MANAGED_SUDOERS_PATH, previous.content.value, { mode: 0o600 });
    await chmod(MANAGED_SUDOERS_PATH, 0o440);
  }
  let rootAllowed = true, loseTerminal = false;
  const launches: Parameters<MachineElevationSpawn>[0][] = [];
  const nativeFailures: unknown[] = [];
  const records: unknown[] = [];
  const passwords: string[] = [];
  let beforeNativeRead: (() => Promise<void>) | undefined;
  const h = await createDesiredPolicyHarness(encryptionMode, { initialPolicy, ...(installed ? { installed } : {}),
    nativeDependencies: { platform: 'linux', execFile: async (file, args) => {
      await beforeNativeRead?.();
      if (file === 'id') return { stdout: args[0] === '-u' ? '1001\n' : args[0] === '-un' ? `${daemonUsername ?? ''}\n` : 'happier\n' };
      if (file !== 'sudo') throw new Error('Unexpected native observation');
      if (!rootAllowed) throw Object.assign(new Error('Root denied'), { code: 1 });
      return { stdout: '' };
    } },
    spawnElevation: invocation => {
      // The real desired cache must already contain the committed target policy.
      const committed = h.client.getMachineMetadataSnapshot();
      expect(committed).toMatchObject({ metadata: { adminAccess: preauthorized } });
      if (committed.status !== 'ready') throw new Error('Desired policy is not committed');
      expect(committed.metadataVersion).toBeGreaterThanOrEqual(2);
      launches.push(invocation);
      expect(invocation.executable).toBe('sudo');
      expect(invocation.args).toContain(initialPolicy.mode === 'ask' ? '-S' : '-n');
      const stdin = new PassThrough(), output = new PassThrough(), stderr = new PassThrough();
      const rootInput = initialPolicy.mode === 'ask' ? new PassThrough() : stdin;
      const controller = new AbortController();
      const stdout = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        const record: unknown = JSON.parse(chunk.toString('utf8'));
        records.push(record);
        if (loseTerminal && record && typeof record === 'object' && 'type' in record && record.type === 'result'
          && 'result' in record && record.result && typeof record.result === 'object' && 'status' in record.result
          && record.result.status !== 'checked') { callback(); return; }
        callback(null, chunk);
      } });
      output.pipe(stdout);
      const settled = (async () => {
        let forward: Promise<void> | undefined;
        if (initialPolicy.mode === 'ask') {
          expect(invocation.args).toContain('-k');
          stderr.write(`[happier-sudo-password:${initialPolicy.administratorUsername}]\n`);
          const lines = createInterface({ input: stdin, crlfDelay: Infinity });
          const iterator = lines[Symbol.asyncIterator]();
          const answer = await iterator.next();
          passwords.push(answer.value ?? '');
          if (answer.done || answer.value !== 'one-use-password') throw new Error('Authentication denied');
          // Sudo consumes one transient password line; the root interpreter
          // receives only the remaining canonical CHECK/APPLY frames.
          forward = (async () => {
            for await (const line of { [Symbol.asyncIterator]: () => iterator }) rootInput.write(line + '\n');
            rootInput.end();
          })();
        }
        const running = runMachineSetupEffectInternal(invocation.args.slice(invocation.args.indexOf('effect-internal') + 1), {
          stdin: rootInput, stdout: output, signal: controller.signal,
          // Only the elevated process has root identity; daemon receipt storage
          // keeps the runner's real UID and protected filesystem ownership.
          readUid: () => 0, runNative: async command => {
            if (command.executable === 'getent') return { code: 0, stderr: '', stdout: command.args.includes('passwd')
              ? 'root:x:0:0::/root:/bin/sh\n' : 'root:x:0:\n' };
            if (command.executable === 'visudo') return { code: 0, stdout: '', stderr: '' };
            throw new Error('Unexpected root native command');
          },
        });
        const [code] = await Promise.all([running, forward]);
        return code;
      })().then(code => { output.end(); stderr.end(); return { code, signal: null }; }, error => {
        nativeFailures.push(error); output.end(); stderr.end(); return { code: 1, signal: null };
      });
      return { stdin, stdout, stderr, settled, async terminate() { controller.abort(); stdin.end(); await settled; } };
    },
  });
  return { ...h, launches, nativeFailures, records, passwords,
    onNativeRead: (handler: NonNullable<typeof beforeNativeRead>) => { beforeNativeRead = handler; },
    denyRoot: () => { rootAllowed = false; }, loseTerminal: () => { loseTerminal = true; },
    readOperations: async () => {
      h.client.setRPCHandlers({ spawnSession: async () => { throw new Error('Administrator operation reads must not create a Session'); },
        stopSession: async () => ({ status: 'not_found' }), requestShutdown: () => {} });
      const context = h.context();
      return ActionOperationListV1ResponseSchema.parse(await h.client.invokeLocalMachineAction(ACTION_OPERATION_RPC_METHODS_V2.list,
        { requestIdentity: { actionId: 'machines.setup.adminAccess.set', requestId: 'actual-admitted-transport-request' } },
        { signal: context.signal, rpcContext: context }));
    },
    operation: (signal = new AbortController().signal): RpcHandlerContext => ({ ...h.context(), signal,
      localActionContext: { actionRequestId: 'actual-admitted-transport-request' } }),
    close: async () => { await h.close(); protectedFiles.directory = ''; await rm(directory, { recursive: true, force: true }); },
  };
}

describe.runIf(process.platform !== 'win32')('administrator Action desired-first host composition', () => {
  it('projects an unknown daemon principal as a typed host refusal after desired CAS without a grant', async () => {
    const h = await createHostBoundary('plain', none, null);
    try {
      expect(await h.set({}, h.operation())).toMatchObject({ status: 'applied', policy: preauthorized,
        effect: { outcome: 'not_applied', reasonCode: 'denied' } });
      expect(h.launches).toEqual([]);
      await expect(readFile(MANAGED_SUDOERS_PATH, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await h.close(); }
  });

  it('feeds the real captured P10 identity into the default setup Plan action', async () => {
    const h = await createDesiredPolicyHarness('plain', { nativeDependencies: {
      execFile: async (file, args) => ({ stdout: file === 'id'
        ? args[0] === '-u' ? '1001' : args[0] === '-un' ? 'daemon-user' : args[0] === '-gn' ? 'daemon-operators' : 'users'
        : '' }),
      fileSystem: { lstat: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
        readFile: async () => { throw new Error('Absent file must not be opened'); } },
    } });
    const pluginId = 'com.example.target-facts';
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{ files: {},
      manifest: { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Target facts', runtime: { apiVersion: 1 },
        contributes: { machineRecipes: [{ id: 'private-service', revision: '1', title: 'Private service',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [{ id: 'socket', kind: 'directory',
            path: '/run/happier-group-composition-test', owner: 'root', group: { kind: 'targetFact', fact: 'daemon.primaryGroup' }, mode: 0o750 }],
        }] } },
    }] }).catch(async error => { await h.close(); throw error; });
    try {
      let nativeReads = 0;
      const options: Omit<Parameters<typeof createMachineSetupPlanAction>[0], 'apiMachine'> = {
        homeId: configuration.activeServerId, machineId: 'machine',
        acquirePluginRuntimeRegistryLease: () => acquireAuthoritativePluginRuntimeRegistryLease({ controller: runtime.controller,
          happyHomeDir: runtime.happyHomeDir }),
        runNative: async command => {
          nativeReads++;
          if (command.executable !== 'getent') throw new Error('Planning cannot mutate native state');
          return { code: 0, stderr: '', stdout: command.args.includes('passwd') ? 'root:x:0:0::/root:/bin/sh\n'
            : `${command.args.at(-1)}:x:1001:\n` };
        },
      };
      const plan = createMachineSetupPlanAction({ ...options, apiMachine: h.client });
      const request: Parameters<typeof plan>[0] = { context: { surface: 'cli', authority: 'present_user' }, input: {
        homeId: configuration.activeServerId, machineId: 'machine', mode: 'effects', sources: [
          { kind: 'direct', setup: { items: [{ kind: 'setupRecipe', selection: {
            ref: { pluginId, recipeId: 'private-service', revision: '1' }, inputs: {},
          } }] } },
        ],
      } };
      // Withhold only the binding; the same real content/recipe readers remain.
      const unbound = createMachineSetupPlanAction({ ...options, apiMachine: {
        getMachineSetupDesiredSnapshot: () => h.client.getMachineSetupDesiredSnapshot(),
      } });
      expect(await unbound(request)).toMatchObject({ ok: false, errorCode: 'machine_recipe_target_fact_unavailable' });
      expect(nativeReads).toBe(0);
      expect(await plan(request)).toMatchObject({ recipePlans: [{ plan: { steps: [{ group: 'daemon-operators' }] } }] });
      expect(h.counts().writes).toBe(0);
    } finally { await runtime.dispose(); await h.close(); }
  });

  it.each(['plain', 'e2ee'] as const)('commits %s desired state before the sole privileged CHECK/APPLY with clients offline', async mode => {
    const h = await createHostBoundary(mode);
    try {
      let edited = false;
      if (mode === 'plain') h.onNativeRead(async () => {
        const snapshot = h.client.getMachineMetadataSnapshot();
        if (!edited && snapshot.status === 'ready'
          && snapshot.metadata.adminAccess && typeof snapshot.metadata.adminAccess === 'object'
          && 'mode' in snapshot.metadata.adminAccess && snapshot.metadata.adminAccess.mode === 'preauthorized') {
          edited = true;
          await h.refresh({ ...h.machine,
            metadata: { ...metadata, adminAccess: preauthorized, displayName: 'Unrelated edit after desired commit' }, metadataVersion: 3 });
        }
      });
      expect(await h.set({}, h.operation()), JSON.stringify(h.records)).toMatchObject({ status: 'applied', policy: preauthorized, metadataVersion: 2,
        effect: { outcome: 'applied', observation: { managedDropIn: 'valid', passwordlessSudoToRoot: 'allowed' } } });
      expect(h.nativeFailures).toEqual([]);
      expect(h.launches).toHaveLength(1);
      const operations = await h.readOperations();
      expect(operations.items).toHaveLength(1);
      expect(operations.items[0]).toMatchObject({ actionId: 'machines.setup.adminAccess.set', state: 'succeeded',
        requestId: 'actual-admitted-transport-request' });
      expect(h.launches[0]?.args).toContain(`--operation-id=${operations.items[0]!.operationId}`);
      const [step] = buildManagedSudoersSteps({ daemonUsername: 'happier', previousPolicy: none, policy: preauthorized });
      if (step?.content?.kind !== 'literal') throw new Error('Expected the canonical managed grant fixture');
      expect(await readFile(MANAGED_SUDOERS_PATH, 'utf8')).toBe(step.content.value);
      if (mode === 'plain') expect(h.client.getMachineMetadataSnapshot()).toMatchObject({ metadata: { displayName: 'Unrelated edit after desired commit' }, metadataVersion: 3 });
      expect(h.counts()).toMatchObject({ writes: 1, statePublications: 2 });
    } finally { await h.close(); }
  });

  it.each(['conflict', 'unknown', 'locked', 'cancelled'] as const)('runs no host inspection or effect after %s desired settlement', async outcome => {
    const h = await createHostBoundary('e2ee');
    const cancellation = new AbortController();
    try {
      if (outcome === 'conflict') h.onWrite(async () => ({ result: 'version-mismatch', version: 2,
        metadata: h.codec.encodeStored({ ...metadata, adminAccess: { version: 1, mode: 'ask', administratorUsername: 'other-admin' } }) }));
      if (outcome === 'unknown') h.onWrite(async () => { throw new Error('ACK unavailable'); });
      if (outcome === 'locked' || outcome === 'cancelled') h.onWrite(async request => {
        // Retire the real incumbent codec or cancel while its ACK is pending.
        if (outcome === 'cancelled') cancellation.abort();
        else await h.refresh({ ...h.machine, encryptionMode: 'e2ee', encryptionKey: new Uint8Array(32).fill(8),
          encryptionVariant: 'dataKey', dataEncryptionKey: 'replacement-envelope' });
        return { result: 'success', version: request.expectedVersion + 1, metadata: request.metadata };
      });
      expect(await h.set({}, h.operation(cancellation.signal))).toMatchObject(outcome === 'cancelled'
        ? { status: 'applied', effect: { outcome: 'not_applied', reasonCode: 'cancelled' } }
        : { status: outcome === 'unknown' ? 'outcomeUnknown' : outcome });
      expect(h.counts()).toMatchObject({ probes: 0, statePublications: 0 });
      expect(h.launches).toEqual([]);
    } finally { await h.close(); }
  });

  it('retains desired success but refuses a changed desired field before host authentication', async () => {
    const h = await createHostBoundary('plain');
    try {
      let changed = false;
      h.onNativeRead(async () => {
        const snapshot = h.client.getMachineMetadataSnapshot();
        if (!changed && snapshot.status === 'ready' && snapshot.metadata.adminAccess
          && typeof snapshot.metadata.adminAccess === 'object' && 'mode' in snapshot.metadata.adminAccess
          && snapshot.metadata.adminAccess.mode === 'preauthorized') {
          changed = true;
          await h.refresh({ ...h.machine, metadata: { ...metadata, adminAccess: none }, metadataVersion: 3 });
        }
      });
      expect(await h.set({}, h.operation())).toMatchObject({ status: 'applied', policy: preauthorized, metadataVersion: 2,
        effect: { outcome: 'not_applied', reasonCode: 'plan_stale' } });
      expect(h.launches).toEqual([]);
      expect(h.counts()).toMatchObject({ admissionChecks: 0 });
    } finally { await h.close(); }
  });

  it('shows denied host capability separately from successfully persisted Preauthorized intent', async () => {
    const h = await createHostBoundary('plain'); h.denyRoot();
    try {
      expect(await h.set({}, h.operation())).toMatchObject({ status: 'applied', policy: preauthorized, metadataVersion: 2,
        effect: { outcome: 'not_applied', reasonCode: 'not_preauthorized' } });
      expect(h.client.getMachineMetadataSnapshot()).toMatchObject({ metadata: { adminAccess: preauthorized } });
      expect(h.client.getMachineAdminAccessRights()).toMatchObject({ observation: { passwordlessSudoToRoot: 'denied' } });
      expect(h.launches).toEqual([]);
    } finally { await h.close(); }
  });

  it('preserves desired success and unknown actual settlement after losing the root terminal, without replay', async () => {
    const h = await createHostBoundary('plain'); h.loseTerminal();
    try {
      expect(await h.set({}, h.operation())).toMatchObject({ status: 'applied', policy: preauthorized, metadataVersion: 2,
        effect: { outcome: 'outcome_unknown' } });
      expect(h.launches).toHaveLength(1);
      expect(await readFile(MANAGED_SUDOERS_PATH, 'utf8')).toContain('NOPASSWD');
      expect(h.client.getMachineAdminAccessRights()).toMatchObject({ observation: { managedDropIn: 'valid' }, freshness: 'current' });
      expect(h.counts()).toMatchObject({ writes: 1, statePublications: 2 });
    } finally { await h.close(); }
  });

  it('keeps unchanged None metadata free of an elevated task or prompt', async () => {
    const h = await createHostBoundary('plain');
    try {
      h.denyRoot();
      expect(await h.set({ adminAccess: none }, h.operation())).toMatchObject({ policy: none });
      expect(h.launches).toEqual([]);
      expect(h.passwords).toEqual([]);
      expect(h.records).toEqual([]);
      expect(h.counts().probes).toBe(0);
      const operations = await h.readOperations();
      expect(operations.items.filter(item => item.actionId === 'machines.setup.adminAccess.set')).toHaveLength(1);
      expect(operations.items.some(item => item.domainRef?.kind === 'machineSetup' && item.domainRef.setupTask)).toBe(false);
    } finally { await h.close(); }
  });

  it.each(['answer', 'cancel', 'retire'] as const)('holds Ask admin reconciliation on the same admitted operation until its transient password is answered (%s)', async completion => {
    const ask = { version: 1, mode: 'ask', administratorUsername: 'ops.admin' } as const;
    const directory = await mkdtemp(join(tmpdir(), 'happier-admin-attendance-'));
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    reloadConfiguration();
    let h: Awaited<ReturnType<typeof createHostBoundary>> | undefined;
    let invocation: ReturnType<Awaited<ReturnType<typeof createHostBoundary>>['set']> | undefined;
    let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    let releaseHome: (() => void) | undefined;
    const snapshots: ActionOperationSnapshotV1[] = [];
    const currentSnapshots: ActionOperationSnapshotV1[] = [];
    const notificationReads: Promise<void>[] = [];
    const prompt = createDeferred<ActionOperationSnapshotV1>();
    onTestFinished(async () => {
      // Only this fixture's unanswered task is released. No fake operation
      // settlement or public cancellation authority is supplied by cleanup.
      await Promise.allSettled(notificationReads);
      const tasks = new Set(currentSnapshots.flatMap(snapshot => snapshot.domainRef?.kind === 'machineSetup'
        && snapshot.domainRef.setupTask ? [snapshot.domainRef.setupTask.id] : []));
      for (const taskId of tasks) await getLiveSystemTasksRunnerAdapter().cancel({ taskId });
      await invocation?.catch(() => undefined);
      await Promise.allSettled(notificationReads);
      await h?.close();
      await runtime?.dispose();
      releaseHome?.();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      reloadConfiguration();
      await rm(directory, { recursive: true, force: true });
    });
    const profile = await addServerProfile({ name: 'Administrator attendance', serverUrl: 'https://home.invalid', webappUrl: 'https://home.invalid' });
    await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
      v: 1, homeServerIdentityId: 'srv_admin_attendance', canonicalServerUrl: profile.serverUrl, revision: 1,
      endpoints: [{ kind: 'https', url: profile.serverUrl }],
    } });
    await useServerProfile(profile.id);
    vi.stubEnv('HAPPIER_ACTIVE_SERVER_ID', profile.id);
    vi.stubEnv('HAPPIER_SERVER_URL', profile.serverUrl);
    reloadConfiguration();
    const installation = await readOrCreateInstallationIdentity();
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.fixture`;
    await writeCredentialsTokenOnly({ token });
    const credentials = await readStoredCredentials();
    if (!credentials) throw new Error('Stored terminal credential must decode through its actual owner');
    releaseHome = publishServerHttpRuntimeOrigin(profile.serverUrl, 'https');
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
      if (path === '/v1/account/encryption/currentness') return { status: 404, data: {} };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      throw new Error(`Unexpected administrator attendance GET ${path}`);
    });
    runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: directory, runtimeOptions: { pluginIds: [] } });
    const api = await ApiClient.create(credentials);
    api.setServerFeaturesSnapshotProvider(() => ({ status: 'ready', features: FeaturesResponseSchema.parse({
      features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_admin_attendance' } },
    }) }));
    h = await createHostBoundary('plain', ask, 'happier', { api, token, installation, onOperation: snapshot => {
      snapshots.push(snapshot);
      // Existing current clients consume the legacy-compatible notification by
      // reading the complete record through the same qualified V2 owner.
      const read = receive(ACTION_OPERATION_RPC_METHODS_V2.get, { operationId: snapshot.operationId }).then(raw => {
        const result = ActionOperationGetV1ResponseSchema.parse(raw);
        if (result.kind !== 'found' || result.operation.operationId !== snapshot.operationId
          || result.operation.actionId !== snapshot.actionId || result.operation.scope.accountId !== snapshot.scope.accountId
          || result.operation.scope.machineId !== snapshot.scope.machineId || result.operation.revision < snapshot.revision) {
          throw new Error('administrator_attendance_notification_read_mismatch');
        }
        const current = result.operation;
        currentSnapshots.push(current);
        const task = current.domainRef?.kind === 'machineSetup' ? current.domainRef.setupTask : undefined;
        // The optional descriptor lands with its producer, not in legacy push.
        if (task && MachineSudoPasswordPromptV1Schema.safeParse(Reflect.get(task, 'prompt')).success) prompt.resolve(current);
      });
      notificationReads.push(read);
      void read.catch(error => prompt.reject(error));
    } });
    h.client.setRPCHandlers({
      spawnSession: async () => { throw new Error('Administrator attendance must not start a Session'); },
      stopSession: async () => ({ status: 'not_found' }), requestShutdown: () => {},
    });
    // Deliver Home's authenticated remote-person packet to this ApiMachine's
    // actual receiver. Its installed terminal credential authenticates the
    // daemon's Home proof; it does not confer present_user on a local caller.
    const receiver = Reflect.get(h.client, 'rpcHandlerManager');
    if (!(receiver instanceof RpcHandlerManager)) throw new Error('ApiMachine must own its receiving RPC manager');
    let received = 0;
    const receive = (method: string, params: unknown, actorAccountId = 'owner', callerAuthority: RpcHandlerContext['callerAuthority'] = 'present_user') => receiver.handleRequest({
      method: `machine:${method}`, params, callerAuthority,
      requestId: method === RPC_METHODS.MACHINE_ADMIN_ACCESS_SET
        ? 'actual-admitted-transport-request' : `administrator-attendance-${++received}`, machineAdmission: {
        machineId: 'machine', installationId: installation.installationId,
        custodianAccountId: 'owner', actorAccountId, role: 'manage', encryptionMode: 'plain',
      },
    });
    invocation = receive(RPC_METHODS.MACHINE_ADMIN_ACCESS_SET, {
      serverId: profile.id, machineId: 'machine', expectedMetadataVersion: 1, expectedAdminAccess: ask,
      adminAccess: preauthorized, comparison: 'field',
    }).then(result => MachineAdminAccessMutationResultV1Schema.parse(result));
    const outcome = await Promise.race([
      prompt.promise.then(snapshot => ({ kind: 'prompt' as const, snapshot })),
      invocation.then(result => ({ kind: 'settled' as const, result })),
    ]);
    if (outcome.kind === 'settled') {
      // Only the winning early-result path asserts. An admission/CAS refusal
      // cannot masquerade as the intended missing-attendance RED.
      expect(outcome.result).toMatchObject({ status: 'applied', policy: preauthorized,
        effect: { outcome: 'needs_attendance' } });
      throw new Error('admin_access_returned_before_sudo_prompt');
    }
    const held = outcome.snapshot;
    expect(held).toMatchObject({ actionId: 'machines.setup.adminAccess.set', state: 'running',
      cancellation: 'supported',
      requestId: 'actual-admitted-transport-request', scope: { accountId: 'owner', machineId: 'machine' },
      domainRef: { kind: 'machineSetup', serverId: profile.id, machineId: 'machine', setupTask: {
        taskKind: 'machine.setup.apply.v1', prompt: { kind: 'sudo.password', adminUsername: 'ops.admin' },
      } } });
    const task = held.domainRef?.kind === 'machineSetup' ? held.domainRef.setupTask : undefined;
    if (!task) throw new Error('The admitted operation must identify its actual transient task');
    const pending = ActionOperationGetV1ResponseSchema.parse(await receive(
      ACTION_OPERATION_RPC_METHODS_V2.get, { operationId: held.operationId }));
    expect(pending).toMatchObject({ kind: 'found', operation: { operationId: held.operationId, state: 'running' } });
    if (pending.kind !== 'found') throw new Error('The actual operation owner must retain the unanswered prompt');
    expect(pending.operation).not.toHaveProperty('settledAt');
    expect(pending.operation).not.toHaveProperty('result');
    expect(h.client.getMachineMetadataSnapshot()).toMatchObject({ metadata: { adminAccess: preauthorized } });
    expect(h.launches).toEqual([]);
    expect(snapshots.some(snapshot => ['succeeded', 'failed', 'cancelled'].includes(snapshot.state))).toBe(false);
    const respond = (actorAccountId: string, callerAuthority: RpcHandlerContext['callerAuthority'] = 'present_user') => receive(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'tool.systemTasks', method: 'respond', params: { taskId: task.id,
        expectedPromptKind: 'sudo.password', answer: { password: 'one-use-password' } },
    }, actorAccountId, callerAuthority);
    expect(await respond('foreign-manager')).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    expect(h.passwords).toEqual([]);
    expect(await respond('owner', 'account_automation')).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    expect(h.passwords).toEqual([]);
    expect(h.launches).toEqual([]);
    if (completion === 'retire') {
      h.replaceInstallation();
      expect(await respond('owner')).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
      expect(h.launches).toEqual([]);
      expect(h.passwords).toEqual([]);
      return;
    }
    if (completion === 'cancel') {
      expect(await receive(ACTION_OPERATION_RPC_METHODS_V1.cancel, { operationId: held.operationId })).toMatchObject({ kind: 'requested' });
      expect(await invocation).toMatchObject({ status: 'applied', effect: { outcome: 'not_applied', reasonCode: 'cancelled' } });
      const cancelled = ActionOperationGetV1ResponseSchema.parse(await receive(ACTION_OPERATION_RPC_METHODS_V2.get,
        { operationId: held.operationId, waitForTerminal: true }));
      expect(cancelled).toMatchObject({ kind: 'found', operation: { operationId: held.operationId, state: 'cancelled' } });
      expect(h.launches).toEqual([]);
      expect(h.passwords).toEqual([]);
      return;
    }
    expect(await respond('owner')).toMatchObject({ ok: true });
    expect(await invocation).toMatchObject({ status: 'applied', policy: preauthorized, effect: { outcome: 'applied' } });
    const terminal = ActionOperationGetV1ResponseSchema.parse(await receive(
      ACTION_OPERATION_RPC_METHODS_V2.get, { operationId: held.operationId, waitForTerminal: true }));
    expect(terminal).toMatchObject({ kind: 'found', operation: { operationId: held.operationId, state: 'succeeded' } });
    expect(terminal).not.toHaveProperty('operation.domainRef.setupTask.prompt');
    const listed = ActionOperationListV1ResponseSchema.parse(await receive(ACTION_OPERATION_RPC_METHODS_V2.list, {}));
    expect(listed.items.filter(snapshot => snapshot.actionId === 'machines.setup.adminAccess.set').map(snapshot => snapshot.operationId)).toEqual([held.operationId]);
    expect(h.launches).toHaveLength(1);
    expect(h.passwords).toEqual(['one-use-password']);
    expect(h.nativeFailures).toEqual([]);
    await Promise.all(notificationReads);
    const probesBeforeNextAdmission = h.counts().probes;
    h.denyNextAdmission();
    expect(await receive(RPC_METHODS.MACHINE_ADMIN_ACCESS_INSPECT,
      { serverId: 'another-client-profile', machineId: 'machine' })).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(h.counts().probes).toBe(probesBeforeNextAdmission);
    expect(await readFile(MANAGED_SUDOERS_PATH, 'utf8')).toContain('NOPASSWD');
    expect(JSON.stringify({ snapshots, currentSnapshots, records: h.records, metadata: h.client.getMachineMetadataSnapshot() })).not.toContain('one-use-password');
  });
});

describe('target-daemon desired administrator policy', () => {
  it.each(['plain', 'e2ee'] as const)('accepts an admitted %s owner across client-local Home aliases without repeating admission', async mode => {
    const h = await createDesiredPolicyHarness(mode);
    try {
      expect(await h.set({ serverId: 'client-local-home-alias' })).toMatchObject({
        status: 'applied', policy: preauthorized, metadataVersion: 2,
      });
      expect(h.counts()).toMatchObject({ writes: 1, admissionChecks: 0 });
      const inspected = await h.client.invokeLocalMachineAction(RPC_METHODS.MACHINE_ADMIN_ACCESS_INSPECT,
        { serverId: 'another-client-alias', machineId: 'machine' },
        { signal: h.context().signal, rpcContext: h.context() });
      expect(MachineAdminAccessInspectResultV1Schema.parse(inspected)).toHaveProperty('observation');
      expect(h.counts().admissionChecks).toBe(0);
    } finally { await h.close(); }
  });

  it('shares the captured setup policy and fresh native observer, and retires both with the original transport', async () => {
    const h = await createDesiredPolicyHarness('plain', { nativeDependencies: {
      execFile: async (file, args) => {
        if (file === 'id') return { stdout: args[0] === '-u' ? '1001\n' : 'happier\n' };
        throw Object.assign(new Error('No unattended administrator access'), { code: 1 });
      },
    } });
    try {
      const captured = h.client.captureMachineAdminAccess();
      expect(await captured.readPolicy()).toEqual(none);
      expect(await captured.observe()).toMatchObject({ daemonUsername: 'happier', passwordlessSudoToRoot: 'denied' });
      expect(h.client.getMachineAdminAccessRights()).toMatchObject({ freshness: 'current' });
      await h.refresh({ ...h.machine, encryptionMode: 'e2ee', encryptionKey: new Uint8Array(32).fill(8),
        encryptionVariant: 'dataKey', dataEncryptionKey: 'replacement-envelope' });
      await expect(captured.readPolicy()).rejects.toMatchObject({ code: 'admin_access_unavailable' });
      await expect(captured.observe()).rejects.toMatchObject({ code: 'admin_access_unavailable' });
    } finally { await h.close(); }
  });

  it.each(['plain', 'e2ee'] as const)('persists desired intent through the %s incumbent codec with every app offline, without probing the host', async mode => {
    const h = await createDesiredPolicyHarness(mode);
    try {
      const ask = { version: 1, mode: 'ask', administratorUsername: 'alice.admin' } as const;
      expect(await h.set({ adminAccess: ask })).toEqual({ status: 'applied', policy: ask, metadataVersion: 2 });
      expect(h.client.getMachineMetadataSnapshot()).toMatchObject({ metadata: { ...metadata, adminAccess: ask } });
      expect(await h.set({ expectedMetadataVersion: 2, expectedAdminAccess: ask, adminAccess: ask }))
        .toEqual({ status: 'unchanged', policy: ask, metadataVersion: 2 });
      expect(await h.set({ adminAccess: ask })).toEqual({ status: 'satisfied', policy: ask, metadataVersion: 2 });
      expect(h.counts()).toMatchObject({ writes: 1, probes: 0 });
    } finally { await h.close(); }
  });

  it.each(['field', 'revision'] as const)('preserves unrelated contention with %s comparison', async comparison => {
    const h = await createDesiredPolicyHarness('plain');
    try {
      h.onWrite(async (request, candidate) => h.counts().writes === 1
        ? { result: 'version-mismatch', version: 2, metadata: h.codec.encodeStored({ ...metadata, adminAccess: none, displayName: 'Concurrent name' }) }
        : { result: 'success', version: request.expectedVersion + 1, metadata: h.codec.encodeStored(candidate) });
      expect(await h.set({ comparison })).toEqual(comparison === 'field'
        ? { status: 'applied', policy: preauthorized, metadataVersion: 3 }
        : { status: 'conflict', policy: none, metadataVersion: 2 });
      expect(h.client.getMachineMetadataSnapshot()).toMatchObject({ metadata: { displayName: 'Concurrent name',
        adminAccess: comparison === 'field' ? preauthorized : none } });
      expect(h.counts()).toMatchObject({ writes: comparison === 'field' ? 2 : 1, probes: 0 });
    } finally { await h.close(); }
  });

  it('returns competing desired intent without overwriting or applying a host effect', async () => {
    const h = await createDesiredPolicyHarness('plain');
    const ask = { version: 1, mode: 'ask', administratorUsername: 'admin' } as const;
    try {
      h.onWrite(async () => ({ result: 'version-mismatch', version: 2, metadata: h.codec.encodeStored({ ...metadata, adminAccess: ask }) }));
      expect(await h.set()).toEqual({ status: 'conflict', policy: ask, metadataVersion: 2 });
      expect(h.counts()).toMatchObject({ writes: 1, probes: 0 });
    } finally { await h.close(); }
  });

  it.each([true, false])('observes a lost ACK once without replay (commit visible: %s)', async committed => {
    const h = await createDesiredPolicyHarness('e2ee');
    try {
      h.onWrite(async (_request, candidate) => {
        if (committed) await h.refresh({ ...h.machine, metadata: candidate, metadataVersion: 2 });
        throw new Error('Network ACK lost');
      });
      expect(await h.set()).toEqual(committed ? { status: 'satisfied', policy: preauthorized, metadataVersion: 2 } : { status: 'outcomeUnknown' });
      expect(h.counts()).toMatchObject({ writes: 1, probes: 0, loads: committed ? 1 : 0 });
    } finally { await h.close(); }
  });

  it.each(['installation', 'transport', 'cancelled'] as const)('refuses a retired %s basis before desired CAS', async change => {
    const h = await createDesiredPolicyHarness('e2ee');
    const current = h.context();
    const cancellation = new AbortController();
    try {
      if (change === 'installation') h.replaceInstallation();
      if (change === 'transport') Reflect.apply(Reflect.get(h.client, 'teardownActiveSocket'), h.client, []);
      if (change === 'cancelled') cancellation.abort();
      const pending = h.set({}, change === 'cancelled' ? { ...current, signal: cancellation.signal } : current);
      if (change === 'transport') await expect(pending).resolves.toEqual({ status: 'unavailable' });
      else if (change === 'cancelled') await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      else await expect(pending).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
      expect(h.counts()).toMatchObject({ writes: 0, probes: 0 });
    } finally { await h.close(); }
  });

  it('finishes an admitted field-semantic rebase without rechecking authority and refuses a stale next request', async () => {
    const h = await createDesiredPolicyHarness('plain');
    const admitted = h.context();
    try {
      h.onWrite(async request => {
        if (h.counts().writes === 1) {
          h.replaceInstallation();
          return { result: 'version-mismatch', version: 2,
            metadata: h.codec.encodeStored({ ...metadata, adminAccess: none, displayName: 'Other' }) };
        }
        return { result: 'success', version: request.expectedVersion + 1, metadata: request.metadata };
      });
      expect(await h.set({}, admitted)).toEqual({ status: 'applied', policy: preauthorized, metadataVersion: 3 });
      await expect(h.set({}, admitted)).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
      expect(h.counts()).toMatchObject({ writes: 2, probes: 0, admissionChecks: 0 });
    } finally { await h.close(); }
  });

  it.each(['cancelled', 'installation'] as const)('keeps acknowledged desired persistence after post-issue %s retirement', async change => {
    const h = await createDesiredPolicyHarness('plain');
    const cancellation = new AbortController();
    try {
      h.onWrite(async request => {
        if (change === 'cancelled') cancellation.abort(); else h.replaceInstallation();
        return { result: 'success', version: request.expectedVersion + 1, metadata: request.metadata };
      });
      expect(await h.set({}, { ...h.context(), signal: cancellation.signal }))
        .toEqual({ status: 'applied', policy: preauthorized, metadataVersion: 2 });
      expect(h.client.getMachineMetadataSnapshot()).toMatchObject({ metadata: { adminAccess: preauthorized } });
      expect(h.counts()).toMatchObject({ writes: 1, probes: 0, admissionChecks: 0 });
    } finally { await h.close(); }
  });

  it('does not accept a pending old-key ACK after the real incumbent codec is retired', async () => {
    const h = await createDesiredPolicyHarness('e2ee');
    try {
      h.onWrite(async request => {
        await h.refresh({ ...h.machine, encryptionMode: 'e2ee', encryptionKey: new Uint8Array(32).fill(8),
          encryptionVariant: 'dataKey', dataEncryptionKey: 'replacement-envelope' });
        return { result: 'success', version: 2, metadata: request.metadata };
      });
      expect(await h.set()).toEqual({ status: 'locked' });
      expect(h.client.getMachineMetadataSnapshot()).toMatchObject({ metadata: { adminAccess: none }, metadataVersion: 1 });
      expect(h.counts()).toMatchObject({ writes: 1, probes: 0 });
    } finally { await h.close(); }
  });

  it.each(['Machine', 'Home'] as const)('never writes a different receiving %s after its logical target is rebound within the same installation', async change => {
    const h = await createDesiredPolicyHarness('plain');
    try {
      if (change === 'Machine') h.rebindMachine(); else h.rebindHome();
      // The request and real admission verifier now name the new Machine,
      // while the original ApiMachine/socket still own the old metadata row.
      await expect(h.set()).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
      expect(h.counts()).toMatchObject({ writes: 0, probes: 0 });
      expect(h.client.getMachineMetadataSnapshot()).toMatchObject({ metadata: { adminAccess: none }, metadataVersion: 1 });
    } finally { await h.close(); }
  });
});

describe('daemon administrator inspection composition', () => {
  it('reaches the native observer through retained routes after transport replacement and publishes only changed facts', async () => {
    let rootAllowed = true;
    let processGroups = 'happier';
    let accountGroups = 'happier';
    let operatorPrefs: Record<string, unknown> = { OperatorUser: 'happier' };
    let operatorUnreadable = false;
    const operatorCommands: string[][] = [];
    let nativeReads = 0;
    let publications = 0;
    let quiescing = false;
    let active: ApiMachineClient | null = null;
    const clients: ApiMachineClient[] = [];
    const signing = tweetnacl.sign.keyPair();
    // Home HTTP is the boundary; the admission schema and signer run unchanged.
    const home = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { v: 1, ok: true },
      statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } });
    let target = { serverId: configuration.activeServerId, machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' };
    const createRoutes = () => createDaemonMachineAdminAccessRoutes({ getMachineClient: () => active, target: () => target,
      nativeDependencies: { platform: 'linux',
        tailscale: { tailscaleBin: '/bin/tailscale', socketPath: '/run/happier/tailscaled.sock' },
        // Process execution and the protected file are the system boundaries.
        execFile: async (file, args) => {
          nativeReads += 1;
          if (file === '/bin/tailscale') {
            operatorCommands.push([...args]);
            if (operatorUnreadable) throw Object.assign(new Error('Native prefs unreadable'), { code: 'EACCES' });
            return { stdout: JSON.stringify(operatorPrefs) };
          }
          if (file === 'id') return { stdout: args[0] === '-u' ? '1001\n' : args[0] === '-un' ? 'happier\n'
            : args[0] === '-Gn' ? args.length === 1 ? processGroups : accountGroups : 'happier\n' };
          if (file !== 'sudo') throw new Error('Unexpected native process');
          if (!rootAllowed) throw Object.assign(new Error('Denied'), { code: 1 });
          return { stdout: '' };
        },
        fileSystem: { lstat: async () => { throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); },
          readFile: async () => { throw new Error('Missing file must not be read'); } },
      },
    });
    const cache = createDaemonMachineRpcRouteAttachmentCache({ getApiMachineForSessions: () => active });
    const routes = createRoutes();
    // Exercise the production attachment and ApiMachine registration, not an injected dispatcher.
    cache.attachMachineAdminAccessRoutes(routes);
    const attach = (daemonState: Machine['daemonState'] = { status: 'running', runtimeId: 'current-runtime' }) => {
      const machine = { id: target.machineId, encryptionMode: 'plain' as const,
        metadata: null, metadataVersion: 0, daemonState, daemonStateVersion: 0 };
      const codec = createMachineContentCodec(machine);
      active = new ApiMachineClient('inspection-token', machine, { runtimeId: 'current-runtime' }, {
        isDaemonQuiescing: () => quiescing,
      });
      clients.push(active);
      Reflect.set(active, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: (event, raw) => {
        if (event !== 'machine-update-state') throw new Error('Unexpected publication');
        publications += 1;
        const input = raw as { daemonState: string; expectedVersion: number };
        const published = MachinePublishedDaemonStateV1Schema.parse(codec.decodeStored(input.daemonState));
        expect(published.adminAccess?.tailscaledOperator).toBeDefined();
        return { result: 'success', daemonState: input.daemonState, version: input.expectedVersion + 1 };
      } }));
      cache.attachApiMachineForSessions(active);
      return active;
    };
    const context = (method: string = RPC_METHODS.MACHINE_ADMIN_ACCESS_INSPECT): RpcHandlerContext => {
      const signal = new AbortController().signal;
      const machineAdmission = { machineId: target.machineId, installationId: target.installationId,
        custodianAccountId: target.custodianAccountId, actorAccountId: 'owner', role: 'manage' as const, encryptionMode: 'plain' as const };
      return { signal, machineAdmission, verifyMachineAdmissionCurrent: () => verifyMachineRpcAdmissionCurrent({
        context: machineAdmission, method: `${machineAdmission.machineId}:${method}`, privateKey: signing.secretKey,
        daemonToken: 'inspection-token', serverHttpBaseUrl: 'https://home.invalid', signal,
      }) };
    };
    const inspect = async (client: ApiMachineClient, input = { serverId: target.serverId, machineId: 'machine' }, current = context()) =>
      MachineAdminAccessInspectResultV1Schema.parse(await client.invokeLocalMachineAction(
        RPC_METHODS.MACHINE_ADMIN_ACCESS_INSPECT, input, { signal: current.signal, rpcContext: current }));
    try {
      const first = attach();
      expect(nativeReads).toBe(0);
      const readRights = (client = active!) => client.getMachineAdminAccessRights();
      const presentRights = (client = active!) => presentMachineAuthorityV1(readRights(client));
      expect(readRights()).toEqual({ observation: null, freshness: 'stale' });
      const initial = await inspect(first);
      expect(initial).toMatchObject({ observation: { daemonUid: 1001, passwordlessSudoToRoot: 'allowed' } });
      expect(publications).toBe(1);
      if (!('observation' in initial)) throw new Error('Inspection unavailable');
      expect(readRights()).toEqual({ observation: initial.observation, freshness: 'current' });
      expect(presentRights()).toMatchObject({ hostAuthority: 'administrator',
        tailscaledOperator: { currentAuthorization: 'allowed' } });
      expect(await inspect(first)).toMatchObject({ observation: initial.observation });
      expect(publications).toBe(1);
      const replacement = attach();
      expect(readRights()).toEqual({ observation: initial.observation, freshness: 'stale' });
      expect(presentRights()).toMatchObject({ hostAuthority: 'unknown', tailscaledOperator: {
        authorization: 'allowed', currentAuthorization: 'unknown', freshness: 'stale' } });
      rootAllowed = false;
      expect(await inspect(replacement)).toMatchObject({ observation: { passwordlessSudoToRoot: 'denied' } });
      expect(publications).toBe(2);
      expect(presentRights()).toMatchObject({ hostAuthority: 'ordinary',
        tailscaledOperator: { currentAuthorization: 'allowed' } });
      operatorPrefs = { OperatorUser: 'someone-else' };
      await inspect(replacement);
      expect(presentRights()).toMatchObject({ hostAuthority: 'ordinary',
        tailscaledOperator: { currentAuthorization: 'denied' } });
      expect(publications).toBe(3);
      operatorUnreadable = true;
      await inspect(replacement);
      expect(presentRights()).toMatchObject({ hostAuthority: 'ordinary',
        tailscaledOperator: { currentAuthorization: 'unknown' } });
      expect(publications).toBe(4);
      operatorUnreadable = false;
      operatorPrefs = { BackendState: 'Running', Self: { Online: true } };
      await inspect(replacement);
      expect(presentRights().tailscaledOperator.currentAuthorization).toBe('unknown');
      expect(publications).toBe(4);
      operatorPrefs = { OperatorUser: 'happier' };
      await inspect(replacement);
      expect(presentRights()).toMatchObject({ hostAuthority: 'ordinary',
        tailscaledOperator: { currentAuthorization: 'allowed' } });
      expect(publications).toBe(5);
      expect(operatorCommands.every(args => JSON.stringify(args) === JSON.stringify([
        '--socket=/run/happier/tailscaled.sock', 'debug', 'prefs',
      ]))).toBe(true);
      await first.shutdown();
      expect(readRights(first)).toMatchObject({ freshness: 'stale' });
      expect(readRights(replacement)).toMatchObject({ freshness: 'current' });
      rootAllowed = true;
      quiescing = true;
      await expect(inspect(replacement)).resolves.toEqual({ status: 'unavailable' });
      expect(readRights(replacement)).toMatchObject({ observation: { passwordlessSudoToRoot: 'denied' }, freshness: 'stale' });
      expect(presentRights()).toMatchObject({ hostAuthority: 'unknown', tailscaledOperator: {
        authorization: 'allowed', currentAuthorization: 'unknown' } });
      quiescing = false;
      expect(await inspect(replacement)).toMatchObject({ observation: { passwordlessSudoToRoot: 'allowed' } });
      expect(publications).toBe(6);
      expect(presentRights()).toMatchObject({ hostAuthority: 'administrator',
        tailscaledOperator: { currentAuthorization: 'allowed' } });
      // This fixture has no opened Machine metadata: unavailable is a CAS input
      // fact, not a dependency on host reconciliation (proved independently above).
      await expect(replacement.invokeLocalMachineAction(RPC_METHODS.MACHINE_ADMIN_ACCESS_SET, {
        serverId: target.serverId, machineId: 'machine', expectedMetadataVersion: 0,
        expectedAdminAccess: { version: 1, mode: 'none' }, adminAccess: { version: 1, mode: 'preauthorized' }, comparison: 'field',
      }, { rpcContext: context(RPC_METHODS.MACHINE_ADMIN_ACCESS_SET) })).resolves.toEqual({ status: 'unavailable' });
      expect(publications).toBe(6);
      await expect(inspect(replacement, { serverId: `${target.serverId}-other`, machineId: 'machine' })).resolves.toHaveProperty('observation');
      const readsBeforeRefusal = nativeReads;
      const admitted = context();
      target = { ...target, installationId: 'replacement-installation' };
      await expect(inspect(replacement, { serverId: target.serverId, machineId: 'machine' }, admitted)).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
      expect(nativeReads).toBe(readsBeforeRefusal);
      cache.attachMachineAdminAccessRoutes(createRoutes());
      const restarted = attach({ status: 'running', runtimeId: 'current-runtime', adminAccess: initial.observation });
      expect(readRights(restarted)).toEqual({ observation: initial.observation, freshness: 'stale' });
      expect(nativeReads).toBe(readsBeforeRefusal);
      // AM-8: native evidence survives admitted inspect, codec/publication and the real shared presenter.
      rootAllowed = false;
      accountGroups = 'happier docker';
      await inspect(restarted);
      expect(presentRights(restarted)).toMatchObject({ hostAuthority: 'administrator', rootEquivalentGroups: ['docker'],
        groupMembership: { state: 'pendingRestart', addedGroups: ['docker'], removedGroups: [] } });
      processGroups = 'docker happier';
      await inspect(restarted);
      expect(presentRights(restarted)).toMatchObject({ hostAuthority: 'administrator', groupMembership: { state: 'current' } });
      const equalPublications = publications;
      accountGroups = 'docker happier docker';
      await inspect(restarted);
      expect(publications).toBe(equalPublications);
      accountGroups = 'happier';
      await inspect(restarted);
      expect(presentRights(restarted)).toMatchObject({ hostAuthority: 'administrator', rootEquivalentGroups: ['docker'],
        groupMembership: { state: 'pendingRestart', addedGroups: [], removedGroups: ['docker'] } });
      processGroups = 'happier';
      await inspect(restarted);
      expect(presentRights(restarted)).toMatchObject({ hostAuthority: 'ordinary', rootEquivalentGroups: [],
        groupMembership: { state: 'current' } });
    } finally {
      await Promise.all(clients.map(client => client.shutdown()));
      home.mockRestore();
    }
  });
});
