import { afterAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildWorktreeRelativePath, SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN } from '@happier-dev/protocol';

import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createLocalScmRepositoryFixture, runScmExecutable } from '@/scm/contracts/scmBackendContractFixtures';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { createEmptyScmHostingProviderRegistry, createScmHostingProviderRuntimeServicesForTest } from '../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import { executeScmActionOperation } from './executeScmActionOperation';

describe('SCM worktree filesystem authority', () => {
  const registration = createGitScmBackendRuntimeRegistration();
  const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
    definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.backend.git/git',
    executableDefinition: registration.runtime!, registration,
    hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(),
  })]);
  const repositories: string[] = [];

  afterAll(async () => {
    await Promise.all(repositories.map((path) => rm(path, { recursive: true, force: true })));
  });

  it('refuses removal outside restricted roots and preserves the dirty linked worktree', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-scm-worktree-policy-' });
    const outsidePath = `${fixture.rootPath}-outside`;
    repositories.push(fixture.rootPath, outsidePath);
    runScmExecutable(fixture.rootPath, 'git', ['worktree', 'add', '--detach', outsidePath]);
    const dirtyPath = join(outsidePath, fixture.trackedPath);
    await writeFile(dirtyPath, 'unsaved work must survive\n');

    const result = await executeScmActionOperation({
      actionId: 'scm.worktree.remove',
      input: { cwd: fixture.rootPath, worktreePath: outsidePath, confirmed: true, authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN },
      registry, workingDirectory: fixture.rootPath,
      accessPolicy: { kind: 'restrictedRoots', roots: [fixture.rootPath] },
    });
    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    expect(await readFile(dirtyPath, 'utf8')).toBe('unsaved work must survive\n');
    expect(runScmExecutable(fixture.rootPath, 'git', ['worktree', 'list', '--porcelain'])).toContain(outsidePath);
  });

  it('resolves an allowed relative removal target against the selected repository', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-scm-worktree-relative-' });
    repositories.push(fixture.rootPath);
    const worktreePath = join(fixture.rootPath, 'linked');
    runScmExecutable(fixture.rootPath, 'git', ['worktree', 'add', '--detach', worktreePath]);
    await expect(executeScmActionOperation({
      actionId: 'scm.worktree.remove',
      input: { cwd: fixture.rootPath, worktreePath: 'linked', confirmed: true, authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN },
      registry, workingDirectory: fixture.rootPath,
      accessPolicy: { kind: 'restrictedRoots', roots: [fixture.rootPath] },
    })).resolves.toMatchObject({ success: true });
    expect(runScmExecutable(fixture.rootPath, 'git', ['worktree', 'list', '--porcelain'])).not.toContain(worktreePath);
  });

  it.each(['empty', 'populated'] as const)('creates and reuses a worktree inside the restricted root (%s)', async (kind) => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-scm-worktree-allowed-' });
    repositories.push(fixture.rootPath);
    const worktreePath = join(fixture.rootPath, buildWorktreeRelativePath('allowed'));
    if (kind === 'populated') {
      await mkdir(worktreePath, { recursive: true });
      await writeFile(join(worktreePath, 'imported.txt'), 'imported contents\n');
    }
    for (let invocation = 0; invocation < 2; invocation += 1) {
      await expect(executeScmActionOperation({
        actionId: 'scm.worktree.create', input: { cwd: fixture.rootPath, displayName: 'allowed' },
        registry, workingDirectory: fixture.rootPath,
        accessPolicy: { kind: 'restrictedRoots', roots: [fixture.rootPath] },
      })).resolves.toMatchObject({ success: true, worktreePath, branchName: 'allowed' });
    }
    expect(runScmExecutable(fixture.rootPath, 'git', ['worktree', 'list', '--porcelain'])).toContain(worktreePath);
    if (kind === 'populated') {
      expect(await readFile(join(worktreePath, 'imported.txt'), 'utf8')).toBe('imported contents\n');
    }
  });

  it.each(['linked_root', 'symlink_destination'] as const)('refuses creation outside restricted roots (%s)', async (kind) => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-scm-worktree-create-policy-' });
    const outsidePath = `${fixture.rootPath}-outside`;
    repositories.push(fixture.rootPath, outsidePath);
    let cwd = fixture.rootPath;
    if (kind === 'linked_root') {
      runScmExecutable(fixture.rootPath, 'git', ['worktree', 'add', '--detach', outsidePath]);
      cwd = outsidePath;
    } else {
      const worktreeParent = dirname(join(fixture.rootPath, buildWorktreeRelativePath('blocked')));
      await mkdir(dirname(worktreeParent), { recursive: true });
      await mkdir(outsidePath);
      await symlink(outsidePath, worktreeParent, process.platform === 'win32' ? 'junction' : 'dir');
    }
    await expect(executeScmActionOperation({
      actionId: 'scm.worktree.create', input: { cwd, displayName: 'blocked' },
      registry, workingDirectory: cwd,
      accessPolicy: { kind: 'restrictedRoots', roots: [cwd] },
    })).resolves.toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    expect(runScmExecutable(fixture.rootPath, 'git', ['worktree', 'list', '--porcelain']))
      .not.toContain(join(fixture.rootPath, buildWorktreeRelativePath('blocked')));
    expect(runScmExecutable(fixture.rootPath, 'git', ['branch', '--list', 'blocked'])).toBe('');
  });

  it('refuses an out-of-root materialization scratch directory and preserves its contents', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-scm-worktree-scratch-policy-' });
    repositories.push(fixture.rootPath);
    const targetPath = join(fixture.rootPath, buildWorktreeRelativePath('blocked'));
    const scratchPath = `${targetPath}.happier-materialize-tmp`;
    await mkdir(targetPath, { recursive: true });
    await writeFile(join(targetPath, 'imported.txt'), 'imported contents\n');
    await mkdir(scratchPath);
    const dirtyPath = join(scratchPath, 'unsaved.txt');
    await writeFile(dirtyPath, 'unsaved sibling contents\n');

    await expect(executeScmActionOperation({
      actionId: 'scm.worktree.create', input: { cwd: fixture.nestedPath, displayName: 'blocked' },
      registry, workingDirectory: fixture.nestedPath,
      accessPolicy: { kind: 'restrictedRoots', roots: [fixture.nestedPath, targetPath] },
    })).resolves.toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    expect(await readFile(dirtyPath, 'utf8')).toBe('unsaved sibling contents\n');
    expect(runScmExecutable(fixture.rootPath, 'git', ['branch', '--list', 'blocked'])).toBe('');
  });

  it.each(['derived', 'scratch'] as const)('refuses prepared review workspace %s paths before fetch or branch mutation', async (kind) => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-scm-review-policy-' });
    repositories.push(fixture.rootPath);
    const sourceUrl = 'https://forge.example/contributor/repository.git';
    runScmExecutable(fixture.rootPath, 'git', ['remote', 'add', 'source', sourceUrl]);
    runScmExecutable(fixture.rootPath, 'git', ['config', `url.file://${fixture.rootPath}.insteadOf`, sourceUrl]);
    const targetPath = join(fixture.rootPath, buildWorktreeRelativePath('blocked'));
    const scratchPath = `${targetPath}.happier-materialize-tmp`;
    if (kind === 'scratch') {
      await mkdir(targetPath, { recursive: true });
      await writeFile(join(targetPath, 'imported.txt'), 'imported contents\n');
      await mkdir(scratchPath);
      await writeFile(join(scratchPath, 'unsaved.txt'), 'unsaved sibling contents\n');
    }
    const input = {
      cwd: fixture.nestedPath, displayName: 'blocked',
      sourceTip: {
        repository: { kind: 'github', deployment: 'https://forge.example', repository: 'contributor/repository' },
        cloneUrl: sourceUrl, branch: 'blocked', sourceHeadSha: fixture.headCommit,
        fetchRef: `refs/heads/${fixture.branchName}`,
      },
    };
    const result = await executeScmActionOperation({
      actionId: 'scm.reviewWorkspace.materializePrepared', input,
      registry, workingDirectory: fixture.nestedPath,
      accessPolicy: { kind: 'restrictedRoots', roots: [fixture.nestedPath, ...(kind === 'scratch' ? [targetPath] : [])] },
    });
    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    await expect(readFile(join(fixture.rootPath, '.git', 'FETCH_HEAD'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runScmExecutable(fixture.rootPath, 'git', ['branch', '--list', 'blocked'])).toBe('');
    if (kind === 'scratch') {
      expect(await readFile(join(scratchPath, 'unsaved.txt'), 'utf8')).toBe('unsaved sibling contents\n');
    }
    await expect(executeScmActionOperation({
      actionId: 'scm.reviewWorkspace.materializePrepared', input,
      registry, workingDirectory: fixture.nestedPath,
      accessPolicy: { kind: 'restrictedRoots', roots: [fixture.rootPath] },
    })).resolves.toMatchObject({ success: true, targetPath, created: true });
    // Reuse needs no scratch mutation, even when only the checkout itself is allowed.
    await expect(executeScmActionOperation({
      actionId: 'scm.reviewWorkspace.materializePrepared', input,
      registry, workingDirectory: fixture.nestedPath,
      accessPolicy: { kind: 'restrictedRoots', roots: [fixture.nestedPath, targetPath] },
    })).resolves.toMatchObject({ success: true, targetPath, created: false });
  });

  it.each(['nested', 'linked', 'registration', 'scratch'] as const)('refuses PR worktree %s paths before fetch or branch mutation', async (kind) => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-scm-pr-policy-' });
    const outsidePath = `${fixture.rootPath}-outside`;
    repositories.push(fixture.rootPath, outsidePath);
    runScmExecutable(fixture.rootPath, 'git', ['remote', 'add', 'origin', fixture.rootPath]);
    const branch = 'blocked-pr';
    const targetPath = join(kind === 'linked' ? outsidePath : fixture.rootPath, buildWorktreeRelativePath(branch));
    const scratchPath = `${targetPath}.happier-materialize-tmp`;
    let cwd = fixture.nestedPath;
    if (kind === 'linked' || kind === 'registration') {
      runScmExecutable(fixture.rootPath, 'git', kind === 'registration'
        ? ['worktree', 'add', '-b', branch, outsidePath]
        : ['worktree', 'add', '--detach', outsidePath]);
      await writeFile(join(outsidePath, 'unsaved.txt'), 'linked contents\n');
      if (kind === 'linked') {
        cwd = join(outsidePath, 'nested');
        await mkdir(cwd, { recursive: true });
      }
    }
    if (kind === 'scratch') {
      await mkdir(targetPath, { recursive: true });
      await writeFile(join(targetPath, 'imported.txt'), 'imported contents\n');
      await mkdir(scratchPath);
      await writeFile(join(scratchPath, 'unsaved.txt'), 'scratch contents\n');
    }
    // The hosting provider is the external metadata boundary. Git, adapters,
    // dispatch and host filesystem policy remain real.
    const provider = { id: 'scm.github', kind: 'github' as const, displayName: 'GitHub',
      baseUrl: 'https://forge.example', remoteName: 'origin', urlSafety: { allowedSchemes: ['https:'] } };
    const hostingRegistry = {
      ...createEmptyScmHostingProviderRegistry(),
      detectRemote: () => ({ kind: 'resolved' as const, providerId: provider.id, provider }),
      getPullRequestCheckout: () => ({ resolvePullRequestCheckoutReference: async () => ({
        pullRequest: null, branch, remoteRef: `refs/heads/${fixture.branchName}`, headSha: fixture.headCommit,
      }) }),
    };
    const prRegistry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.backend.git/git',
      executableDefinition: registration.runtime!, registration,
      hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(hostingRegistry),
    })]);
    const input = { cwd, sourcePath: cwd, prReference: { number: 7 }, mode: 'worktree' };
    const branchesBefore = runScmExecutable(fixture.rootPath, 'git', ['branch', '--list']);
    const worktreesBefore = runScmExecutable(fixture.rootPath, 'git', ['worktree', 'list', '--porcelain']);
    const fetchHeadPath = resolve(cwd, runScmExecutable(cwd, 'git', ['rev-parse', '--git-path', 'FETCH_HEAD']));
    await expect(executeScmActionOperation({
      actionId: 'scm.pullRequest.prepareWorktree', input, registry: prRegistry, workingDirectory: cwd,
      accessPolicy: { kind: 'restrictedRoots', roots: [cwd, ...(['scratch', 'registration'].includes(kind) ? [targetPath] : [])] },
    })).resolves.toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    await expect(readFile(fetchHeadPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runScmExecutable(fixture.rootPath, 'git', ['branch', '--list'])).toBe(branchesBefore);
    expect(runScmExecutable(fixture.rootPath, 'git', ['worktree', 'list', '--porcelain'])).toBe(worktreesBefore);
    if (kind === 'scratch') {
      expect(await readFile(join(scratchPath, 'unsaved.txt'), 'utf8')).toBe('scratch contents\n');
      expect(await readFile(join(targetPath, 'imported.txt'), 'utf8')).toBe('imported contents\n');
    }
    if (kind === 'linked' || kind === 'registration') {
      expect(await readFile(join(outsidePath, 'unsaved.txt'), 'utf8')).toBe('linked contents\n');
    }
    await expect(executeScmActionOperation({
      actionId: 'scm.pullRequest.prepareWorktree', input, registry: prRegistry, workingDirectory: cwd,
      accessPolicy: { kind: 'restrictedRoots', roots: [fixture.rootPath, outsidePath] },
    })).resolves.toMatchObject({ success: true, targetPath: kind === 'registration' ? outsidePath : targetPath });
    // Reuse must not demand authority for a scratch sibling it will not touch.
    await expect(executeScmActionOperation({
      actionId: 'scm.pullRequest.prepareWorktree', input, registry: prRegistry, workingDirectory: cwd,
      accessPolicy: { kind: 'restrictedRoots', roots: [cwd, kind === 'registration' ? outsidePath : targetPath, targetPath] },
    })).resolves.toMatchObject({ success: true });
  });
});
