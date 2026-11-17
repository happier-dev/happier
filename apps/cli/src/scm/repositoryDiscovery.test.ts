import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PLUGIN_MANIFEST, activate, activateAccount } from '@happier-dev/plugins-scm-github';
import { ScmHostingProviderContributionSchema } from '@happier-dev/protocol';

import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { OS_USER_FILESYSTEM_ACCESS_POLICY } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { createScmHostingProviderRegistry } from './hostingProviders/registry';
import { discoverScmRepositories } from './repositoryDiscovery';

const temporaryDirectories: string[] = [];
let testkit: Awaited<ReturnType<typeof createPluginTestkit>>;
let registry: ReturnType<typeof createScmHostingProviderRegistry>;

beforeAll(async () => {
  testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount } });
  const registration = testkit.registration('scmHostingProviders', 'github');
  if (!registration) throw new Error('Bundled GitHub hosting provider did not activate');
  registry = createScmHostingProviderRegistry({
    providers: (PLUGIN_MANIFEST.contributes.scmHostingProviders ?? []).map(provider => {
      const definition = ScmHostingProviderContributionSchema.parse(provider);
      return { ...definition, pluginId: PLUGIN_MANIFEST.id,
        displayName: typeof definition.title === 'string' ? definition.title : definition.title.fallback };
    }),
    runtimeRegistrations: [{ pluginId: PLUGIN_MANIFEST.id, occurrenceId: 'discovery-test',
      registration: { id: 'github', ...registration } }],
  });
});

afterAll(async () => { await testkit?.dispose(); });
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'happier-discover-'));
  temporaryDirectories.push(directory);
  return directory;
}

function git(directory: string, ...args: string[]) {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
}

async function repository(directory: string, origin?: string) {
  await mkdir(directory, { recursive: true });
  git(directory, 'init', '--quiet');
  if (origin) git(directory, 'config', 'remote.origin.url', origin);
}

describe('discoverScmRepositories on the real filesystem and Git boundary', () => {
  it('finds only immediate-child normalized origin matches without changing dirty or untracked work', async () => {
    const directory = await temporaryDirectory();
    const folder = join(directory, 'selected');
    const matching = join(folder, 'unfinished');
    const unrelated = join(folder, 'unrelated');
    const malformed = join(folder, 'invalid-origin');
    const noOrigin = join(folder, 'no-origin');
    await repository(matching, 'git@github.com:Happier-Dev/Onboarding.git');
    await repository(unrelated, 'https://github.com/elsewhere/unrelated.git');
    await repository(malformed, 'not a valid remote');
    await repository(noOrigin);
    await repository(join(folder, 'nested', 'too-deep'), 'https://github.com/happier-dev/onboarding.git');
    await writeFile(join(matching, 'tracked.bin'), Buffer.from([0, 1, 2]));
    git(matching, 'add', 'tracked.bin');
    git(matching, '-c', 'user.name=Discovery Test', '-c', 'user.email=discovery@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
    const dirtyBytes = Buffer.from([0, 255, 13, 10, 7, 128]);
    const untrackedBytes = Buffer.from([255, 0, 128]);
    await writeFile(join(matching, 'tracked.bin'), dirtyBytes);
    await writeFile(join(matching, 'untracked.bin'), untrackedBytes);
    const configBefore = await readFile(join(matching, '.git', 'config'));
    const indexBefore = await readFile(join(matching, '.git', 'index'));
    const headBefore = git(matching, 'rev-parse', 'HEAD');
    const statusBefore = git(matching, 'status', '--porcelain');
    // Positive fixture control: Git itself sees both kinds of unfinished work and the configured origin.
    expect(statusBefore).toContain(' M tracked.bin');
    expect(statusBefore).toContain('?? untracked.bin');
    expect(git(matching, 'config', '--local', '--get', 'remote.origin.url').trim())
      .toBe('git@github.com:Happier-Dev/Onboarding.git');

    const tracePath = join(directory, 'git-events.jsonl');
    const result = await runAddedHostedSession({
      environment: { ...process.env, GIT_TRACE2_EVENT: tracePath }, workingDirectory: directory, end() {},
    }, () => discoverScmRepositories({
      request: { cwd: folder, repositories: [{ kind: 'github', deployment: 'https://github.com',
        repository: 'happier-dev/onboarding' }] }, workingDirectory: directory,
      accessPolicy: OS_USER_FILESYSTEM_ACCESS_POLICY, hostingProviderRegistry: registry,
    }));

    expect(result).toEqual({ success: true,
      matches: [{ rootPath: matching, repositoryIdentity: { kind: 'github', deployment: 'https://github.com',
        repository: 'happier-dev/onboarding' } }],
      skipped: [{ rootPath: malformed, origin: { success: true, kind: 'invalid' } }],
    });
    const events = (await readFile(tracePath, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { event: string; argv?: string[] });
    const commands = events.filter(event => event.event === 'start').map(event => event.argv?.slice(1));
    // One read per immediate-child repository; neither a recursive scan nor a Git writer is admitted.
    expect(commands).toEqual(Array.from({ length: 4 }, () => ['config', '--local', '--get', 'remote.origin.url']));
    expect(await readFile(join(matching, 'tracked.bin'))).toEqual(dirtyBytes);
    expect(await readFile(join(matching, 'untracked.bin'))).toEqual(untrackedBytes);
    expect(await readFile(join(matching, '.git', 'config'))).toEqual(configBefore);
    expect(await readFile(join(matching, '.git', 'index'))).toEqual(indexBefore);
    expect(git(matching, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(matching, 'status', '--porcelain')).toBe(statusBefore);
  });

  it('preserves the native failure code when the selected folder is missing', async () => {
    const directory = await temporaryDirectory();
    const missing = join(directory, 'moved-folder');
    const nativeError = await readdir(missing).catch((error: unknown) => error);
    expect(nativeError).toMatchObject({ code: 'ENOENT' });
    const result = await discoverScmRepositories({ request: { cwd: missing, repositories: [] },
      workingDirectory: directory, accessPolicy: OS_USER_FILESYSTEM_ACCESS_POLICY,
      hostingProviderRegistry: registry });
    expect(result).toMatchObject({ success: false, errorCode: 'ENOENT', error: expect.any(String) });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'preserves the native failure code when the selected folder is unreadable', async () => {
      const directory = await temporaryDirectory();
      const unreadable = join(directory, 'unreadable');
      await mkdir(unreadable);
      await chmod(unreadable, 0);
      try {
        const nativeError = await readdir(unreadable).catch((error: unknown) => error);
        expect(nativeError).toMatchObject({ code: 'EACCES' });
        const result = await discoverScmRepositories({ request: { cwd: unreadable, repositories: [] },
          workingDirectory: directory, accessPolicy: OS_USER_FILESYSTEM_ACCESS_POLICY,
          hostingProviderRegistry: registry });
        expect(result).toMatchObject({ success: false, errorCode: 'EACCES', error: expect.any(String) });
      } finally {
        await chmod(unreadable, 0o700);
      }
    },
  );
});
