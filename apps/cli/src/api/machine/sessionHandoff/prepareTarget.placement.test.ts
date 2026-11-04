import { resolveSessionHandoffPrepareTargetJobLeaseTtlMs } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobLease';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createProjectSessionRuntimeFixture } from '@/daemon/testkit/projectSessionRuntimeFixture';
import { createSessionAgentIsolationMemberPreparation } from '@/daemon/agentIsolation/sessionPreparation';
import { prepareDaemonAgentIsolationIdentity } from '@/daemon/spawn/prepareDaemonAgentIsolationIdentity';
import { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';
import { createSessionHandoffPrepareTargetJobStore } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createSessionHandoffPrepareTargetActionHandler } from './prepareTarget';
import { seedManagedSessionDirectory } from '@/session/creation/seedManagedSessionDirectory';
import { createWorkspaceSyncSeedExport } from '@/workspaces/sync/workspaceSyncSeedTransfer';

const acl = vi.hoisted(() => new Map<number, Map<string, string>>());
// Native passwd and ACL utilities are OS boundaries; admission and jobs stay real.
vi.mock('@happier-dev/cli-common/process', async original => {
  const actual = await original<typeof import('@happier-dev/cli-common/process')>();
  return { ...actual, execFileWithDeadline: async (...args: Parameters<typeof actual.execFileWithDeadline>) => args[0] === 'getent'
    ? { stdout: 'happier-agent:x:2403:2403::/var/lib/happier-agent:/usr/sbin/nologin\n', stderr: '' }
    : actual.execFileWithDeadline(...args) };
});
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(),
  execFile(command: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) {
    const path = args.at(-1)!;
    const metadata = statSync(path);
    const mode = metadata.mode;
    const access = (bits: number) => `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
    const entries = acl.get(metadata.ino) ?? new Map([['user:', access((mode >> 6) & 7)], ['group:', access((mode >> 3) & 7)], ['other:', access(mode & 7)]]);
    acl.set(metadata.ino, entries);
    if (command !== 'setfacl') return done(new Error('Unexpected native ACL command'), '');
    if (args.includes('-k')) for (const key of entries.keys()) if (key.startsWith('default:')) entries.delete(key);
    const replacement = args.indexOf('--set');
    if (replacement >= 0) for (const key of entries.keys()) if (!key.startsWith('default:')) entries.delete(key);
    if (replacement >= 0) for (const entry of args[replacement + 1]!.split(',')) {
      const parts = entry.split(':'); const value = parts.pop()!;
      const key = parts.join(':').replace(/^d:/, 'default:').replace(/^u:/, 'user:');
      entries.set(key, value);
    }
    done(null, '');
  },
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); acl.clear(); });

it.skipIf(process.platform !== 'linux')('holds admitted placement before ingress bootstrap disposal while the target job continues', async () => {
  const session = await createProjectSessionRuntimeFixture({ homeServerIdentityId: 'srv_handoff_placement' });
  const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
  const workspace = await mkdtemp(join(tmpdir(), 'handoff-accepted-root-'));
  let releaseNative!: () => void;
  const nativePending = new Promise<void>(resolve => { releaseNative = resolve; });
  const activePrepareJobs = new Map<string, Promise<void>>();
  try {
    await writeFile(join(workspace, 'notes.txt'), 'source workspace');
    const transferId = 'session-handoff:held:workspace-seed';
    const seed = await createWorkspaceSyncSeedExport({ operationId: transferId, activeServerDir: session.directory, sourcePath: workspace,
      workspaceTransfer: { includeIgnoredMode: 'include_selected', ignoredIncludeGlobs: [], includeAllIgnored: true } });
    const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir: session.directory });
    const agentBundle = await sourceExportStore.writeAgentBundleFile({ handoffId: 'held',
      agentBundle: { agentId: 'claude', remoteSessionId: 'native', transcriptBase64: 'e30K' } });
    await sourceExportStore.save({ handoffId: 'held', exportedAtMs: 1, agentBundle });
    const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir: session.directory });
    let admitted = false;
    let importedPath = '';
    const handler = createSessionHandoffPrepareTargetActionHandler({ prepareJobStore, sourceExportStore, activePrepareJobs,
      prepareTargetJobLeaseOwnerId: 'placement-test', prepareTargetJobLeaseTtlMs: resolveSessionHandoffPrepareTargetJobLeaseTtlMs(),
      getTransferRouteCache: () => { throw new Error('Placement fixture does not use workspace route caching'); },
      invalidateDirectPeerRouteCacheForHandoffMachines: () => undefined, runtimeConfig: { activeServerDir: session.directory },
      machineTransferChannel: undefined, directPeerTransfer: { publishTransfer: () => [], clearPublishedTransfer: () => undefined,
        requestPayloadFile: async request => {
          const payload = request.transferId === transferId ? seed.payloadSource
            : await seed.onDemandScope.resolvePayloadSourceOnOpen({ transferId: request.transferId, requestBody: undefined });
          if (payload.kind === 'buffer') await writeFile(request.destinationPath, payload.payload);
          else if (payload.kind === 'file') await copyFile(payload.filePath, request.destinationPath);
          else throw new Error('Unexpected native transfer');
          return { destinationPath: request.destinationPath };
        } },
      prepareManagedDirectoryPlacement: async (request, context) => {
        const prepared = await prepareDaemonAgentIsolationIdentity({ hasAgentRuntime: true,
          prepareAgentIsolationMember: createSessionAgentIsolationMemberPreparation({ machineId: session.bootstrap.attribution.machineId,
            custodianAccountId: session.bootstrap.attribution.accountId,
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_handoff_placement', machineId: session.bootstrap.attribution.machineId }),
          })(context?.requesterSessionBootstrap ? { bootstrap: context.requesterSessionBootstrap } : null, context!.signal),
          readAgentIsolationEnabled: () => true,
          managedDirectory: { directory: request.targetPath, workspaceRoots: [workspace] }, signal: context?.signal,
        });
        if (!prepared.ok) throw new Error('Canonical placement refused');
        admitted = true;
        return prepared.payloadPlacement;
      },
      // The native provider import is the external boundary; keep it pending
      // across ingress disposal, then exercise ordinary typed failure cleanup.
      importSessionBundle: async (_bundle, targetPath) => {
        importedPath = targetPath;
        expect(await readFile(join(targetPath, 'notes.txt'), 'utf8')).toBe('source workspace');
        expect(acl.get(statSync(join(targetPath, 'notes.txt')).ino)?.get('user:2403')).toBe('rw-');
        await nativePending;
        throw Object.assign(new Error('Native import version unsupported'), { code: 'agent_version_unsupported' });
      },
    });
    await handler.handle({ handoffId: 'held', operationId: 'held-operation', sessionId: 'target-session', targetDirectory: { kind: 'managed' },
      sourceMachineId: 'source', targetMachineId: 'target', sourceSessionStorageMode: 'persisted',
      negotiatedTransportStrategy: 'direct_peer', targetPath: '/daemon/private/placeholder', handoffMetadataV2: {
        workspaceSeedTransferPublication: { transferId, sizeBytes: seed.payloadSource.sizeBytes!, manifestHash: seed.payloadSource.manifestHash!, endpointCandidates: [] },
      } },
    { requesterSessionBootstrap: session.bootstrap, signal: new AbortController().signal });
    expect(admitted).toBe(true);
    await session.bootstrap.dispose();
    const jobs = [...activePrepareJobs.values()];
    releaseNative();
    await Promise.all(jobs);
    expect(importedPath.startsWith(`${workspace}/`), (await prepareJobStore.read('prepare_held'))?.lastErrorMessage).toBe(true);
    expect((await prepareJobStore.read('prepare_held'))?.lastErrorCode).toBe('agent_version_unsupported');
    expect(await createManagedSessionDirectories({ activeServerDir: session.directory }).listRecords()).toEqual([]);
  } finally {
    releaseNative(); await Promise.all(activePrepareJobs.values());
    await runtime.dispose(); await rm(workspace, { recursive: true, force: true });
  }
});

// Fork and handoff use the same real seed materializer; only OS ACL utilities are modeled.
it.skipIf(process.platform !== 'linux')('gives the retained fork member access to copied files and executable entries before launch', async () => {
  const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
  const directory = await mkdtemp(join(tmpdir(), 'fork-member-seed-access-'));
  try {
    const workspace = join(directory, 'accepted'); await mkdir(workspace);
    const owner = createManagedSessionDirectories({ activeServerDir: directory, payloadPlacement: { root: workspace, agentUid: 2403 } });
    const source = await owner.materializeForFreshSpawn({ sessionCreationTag: 'source' });
    await owner.bind({ allocationId: source.allocationId, sessionId: 'source' });
    await mkdir(join(source.directory, 'scripts'));
    await writeFile(join(source.directory, 'notes.txt'), 'retained seed', { mode: 0o600 });
    await writeFile(join(source.directory, 'scripts', 'run'), '#!/bin/sh\n', { mode: 0o700 });
    const target = await owner.materializeForFreshSpawn({ sessionCreationTag: 'fork' });
    expect(await seedManagedSessionDirectory({ activeServerDir: directory, sessionCreationTag: 'fork', targetPath: target.directory,
      seed: { sourceSessionId: 'source', sourceSessionCreationTag: 'source', sourcePath: source.directory } })).toEqual({ ok: true });
    expect(await readFile(join(target.directory, 'notes.txt'), 'utf8')).toBe('retained seed');
    expect(acl.get(statSync(join(target.directory, 'notes.txt')).ino)?.get('user:2403')).toBe('rw-');
    expect(acl.get(statSync(join(target.directory, 'scripts', 'run')).ino)?.get('user:2403')).toBe('rwx');
    expect(acl.get(statSync(join(target.directory, 'scripts')).ino)?.get('default:user:2403')).toBe('rwx');
    expect(acl.has(statSync(join(directory, 'session-directories', '.owners')).ino)).toBe(false);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
});
