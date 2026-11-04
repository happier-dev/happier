import { chmodSync, realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { executeAgentLaunchPayload } from './agentLaunchShim';
import { encodeAgentLaunchFrame, readAgentLaunchFrame, type AgentLaunchPayload } from './agentLaunchFrame';

const boundary = vi.hoisted(() => ({ foreignOwnerPath: '', grants: [] as string[] }));
// Only native ACL utilities and one foreign-owned inode are OS substitutions.
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(),
  execFile(command: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) {
    const path = args.at(-1)!;
    if (command === 'setfacl') {
      if (args.includes('--set')) { boundary.grants.push(realpathSync(path)); chmodSync(path, 0o710); }
      done(null, '');
    } else done(new Error('Unexpected native command'), '');
  },
}));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    const entry = await fs.lstat(...args);
    return String(args[0]) === boundary.foreignOwnerPath ? Object.assign(entry, { uid: 99997 }) : entry;
  } };
});
const roots: string[] = [];
afterEach(async () => { boundary.foreignOwnerPath = ''; boundary.grants.length = 0;
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp('/tmp/h-shim-'); roots.push(root);
  const path = join(root, 'private');
  const payload: AgentLaunchPayload = { v: 1, executable: process.execPath,
    args: ['-e', 'const s=require("fs").lstatSync(process.argv[1]);process.stdout.write(JSON.stringify({directory:s.isDirectory(),mode:s.mode&511,uid:s.uid}))', path],
    cwd: root, runtimeHome: join(root, 'runtime'), environment: {}, selectedMaterials: [],
    nativeSocketDirectory: { path, daemonUid: 99998 } };
  return { root, path, payload };
}

it.skipIf(process.platform !== 'linux')('prepares the frame-bound native-owned parent without writable group access, then removes it after the real child exits', async () => {
  const { root, path, payload } = await fixture();
  const frame = await readAgentLaunchFrame(Readable.from([encodeAgentLaunchFrame(payload)], { objectMode: false }));
  const output = new PassThrough(); let text = ''; output.on('data', chunk => { text += String(chunk); });
  await expect(executeAgentLaunchPayload(frame, { agentHome: root, input: Readable.from([]), stdout: output, stderr: new PassThrough() }))
    .resolves.toEqual({ code: 0, signal: null });
  expect(JSON.parse(text)).toEqual({ directory: true, mode: 0o710, uid: process.getuid!() });
  expect(boundary.grants).toEqual([path]);
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform !== 'linux').each(['symlink', 'file', 'foreign owner'] as const)('refuses a %s alias parent before granting access or running its child', async kind => {
  const { root, path, payload } = await fixture();
  const retained = join(root, 'retained'); await mkdir(retained, { mode: 0o700 });
  await writeFile(join(retained, 'state'), 'unchanged');
  if (kind === 'symlink') await symlink(retained, path);
  else if (kind === 'file') await writeFile(path, 'retained file');
  else { await mkdir(path, { mode: 0o700 }); boundary.foreignOwnerPath = path; }
  await expect(executeAgentLaunchPayload(payload, { agentHome: root, input: Readable.from([]), stdout: new PassThrough(), stderr: new PassThrough() }))
    .rejects.toMatchObject({ code: 'agent_launch_material_invalid' });
  expect(boundary.grants).toEqual([]);
  expect(await readFile(join(retained, 'state'), 'utf8')).toBe('unchanged');
});

it.skipIf(process.platform !== 'linux')('cleans the native alias parent when the existing launch signal cancels its running child', async () => {
  const { root, path, payload } = await fixture();
  const controller = new AbortController();
  const output = new PassThrough(); output.once('data', () => controller.abort());
  await executeAgentLaunchPayload({ ...payload, args: ['-e', 'process.stdout.write("ready");process.stdin.resume()'] }, {
    agentHome: root, input: new PassThrough(), stdout: output, stderr: new PassThrough(), signal: controller.signal,
  }).catch(() => undefined);
  expect(boundary.grants).toEqual([path]);
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
