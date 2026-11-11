import { afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DeploymentMoveToRepositoryResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { normalizeStoredComposeDefinitionInput } from '@/workspaces/projectSetup/nativeComposeSource';
import { runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { createDeploymentMoveFixture } from './deploymentMove.testkit';

afterEach(() => vi.unstubAllEnvs());
it.each([{ edited: false, cold: false, storedChanged: false, attach: false, create: false },
  { edited: true, cold: false, storedChanged: false, attach: false, create: false },
  { edited: true, cold: true, storedChanged: false, attach: false, create: false },
  { edited: false, cold: false, storedChanged: true, attach: false, create: false },
  { edited: false, cold: false, storedChanged: false, attach: true, create: false },
  { edited: false, cold: false, storedChanged: false, attach: true, create: true }])(
  'keeps stored authoritative, then admits actual merged bytes (edited=$edited cold=$cold storedChanged=$storedChanged attach=$attach create=$create)', async ({ edited, cold, storedChanged, attach, create }) => {
  const fixture = await createDeploymentMoveFixture({ attach, create });
  const { git, remote, forge, repository, detail, initial, executeMove, sourceRepository } = fixture;
  let { input } = fixture;
  try {
    const preview = await executeMove(input);
    expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true, result: { kind: create ? 'previewCreate' : 'preview',
      review: { ...(!create ? { before: 'base\n' } : {}), document: initial.document } } });
    expect(forge.repositoryCreated()).toBe(!create);
    await writeFile(join(git.rootPath, 'personal.txt'), 'Personal work');
    const opened = await executeMove({ ...input, mode: 'apply' });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) throw new Error(opened.errorCode);
    const result = DeploymentMoveToRepositoryResultV1Schema.parse(opened.result);
    expect(result.kind, JSON.stringify(result)).toBe('pullRequest');
    if (result.kind !== 'pullRequest') throw new Error(JSON.stringify(result));
    if (create) {
      expect(result.repository).toMatchObject({ repository, baseBranch: 'main', workspace: input.workspace });
      if (!result.repository) throw new Error('Created repository placement is missing');
      input = { ...input, ...result.repository };
      delete input.createRepository;
    }
    expect(detail.content.definition).toEqual(initial);
    const continuation = result.continuation;
    expect(fixture.readSource().repository).toMatchObject(sourceRepository);
    expect(await readFile(join(git.rootPath, 'personal.txt'), 'utf8')).toBe('Personal work');
    // A merge commit differs from the exported head; it can also contain a reviewed edit.
    runScmExecutable(git.rootPath, 'git', ['merge', '--no-ff', continuation.headCommit, '-m', 'Merge definition']);
    if (edited) {
      await writeFile(join(git.rootPath, git.trackedPath), 'services:\n  app:\n    image: nginx:2\n    env_file: runtime.env\n');
      await writeFile(join(git.rootPath, 'runtime.env'), 'PUBLIC_VALUE=two\n');
      runScmExecutable(git.rootPath, 'git', ['add', git.trackedPath, 'runtime.env']);
      runScmExecutable(git.rootPath, 'git', ['commit', '-m', 'Reviewed merge edit']);
    }
    const mergedCommit = runScmExecutable(git.rootPath, 'git', ['rev-parse', 'HEAD']);
    runScmExecutable(git.rootPath, 'git', ['push', remote.remotePath, `${input.baseBranch}:${input.baseBranch}`]);
    forge.setPullRequest({ ...continuation.pullRequest, state: 'merged', headSha: continuation.headCommit, mergeCommitSha: mergedCommit });
    detail.content = { ...detail.content, name: 'Renamed while PR open' };
    if (storedChanged) {
      const changed = await normalizeStoredComposeDefinitionInput({ from: 'compose', document: 'services:\n  replacement:\n    image: nginx:3\n',
        profiles: [], services: ['replacement'] });
      detail.content = { ...detail.content, definition: { ...changed, contentRevision: initial.contentRevision + 1 } };
    }
    const currentStored = detail.content.definition;
    detail.environment.revision += 1;
    const resumed = cold ? { pullRequestReference: { number: continuation.pullRequest.number } } : { continuation };
    const continued = await executeMove({ ...input, mode: cold ? 'preview' : 'apply', ...resumed });
    expect(continued.ok, JSON.stringify(continued)).toBe(true);
    if (!continued.ok) throw new Error(continued.errorCode);
    let settled = DeploymentMoveToRepositoryResultV1Schema.parse(continued.result);
    if (edited || storedChanged) {
      expect(settled.kind).toBe('reviewMerged');
      expect(detail.content.definition).toEqual(currentStored);
      if (settled.kind !== 'reviewMerged') throw new Error('Expected explicit merged review');
      if (edited) expect(settled.review.mergedPublicFiles).toEqual([{ path: 'runtime.env', content: 'PUBLIC_VALUE=two\n' }]);
      const accepted = await executeMove({ ...input, mode: 'apply', ...resumed,
        useMergedVersion: settled.review });
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) throw new Error(accepted.errorCode);
      settled = DeploymentMoveToRepositoryResultV1Schema.parse(accepted.result);
    }
    expect(settled).toMatchObject({ kind: 'switched', commitSha: mergedCommit });
    expect(mergedCommit).not.toBe(continuation.headCommit);
    expect(detail.content).toMatchObject({ name: 'Renamed while PR open', definition: { kind: 'repository', ref: mergedCommit,
      compose: { path: git.trackedPath, services: ['app'] } } });
    expect(detail.content.definition).not.toHaveProperty('document');
  } finally {
    await fixture.cleanup();
  }
});
