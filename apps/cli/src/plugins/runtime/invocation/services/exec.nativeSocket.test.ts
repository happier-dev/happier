import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createStablePluginExecService, issueAgentNativeLaunchQualifierForHost,
  authorizePluginExecLaunchForHost } from './exec';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { Readable } from 'node:stream';

const boundary = vi.hoisted(() => ({ grants: [] as string[], uid: 994, aclUnavailable: false }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(),
  execFile(command: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) {
    if (boundary.aclUnavailable) { done(new Error('Native ACL utility unavailable'), ''); return; }
    if (command === 'setfacl') { if (args[0] === '-m') boundary.grants.push(args.at(-1)!); done(null, ''); }
    else done(null, `user::rwx\nuser:${boundary.uid}:rwx\ngroup::---\nmask::rwx\nother::---\n`);
  },
}));
afterEach(() => { boundary.grants.length = 0; boundary.aclUnavailable = false; });
function create(root: string) {
  return createStablePluginExecService({ signal: new AbortController().signal, isOccurrenceCurrent: () => true,
    resolveExecutable: async () => ({ command: '/opt/managed/codex' }), resolvePath: async () => root,
    prepareAgentNativeLaunch: async () => undefined,
    agentIsolation: { read: () => ({ enabled: true,
      status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [root],
      localTransport: { agentUid: boundary.uid }, launch: { managedHappierBinaryPath: '/opt/happier/current/happier',
        runtimeHome: join(root, 'runtime'), selectedEnvironmentKeys: [], selectedMaterials: [],
        sessionMcpContext: { v: 1, socketPath: '/tmp/mcp.sock', bearerToken: 'selected-bearer' } } }) },
  });
}

it.skipIf(process.platform !== 'linux').each([994, 996])('binds only the held UID %s directory to server preparation; original proxy launch has no repeated grant', async uid => {
  boundary.uid = uid;
  const root = await mkdtemp('/tmp/h-exec-');
  const service = create(root);
  const material = { runtimeHome: join(root, 'runtime'), environment: {}, selectedMaterials: [],
    nativeIdentity: { agentUid: uid, agentGid: uid, home: root } };
  const original = issueAgentNativeLaunchQualifierForHost(service, undefined, () => material);
  const directory = await service.prepareNativeSocketDirectory({ nativeLaunch: original });
  try {
    expect(directory.nativeProxy).toBe(true);
    expect(directory.nativeLaunch).not.toBe(original);
    const request = { executable: { kind: 'systemTool', id: 'codex-cli' } as const, args: ['app-server'], cwd: { root: 'workspace', relativePath: '' } as const };
    const launch = await authorizePluginExecLaunchForHost(service, request, { nativeLaunch: directory.nativeLaunch });
    const frame = await readAgentLaunchFrame(Readable.from([launch.stdinPreamble!], { objectMode: false }));
    expect(launch.command).toBe('sudo');
    expect(frame.nativeSocketDirectory).toEqual({ path: join(directory.path, 'private'), daemonUid: process.getuid!() });
    await launch.release();
    const proxy = await authorizePluginExecLaunchForHost(service, request, { nativeLaunch: original });
    const proxyFrame = await readAgentLaunchFrame(Readable.from([proxy.stdinPreamble!], { objectMode: false }));
    expect(proxyFrame.nativeSocketDirectory).toBeUndefined();
    await proxy.release();
    expect(boundary.grants).toEqual([directory.path]);
  } finally { await directory.dispose(); await rm(root, { recursive: true, force: true }); }
  await expect(stat(directory.path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform !== 'linux')('refuses copied or foreign qualifiers before any directory grant', async () => {
  const root = await mkdtemp('/tmp/h-exec-'); const service = create(root);
  const foreign = issueAgentNativeLaunchQualifierForHost(create(root));
  const original = issueAgentNativeLaunchQualifierForHost(service);
  try {
    for (const nativeLaunch of [foreign, { ...original }]) {
      await expect(service.prepareNativeSocketDirectory({ nativeLaunch })).rejects.toMatchObject({ code: 'plugin_exec_native_launch_qualifier_invalid' });
    }
    expect(boundary.grants).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('preserves direct transport for the executing UID without ACL commands', async () => {
  const service = createStablePluginExecService({ signal: new AbortController().signal, isOccurrenceCurrent: () => true,
    resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => process.cwd() });
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = '/tmp/' + 'private-owner-temp-'.repeat(12);
  let directory: Awaited<ReturnType<typeof service.prepareNativeSocketDirectory>> | undefined;
  try {
    directory = await service.prepareNativeSocketDirectory();
    expect(directory.path.startsWith('/tmp/happier-codex-')).toBe(true);
    expect(directory.nativeProxy).toBe(false); expect(boundary.grants).toEqual([]);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir;
    await directory?.dispose();
  }
});

it.skipIf(process.platform !== 'linux')('refuses withdrawn held native material before any directory grant instead of selecting the daemon UID', async () => {
  const root = await mkdtemp('/tmp/h-exec-'); const service = create(root);
  let material: ReturnType<NonNullable<Parameters<typeof issueAgentNativeLaunchQualifierForHost>[2]>> = {
    runtimeHome: root, environment: {}, selectedMaterials: [], nativeIdentity: { agentUid: 994, agentGid: 994, home: root } };
  const nativeLaunch = issueAgentNativeLaunchQualifierForHost(service, undefined, () => material);
  material = undefined;
  try {
    await expect(service.prepareNativeSocketDirectory({ nativeLaunch })).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    expect(boundary.grants).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('preserves an ordinary Session qualifier whose explicitly supplied material getter starts empty', async () => {
  const service = createStablePluginExecService({ signal: new AbortController().signal, isOccurrenceCurrent: () => true,
    resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => process.cwd() });
  const nativeLaunch = issueAgentNativeLaunchQualifierForHost(service, undefined, () => undefined);
  const directory = await service.prepareNativeSocketDirectory({ nativeLaunch });
  try { expect(directory.nativeProxy).toBe(false); expect(directory.nativeLaunch).toBe(nativeLaunch); expect(boundary.grants).toEqual([]); }
  finally { await directory.dispose(); }
});

it.skipIf(process.platform !== 'linux')('settles unavailable native ACL support as the canonical isolation refusal without a daemon fallback', async () => {
  const root = await mkdtemp('/tmp/h-exec-'); const service = create(root);
  const nativeLaunch = issueAgentNativeLaunchQualifierForHost(service, undefined, () => ({
    runtimeHome: root, environment: {}, selectedMaterials: [], nativeIdentity: { agentUid: 994, agentGid: 994, home: root } }));
  boundary.aclUnavailable = true;
  try {
    await expect(service.prepareNativeSocketDirectory({ nativeLaunch })).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    expect(boundary.grants).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
