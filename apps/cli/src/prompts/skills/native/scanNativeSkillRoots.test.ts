import { afterEach, expect, it, vi } from 'vitest';
import { constants, openSync, writeSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanNativeSkillRoots } from './scanNativeSkillRoots';
import { buildPromptBundleBodyFromDirectory } from '@/prompts/assets/shared/promptBundleDirectory';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { SkillFoundListInputV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';

const { beforeReadDirectory } = vi.hoisted(() => ({
  beforeReadDirectory: vi.fn<(path: unknown) => void | Promise<void>>(),
}));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    async readdir(...args: Parameters<typeof fs.readdir>) {
      await beforeReadDirectory(args[0]);
      return fs.readdir(...args);
    },
  };
});

async function createSkill(root: string, name: string) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Native\n---\nNative body`);
  return directory;
}

const homes: string[] = [];
const releaseReads: Array<() => Promise<void>> = [];
afterEach(async () => {
  beforeReadDirectory.mockReset();
  for (const release of releaseReads.splice(0)) await release();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

it('opens independent native roots while the first directory read is still pending and preserves root order', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-native-root-order-')); homes.push(home);
  const first = join(home, '.native-first');
  const second = join(home, '.native-second');
  await createSkill(first, 'review-first');
  await createSkill(second, 'review-second');

  const firstRead = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  beforeReadDirectory.mockImplementation(path => {
    if (path === first) {
      firstRead.resolve();
      return releaseFirst.promise;
    }
  });
  const scanning = scanNativeSkillRoots({ home, nativeRoots: { user: [['.native-first'], ['.native-second']] } });
  try {
    await firstRead.promise;
    expect(beforeReadDirectory).toHaveBeenCalledWith(second);
  } finally {
    releaseFirst.resolve();
    expect((await scanning).names.map(({ name }) => name)).toEqual(['review-first', 'review-second']);
  }
});
it('discovers the hosted Session home and relative project roots independently', async () => {
  await Promise.all(['first', 'second'].map(async name => {
    const home = await mkdtemp(join(tmpdir(), 'happier-native-session-')); homes.push(home);
    const cwd = join(home, 'workspace');
    await createSkill(join(home, '.native'), `${name}-user`);
    await createSkill(join(cwd, 'extra', '.project'), `${name}-project`);
    const result = await runAddedHostedSession({
      environment: { NODE_ENV: 'test', HOME: home, USERPROFILE: home }, workingDirectory: cwd, end() {},
    }, () => scanNativeSkillRoots({ nativeRoots: { user: [['.native']], project: [['.project']] },
      additionalProjectDirectories: ['extra'] }));
    expect(result.status).toBe('ok');
    expect(result.names.map(item => item.name).sort()).toEqual([`${name}-project`, `${name}-user`]);
  }));
});
it.skipIf(process.platform === 'win32')('reports a FIFO entry as unknown without blocking preparation or Found', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-native-fifo-')); homes.push(home);
  const root = join(home, '.native');
  const directory = join(root, 'blocked');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'SKILL.md');
  execFileSync('mkfifo', [path]);
  // Release the old scanner's pending OS read after the runner reports RED.
  // The bound belongs to Vitest; the product has no scan timer.
  const nativeRoots = { user: [['.native']] };
  const masking = scanNativeSkillRoots({ home, nativeRoots });
  releaseReads.push(async () => {
    const fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
    try { writeSync(fd, 'Native fixture'); } finally { closeSync(fd); }
    await masking;
  });
  expect(await masking).toEqual({ status: 'failed', roots: [root], names: [] });
  const found = await scanNativeSkillRoots({ purpose: 'found', home, agents: [{ agentId: 'reader', nativeRoots }] });
  expect(found).toEqual({ roots: [{ path: root, scope: 'user', agents: ['reader'], status: 'failed' }], items: [] });
}, 1000);

it('merges physical aliases and Agent coverage while retaining distinct copies and failed aliases', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-native-alias-')); homes.push(home);
  const skill = await createSkill(join(home, '.claude', 'skills'), 'review');
  await mkdir(join(home, '.agents'));
  await symlink(join(home, '.claude', 'skills'), join(home, '.agents', 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  const separate = await createSkill(join(home, '.separate'), 'review');
  const failed = join(home, '.failed');
  // A valid alias whose target is not a directory must remain a failed root.
  const notDirectory = join(home, 'not-directory');
  await writeFile(notDirectory, 'Not a directory');
  await symlink(notDirectory, failed, process.platform === 'win32' ? 'junction' : undefined);
  const found = await scanNativeSkillRoots({ purpose: 'found', home, agents: [
    { agentId: 'first', nativeRoots: { user: [['.claude', 'skills']] } },
    { agentId: 'second', nativeRoots: { user: [['.agents', 'skills'], ['.separate'], ['.failed']] } },
  ] });
  expect(found.items.map(item => ({ path: item.path, agents: item.agents }))).toEqual([
    { path: skill, agents: ['first', 'second'] }, { path: separate, agents: ['second'] },
  ]);
  expect(found.roots).toContainEqual({ path: failed, scope: 'user', agents: ['second'], status: 'failed' });
});

it('retains failed-root uncertainty for an existing alias whose target is missing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-native-broken-alias-')); homes.push(home);
  const alias = join(home, '.native');
  await symlink(join(home, 'missing'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const nativeRoots = { user: [['.native']] };
  expect(await scanNativeSkillRoots({ home, nativeRoots })).toEqual({ status: 'failed', roots: [alias], names: [] });
  const found = await scanNativeSkillRoots({ purpose: 'found', home, agents: [{ agentId: 'reader', nativeRoots }] });
  expect(found).toEqual({ roots: [{ path: alias, scope: 'user', agents: ['reader'], status: 'failed' }], items: [] });
});
it('uses declared roots, walks only to the repository boundary and retains failed-root uncertainty', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-native-scan-')); homes.push(home);
  const root = join(home, 'repo'), directory = join(root, 'nested');
  await mkdir(join(root, '.git'), { recursive: true }); await mkdir(directory);
  const skill = async (parent: string, name: string) => {
    const dir = join(parent, name); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Native\n---\nNative body`);
  };
  await skill(join(root, '.skills'), 'project');
  await skill(join(home, '.skills'), 'above-repo');
  await skill(join(home, '.native'), 'user');
  await writeFile(join(home, '.unreadable'), 'A file cannot be scanned as a root');
  const result = await scanNativeSkillRoots({ home, directory, nativeRoots: { user: [['.native'], ['.unreadable']], project: [['.skills']] } });
  expect(result.status).toBe('failed');
  expect(result.names.map(item => item.name).sort()).toEqual(['project', 'user']);
  expect(result).toMatchObject({ roots: [join(home, '.unreadable')] });
});

