import { describe, expect, it } from 'vitest';
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
