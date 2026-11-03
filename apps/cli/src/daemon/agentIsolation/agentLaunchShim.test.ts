import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeAgentLaunchPayload, publishAgentLaunchMaterials } from './agentLaunchShim';
import type { AgentLaunchPayload } from './agentLaunchFrame';
import { userInfo } from 'node:os';
import { runAgentLaunchShim } from '../../cli/commands/agentLaunch';

const publicationFailure = vi.hoisted(() => ({
  destination: '', previouslyPublished: '', observedBytes: undefined as Uint8Array | undefined,
}));
// Fail only the final OS publication of the second file. The first selected
// credential and all validation/atomic-write/cleanup logic use the real disk.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (String(args[1]) === publicationFailure.destination) {
      publicationFailure.observedBytes = await actual.readFile(publicationFailure.previouslyPublished);
      throw Object.assign(new Error('publication failed'), { code: 'EIO' });
    }
    return actual.rename(...args);
  } };
});

const roots: string[] = [];
async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-agent-launch-test-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  publicationFailure.destination = '';
  publicationFailure.previouslyPublished = '';
  publicationFailure.observedBytes = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function payload(agentHome: string): AgentLaunchPayload {
  return { v: 1, executable: '/bin/cat', args: [], cwd: agentHome,
    runtimeHome: join(agentHome, 'runtime', 'lease-owned'), environment: {},
    selectedMaterials: [
      { relativePath: '.provider/auth', contentBase64: Buffer.from([0, 255, 10]).toString('base64') },
      { relativePath: 'files/token.bin', contentBase64: 'c2VsZWN0ZWQ=' },
      { relativePath: '.happier/session-mcp.json', contentBase64: 'e30=' },
    ] };
}

