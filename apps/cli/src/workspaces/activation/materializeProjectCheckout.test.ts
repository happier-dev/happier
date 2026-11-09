import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { runWithRealGitScmRuntime } from '../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import { createScmHostingProviderRuntimeServicesForTest } from '../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import { createBareRemoteRepository, makeCloneTargetDescription, makeProviderRegistry, makeRequest, runGit } from '../../../../../packages/plugins/scm-git/src/operations/repositoryCloneOperations.test-support';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createScmBackendRegistry } from '@/scm/registry';

import { materializeProjectCheckout } from './materializeProjectCheckout';
// Load real daemon SCM composition before timing filesystem realization.
await import('@/scm/workspace/workspaceCheckoutOperations');

const temporaryRoots: string[] = [];
const git = promisify(execFile);
function cloneRegistry(providers: ReturnType<typeof makeProviderRegistry>) {
  const registration = createGitScmBackendRuntimeRegistration();
  if (!registration.runtime) throw new Error('Git SCM test runtime is unavailable');
  return createScmBackendRegistry([createRegisteredScmBackendAdapter({
    definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
    executableDefinition: registration.runtime, registration,
    hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(providers),
  })]);
}
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'happier-project-open-'));
  temporaryRoots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('materializeProjectCheckout', () => {
  it('retains a hosting credential refusal through the real clone and project materialization path', async () => {
    const parent = await temporaryRoot();
    const description = makeCloneTargetDescription('/tmp/qa-auth-refusal.git');
    const failureCause = { phase: 'scm.repository_auth.materialization', errorClass: 'Error', errorCode: null, httpStatus: null };
    const remediation = { kind: 'auth_required', label: 'Sign in to GitHub on the selected machine.' };
    const registration = createGitScmBackendRuntimeRegistration();
    if (!registration.runtime) throw new Error('Git SCM test runtime is unavailable');
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
      executableDefinition: registration.runtime, registration,
      hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(makeProviderRegistry(description, {
        // External hosting-plugin boundary; SCM dispatch and project materialization stay real.
        describeCloneTargets: async () => { throw Object.assign(new Error('Credential unavailable'), {
          errorCode: 'REMOTE_AUTH_REQUIRED', failureCause, remediation }); },
      })),
    })]);
    const request = makeRequest(parent, '/tmp/qa-auth-refusal.git');
    await expect(runWithRealGitScmRuntime(() => materializeProjectCheckout({
      selector: { provider: request.provider, repository: request.repository, protocol: request.protocol }, registry,
      materialization: { kind: 'clone', destinationParentPath: parent, destinationDirectoryName: 'refused' },
    }))).rejects.toMatchObject({ code: 'REMOTE_AUTH_REQUIRED', failureCause, remediation });
  });

  it.each(['commit', 'branch'] as const)('clones a selected %s through the real Git checkout owner without moving branch refs', async selection => {
    const parent = await temporaryRoot();
    const remote = createBareRemoteRepository();
    temporaryRoots.push(join(remote, '..'));
    const source = join(remote, '..', 'source');
    const pin = runGit(source, ['rev-parse', 'HEAD']);
    await writeFile(join(source, 'README.md'), 'advanced upstream main\n');
    runGit(source, ['add', 'README.md']);
    runGit(source, ['commit', '-m', 'advance main']);
    runGit(source, ['push', remote, 'main']);
    const branchHead = runGit(source, ['rev-parse', 'HEAD']);
    const registration = createGitScmBackendRuntimeRegistration();
    if (!registration.runtime) throw new Error('Git SCM test runtime is unavailable');
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
      executableDefinition: registration.runtime, registration,
      hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(
        makeProviderRegistry(makeCloneTargetDescription(remote))),
    })]);
    const request = makeRequest(parent, remote, 'selected');
    const result = await runWithRealGitScmRuntime(() => materializeProjectCheckout({
      selector: { provider: request.provider, repository: request.repository, protocol: request.protocol },
      ref: selection === 'commit' ? pin : 'main', registry,
      materialization: { kind: 'clone', destinationParentPath: parent, destinationDirectoryName: 'selected' },
    }));
    expect(runGit(result.rootPath, ['rev-parse', 'HEAD'])).toBe(selection === 'commit' ? pin : branchHead);
    expect(runGit(result.rootPath, ['branch', '--show-current'])).toBe(selection === 'commit' ? '' : 'main');
    expect(runGit(result.rootPath, ['rev-parse', 'main'])).toBe(branchHead);
    expect(runGit(result.rootPath, ['rev-parse', 'origin/main'])).toBe(branchHead);
    expect(runGit(source, ['rev-parse', 'main'])).toBe(branchHead);
  });

  it.each(['plain', 'symlinked ancestor'] as const)('creates a missing destination parent, like the offered ~/src on a fresh Machine (%s)', async shape => {
    const home = await temporaryRoot();
    const real = await realpath(home);
    let base = real;
    if (shape === 'symlinked ancestor') {
      await mkdir(join(real, 'volume'));
      await symlink(join(real, 'volume'), join(real, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
      base = join(real, 'alias');
    }
    const remote = createBareRemoteRepository();
    temporaryRoots.push(join(remote, '..'));
    const request = makeRequest(join(base, 'src'), remote, 'gitignore');
    const result = await runWithRealGitScmRuntime(() => materializeProjectCheckout({
      selector: { provider: request.provider, repository: request.repository, protocol: request.protocol },
      registry: cloneRegistry(makeProviderRegistry(makeCloneTargetDescription(remote))),
      materialization: { kind: 'clone', destinationParentPath: join(base, 'src', 'nested'), destinationDirectoryName: 'gitignore' },
    }));
    const expected = join(real, shape === 'plain' ? '' : 'volume', 'src', 'nested', 'gitignore');
    expect(result).toMatchObject({ rootPath: expected, directory: expected, created: true });
    expect(runGit(expected, ['rev-parse', '--is-inside-work-tree'])).toBe('true');
  });

  it('leaves no folders behind when the clone is refused before its effect', async () => {
    const home = await temporaryRoot();
    const description = makeCloneTargetDescription('/tmp/qa-auth-refusal.git');
    const request = makeRequest(home, '/tmp/qa-auth-refusal.git');
    await expect(runWithRealGitScmRuntime(() => materializeProjectCheckout({
      selector: { provider: request.provider, repository: request.repository, protocol: request.protocol },
      registry: cloneRegistry(makeProviderRegistry(description, {
        // External hosting-plugin boundary; SCM dispatch and project materialization stay real.
        describeCloneTargets: async () => { throw Object.assign(new Error('Credential unavailable'), { errorCode: 'REMOTE_AUTH_REQUIRED' }); },
      })),
      materialization: { kind: 'clone', destinationParentPath: join(home, 'src'), destinationDirectoryName: 'refused' },
    }))).rejects.toMatchObject({ code: 'REMOTE_AUTH_REQUIRED' });
    await expect(access(join(home, 'src'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([['is a file', ''], ['sits under a file', 'child']] as const)('refuses a destination parent that %s and leaves the file alone', async (_shape, suffix) => {
    const home = await temporaryRoot();
    await writeFile(join(home, 'taken'), 'keep');
    const request = makeRequest(home, '/tmp/unused.git');
    await expect(runWithRealGitScmRuntime(() => materializeProjectCheckout({
      selector: { provider: request.provider, repository: request.repository, protocol: request.protocol },
      registry: cloneRegistry(makeProviderRegistry(makeCloneTargetDescription('/tmp/unused.git'))),
      materialization: { kind: 'clone', destinationParentPath: join(home, 'taken', suffix), destinationDirectoryName: 'repo' },
    }))).rejects.toMatchObject({ code: 'invalid_directory' });
    expect(await readFile(join(home, 'taken'), 'utf8')).toBe('keep');
  });

  it('materializes initial main at the reviewed pin without a second detached checkout', async () => {
    const parent = await temporaryRoot();
    const remote = createBareRemoteRepository();
    temporaryRoots.push(join(remote, '..'));
    const source = join(remote, '..', 'source');
    const pin = runGit(source, ['rev-parse', 'HEAD']);
    await writeFile(join(source, 'README.md'), 'advanced upstream main\n');
    runGit(source, ['add', 'README.md']);
    runGit(source, ['commit', '-m', 'advance upstream main']);
    runGit(source, ['push', remote, 'main']);
    const newer = runGit(source, ['rev-parse', 'HEAD']);
    const registration = createGitScmBackendRuntimeRegistration();
    if (!registration.runtime) throw new Error('Git SCM test runtime is unavailable');
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
      executableDefinition: registration.runtime, registration,
      hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(
        makeProviderRegistry(makeCloneTargetDescription(remote))),
    })]);
    const request = makeRequest(parent, remote, 'starter');
    const result = await runWithRealGitScmRuntime(() => materializeProjectCheckout({
      selector: { provider: request.provider, repository: request.repository, protocol: request.protocol },
      ref: pin,
      materialization: { kind: 'clone', destinationParentPath: parent, destinationDirectoryName: 'starter',
        initialCheckout: { branch: 'main', commit: pin } },
      registry,
    }));
    expect(runGit(result.rootPath, ['branch', '--show-current'])).toBe('main');
    expect(runGit(result.rootPath, ['rev-parse', 'main'])).toBe(pin);
    expect(runGit(result.rootPath, ['rev-parse', 'HEAD'])).toBe(pin);
    expect(runGit(source, ['rev-parse', 'HEAD'])).toBe(newer);
  });

  it('realizes a worktree through the registered Git owner and preserves a selected nested directory', async () => {
    const sandbox = await temporaryRoot();
    const root = join(sandbox, 'repository');
    await mkdir(join(root, 'packages', 'app'), { recursive: true });
    await writeFile(join(root, 'packages', 'app', 'README.md'), 'selected package');
    await git('git', ['init', '-b', 'main'], { cwd: root });
    await git('git', ['add', '.'], { cwd: root });
    await git('git', ['-c', 'user.name=Open test', '-c', 'user.email=open@example.invalid', 'commit', '-m', 'initial'], { cwd: root });
    const registration = createGitScmBackendRuntimeRegistration();
    if (!registration.runtime) throw new Error('Git SCM test runtime is unavailable');
    const backend = createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
      executableDefinition: registration.runtime, registration,
    });
    const target = join(sandbox, 'worktree');
    const result = await runWithRealGitScmRuntime(() => materializeProjectCheckout({
      sourceDirectory: join(root, 'packages', 'app'), sourceRootPath: root,
      materialization: { kind: 'worktree', targetPath: target,
        checkout: { kind: 'git_worktree', displayName: 'open-feature', baseRef: 'main', branchMode: 'new' } },
      registry: createScmBackendRegistry([backend]),
    }));
    expect(result).toEqual({ rootPath: target, directory: join(target, 'packages', 'app'), created: true });
    expect(await readFile(join(result.directory, 'README.md'), 'utf8')).toBe('selected package');
    expect((await git('git', ['branch', '--show-current'], { cwd: target })).stdout.trim()).toBe('open-feature');
  });

  it('attaches a contained folder without running repository setup or creating a Session', async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, 'packages', 'app'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { setup: 'exit 99' } }));
    const result = await materializeProjectCheckout({
      sourceDirectory: root, sourceRootPath: root,
      subdir: 'packages/app', materialization: { kind: 'attach' },
    });
    expect(result).toEqual({ rootPath: root, directory: join(root, 'packages', 'app'), created: false });
    expect(await readFile(join(root, 'package.json'), 'utf8')).toContain('exit 99');
  });

  it('refuses traversal and symlink escape instead of silently selecting the checkout root', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const subdir of ['../outside', 'escape']) {
      await expect(materializeProjectCheckout({
        sourceDirectory: root, sourceRootPath: root,
        subdir, materialization: { kind: 'attach' },
      })).rejects.toMatchObject({ code: 'invalid_directory' });
    }
  });

  it('names a subfolder the checkout lacks apart from an unsafe path', async () => {
    const root = await temporaryRoot();
    await expect(materializeProjectCheckout({
      sourceDirectory: root, sourceRootPath: root,
      subdir: 'not-in-the-repository', materialization: { kind: 'attach' },
    })).rejects.toMatchObject({ code: 'repository_subfolder_missing' });
  });

  it('accepts an authorized root alias while retaining its physical identity', async () => {
    const root = await temporaryRoot();
    const aliases = await temporaryRoot();
    const alias = join(aliases, 'checkout');
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await materializeProjectCheckout({ sourceDirectory: alias, materialization: { kind: 'attach' } }))
      .toEqual({ rootPath: root, directory: root, created: false });
  });

  it('does not create a missing attach path or run after pre-effect cancellation', async () => {
    const root = await temporaryRoot();
    await expect(materializeProjectCheckout({
      sourceDirectory: join(root, 'missing'), materialization: { kind: 'attach' },
    })).rejects.toMatchObject({ code: 'invalid_directory' });
    const controller = new AbortController();
    controller.abort();
    await expect(materializeProjectCheckout({
      sourceDirectory: root, materialization: { kind: 'attach' }, signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
