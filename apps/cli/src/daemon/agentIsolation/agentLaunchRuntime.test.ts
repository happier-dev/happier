import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectAgentIsolationOperationMaterial } from './agentLaunchMaterials';
import { executeAgentLaunchPayload } from './agentLaunchShim';
import type { AgentLaunchPayload } from './agentLaunchFrame';
import { readAgentLaunchFrame } from './agentLaunchFrame';
import { prepareRequesterNativeOperation } from './prepareNativeOperation';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import * as filesystem from 'node:fs/promises';
import { deriveAgentIsolationMemberIdentity } from './provisioning';
import { createAgentIsolationEffectsBoundary, runAgentIsolationMemberReadinessBoundary } from './agentIsolationEffects.testkit';
import { ensureAgentIsolationMember } from './agentIsolationProvisioner';
import { writeAgentIsolationMemberBinding } from './memberBindings';

const boundary = vi.hoisted(() => ({ home: '', member: undefined as undefined | { path: string; uid: number },
  memberFrames: [] as Array<{ username: string; agentUid: number; home: string }> }));
// Replace only getent/sudo OS dispatch. Preparation, framing, cleanup and children stay real.
vi.mock('@happier-dev/cli-common/process', async importOriginal => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/process')>();
  return { ...actual, execFileWithDeadline: async (...args: Parameters<typeof actual.execFileWithDeadline>) => {
    if (args[0] === 'getent' && args[1]?.at(-1) === 'happier-agent') return {
      stdout: `happier-agent:x:99998:99998::${boundary.home}:/usr/sbin/nologin\n`, stderr: '',
    };
    if (args[0] === 'sudo') {
      expect(args[1]?.at(-1)).toBe('agent-launch');
      expect(args[2]?.env).toEqual({});
      const frame = await readAgentLaunchFrame(Readable.from([args[2]!.inputBytes!], { objectMode: false }), undefined, true);
      if (!('action' in frame)) {
        const readiness = await runAgentIsolationMemberReadinessBoundary({ request: args, nativeHome: boundary.member });
        if (!readiness) throw new Error('Unexpected native operation OS command');
        return readiness;
      }
      expect('action' in frame && frame.action).toBe('retire_operation');
      expect(args[1]?.slice(0, 4)).toEqual(['-n', '-u', frame.nativeIdentity?.username ?? 'happier-agent', '--']);
      if (frame.nativeIdentity) boundary.memberFrames.push(frame.nativeIdentity);
      // OS RunAs maps the canonical native home/UID to this test's real temp home.
      const runtimeHome = frame.nativeIdentity ? frame.runtimeHome.replace(frame.nativeIdentity.home, boundary.home) : frame.runtimeHome;
      await executeAgentLaunchPayload({ ...frame, runtimeHome }, io(boundary.home));
      return { stdout: '', stderr: '' };
    }
    return actual.execFileWithDeadline(...args);
  } };
});

async function operation(agentHome: string, key: string) {
  boundary.home = agentHome;
  const identity = { kind: 'isolated' as const, separationRequired: true,
    requester: { serverId: 'home', accountId: 'guest', machineId: 'machine', installationId: 'installation' } };
  return prepareRequesterNativeOperation({ requesterIdentity: identity, resolveRequesterIdentity: async () => identity,
    readMaterial: () => ({ materializationKey: key, environment: {}, selectedMaterials: [] }), signal: new AbortController().signal }, {
    machine: { managedHappierBinaryPath: '/fixture/happier', read: () => ({ enabled: true,
      status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [agentHome] }) },
    homeServerIdentityId: 'home', machineId: 'machine', installationId: 'installation', reloadController: createPluginReloadController(),
  });
}