async function expectTransientMaterialRemoved(launch: AgentLaunchPayload): Promise<void> {
  await expect(stat(join(launch.runtimeHome, 'files'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(join(launch.runtimeHome, '.happier/session-mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(join(launch.runtimeHome, '.provider/auth'))).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('Agent launch runtime home', () => {
  it.skipIf(userInfo().username === 'happier-agent')('refuses the command before reading a frame unless the OS identity is happier-agent', async () => {
    await expect(runAgentLaunchShim([])).rejects.toMatchObject({ code: 'agent_launch_identity_unavailable' });
  });
  it('publishes selected bytes privately and replaces material atomically through the same owner', async () => {
    const agentHome = await home();
    const launch = payload(agentHome);
    await publishAgentLaunchMaterials(launch, agentHome);
    expect(await readFile(join(launch.runtimeHome, '.provider/auth'))).toEqual(Buffer.from([0, 255, 10]));
    expect((await stat(launch.runtimeHome)).mode & 0o777).toBe(0o700);
    expect((await stat(join(launch.runtimeHome, '.provider/auth'))).mode & 0o777).toBe(0o600);
    const firstPublication = await stat(launch.runtimeHome);
    const firstFile = await stat(join(launch.runtimeHome, '.provider/auth'));
    await publishAgentLaunchMaterials(launch, agentHome);
    expect((await stat(launch.runtimeHome)).ino).toBe(firstPublication.ino);
    expect((await stat(join(launch.runtimeHome, '.provider/auth'))).ino).toBe(firstFile.ino);
    await publishAgentLaunchMaterials({ ...launch, selectedMaterials: [{ relativePath: 'new', contentBase64: 'bmV3' }] }, agentHome);
    expect((await readdir(launch.runtimeHome)).sort()).toEqual(['.happier', '.provider', 'files', 'new']);
    expect(await readdir(join(agentHome, 'runtime'))).toEqual(['lease-owned']);
  });

  it('preserves provider-created native resume state while rotating selected credentials', async () => {
    const agentHome = await home();
    const launch = { ...payload(agentHome), selectedMaterials: [
      { relativePath: 'native-home/.credentials.json', contentBase64: Buffer.from('old-selected').toString('base64') },
    ] };
    await publishAgentLaunchMaterials(launch, agentHome);
    const resumeFile = join(launch.runtimeHome, 'native-home/projects/workspace/session.jsonl');
    await mkdir(join(launch.runtimeHome, 'native-home/projects/workspace'), { recursive: true, mode: 0o700 });
    await writeFile(resumeFile, 'provider-created-resume-state', { mode: 0o600 });
    await publishAgentLaunchMaterials({ ...launch, selectedMaterials: [
      { relativePath: 'native-home/.credentials.json', contentBase64: Buffer.from('rotated-selected').toString('base64') },
    ] }, agentHome);
    expect(await readFile(resumeFile, 'utf8')).toBe('provider-created-resume-state');
    expect(await readFile(join(launch.runtimeHome, 'native-home/.credentials.json'), 'utf8')).toBe('rotated-selected');
  });

  it('rejects destination escape and symlink ancestry without touching the outside directory', async () => {
    const agentHome = await home();
    const outside = await home();
    await symlink(outside, join(agentHome, 'runtime'));
    await expect(publishAgentLaunchMaterials(payload(agentHome), agentHome)).rejects.toMatchObject({ code: 'agent_launch_material_invalid' });
    await mkdir(join(outside, 'untouched'));
    await expect(publishAgentLaunchMaterials({ ...payload(agentHome), runtimeHome: outside }, agentHome)).rejects.toMatchObject({ code: 'agent_launch_material_invalid' });
    expect(await readdir(outside)).toEqual(['untouched']);
  });

  it('rejects selected file traversal before publishing any material', async () => {
    const agentHome = await home();
    const launch = { ...payload(agentHome), selectedMaterials: [{ relativePath: '../escape', contentBase64: 'c2VjcmV0' }] };
    await expect(publishAgentLaunchMaterials(launch, agentHome)).rejects.toMatchObject({ code: 'agent_launch_material_invalid' });
    expect(await readdir(agentHome)).toEqual([]);
  });

  it('rejects symlinked selected-entry parents without following them or replacing retained state', async () => {
    const agentHome = await home();
    const outside = await home();
    const launch = payload(agentHome);
    await mkdir(launch.runtimeHome, { recursive: true, mode: 0o700 });
    await symlink(outside, join(launch.runtimeHome, '.provider'));
    await writeFile(join(outside, 'auth'), 'untouched');
    await expect(publishAgentLaunchMaterials(launch, agentHome)).rejects.toMatchObject({ code: 'agent_launch_material_invalid' });
    expect(await readFile(join(outside, 'auth'), 'utf8')).toBe('untouched');
    expect((await readdir(launch.runtimeHome))).toEqual(['.provider']);
  });

  it.skipIf(process.platform !== 'linux')('hands binary input/EOF and output to a real child with backpressure', async () => {
    const agentHome = await home();
    const launch = { ...payload(agentHome), selectedMaterials: [
      ...payload(agentHome).selectedMaterials,
      { relativePath: 'native-home/auth.json', contentBase64: Buffer.from('selected-provider-credential').toString('base64') },
    ] };
    await publishAgentLaunchMaterials(launch, agentHome);
    const nativeState = join(launch.runtimeHome, 'native-home/projects/workspace/session.jsonl');
    await mkdir(join(launch.runtimeHome, 'native-home/projects/workspace'), { recursive: true, mode: 0o700 });
    await writeFile(nativeState, 'provider-created-resume-state', { mode: 0o600 });
    const bytes = Buffer.alloc(512 * 1024);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
    const output = new PassThrough({ highWaterMark: 32 });
    const error = new PassThrough();
    const chunks: Buffer[] = [];
    const consume = (async () => { for await (const chunk of output) chunks.push(Buffer.from(chunk)); })();
    const result = await executeAgentLaunchPayload(launch, {
      agentHome, input: Readable.from([bytes]), stdout: output, stderr: error,
    });
    output.end();
    await consume;
    expect(result).toEqual({ code: 0, signal: null });
    expect(Buffer.concat(chunks)).toEqual(bytes);
    await expectTransientMaterialRemoved(launch);
    await expect(stat(join(launch.runtimeHome, 'native-home/auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(nativeState, 'utf8')).toBe('provider-created-resume-state');
  });

  it.skipIf(process.platform !== 'linux')('awaits material cleanup when child startup fails after publication', async () => {
    const agentHome = await home();
    const launch = { ...payload(agentHome), executable: join(agentHome, 'missing-executable') };
    await expect(executeAgentLaunchPayload(launch, {
      agentHome, input: Readable.from([]), stdout: new PassThrough(), stderr: new PassThrough(),
    })).rejects.toBeDefined();
    await expectTransientMaterialRemoved(launch);
    expect(await readdir(join(agentHome, 'runtime'))).toEqual(['lease-owned']);
  });

  it('removes already-published selected bytes when a later OS publication fails', async () => {
    const agentHome = await home();
    const launch = payload(agentHome);
    const retainedState = join(launch.runtimeHome, 'native-home/projects/workspace/session.jsonl');
    await mkdir(join(launch.runtimeHome, 'native-home/projects/workspace'), { recursive: true, mode: 0o700 });
    await writeFile(retainedState, 'provider-created-resume-state', { mode: 0o600 });
    publicationFailure.previouslyPublished = join(launch.runtimeHome, '.provider/auth');
    publicationFailure.destination = join(launch.runtimeHome, 'files/token.bin');
    await expect(executeAgentLaunchPayload(launch, {
      agentHome, input: Readable.from([]), stdout: new PassThrough(), stderr: new PassThrough(),
    })).rejects.toMatchObject({ code: 'EIO' });
    expect(publicationFailure.observedBytes).toEqual(Buffer.from([0, 255, 10]));
    await expect(stat(publicationFailure.previouslyPublished)).rejects.toMatchObject({ code: 'ENOENT' });
    await expectTransientMaterialRemoved(launch);
    expect(await readFile(retainedState, 'utf8')).toBe('provider-created-resume-state');
  });

  it.skipIf(process.platform !== 'linux')('awaits material cleanup after cancelling a running child', async () => {
    const agentHome = await home();
    const launch = { ...payload(agentHome), executable: process.execPath,
      args: ['-e', 'process.stdout.write("ready");process.stdin.resume()'] };
    const controller = new AbortController();
    const output = new PassThrough();
    let started = false;
    output.once('data', () => { started = true; controller.abort(); });
    await executeAgentLaunchPayload(launch, { agentHome, input: new PassThrough(),
      stdout: output, stderr: new PassThrough(), signal: controller.signal }).catch(() => undefined);
    expect(started).toBe(true);
    await expectTransientMaterialRemoved(launch);
  });

  it.skipIf(process.platform !== 'linux')('keeps primary Agent config and Session context after a concurrent custom-tool frame settles', async () => {
    const agentHome = await home();
    const primary: AgentLaunchPayload = { ...payload(agentHome), executable: process.execPath,
      args: ['-e', 'process.stdout.write("ready");process.stdin.resume()'],
      selectedMaterials: [
        { relativePath: 'files/primary-config.json', contentBase64: Buffer.from('primary-config').toString('base64') },
        { relativePath: '.happier/session-mcp.json', contentBase64: Buffer.from('primary-context').toString('base64') },
      ] };
    const controller = new AbortController();
    const output = new PassThrough();
    const ready = new Promise<void>(resolve => output.once('data', () => resolve()));
    const pending = executeAgentLaunchPayload(primary, { agentHome, input: new PassThrough(),
      stdout: output, stderr: new PassThrough(), signal: controller.signal });
    const settled = pending.then(result => ({ result }), (error: unknown) => ({ error }));
    try {
      await Promise.race([ready, settled.then(() => { throw new Error('Primary Agent exited before ready'); })]);
      expect(await readFile(join(primary.runtimeHome, 'files/primary-config.json'), 'utf8')).toBe('primary-config');
      const custom: AgentLaunchPayload = { ...primary, executable: '/bin/cat', args: [],
        selectedMaterials: [{ relativePath: 'files/custom-config.json', contentBase64: Buffer.from('custom-config').toString('base64') }] };
      expect(await executeAgentLaunchPayload(custom, { agentHome, input: Readable.from([]),
        stdout: new PassThrough(), stderr: new PassThrough() })).toEqual({ code: 0, signal: null });
      await expect(stat(join(primary.runtimeHome, 'files/custom-config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(primary.runtimeHome, 'files/primary-config.json'), 'utf8')).toBe('primary-config');
      expect(await readFile(join(primary.runtimeHome, '.happier/session-mcp.json'), 'utf8')).toBe('primary-context');
    } finally { controller.abort(); await settled; output.end(); }
  });

  it('does not gain cleanup authority over a refused destination', async () => {
    const agentHome = await home();
    const outside = await home();
    await mkdir(join(outside, 'untouched'));
    await expect(executeAgentLaunchPayload({ ...payload(agentHome), runtimeHome: outside }, {
      agentHome, input: Readable.from([]), stdout: new PassThrough(), stderr: new PassThrough(),
    })).rejects.toMatchObject({ code: 'agent_launch_material_invalid' });
    expect(await readdir(outside)).toEqual(['untouched']);

    const launch = payload(agentHome);
    await mkdir(join(launch.runtimeHome, '.provider'), { recursive: true, mode: 0o700 });
    await writeFile(join(launch.runtimeHome, '.provider/auth'), 'preexisting-provider-state');
    await symlink(outside, join(launch.runtimeHome, 'files'));
    await expect(executeAgentLaunchPayload(launch, {
      agentHome, input: Readable.from([]), stdout: new PassThrough(), stderr: new PassThrough(),
    })).rejects.toMatchObject({ code: 'agent_launch_material_invalid' });
    expect(await readFile(join(launch.runtimeHome, '.provider/auth'), 'utf8')).toBe('preexisting-provider-state');
    expect(await readdir(outside)).toEqual(['untouched']);
  });
});
