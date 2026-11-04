import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'happier-project-open-'));
  temporaryRoots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('materializeProjectCheckout', () => {
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