const roots: string[] = [];
async function home() {
  const path = await mkdtemp(join(tmpdir(), 'happier-operation-runtime-'));
  roots.push(path);
  return path;
}
afterEach(async () => { vi.restoreAllMocks(); boundary.member = undefined; boundary.memberFrames.length = 0;
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function launch(home: string, key: string, script: string): AgentLaunchPayload {
  return { v: 1, executable: process.execPath, args: ['-e', script], cwd: home,
    ...projectAgentIsolationOperationMaterial({ home, agentUid: process.getuid!(), agentGid: process.getgid!() }, {
      materializationKey: key, environment: {}, selectedMaterials: [{ relativePath: 'files/secret', contentBase64: 'c2VjcmV0' }],
    }) };
}
const io = (agentHome: string) => ({ agentHome, input: Readable.from([]), stdout: new PassThrough(), stderr: new PassThrough() });
async function bytes(path: string): Promise<number> {
  const entry = await stat(path);
  if (entry.isFile()) return entry.size;
  return (await Promise.all((await readdir(path)).map(name => bytes(join(path, name))))).reduce((a, b) => a + b, 0);
}

describe.skipIf(process.platform !== 'linux')('finite native operation runtime', () => {
  it('keeps one native identity cache and zero completed runtime directories after the observed 66 launches', async () => {
    const agentHome = await home();
    // Sparse files model the incident's logical size without allocating 2.49 GiB in RED.
    const script = `const fs=require('node:fs'),p=require('node:path');const c=process.env.XDG_CACHE_HOME;fs.mkdirSync(p.join(c,'bun'),{recursive:true});const f=p.join(c,'bun','runtime');if(!fs.existsSync(f)){const fd=fs.openSync(f,'wx');fs.ftruncateSync(fd,38*1024*1024);fs.closeSync(fd)}process.stdout.write(c);`;
    const caches = new Set<string>();
    for (let index = 0; index < 66; index++) {
      const lease = await operation(agentHome, `operation-${index}`);
      const input = launch(agentHome, `operation-${index}`, script);
      const streams = io(agentHome);
      let output = '';
      streams.stdout.on('data', chunk => { output += String(chunk); });
      expect(await executeAgentLaunchPayload(input, streams)).toEqual({ code: 0, signal: null });
      caches.add(output);
      await lease.dispose();
    }
    expect(caches.size).toBe(1);
    expect(await readdir(join(agentHome, 'runtime/operations'))).toEqual([]);
    expect(await bytes(agentHome)).toBe(38 * 1024 * 1024);
  }, 60_000);

  it.skipIf(process.getuid?.() === 0)('launches and retires native operations through search-only identity ancestors without widening them', async () => {
    const parent = await home();
    const agentHome = join(parent, 'identity');
    await mkdir(agentHome, { mode: 0o700 });
    await chmod(parent, 0o111);
    try {
      const lease = await operation(agentHome, 'search-only');
      const streams = io(agentHome); let output = '';
      streams.stdout.on('data', chunk => { output += String(chunk); });
      expect(await executeAgentLaunchPayload(launch(agentHome, 'search-only', 'process.stdout.write("native-ready")'), streams))
        .toEqual({ code: 0, signal: null });
      expect(output).toBe('native-ready');
      await lease.dispose();
      expect(await readdir(join(agentHome, 'runtime/operations'))).toEqual([]);
      expect((await stat(join(agentHome, '.cache'))).mode & 0o777).toBe(0o700);
      expect((await stat(parent)).mode & 0o777).toBe(0o111);
    } finally { await chmod(parent, 0o700); }
  });

  it('separates two native identity caches while concurrent operations of one identity share theirs', async () => {
    const first = await home(); const second = await home();
    const script = `const fs=require('node:fs');fs.mkdirSync(process.env.XDG_CACHE_HOME,{recursive:true});process.stdout.write(process.env.XDG_CACHE_HOME);`;
    const leases = [];
    for (const [index, agentHome] of [first, first, second].entries()) leases.push(await operation(agentHome, `concurrent-${index}`));
    const paths = await Promise.all([first, first, second].map(async (agentHome, index) => {
      const streams = io(agentHome); let output = '';
      streams.stdout.on('data', chunk => { output += String(chunk); });
      await executeAgentLaunchPayload(launch(agentHome, `concurrent-${index}`, script), streams);
      return output;
    }));
    expect(paths[0]).toBe(paths[1]); expect(paths[2]).not.toBe(paths[0]);
    await writeFile(join(paths[0]!, 'identity'), 'first');
    await expect(readFile(join(paths[2]!, 'identity'))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const [index, agentHome] of [first, first, second].entries()) { boundary.home = agentHome; await leases[index]!.dispose(); }
    for (const agentHome of [first, second]) expect(await readdir(join(agentHome, 'runtime/operations'))).toEqual([]);
  });

  it('retires operation runtime after startup failure and cancellation', async () => {
    const agentHome = await home();
    const missing = { ...launch(agentHome, 'missing', ''), executable: join(agentHome, 'missing') };
    const first = await operation(agentHome, 'missing');
    await expect(executeAgentLaunchPayload(missing, io(agentHome))).rejects.toBeDefined();
    await first.dispose();
    const second = await operation(agentHome, 'cancel');
    const controller = new AbortController(); const streams = io(agentHome);
    streams.stdout.once('data', () => controller.abort());
    await executeAgentLaunchPayload(launch(agentHome, 'cancel', 'process.stdout.write("ready");process.stdin.resume()'), {
      ...streams, input: new PassThrough(), signal: controller.signal,
    }).catch(() => undefined);
    expect(controller.signal.aborted).toBe(true);
    await second.dispose();
    expect(await readdir(join(agentHome, 'runtime/operations'))).toEqual([]);
  });

  it('retains one preparation across live sibling children, then retires its runtime on disposal', async () => {
    const agentHome = await home(); const lease = await operation(agentHome, 'siblings');
    const input = { ...launch(agentHome, 'siblings', ''), selectedMaterials: [] };
    const controller = new AbortController(); const streams = io(agentHome);
    const ready = new Promise<void>(resolve => streams.stdout.once('data', () => resolve()));
    const first = executeAgentLaunchPayload({ ...input, args: ['-e', `const fs=require('node:fs');fs.mkdirSync(process.env.XDG_CONFIG_HOME,{recursive:true});fs.writeFileSync(process.env.XDG_CONFIG_HOME+'/alive','sibling');process.stdout.write('ready');process.stdin.resume()`] },
      { ...streams, input: new PassThrough(), signal: controller.signal });
    const settled = first.then(value => value, () => undefined);
    try {
      await Promise.race([ready, settled.then(() => { throw new Error('Sibling exited before readiness'); })]);
      await executeAgentLaunchPayload({ ...input, args: ['-e', ''] }, io(agentHome));
      expect(await readFile(join(input.runtimeHome, '.config/alive'), 'utf8')).toBe('sibling');
    } finally { controller.abort(); await settled; }
    expect(await stat(input.runtimeHome)).toBeDefined();
    await lease.dispose();
    await expect(stat(input.runtimeHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('unlinks provider-created symlinks and refuses a replaced operation root without following its target', async () => {
    const agentHome = await home(); const outside = await home();
    await writeFile(join(outside, 'sentinel'), 'untouched');
    const lease = await operation(agentHome, 'replace');
    const input = launch(agentHome, 'replace', '');
    const moved = `${input.runtimeHome}-moved`;
    const script = `require('node:fs').symlinkSync(${JSON.stringify(outside)},${JSON.stringify(join(input.runtimeHome, 'provider-link'))});`;
    expect(await executeAgentLaunchPayload({ ...input, args: ['-e', script] }, io(agentHome))).toEqual({ code: 0, signal: null });
    await lease.dispose();
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
    const replaced = await operation(agentHome, 'replace');
    await executeAgentLaunchPayload(input, io(agentHome));
    await rename(input.runtimeHome, moved); await symlink(outside, input.runtimeHome);
    await expect(replaced.dispose()).rejects.toBeDefined();
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
  });

  it('refuses a symlinked identity cache before starting the child', async () => {
    const agentHome = await home(); const outside = await home();
    await mkdir(join(agentHome, 'runtime'), { mode: 0o700 });
    await writeFile(join(outside, 'sentinel'), 'untouched');
    await symlink(outside, join(agentHome, '.cache'));
    const input = launch(agentHome, 'cache-refusal', `require('node:fs').writeFileSync(${JSON.stringify(join(outside, 'started'))},'bad')`);
    await expect(executeAgentLaunchPayload(input, io(agentHome))).rejects.toBeDefined();
    expect(await readdir(outside)).toEqual(['sentinel']);
  });

  it.each(['outside', 'session', 'foreign owner'] as const)('refuses cleanup custody for %s runtime', async kind => {
    const agentHome = await home(); const outside = await home();
    const runtimeHome = kind === 'outside' ? join(outside, 'runtime') : kind === 'session'
      ? join(agentHome, 'runtime/session') : launch(agentHome, 'foreign', '').runtimeHome;
    await mkdir(runtimeHome, { recursive: true, mode: 0o700 });
    await writeFile(join(runtimeHome, 'sentinel'), 'untouched');
    const actualStat = filesystem.stat;
    const metadata = vi.spyOn(filesystem, 'stat').mockImplementation(async path => {
      const entry = await actualStat(path);
      return kind === 'foreign owner' && await filesystem.realpath(path) === runtimeHome
        ? Object.assign(entry, { uid: 99997 }) : entry;
    });
    try {
      await expect(executeAgentLaunchPayload({ v: 1, action: 'retire_operation', runtimeHome }, io(agentHome))).rejects.toBeDefined();
      expect(await readFile(join(runtimeHome, 'sentinel'), 'utf8')).toBe('untouched');
      await expect(stat(join(agentHome, '.cache'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { metadata.mockRestore(); }
  });

  it('disposes member A and B through their exact native identities without retiring the other member', async () => {
    const observed = [];
    for (const [index, accountId] of ['member-a', 'member-b'].entries()) {
      const agentHome = await home(); boundary.home = agentHome;
      const identity = { kind: 'isolated' as const, separationRequired: true,
        requester: { serverId: 'home', accountId, machineId: 'machine', installationId: 'installation' } };
      const requesterIdentity = { ...identity, homeServerIdentityId: 'home' };
      const member = { ...deriveAgentIsolationMemberIdentity(requesterIdentity), agentUid: 2402 + index, agentGid: 2402 + index };
      const preparation = createAgentIsolationEffectsBoundary({ installationId: 'installation',
        installedCli: '/fixture/happier', readRoots: () => [], readSessionsToReplace: () => 0,
        publishStatus: async () => {}, backend: {
          async observe(step) { return { stepId: step.id, status: 'satisfied', facts: {
            uid: member.agentUid, gid: step.id === 'member-workspace' ? 1001 : member.agentGid,
          } }; },
          async apply() { throw new Error('Already prepared member requires no setup'); },
        } });
      await writeAgentIsolationMemberBinding(agentHome, member);
      boundary.member = { path: member.home, uid: member.agentUid };
      const actualLstat = filesystem.lstat, actualRealpath = filesystem.realpath;
      const lstatSpy = vi.spyOn(filesystem, 'lstat').mockImplementation(async path => String(path) === member.home
        ? Object.assign(await actualLstat(agentHome), { uid: member.agentUid, gid: member.agentGid, mode: 0o40700 }) : actualLstat(path));
      const realpathSpy = vi.spyOn(filesystem, 'realpath').mockImplementation(async path => String(path) === member.home || String(path) === member.workspaceRoot
        ? String(path) : actualRealpath(path));
      try {
        const native = await prepareRequesterNativeOperation({ requesterIdentity: identity, resolveRequesterIdentity: async () => identity,
          readMaterial: () => ({ materializationKey: 'same-operation', environment: {}, selectedMaterials: [] }), signal: new AbortController().signal }, {
          machine: { managedHappierBinaryPath: preparation.effects.installedCli,
            read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'unavailable', code: 'metadata_unavailable' }, workspaceRoots: [] }),
            async prepareMember(input) { const result = await ensureAgentIsolationMember({ ...input,
              activeServerDir: agentHome, verifyLocalCustody: async () => true,
              port: { read: async () => ({ status: 'ready', metadataVersion: 1,
                metadata: { agentIsolation: { enabled: true, memberProvisioning: 'linuxUsersV1' } } }),
                compareAndSwap: async () => ({ status: 'unavailable' }) },
              setup: async () => { throw new Error('Already prepared member requires no setup'); },
            }, { ...preparation.effects, nativeReadiness: { privateRoots: [], system: {
              async run(command, args) {
                expect(command).toBe('sudo');
                expect(args).toEqual(['-n', '-l', '-u', member.username, '--', preparation.effects.installedCli, 'agent-launch']);
                return { stdout: '', stderr: '' };
              },
            } } });
              if (result.kind !== 'ready') throw new Error('Member OS fixture refused preparation'); return result; } },
          homeServerIdentityId: 'home', machineId: 'machine', installationId: 'installation', reloadController: createPluginReloadController(),
        });
        const input = launch(agentHome, 'same-operation', '');
        await executeAgentLaunchPayload(input, io(agentHome));
        observed.push({ native, agentHome, runtimeHome: input.runtimeHome, member });
      } finally { lstatSpy.mockRestore(); realpathSpy.mockRestore(); }
    }
    for (const [index, entry] of observed.entries()) {
      boundary.home = entry.agentHome; boundary.member = { path: entry.member.home, uid: entry.member.agentUid };
      await entry.native.dispose();
      expect(boundary.memberFrames.at(-1)).toMatchObject({ username: entry.member.username,
        agentUid: entry.member.agentUid, home: entry.member.home });
      await expect(stat(entry.runtimeHome)).rejects.toMatchObject({ code: 'ENOENT' });
      if (index === 0) expect(await stat(observed[1]!.runtimeHome)).toBeDefined();
    }
  });
});
