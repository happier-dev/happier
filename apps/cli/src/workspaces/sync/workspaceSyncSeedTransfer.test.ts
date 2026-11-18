import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';

import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { createScmBackendRegistry } from '@/scm/registry';
import { materializeWorkspaceExportArtifactsWithScmWorkspace } from '@/scm/workspace/workspaceExportMaterialization';
import { writeTransferPayloadSourceToFile } from '@/machines/transfer/transferPayloadFileSink';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createLocalScmRepositoryFixture, runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import {
  createWorkspaceSyncSeedExport,
  materializeLocalWorkspaceSyncSeed,
  materializeWorkspaceSyncSeedExport,
  resolveWorkspaceSyncSeedTransfer,
} from './workspaceSyncSeedTransfer';

describe('workspace sync seed transfer', () => {
  it('keeps the real Git ownership refusal in an isolated member home instead of exporting raw normal-repository admin', async () => {
    const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'seed-member-ownership-' });
    const memberHome = await mkdtemp(join(tmpdir(), 'seed-member-home-'));
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git', executableDefinition: registration.runtime!, registration,
    })]);
    const request = { operationId: 'member-seed', activeServerDir: memberHome, sourcePath: repository.rootPath,
      workspaceTransfer: resolveWorkspaceSyncSeedTransfer({ selection: 'all_files', extraIncludePatterns: [], extraIgnorePatterns: [] }), registry };
    try {
      // Git's own test switch exercises its actual ownership refusal without requiring root/chown.
      // It is the same system-boundary discriminator used by repository.test.ts.
      await runAddedHostedSession({ environment: { ...process.env, HOME: memberHome, USERPROFILE: memberHome,
        GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' }, workingDirectory: repository.rootPath, end() {} }, async () => {
        await expect(createWorkspaceSyncSeedExport(request)).rejects.toMatchObject({
          errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE, message: 'git_dubious_ownership',
        });
      });
      await runAddedHostedSession({ environment: { ...process.env, HOME: memberHome, USERPROFILE: memberHome },
        workingDirectory: repository.rootPath, end() {} }, async () => {
        const exported = await createWorkspaceSyncSeedExport(request);
        const envelope = JSON.parse(exported.payloadSource.payload.toString('utf8'));
        expect(envelope.workspaceExportArtifacts.workspaceIntegrationMetadata.headRevision).toBe(repository.headCommit);
        expect(envelope.workspaceExportArtifacts.manifest.entries.some((entry: { relativePath: string }) => entry.relativePath === '.git' || entry.relativePath.startsWith('.git/'))).toBe(false);
        await exported.payloadSource.dispose?.();
      });
    } finally { await Promise.all([rm(repository.rootPath, { recursive: true, force: true }), rm(memberHome, { recursive: true, force: true })]); }
  });

  it('refuses a real worktree whose common repository moved before publishing a seed', async () => {
    const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'seed-unavailable-worktree-' });
    const root = await mkdtemp(join(tmpdir(), 'seed-unavailable-target-'));
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git', executableDefinition: registration.runtime!, registration,
    })]);
    try {
      const sourcePath = join(root, 'linked');
      runScmExecutable(repository.rootPath, 'git', ['worktree', 'add', '-b', 'linked', sourcePath]);
      await rename(repository.rootPath, join(root, 'moved-common-repository'));
      await expect(createWorkspaceSyncSeedExport({ operationId: 'unavailable-seed', activeServerDir: root,
        sourcePath, workspaceTransfer: resolveWorkspaceSyncSeedTransfer({ selection: 'all_files', extraIncludePatterns: [], extraIgnorePatterns: [] }), registry }))
        .rejects.toMatchObject({ errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE });
    } finally { await Promise.all([rm(repository.rootPath, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]); }
  });

  it.each(['normal', 'worktree', 'separate', 'submodule'] as const)('exports and imports a real %s checkout through the finite remote seed', async kind => {
    const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'seed-worktree-' });
    const root = await mkdtemp(join(tmpdir(), 'seed-worktree-target-'));
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
      executableDefinition: registration.runtime!, registration,
    })]);
    let sourcePath = repository.rootPath;
    try {
      if (kind === 'worktree') {
        sourcePath = join(root, 'linked');
        runScmExecutable(repository.rootPath, 'git', ['worktree', 'add', '-b', 'linked', sourcePath]);
      } else if (kind === 'separate') {
        runScmExecutable(sourcePath, 'git', ['init', '--separate-git-dir', join(root, 'admin')]);
      } else if (kind === 'submodule') {
        runScmExecutable(sourcePath, 'git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', sourcePath, 'child']);
        sourcePath = join(sourcePath, 'child');
      }
      await writeFile(join(sourcePath, 'tracked.txt'), 'local changes');
      const exported = await createWorkspaceSyncSeedExport({ operationId: 'worktree-seed', activeServerDir: root,
        sourcePath, workspaceTransfer: resolveWorkspaceSyncSeedTransfer({ selection: 'all_files', extraIncludePatterns: [], extraIgnorePatterns: [] }), registry });
      const targetPath = join(root, 'target');
      const custody = await materializeWorkspaceSyncSeedExport({ operationId: 'worktree-seed', targetPath,
        requestPayload: async request => {
          const payload = request.transferId === 'worktree-seed' ? exported.payloadSource
            : await exported.onDemandScope.resolvePayloadSourceOnOpen({ transferId: request.transferId, requestBody: {} });
          try { await writeTransferPayloadSourceToFile({ source: payload, destinationPath: request.destinationPath }); }
          finally { await payload.dispose?.(); }
        }, materializeWorkspaceExportArtifacts: input => materializeWorkspaceExportArtifactsWithScmWorkspace({ ...input, registry }),
      });
      await custody.commit();
      expect(runScmExecutable(targetPath, 'git', ['rev-parse', 'HEAD'])).toBe(repository.headCommit);
      expect(await readFile(join(targetPath, 'tracked.txt'), 'utf8')).toBe('local changes');
      expect((await readFile(join(targetPath, '.git', 'HEAD'), 'utf8')).length).toBeGreaterThan(0);
    } finally { await Promise.all([rm(repository.rootPath, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]); }
  });

  it.each([
    ['all_files', 'local'], ['all_files', 'remote'],
    ['git_worktree', 'local'], ['git_worktree', 'remote'],
  ] as const)('materializes %s policy through %s seed with ignored selections and explicit exclusions', async (selection, transport) => {
    const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'seed-content-policy-' });
    const root = await mkdtemp(join(tmpdir(), 'seed-content-policy-target-'));
    const targetPath = join(root, 'target');
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
      executableDefinition: registration.runtime!, registration,
    })]);
    const operationId = `seed-policy-${selection}-${transport}`;
    const workspaceTransfer = resolveWorkspaceSyncSeedTransfer({ selection,
      extraIncludePatterns: ['include.env'], extraIgnorePatterns: ['excluded.txt'] });
    try {
      await writeFile(join(repository.rootPath, '.gitignore'), 'ignored.txt\ninclude.env\nsecret.env\n');
      for (const path of ['ignored.txt', 'include.env', 'secret.env', 'excluded.txt', 'user.txt']) {
        await writeFile(join(repository.rootPath, path), `content:${path}`);
      }
      if (transport === 'local') {
        const custody = await materializeLocalWorkspaceSyncSeed({ operationId, activeServerDir: root,
          sourcePath: repository.rootPath, targetPath, workspaceTransfer, registry });
        await custody.commit();
      } else {
        const exported = await createWorkspaceSyncSeedExport({ operationId, activeServerDir: root,
          sourcePath: repository.rootPath, workspaceTransfer, registry });
        const custody = await materializeWorkspaceSyncSeedExport({ operationId, targetPath,
          requestPayload: async request => {
            const payload = request.transferId === operationId ? exported.payloadSource
              : await exported.onDemandScope.resolvePayloadSourceOnOpen({ transferId: request.transferId, requestBody: {} });
            try { await writeTransferPayloadSourceToFile({ source: payload, destinationPath: request.destinationPath }); }
            finally { await payload.dispose?.(); }
          }, materializeWorkspaceExportArtifacts: input => materializeWorkspaceExportArtifactsWithScmWorkspace({ ...input, registry }),
        });
        await custody.commit();
      }
      for (const path of ['user.txt', 'include.env']) {
        expect(await readFile(join(targetPath, path), 'utf8')).toBe(`content:${path}`);
      }
      for (const path of ['ignored.txt', 'secret.env']) {
        if (selection === 'all_files') expect(await readFile(join(targetPath, path), 'utf8')).toBe(`content:${path}`);
        else await expect(readFile(join(targetPath, path))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await expect(readFile(join(targetPath, 'excluded.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await Promise.all([rm(repository.rootPath, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]);
    }
  });

  it('keeps an intentionally empty nested Git selection empty instead of exporting ignored content', async () => {
    const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'nested-empty-selection-' });
    const sourcePath = join(repository.rootPath, 'private'); await mkdir(sourcePath);
    await writeFile(join(repository.rootPath, '.gitignore'), 'private/\n');
    await writeFile(join(sourcePath, 'secret.env'), 'must not be exported\n');
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
      executableDefinition: registration.runtime!, registration,
    })]);
    try {
      const exported = await createWorkspaceSyncSeedExport({ operationId: 'nested-empty-selection',
        activeServerDir: repository.rootPath, sourcePath, registry,
        workspaceTransfer: { includeIgnoredMode: 'exclude', ignoredIncludeGlobs: [], contentOnly: true } });
      if (exported.payloadSource.kind !== 'buffer') throw new Error('Seed envelope is a finite manifest');
      const envelope = JSON.parse(exported.payloadSource.payload.toString('utf8'));
      expect(envelope.workspaceExportArtifacts.manifest.entries).toEqual([]);
      expect(envelope.workspaceExportArtifacts.excludedPaths).toEqual(['secret.env']);
      expect(envelope.blobTransferIds).toEqual({});
    } finally { await rm(repository.rootPath, { recursive: true, force: true }); }
  });

  it('retains the original manifest when a received finite seed materializes for later three-way return', async () => {
    const root = await mkdtemp(join(tmpdir(), 'received-seed-baseline-'));
    const sourcePath = join(root, 'source'); await mkdir(sourcePath);
    await writeFile(join(sourcePath, 'base.bin'), Buffer.from([0, 255, 3]));
    const registry = createScmBackendRegistry([]);
    try {
      const exported = await createWorkspaceSyncSeedExport({ operationId: 'received-baseline', sourcePath, activeServerDir: root,
        workspaceTransfer: { includeIgnoredMode: 'exclude', ignoredIncludeGlobs: [] }, registry });
      const received = await materializeWorkspaceSyncSeedExport({ operationId: 'received-baseline', targetPath: join(root, 'target'),
        requestPayload: async request => {
          const payload = request.transferId === 'received-baseline' ? exported.payloadSource
            : await exported.onDemandScope.resolvePayloadSourceOnOpen({ transferId: request.transferId, requestBody: {} });
          try { await writeTransferPayloadSourceToFile({ source: payload, destinationPath: request.destinationPath }); }
          finally { await payload.dispose?.(); }
        },
        materializeWorkspaceExportArtifacts: input => materializeWorkspaceExportArtifactsWithScmWorkspace({ ...input, registry }),
      });
      expect(received.manifest).toMatchObject({ entries: [expect.objectContaining({ relativePath: 'base.bin', sizeBytes: 3 })] });
      await received.commit();
      expect(await readFile(join(root, 'target', 'base.bin'))).toEqual(Buffer.from([0, 255, 3]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses a selected nested Git repository visibly instead of silently omitting its files', async () => {
    const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'nested-git-return-' });
    const nested = join(repository.rootPath, 'nested-repository'); await mkdir(nested);
    runScmExecutable(nested, 'git', ['init', '-q']);
    await writeFile(join(nested, 'work.txt'), 'nested work stays available\n');
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
      executableDefinition: registration.runtime!, registration,
    })]);
    try {
      await expect(createWorkspaceSyncSeedExport({ operationId: 'nested-git-return', activeServerDir: repository.rootPath,
        sourcePath: repository.rootPath, registry,
        workspaceTransfer: { includeIgnoredMode: 'exclude', ignoredIncludeGlobs: [], contentOnly: true } }))
        .rejects.toMatchObject({ code: 'workspace_file_unsupported', path: 'nested-repository' });
      expect(await readFile(join(nested, 'work.txt'), 'utf8')).toBe('nested work stays available\n');
    } finally { await rm(repository.rootPath, { recursive: true, force: true }); }
  });

  it('refuses plain-folder export without nested repository ignore semantics instead of leaking ignored files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-return-nested-'));
    const nested = join(root, 'nested'); await mkdir(nested);
    runScmExecutable(nested, 'git', ['init', '-q']);
    await writeFile(join(nested, 'file.txt'), 'nested user file\n');
    await writeFile(join(nested, '.git', 'hooks', 'planted'), 'nested control bytes\n');
    await writeFile(join(nested, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(nested, 'ignored.txt'), 'nested ignored bytes\n');
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
      executableDefinition: registration.runtime!, registration,
    })]);
    try {
      await expect(createWorkspaceSyncSeedExport({ operationId: 'nested-return', activeServerDir: root,
        sourcePath: root, registry,
        workspaceTransfer: { includeIgnoredMode: 'exclude', ignoredIncludeGlobs: [], contentOnly: true } }))
        .rejects.toMatchObject({ code: 'workspace_file_unsupported', path: 'nested' });
      expect(await readFile(join(nested, 'ignored.txt'), 'utf8')).toBe('nested ignored bytes\n');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('exports committed and dirty content for return without Git control files, history, or ignored files', async () => {
    const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'content-return-' });
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
      executableDefinition: registration.runtime!, registration,
    })]);
    try {
      await writeFile(join(repository.rootPath, 'tracked.txt'), 'agent committed content\n');
      runScmExecutable(repository.rootPath, 'git', ['commit', '-am', 'Agent content']);
      await writeFile(join(repository.rootPath, 'dirty.txt'), 'uncommitted content\n');
      await writeFile(join(repository.rootPath, '.gitignore'), 'ignored.txt\nmissing.env\n');
      await writeFile(join(repository.rootPath, 'ignored.txt'), 'stay in sandbox\n');
      await writeFile(join(repository.rootPath, '.git', 'hooks', 'planted'), 'stay in sandbox\n');
      const exported = await createWorkspaceSyncSeedExport({ operationId: 'content-return', activeServerDir: repository.rootPath,
        sourcePath: repository.rootPath, registry,
        workspaceTransfer: { includeIgnoredMode: 'exclude', ignoredIncludeGlobs: [], contentOnly: true,
          exclusionCandidates: ['missing.env', 'tracked.txt'] } });
      expect(exported.payloadSource.kind).toBe('buffer');
      if (exported.payloadSource.kind !== 'buffer') throw new Error('Seed envelope is a finite manifest');
      const envelope = JSON.parse(exported.payloadSource.payload.toString('utf8')) as {
        workspaceExportArtifacts: { manifest: { entries: { relativePath: string }[] }; workspaceIntegrationMetadata?: unknown; excludedPaths?: readonly string[] };
        blobTransferIds: Record<string, string>;
      };
      const paths = envelope.workspaceExportArtifacts.manifest.entries.map(entry => entry.relativePath);
      expect(paths).toEqual(expect.arrayContaining(['tracked.txt', 'dirty.txt']));
      expect(paths.some(path => path.split('/').includes('.git') || path.startsWith('.happier-scm/') || path === 'ignored.txt')).toBe(false);
      expect(envelope.workspaceExportArtifacts.workspaceIntegrationMetadata).toBeUndefined();
      expect(envelope.workspaceExportArtifacts.excludedPaths).toEqual(['ignored.txt', 'missing.env']);
      for (const transferId of Object.values(envelope.blobTransferIds)) {
        const payload = await exported.onDemandScope.resolvePayloadSourceOnOpen({ transferId, requestBody: {} });
        await payload.dispose?.();
      }
    } finally { await rm(repository.rootPath, { recursive: true, force: true }); }
  });

  it('publishes SCM artifacts as a manifest plus digest-addressed finite transfers', async () => {
    const source = await mkdtemp(join(tmpdir(), 'happier-sync-seed-source-'));
    const file = join(source, 'hello.txt');
    await writeFile(file, 'hello seed', 'utf8');
    const prepared = await createWorkspaceSyncSeedExport({
      operationId: 'copy-1',
      activeServerDir: source,
      sourcePath: source,
      workspaceTransfer: { includeIgnoredMode: 'exclude', ignoredIncludeGlobs: [] },
      registry: createScmBackendRegistry([]),
    });

    const envelope = JSON.parse((prepared.payloadSource.kind === 'buffer'
      ? prepared.payloadSource.payload
      : Buffer.alloc(0)).toString('utf8')) as { blobTransferIds: Record<string, string> };
    const digest = Object.keys(envelope.blobTransferIds)[0]!;
    const blob = await prepared.onDemandScope.resolvePayloadSourceOnOpen({
      transferId: envelope.blobTransferIds[digest]!,
      requestBody: {},
    });
    expect(blob.kind).toBe('file');
    expect(blob.kind === 'file' ? await readFile(blob.filePath, 'utf8') : null).toBe('hello seed');
    expect(prepared.onDemandScope.allowTransferId('copy-1:blob:not-authorized')).toBe(false);
  });

  it('materializes the received SCM artifact envelope through the canonical target owner', async () => {
    const target = await mkdtemp(join(tmpdir(), 'happier-sync-seed-target-'));
    const digest = 'sha256:seed';
    const envelope = Buffer.from(JSON.stringify({
      v: 1,
      workspaceExportArtifacts: {
        manifest: { entries: [{ relativePath: 'hello.txt', kind: 'file', digest, sizeBytes: 10, executable: false }] },
      },
      blobTransferIds: { [digest]: `copy-1:blob:${createHash('sha256').update(digest).digest('hex')}` },
    }), 'utf8');
    const materialize: Parameters<typeof materializeWorkspaceSyncSeedExport>[0]['materializeWorkspaceExportArtifacts'] = async (input) => {
      const blobPath = input.blobProvider.getBlobFilePath(digest)!;
      await writeFile(join(target, 'observed.txt'), await readFile(blobPath));
      return {
        targetPath: input.targetPath,
        custody: {
          receipt: {
            v: 1,
            previousTargetName: null,
            originalTargetIdentity: null,
            promotedTargetIdentity: null,
          },
          bindPromotedTarget: async () => undefined,
          commit: async () => undefined,
          abort: async () => undefined,
        },
      };
    };

    const custody = await materializeWorkspaceSyncSeedExport({
      operationId: 'copy-1',
      targetPath: target,
      requestPayload: async ({ transferId, destinationPath }) => {
        const payload = transferId === 'copy-1' ? envelope : Buffer.from('hello seed', 'utf8');
        await writeFile(destinationPath, payload);
      },
      materializeWorkspaceExportArtifacts: materialize,
    });
    expect(await readFile(join(target, 'observed.txt'), 'utf8')).toBe('hello seed');
    await custody.commit();
  });

  it('stops a cancelled remote seed before downloading another blob or promoting the target', async () => {
    const target = await mkdtemp(join(tmpdir(), 'happier-sync-seed-cancelled-'));
    const firstDigest = 'sha256:first';
    const secondDigest = 'sha256:second';
    const envelope = Buffer.from(JSON.stringify({
      v: 1,
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            { relativePath: 'first.txt', kind: 'file', digest: firstDigest, sizeBytes: 5, executable: false },
            { relativePath: 'second.txt', kind: 'file', digest: secondDigest, sizeBytes: 6, executable: false },
          ],
        },
      },
      blobTransferIds: {
        [firstDigest]: `copy-cancelled:blob:${createHash('sha256').update(firstDigest).digest('hex')}`,
        [secondDigest]: `copy-cancelled:blob:${createHash('sha256').update(secondDigest).digest('hex')}`,
      },
    }), 'utf8');
    const cancellation = new AbortController();
    const requestedTransferIds: string[] = [];
    const materialize = vi.fn(async () => {
      throw new Error('cancelled seed must not promote the target');
    });

    try {
      await expect(materializeWorkspaceSyncSeedExport({
        operationId: 'copy-cancelled',
        targetPath: target,
        signal: cancellation.signal,
        requestPayload: async ({ transferId, destinationPath }) => {
          requestedTransferIds.push(transferId);
          await writeFile(destinationPath, transferId === 'copy-cancelled' ? envelope : Buffer.from('first'));
          if (transferId !== 'copy-cancelled') cancellation.abort();
        },
        materializeWorkspaceExportArtifacts: materialize,
      })).rejects.toMatchObject({ name: 'AbortError' });
      expect(requestedTransferIds).toEqual([
        'copy-cancelled',
        `copy-cancelled:blob:${createHash('sha256').update(firstDigest).digest('hex')}`,
      ]);
      expect(materialize).not.toHaveBeenCalled();
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it('threads cancellation into the canonical materialization checkpoints', async () => {
    const target = await mkdtemp(join(tmpdir(), 'happier-sync-seed-materialize-cancelled-'));
    const digest = 'sha256:seed';
    const envelope = Buffer.from(JSON.stringify({
      v: 1,
      workspaceExportArtifacts: {
        manifest: { entries: [{ relativePath: 'hello.txt', kind: 'file', digest, sizeBytes: 10, executable: false }] },
      },
      blobTransferIds: { [digest]: `copy-materialize-cancelled:blob:${createHash('sha256').update(digest).digest('hex')}` },
    }), 'utf8');
    const cancellation = new AbortController();

    try {
      await expect(materializeWorkspaceSyncSeedExport({
        operationId: 'copy-materialize-cancelled',
        targetPath: target,
        signal: cancellation.signal,
        requestPayload: async ({ transferId, destinationPath }) => {
          await writeFile(destinationPath, transferId === 'copy-materialize-cancelled' ? envelope : Buffer.from('hello seed'));
        },
        materializeWorkspaceExportArtifacts: async (input) => {
          cancellation.abort();
          const assertCanContinue = input.assertCanContinue;
          expect(assertCanContinue).toEqual(expect.any(Function));
          await assertCanContinue?.();
          throw new Error('cancelled materialization must not complete');
        },
      })).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it('materializes a same-machine all-files seed with rollback custody', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'happier-sync-local-seed-'));
    const source = join(fixture, 'source');
    const target = join(fixture, 'target');
    await Promise.all([mkdir(source), mkdir(target)]);
    await writeFile(join(source, 'new.txt'), 'new');
    await writeFile(join(target, 'old.txt'), 'old');
    try {
      const custody = await materializeLocalWorkspaceSyncSeed({
        operationId: 'relationship-local',
        activeServerDir: fixture,
        sourcePath: source,
        targetPath: target,
        workspaceTransfer: { includeIgnoredMode: 'include_selected', ignoredIncludeGlobs: [] },
        registry: createScmBackendRegistry([]),
      });
      await expect(readFile(join(target, 'new.txt'), 'utf8')).resolves.toBe('new');
      await custody.abort();
      await expect(readFile(join(target, 'old.txt'), 'utf8')).resolves.toBe('old');
      await expect(readFile(join(target, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
