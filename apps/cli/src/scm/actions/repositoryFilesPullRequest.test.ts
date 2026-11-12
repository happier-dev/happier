import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLocalScmRepositoryFixture, runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { createScmHostingProviderRuntimeServicesForTest } from '../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import { commitGuardedFileReplace } from '@/rpc/handlers/fileSystem/commitGuardedFileReplace';
import { executeScmActionOperation } from './executeScmActionOperation';
import { prepareRepositoryFilesPullRequest, openRepositoryFilesPullRequest } from './repositoryFilesPullRequest';
import { createAdmittedCheckoutRepositoryFiles } from '@/deployments/admittedCheckoutRepositoryFiles';
import { createDeploymentGitRegistry } from '@/deployments/targets/ownServer/exactCommitRelease.testkit';
import { createGithubForgeHttpFixture } from '@/testkit/scm/githubForgeHttp';
import { createLocalGitForgeHostConfig, createLocalGitForgeTransport } from '@/testkit/scm/localGitForgeTransport';
import { createBareGitRemoteFixture } from '@/testkit/scm/scmBackendContractFixtures';

it('retains a typed HTTPS push refusal after committing the reviewed files', async () => {
  const git = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'definition-pr-denied-' });
  const remote = createBareGitRemoteFixture('definition-pr-denied-remote-');
  const url = 'https://github.com/octocat/Hello-World.git';
  const forge = createGithubForgeHttpFixture({ nameWithOwner: 'octocat/Hello-World', cloneUrl: url });
  let deniedRequests = 0;
  // Native credential custody launches Git outside the injected workspace runner.
  // Redirect that OS transport too, to a real local HTTP denial boundary.
  const server = createServer((_request, response) => {
    deniedRequests += 1;
    response.writeHead(403); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP boundary address');
  const hostConfig = await createLocalGitForgeHostConfig({ url, remotePath: `http://127.0.0.1:${address.port}/repo.git` });
  vi.stubEnv('GIT_CONFIG_GLOBAL', hostConfig.path);
  const transport = createLocalGitForgeTransport({ url, remotePath: remote.remotePath });
  const registry = createDeploymentGitRegistry({ resolveScmHostingProviderRegistry: async () => forge.hosting }, transport);
  try {
    runScmExecutable(git.rootPath, 'git', ['remote', 'add', 'origin', url]);
    runScmExecutable(git.rootPath, 'git', ['push', remote.remotePath, `${git.branchName}:${git.branchName}`]);
    runScmExecutable(git.rootPath, 'git', ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${git.branchName}`]);
    const host = createAdmittedCheckoutRepositoryFiles({ root: git.rootPath, context: {}, registry });
    const review = await prepareRepositoryFilesPullRequest({ cwd: git.rootPath, baseCommit: git.headCommit,
      baseBranch: git.branchName, branchName: 'happier/move-denied', title: 'Move definition',
      files: [{ path: git.trackedPath, content: 'services: {app: {image: nginx}}\n' }] }, host);
    const result = await openRepositoryFilesPullRequest(review, host);
    expect(deniedRequests).toBeGreaterThan(0);
    expect(result).toMatchObject({ kind: 'partial', stage: 'pullRequest', errorCode: 'REMOTE_AUTH_REQUIRED',
      headCommit: expect.stringMatching(/^[a-f0-9]{40,64}$/) });
    expect(runScmExecutable(git.rootPath, 'git', ['rev-parse', 'HEAD'])).toBe(git.headCommit);
    expect(runScmExecutable(remote.remotePath, 'git', ['for-each-ref', '--format=%(refname)', 'refs/heads/happier/'])).toBe('');
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await hostConfig.cleanup();
    await rm(git.rootPath, { recursive: true, force: true });
    await rm(remote.remotePath, { recursive: true, force: true });
  }
});

describe('repository definition pull request composition', () => {
  it.each([false, true])('commits the exact reviewed files and removals on its own worktree (remove=%s)', async remove => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'definition-pr-' });
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({ definition: { id: 'git', kind: 'git' },
      qualifiedId: 'happier.scm.backend.git/git', executableDefinition: registration.runtime!, registration,
      hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest() })]);
    const tracked = await readFile(join(fixture.rootPath, fixture.trackedPath), 'utf8');
    if (remove) {
      await writeFile(join(fixture.rootPath, 'obsolete.conf'), 'old setting');
      runScmExecutable(fixture.rootPath, 'git', ['add', 'obsolete.conf']);
      runScmExecutable(fixture.rootPath, 'git', ['commit', '-m', 'Original public file']);
    }
    const baseCommit = runScmExecutable(fixture.rootPath, 'git', ['rev-parse', 'HEAD']);
    // The missing Forge is a real external capability failure. Native work up to
    // that boundary must be recoverable without changing the person's checkout.
    const host = {
      executeScm: (actionId: Parameters<typeof executeScmActionOperation>[0]['actionId'], input: unknown) =>
        executeScmActionOperation({ actionId, input, registry, workingDirectory: fixture.rootPath }),
      writeFile: (input: { rootPath: string; path: string; content: string; expectedHash: string | null }) =>
        commitGuardedFileReplace({ destPath: join(input.rootPath, input.path), expectation: input.expectedHash,
          source: { kind: 'bytes', bytes: Buffer.from(input.content, 'base64') } }),
      deleteFile: async (input: { rootPath: string; path: string; recursive: false }) => {
        await rm(join(input.rootPath, input.path));
        return { success: true as const };
      },
    };
    let ownedWorktree: string | undefined;
    try {
      const review = await prepareRepositoryFilesPullRequest({ cwd: fixture.rootPath, baseCommit,
        baseBranch: fixture.branchName, branchName: 'definition-export', title: 'Export definition',
        files: [{ path: fixture.trackedPath, content: 'services:\n  app:\n    image: nginx\n' },
          ...(remove ? [{ path: 'obsolete.conf', content: null }] : [])] }, host);
      expect(review.files[0]).toMatchObject({ before: tracked, content: 'services:\n  app:\n    image: nginx\n' });
      await writeFile(join(fixture.rootPath, 'personal.txt'), 'Uncommitted personal work');
      const result = await openRepositoryFilesPullRequest(review, host);
      expect(result.kind).toBe('partial');
      if (result.kind !== 'partial') throw new Error('The fixture has no Forge');
      ownedWorktree = result.worktree?.path;
      expect(result.stage).toBe('pullRequest');
      expect(result.errorCode).toBe('FEATURE_UNSUPPORTED');
      expect(ownedWorktree).toBeTruthy();
      expect(result.headCommit).toMatch(/^[a-f0-9]{40,64}$/);
      expect(runScmExecutable(fixture.rootPath, 'git', ['rev-parse', 'HEAD'])).toBe(baseCommit);
      expect(await readFile(join(fixture.rootPath, fixture.trackedPath), 'utf8')).toBe(tracked);
      expect(await readFile(join(fixture.rootPath, 'personal.txt'), 'utf8')).toBe('Uncommitted personal work');
      expect(runScmExecutable(fixture.rootPath, 'git', ['show', `${result.headCommit}:${fixture.trackedPath}`]))
        .toBe('services:\n  app:\n    image: nginx');
      expect(runScmExecutable(fixture.rootPath, 'git', ['diff-tree', '--no-commit-id', '--name-only', '-r', result.headCommit!]).split('\n').sort())
        .toEqual([fixture.trackedPath, ...(remove ? ['obsolete.conf'] : [])].sort());
      if (remove) {
        expect(runScmExecutable(fixture.rootPath, 'git', ['ls-tree', '--name-only', result.headCommit!, 'obsolete.conf'])).toBe('');
        expect(await readFile(join(fixture.rootPath, 'obsolete.conf'), 'utf8')).toBe('old setting');
      }
      // Retrying the existing PR step keeps the same branch/commit; no new export.
      const resumed = await openRepositoryFilesPullRequest(review, host, result);
      expect(resumed).toMatchObject({ kind: 'partial', stage: 'pullRequest', headCommit: result.headCommit,
        worktree: result.worktree });
    } finally {
      if (ownedWorktree) await rm(ownedWorktree, { recursive: true, force: true });
      await rm(fixture.rootPath, { recursive: true, force: true });
    }
  });
});