it.each(['~/repo/nested', '~\\repo\\nested'])('expands the public Found directory against the captured machine home (%s)', async directory => {
  const home = await mkdtemp(join(tmpdir(), 'happier-native-home-')); homes.push(home);
  const repository = join(home, 'repo');
  await mkdir(join(repository, '.git'), { recursive: true });
  await mkdir(join(repository, 'nested'));
  const skillDirectory = await createSkill(join(repository, '.skills'), 'project');
  const request = SkillFoundListInputV1Schema.parse({ machineId: 'machine', directory });
  const found = await scanNativeSkillRoots({ purpose: 'found', home, directory: request.directory,
    agents: [{ agentId: 'claude', nativeRoots: { project: [['.skills']] } }] });
  expect(found.items.map(item => item.path)).toEqual([skillDirectory]);
});

it('retains invocation eligibility in Found without hiding skills from management discovery', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-native-invocation-')); homes.push(home);
  for (const [name, flag] of [['hidden', 'user-invocable: false'], ['explicit', 'user-invocable: true'], ['default', '']] as const) {
    const directory = await createSkill(join(home, '.codex', 'skills'), name);
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Native\n${flag}\n---\nNative body`);
  }
  const found = await scanNativeSkillRoots({ purpose: 'found', home,
    agents: [{ agentId: 'codex', nativeRoots: { user: [['.codex', 'skills']] } }] });
  expect(found.items).toEqual([
    expect.objectContaining({ name: 'default', userInvocable: true }),
    expect.objectContaining({ name: 'explicit', userInvocable: true }),
    expect.objectContaining({ name: 'hidden', userInvocable: false }),
  ]);
});

it('aggregates shared Agent roots and hashes complete skill files and executable modes through the existing bundle owner', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-native-found-')); homes.push(home);
  const skillDirectory = await createSkill(join(home, '.shared'), 'shared');
  await mkdir(join(skillDirectory, 'scripts'));
  const script = join(skillDirectory, 'scripts', 'run.sh');
  await writeFile(script, '#!/bin/sh\necho first\n');
  await chmod(script, 0o644);
  await writeFile(join(home, '.unreadable'), 'A file cannot be scanned as a root');
  const repository = join(home, 'repo');
  const directory = join(repository, 'nested');
  await mkdir(join(repository, '.git'), { recursive: true });
  await mkdir(directory);
  const projectSkill = await createSkill(join(repository, '.project'), 'project');
  await createSkill(join(home, '.project'), 'above-repository');
  const input = { purpose: 'found' as const, home, directory, agents: [
    { agentId: 'first', nativeRoots: { user: [['.shared'], ['.unreadable']], project: [['.project']] } },
    { agentId: 'second', nativeRoots: { user: [['.shared']] } },
  ] };
  const before = await scanNativeSkillRoots(input);
  expect(before.roots).toEqual([
    { path: join(home, '.shared'), scope: 'user', agents: ['first', 'second'], status: 'ok' },
    { path: join(home, '.unreadable'), scope: 'user', agents: ['first'], status: 'failed' },
    { path: join(directory, '.project'), scope: 'project', agents: ['first'], status: 'ok' },
    { path: join(repository, '.project'), scope: 'project', agents: ['first'], status: 'ok' },
  ]);
  expect(before.items).toEqual([{ name: 'shared', description: 'Native', path: skillDirectory, userInvocable: true,
    digest: computePromptBundleDigestV1(buildPromptBundleBodyFromDirectory({ rootDirectory: skillDirectory })),
    agents: ['first', 'second'], scope: 'user', pluginOwned: null },
    { name: 'project', description: 'Native', path: projectSkill, userInvocable: true,
      digest: computePromptBundleDigestV1(buildPromptBundleBodyFromDirectory({ rootDirectory: projectSkill })),
      agents: ['first'], scope: 'project', pluginOwned: null },
  ]);
  await writeFile(script, '#!/bin/sh\necho other\n');
  const changedContent = await scanNativeSkillRoots(input);
  expect(changedContent.items[0]?.digest).not.toBe(before.items[0]?.digest);
  if (process.platform !== 'win32') {
    // Windows chmod does not expose POSIX executable-bit changes.
    await chmod(script, 0o755);
    const changedMode = await scanNativeSkillRoots(input);
    expect(changedMode.items[0]?.digest).not.toBe(changedContent.items[0]?.digest);
  }
});

it('selects the newest plugin version, confines plugin links and excludes plugin roots from masking', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-native-plugin-')); homes.push(home);
  const cache = join(home, '.claude', 'plugins', 'cache');
  const oldVersion = join(cache, 'market', 'fixture', 'old');
  const newVersion = join(cache, 'market', 'fixture', 'new');
  await createSkill(join(oldVersion, 'skills'), 'old');
  const newest = await createSkill(join(newVersion, 'skills'), 'new');
  await utimes(oldVersion, new Date(1000), new Date(1000));
  await utimes(newVersion, new Date(2000), new Date(2000));
  const outside = join(home, 'outside');
  await createSkill(join(outside, 'skills'), 'escaped');
  await symlink(outside, join(cache, 'market', 'fixture', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await createSkill(join(home, '.native'), 'native');
  const nativeRoots = { user: [['.native']], plugin: [['.claude', 'plugins', 'cache', '*', '{plugin}', '*', 'skills']] };
  const found = await scanNativeSkillRoots({ purpose: 'found', home, agents: [
    { agentId: 'claude', nativeRoots }, { agentId: 'other', nativeRoots: { plugin: nativeRoots.plugin } },
  ] });
  expect(found.items.map(item => ({ name: item.name, path: item.path, pluginOwned: item.pluginOwned }))).toEqual([
    { name: 'native', path: join(home, '.native', 'native'), pluginOwned: null },
    { name: 'new', path: newest, pluginOwned: { pluginName: 'fixture' } },
  ]);
  expect(found.roots).toEqual(expect.arrayContaining([
    { path: join(newVersion, 'skills'), scope: 'plugin', agents: ['claude', 'other'], status: 'ok' },
    expect.objectContaining({ scope: 'plugin', status: 'failed' }),
  ]));
  const masking = await scanNativeSkillRoots({ home, nativeRoots });
  expect(masking).toEqual({ status: 'ok', names: [{ name: 'native', path: join(home, '.native', 'native', 'SKILL.md'), root: join(home, '.native') }] });
});

it('keeps plugin ownership distinct when a native root aliases its confined skill directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-native-provenance-')); homes.push(home);
  const pluginRoot = join(home, 'cache', 'fixture', 'skills');
  await createSkill(pluginRoot, 'review');
  await symlink(pluginRoot, join(home, '.native'), process.platform === 'win32' ? 'junction' : 'dir');
  const found = await scanNativeSkillRoots({ purpose: 'found', home, agents: [{ agentId: 'reader', nativeRoots: {
    user: [['.native']], plugin: [['cache', '{plugin}', 'skills']],
  } }] });
  expect(found.items.map(({ scope, pluginOwned }) => ({ scope, pluginOwned }))).toEqual([
    { scope: 'user', pluginOwned: null }, { scope: 'plugin', pluginOwned: { pluginName: 'fixture' } },
  ]);
});
