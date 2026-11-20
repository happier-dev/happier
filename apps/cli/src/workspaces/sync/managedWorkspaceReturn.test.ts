import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';
import { configuration } from '@/configuration';
import { registerSessionTargetWorkspace, resolveSessionTargetWorkspace } from '@/daemon/sessions/sessionTargetWorkspaces';
import { runWithWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { scanWorkspaceManifest } from '@/scm/workspace/workspaceExportPackaging/scanWorkspaceManifest';
import { readStoredScmComparison, resolveStoredScmComparisonPath as unscopedResolveStoredScmComparisonPath, resolveStoredScmComparisonEndpointsPath } from '@/scm/comparisons/comparisonStorage';
import { deleteCapturedScmComparison as unscopedDeleteCapturedScmComparison, prepareCapturedScmComparisonInvestigation as unscopedPrepareCapturedScmComparisonInvestigation, readCapturedScmComparison as unscopedReadCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { spawnSessionHolderChild, type SessionHolderChild } from '@/subprocess/supervision/sessionHolder';
import { applyManagedWorkspaceReturn as unscopedApplyManagedWorkspaceReturn, prepareManagedWorkspaceReturn as unscopedPrepareManagedWorkspaceReturn, prepareManagedWorkspaceReturnFromStage as unscopedPrepareManagedWorkspaceReturnFromStage, projectManagedWorkspaceReturnFailure } from './managedWorkspaceReturn';

import { runWithScmAccountScope } from '@/scm/accountScope';

function withAccount<Args extends readonly unknown[], Result>(effect: (...args: Args) => Result) {
  return (...args: Args): Result => runWithScmAccountScope('workspace-return-test-account', () => effect(...args));
}
const prepareManagedWorkspaceReturn = withAccount(unscopedPrepareManagedWorkspaceReturn);
const prepareManagedWorkspaceReturnFromStage = withAccount(unscopedPrepareManagedWorkspaceReturnFromStage);
const applyManagedWorkspaceReturn = withAccount(unscopedApplyManagedWorkspaceReturn);
const resolveStoredScmComparisonPath = withAccount(unscopedResolveStoredScmComparisonPath);
const readCapturedScmComparison = withAccount(unscopedReadCapturedScmComparison);
const prepareCapturedScmComparisonInvestigation = withAccount(unscopedPrepareCapturedScmComparisonInvestigation);
const deleteCapturedScmComparison = withAccount(unscopedDeleteCapturedScmComparison);

const holderPath = resolveSessionHolderExecutablePath();
const helperPath = resolveProcessCustodySupportExecutable('linux');

describe.skipIf(process.platform !== 'linux' || !holderPath || !helperPath)('managed workspace reviewed return', () => {
  let directory: string;
  let hostRoot: string;
  let targetRoot: string;
  let agent: SessionHolderChild;
  let lifetime: AbortController;
  let recordBaseline: () => Promise<void>;
  const sessionId = `return-${Date.now()}`;
  const registration = createGitScmBackendRuntimeRegistration();
  const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({ definition: { id: 'git', kind: 'git' },
    qualifiedId: 'happier.scm.git/git', executableDefinition: registration.runtime!, registration })]);

  beforeEach(async () => {
    lifetime = new AbortController();
    directory = await mkdtemp(join(tmpdir(), 'hreturn-'));
    hostRoot = join(directory, 'host');
    targetRoot = join(directory, 'target');
    await mkdir(hostRoot);
    await mkdir(targetRoot);
    const target = {
      id: sessionId, holderPath: holderPath!, helperPath: helperPath!, socketDirectory: directory,
      exec: (command: string) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.once('error', reject);
        child.once('close', status => resolve({ status: status ?? 1, stdout, stderr }));
      }),
      openChannel: (argv: readonly string[]) => {
        const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
        const channel = Duplex.from({ readable: child.stdout, writable: child.stdin });
        child.once('close', () => channel.destroy());
        return channel;
      },
    };
    const primarySocketPath = join(directory, 'h.sock');
    agent = spawnSessionHolderChild({ executablePath: holderPath!, socketPath: primarySocketPath,
      command: 'sleep', args: ['600'], cwd: targetRoot, target });
    await new Promise<void>((resolve, reject) => { agent.once('spawn', resolve); agent.once('error', reject); });
    registerSessionTargetWorkspace({ sessionId, lifetime: lifetime.signal, primarySocketPath, target,
      workspace: { hostRoot, targetRoot } });
    recordBaseline = async () => registerSessionTargetWorkspace({ sessionId, lifetime: lifetime.signal, primarySocketPath, target,
      workspace: { hostRoot, targetRoot }, baseline: await scanWorkspaceManifest({ workspaceRoot: hostRoot,
        safeFilterPolicy: { excludeAdministrativePaths: false } }) });
  });

  afterEach(async () => {
    lifetime.abort();
    await agent?.terminateGroup({ graceMs: 100 });
    await rm(directory, { recursive: true, force: true });
  });

  it('reviews complete text, binary, additions, deletions and symlinks, then applies only accepted subtrees without stopping the Session', async () => {
    runScmExecutable(hostRoot, 'git', ['init', '-q']);
    await writeFile(join(hostRoot, '.git', 'sentinel'), 'host metadata');
    await mkdir(join(hostRoot, 'tree'));
    await mkdir(join(targetRoot, 'tree'));
    await writeFile(join(hostRoot, 'tree', 'old.txt'), 'deleted\n');
    await writeFile(join(hostRoot, 'tree', 'changed.txt'), 'before\n');
    await writeFile(join(targetRoot, 'tree', 'changed.txt'), 'after\n');
    await writeFile(join(targetRoot, 'tree', 'added.txt'), 'new\n');
    await writeFile(join(targetRoot, 'tree', 'image.bin'), Buffer.from([0, 255, 7]));
    await symlink('added.txt', join(targetRoot, 'tree', 'link'));
    await writeFile(join(hostRoot, 'leave.txt'), 'host only');
    await writeFile(join(targetRoot, 'leave.txt'), 'target only');
    await writeFile(join(hostRoot, 'remove.txt'), 'removed in target');
    await recordBaseline();

    const preview = await prepareManagedWorkspaceReturn({ sessionId, activeServerDir: directory, registry });
    const retained = await readStoredScmComparison(resolveStoredScmComparisonPath({ activeServerDir: directory,
      sessionId, comparisonId: preview.returnId }));
    expect(retained.comparison.inventory.files.some(file => file.path === 'tree/image.bin')).toBe(true);
    expect(retained.comparison.repository.rootPath).toBe(hostRoot);
    expect(preview.paths.map(entry => entry.path)).toEqual(['leave.txt', 'remove.txt', 'tree']);
    const files = preview.paths.find(entry => entry.path === 'tree')!.files;
    expect(files.map(file => [file.path, file.changeKind])).toEqual([
      ['tree/added.txt', 'added'], ['tree/changed.txt', 'modified'], ['tree/image.bin', 'added'],
      ['tree/link', 'added'], ['tree/old.txt', 'deleted'],
    ]);
    expect(files.find(file => file.path.endsWith('changed.txt'))?.evidence).toMatchObject({ state: 'available',
      unifiedDiff: expect.stringContaining('-before\n+after\n') });
    expect(files.find(file => file.path.endsWith('image.bin'))).toMatchObject({ binary: true });
    expect(files.find(file => file.path.endsWith('link'))?.evidence).toMatchObject({ state: 'available', unifiedDiff: expect.stringContaining('+added.txt') });
    expect(await readFile(join(hostRoot, 'tree', 'changed.txt'), 'utf8')).toBe('before\n');
    // Later target edits must not replace the captured bytes the person reviewed.
    await writeFile(join(targetRoot, 'tree', 'changed.txt'), 'later target edit\n');
    await expect(applyManagedWorkspaceReturn({ sessionId, activeServerDir: directory, returnId: preview.returnId, paths: ['remove.txt', 'tree'] }))
      .resolves.toMatchObject({ appliedPaths: ['remove.txt', 'tree/added.txt', 'tree/changed.txt', 'tree/image.bin', 'tree/link', 'tree/old.txt'], conflicts: [] });
    await expect(readFile(join(hostRoot, 'remove.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(hostRoot, 'tree', 'changed.txt'), 'utf8')).toBe('after\n');
    expect(await readFile(join(hostRoot, 'tree', 'image.bin'))).toEqual(Buffer.from([0, 255, 7]));
    expect(await readlink(join(hostRoot, 'tree', 'link'))).toBe('added.txt');
    await expect(readFile(join(hostRoot, 'tree', 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(hostRoot, 'leave.txt'), 'utf8')).toBe('host only');
    expect(await readFile(join(hostRoot, '.git', 'sentinel'), 'utf8')).toBe('host metadata');
    await expect(agent.request({ op: 'status' })).resolves.toMatchObject({ ok: true, exit: null });
    // The same target holder remains available for another finite operation.
    await expect(prepareManagedWorkspaceReturn({ sessionId, activeServerDir: directory, registry })).resolves.toMatchObject({ sessionId });
  });

  it('rejects changed host preimages and an unreviewed path', async () => {
    await mkdir(join(hostRoot, 'changing'));
    await mkdir(join(targetRoot, 'changing'));
    await writeFile(join(hostRoot, 'changing', 'file.txt'), 'before');
    await writeFile(join(targetRoot, 'changing', 'file.txt'), 'after');
    await recordBaseline();
    const preview = await prepareManagedWorkspaceReturn({ sessionId, activeServerDir: directory, registry });
    await expect(applyManagedWorkspaceReturn({ sessionId, activeServerDir: directory, returnId: preview.returnId, paths: ['.git'] }))
      .rejects.toMatchObject({ code: 'invalid_request' });
    await writeFile(join(hostRoot, 'changing', 'file.txt'), 'new host edit');
    await expect(applyManagedWorkspaceReturn({ sessionId, activeServerDir: directory, returnId: preview.returnId, paths: ['changing'] }))
      .rejects.toMatchObject({ code: 'conflict_changed' });
    expect(await readFile(join(hostRoot, 'changing', 'file.txt'), 'utf8')).toBe('new host edit');
  });

  it('preserves nested Git metadata while returning an independent file in the same directory', async () => {
    await mkdir(join(hostRoot, 'nested', '.git'), { recursive: true });
    await writeFile(join(hostRoot, 'nested', '.git', 'keep'), 'metadata');
    await mkdir(join(targetRoot, 'nested'));
    await writeFile(join(targetRoot, 'nested', 'new.txt'), 'new');
    await recordBaseline();
    const preview = await prepareManagedWorkspaceReturn({ sessionId, activeServerDir: directory, registry });
    await applyManagedWorkspaceReturn({ sessionId, activeServerDir: directory, returnId: preview.returnId, paths: ['nested'] });
    expect(await readFile(join(hostRoot, 'nested', 'new.txt'), 'utf8')).toBe('new');
    expect(await readFile(join(hostRoot, 'nested', '.git', 'keep'), 'utf8')).toBe('metadata');
  });

  it('keeps a both-changed host file and retains the complete sandbox version for review', async () => {
    await mkdir(join(hostRoot, 'tree'));
    await mkdir(join(targetRoot, 'tree'));
    await writeFile(join(hostRoot, 'tree', 'both.txt'), 'initial\n');
    await writeFile(join(hostRoot, 'tree', 'agent.txt'), 'initial agent\n');
    await recordBaseline();
    await writeFile(join(hostRoot, 'tree', 'both.txt'), 'person edit\n');
    await writeFile(join(targetRoot, 'tree', 'both.txt'), 'sandbox edit\n');
    await writeFile(join(targetRoot, 'tree', 'agent.txt'), 'agent edit\n');
    const preview = await prepareManagedWorkspaceReturn({ sessionId, activeServerDir: directory, registry });
    expect(preview.paths[0]?.conflicts).toEqual([{ path: 'tree/both.txt', code: 'both_changed' }]);
    expect(preview.paths[0]?.files.find(file => file.path.endsWith('both.txt'))?.evidence).toMatchObject({ state: 'available',
      unifiedDiff: expect.stringContaining('+sandbox edit\n') });
    await expect(applyManagedWorkspaceReturn({ sessionId, activeServerDir: directory, returnId: preview.returnId, paths: ['tree'] }))
      .resolves.toMatchObject({ appliedPaths: ['tree/agent.txt'], conflicts: [{ path: 'tree/both.txt', code: 'both_changed' }] });
    expect(await readFile(join(hostRoot, 'tree', 'both.txt'), 'utf8')).toBe('person edit\n');
    expect(await readFile(join(hostRoot, 'tree', 'agent.txt'), 'utf8')).toBe('agent edit\n');
    await expect(applyManagedWorkspaceReturn({ sessionId, activeServerDir: directory, returnId: preview.returnId, paths: ['tree/both.txt'],
      replaceConflictPaths: ['tree/both.txt'] })).resolves.toMatchObject({ appliedPaths: ['tree/both.txt'], conflicts: [] });
    expect(await readFile(join(hostRoot, 'tree', 'both.txt'), 'utf8')).toBe('sandbox edit\n');
  });

  it('never returns sandbox hooks or configuration to the host', async () => {
    runScmExecutable(hostRoot, 'git', ['init', '-q']);
    runScmExecutable(hostRoot, 'git', ['config', 'return-test.owner', 'host']);
    const hostConfig = await readFile(join(hostRoot, '.git', 'config'), 'utf8');
    await recordBaseline();
    runScmExecutable(targetRoot, 'git', ['init', '-q']);
    runScmExecutable(targetRoot, 'git', ['config', 'return-test.owner', 'sandbox']);
    await writeFile(join(targetRoot, '.git', 'hooks', 'pre-commit'), 'sandbox hook');
    await writeFile(join(targetRoot, 'returned.txt'), 'reviewed bytes');
    const preview = await prepareManagedWorkspaceReturn({ sessionId, activeServerDir: directory, registry });
    expect(preview.paths.map(entry => entry.path)).toEqual(['returned.txt']);
    await applyManagedWorkspaceReturn({ sessionId, activeServerDir: directory, returnId: preview.returnId, paths: ['returned.txt'] });
    expect(await readFile(join(hostRoot, '.git', 'config'), 'utf8')).toBe(hostConfig);
    await expect(readFile(join(hostRoot, '.git', 'hooks', 'pre-commit'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves host-only edits beside a changed sandbox file in the same subtree', async () => {
    await mkdir(join(hostRoot, 'tree'));
    await mkdir(join(targetRoot, 'tree'));
    await writeFile(join(hostRoot, 'tree', 'local.txt'), 'initial local');
    await writeFile(join(hostRoot, 'tree', 'agent.txt'), 'initial agent');
    await recordBaseline();
    await writeFile(join(hostRoot, 'tree', 'local.txt'), 'person edit');
    await writeFile(join(targetRoot, 'tree', 'local.txt'), 'initial local');
    await writeFile(join(targetRoot, 'tree', 'agent.txt'), 'agent edit');
    const preview = await prepareManagedWorkspaceReturn({ sessionId, activeServerDir: directory, registry });
    expect(preview.paths[0]?.conflicts).toEqual([]);
    await expect(applyManagedWorkspaceReturn({ sessionId, activeServerDir: directory, returnId: preview.returnId, paths: ['tree'] }))
      .resolves.toMatchObject({ appliedPaths: ['tree/agent.txt'], conflicts: [] });
    expect(await readFile(join(hostRoot, 'tree', 'local.txt'), 'utf8')).toBe('person edit');
    expect(await readFile(join(hostRoot, 'tree', 'agent.txt'), 'utf8')).toBe('agent edit');
  });

  it('offers the complete review without automatic apply when the original baseline is unavailable', async () => {
    await writeFile(join(hostRoot, 'file.txt'), 'host\n');
    await writeFile(join(targetRoot, 'file.txt'), 'sandbox\n');
    const preview = await prepareManagedWorkspaceReturn({ sessionId, activeServerDir: directory, registry });
    expect(preview.applyUnavailableReason).toBe('baseline_unavailable');
    expect(preview.paths[0]?.files[0]?.evidence).toMatchObject({ state: 'available', unifiedDiff: expect.stringContaining('+sandbox\n') });
    await expect(applyManagedWorkspaceReturn({ sessionId, activeServerDir: directory, returnId: preview.returnId, paths: ['file.txt'] }))
      .rejects.toMatchObject({ code: 'baseline_unavailable' });
    expect(await readFile(join(hostRoot, 'file.txt'), 'utf8')).toBe('host\n');
  });

  it('excludes ignored host files from a review without a copied baseline', async () => {
    const registration = createGitScmBackendRuntimeRegistration();
    const gitRegistry = createScmBackendRegistry([createRegisteredScmBackendAdapter({ definition: { id: 'git', kind: 'git' },
      qualifiedId: 'happier.scm.git/git', executableDefinition: registration.runtime!, registration })]);
    runScmExecutable(hostRoot, 'git', ['init', '-q']);
    await writeFile(join(hostRoot, '.gitignore'), 'ignored.txt\nnode_modules/\n');
    await writeFile(join(targetRoot, '.gitignore'), 'ignored.txt\nnode_modules/\n');
    await writeFile(join(hostRoot, 'ignored.txt'), 'person ignored bytes');
    await mkdir(join(hostRoot, 'node_modules', 'package'), { recursive: true });
    await writeFile(join(hostRoot, 'node_modules', 'package', 'cache.bin'), Buffer.alloc(128 * 1024, 0x7f));
    await writeFile(join(targetRoot, 'file.txt'), 'sandbox');
    // The real OS refuses reading either ignored payload, so filtering after
    // copying/hashing cannot satisfy this capture contract.
    await chmod(join(hostRoot, 'ignored.txt'), 0o000);
    await chmod(join(hostRoot, 'node_modules'), 0o000);
    const preview = await prepareManagedWorkspaceReturn({ sessionId, activeServerDir: directory, registry: gitRegistry })
      .finally(async () => {
        await chmod(join(hostRoot, 'ignored.txt'), 0o600);
        await chmod(join(hostRoot, 'node_modules'), 0o700);
      });
    expect(preview.paths.flatMap(group => group.files.map(file => file.path))).toEqual(['file.txt']);
    expect(preview.applyUnavailableReason).toBe('baseline_unavailable');
    expect(await readFile(join(hostRoot, 'ignored.txt'), 'utf8')).toBe('person ignored bytes');
    const endpoints = resolveStoredScmComparisonEndpointsPath(resolveStoredScmComparisonPath({ activeServerDir: directory,
      sessionId, comparisonId: preview.returnId }));
    await expect(readFile(join(endpoints, 'before', 'ignored.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(endpoints, 'before', 'node_modules', 'package', 'cache.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serves retained native review through the existing comparison reader and deletes its raw endpoints with that comparison', async () => {
    await writeFile(join(hostRoot, 'file.txt'), 'host\n');
    await writeFile(join(targetRoot, 'file.txt'), 'sandbox\n');
    const preview = await prepareManagedWorkspaceReturnFromStage({ sessionId, hostRoot, stageRoot: targetRoot,
      activeServerDir: configuration.activeServerDir, registry });
    const selector = { cwd: hostRoot, sessionId, comparisonId: preview.returnId, source: { kind: 'workingTree' as const } };
    try {
      const captured = await readCapturedScmComparison(selector);
      expect(captured.comparison.inventory.files[0]?.evidence).toMatchObject({ unifiedDiff: expect.stringContaining('+sandbox\n') });
      const endpoints = await prepareCapturedScmComparisonInvestigation({ ...selector, directory: join(directory, 'investigation') });
      expect(await readFile(join(endpoints.beforeDirectory, 'file.txt'), 'utf8')).toBe('host\n');
      expect(await readFile(join(endpoints.afterDirectory, 'file.txt'), 'utf8')).toBe('sandbox\n');
      await expect(runWithWorkspaceSource(resolveSessionTargetWorkspace({ sessionId })!, () =>
        prepareCapturedScmComparisonInvestigation({ ...selector, directory: join(targetRoot, 'investigation') })))
        .rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
      await deleteCapturedScmComparison(selector);
      await expect(readFile(join(endpoints.afterDirectory, 'file.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await deleteCapturedScmComparison(selector).catch(() => {});
    }
  });

  it('preserves an ignored host sibling when the sandbox deletes the user files in its directory', async () => {
    const registration = createGitScmBackendRuntimeRegistration();
    const gitRegistry = createScmBackendRegistry([createRegisteredScmBackendAdapter({ definition: { id: 'git', kind: 'git' },
      qualifiedId: 'happier.scm.git/git', executableDefinition: registration.runtime!, registration })]);
    runScmExecutable(hostRoot, 'git', ['init', '-q']);
    await writeFile(join(hostRoot, '.gitignore'), 'tree/ignored.txt\n');
    await writeFile(join(targetRoot, '.gitignore'), 'tree/ignored.txt\n');
    await mkdir(join(hostRoot, 'tree'));
    await writeFile(join(hostRoot, 'tree', 'user.txt'), 'copied user file');
    await recordBaseline();
    await writeFile(join(hostRoot, 'tree', 'ignored.txt'), 'person ignored bytes');
    const preview = await prepareManagedWorkspaceReturn({ sessionId, activeServerDir: directory, registry: gitRegistry });
    await expect(applyManagedWorkspaceReturn({ sessionId, activeServerDir: directory, returnId: preview.returnId, paths: ['tree'] }))
      .resolves.toMatchObject({ appliedPaths: ['tree/user.txt'], conflicts: [] });
    expect(await readFile(join(hostRoot, 'tree', 'ignored.txt'), 'utf8')).toBe('person ignored bytes');
    await expect(readFile(join(hostRoot, 'tree', 'user.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([{ originallyIgnored: false, relativePath: 'local.env' }, { originallyIgnored: true, relativePath: 'local.env' }, { originallyIgnored: false, relativePath: 'tree/local.env' }])('does not interpret an ignored sandbox file as a deletion from the copied base ($relativePath, originally ignored: $originallyIgnored)', async ({ originallyIgnored, relativePath }) => {
    runScmExecutable(hostRoot, 'git', ['init', '-q']);
    runScmExecutable(targetRoot, 'git', ['init', '-q']);
    await writeFile(join(hostRoot, '.gitignore'), originallyIgnored ? `${relativePath}\n` : '');
    await mkdir(dirname(join(hostRoot, relativePath)), { recursive: true });
    await writeFile(join(hostRoot, relativePath), 'copied local values');
    await recordBaseline();
    await writeFile(join(targetRoot, '.gitignore'), `${relativePath}\n`);
    await mkdir(dirname(join(targetRoot, relativePath)), { recursive: true });
    await writeFile(join(targetRoot, relativePath), 'sandbox local values');
    const preview = await prepareManagedWorkspaceReturn({ sessionId, activeServerDir: directory, registry });
    expect(preview.paths.map(group => group.path)).toEqual(originallyIgnored ? [] : ['.gitignore']);
    if (!originallyIgnored) await applyManagedWorkspaceReturn({ sessionId, activeServerDir: directory, returnId: preview.returnId, paths: ['.gitignore'] });
    expect(await readFile(join(hostRoot, relativePath), 'utf8')).toBe('copied local values');
  });

  it('preserves a host file when the sandbox ignores and removes its copied path', async () => {
    runScmExecutable(hostRoot, 'git', ['init', '-q']);
    runScmExecutable(targetRoot, 'git', ['init', '-q']);
    await writeFile(join(hostRoot, '.gitignore'), '');
    await writeFile(join(hostRoot, 'local.env'), 'copied local values');
    await writeFile(join(targetRoot, 'local.env'), 'copied local values');
    await recordBaseline();
    await writeFile(join(targetRoot, '.gitignore'), 'local.env\n');
    await rm(join(targetRoot, 'local.env'));
    const preview = await prepareManagedWorkspaceReturn({ sessionId, activeServerDir: directory, registry });
    expect(preview.paths.map(group => group.path)).toEqual(['.gitignore']);
    await applyManagedWorkspaceReturn({ sessionId, activeServerDir: directory, returnId: preview.returnId, paths: ['.gitignore'] });
    expect(await readFile(join(hostRoot, 'local.env'), 'utf8')).toBe('copied local values');
  });

  it('refuses a structural replacement that would remove host Git metadata', async () => {
    await mkdir(join(hostRoot, 'nested', '.git'), { recursive: true });
    await writeFile(join(hostRoot, 'nested', '.git', 'config'), 'person repository config');
    await writeFile(join(hostRoot, 'nested', 'user.txt'), 'copied file');
    await recordBaseline();
    await writeFile(join(targetRoot, 'nested'), 'sandbox replacement');
    await expect(prepareManagedWorkspaceReturn({ sessionId, activeServerDir: directory, registry }))
      .rejects.toMatchObject({ code: 'workspace_file_unsupported', details: { path: 'nested/.git' } });
    expect(await readFile(join(hostRoot, 'nested', '.git', 'config'), 'utf8')).toBe('person repository config');
  });

  it('adds a sandbox file beside an existing ignored-only host directory without replacing that directory', async () => {
    const registration = createGitScmBackendRuntimeRegistration();
    const gitRegistry = createScmBackendRegistry([createRegisteredScmBackendAdapter({ definition: { id: 'git', kind: 'git' },
      qualifiedId: 'happier.scm.git/git', executableDefinition: registration.runtime!, registration })]);
    runScmExecutable(hostRoot, 'git', ['init', '-q']);
    await writeFile(join(hostRoot, '.gitignore'), 'tree/ignored.txt\n');
    await writeFile(join(targetRoot, '.gitignore'), 'tree/ignored.txt\n');
    await recordBaseline();
    await mkdir(join(hostRoot, 'tree'));
    await writeFile(join(hostRoot, 'tree', 'ignored.txt'), 'person ignored bytes');
    await mkdir(join(targetRoot, 'tree'));
    await writeFile(join(targetRoot, 'tree', 'user.txt'), 'sandbox user file');
    const preview = await prepareManagedWorkspaceReturn({ sessionId, activeServerDir: directory, registry: gitRegistry });
    await expect(applyManagedWorkspaceReturn({ sessionId, activeServerDir: directory, returnId: preview.returnId, paths: ['tree'] }))
      .resolves.toMatchObject({ appliedPaths: ['tree/user.txt'], conflicts: [] });
    expect(await readFile(join(hostRoot, 'tree', 'ignored.txt'), 'utf8')).toBe('person ignored bytes');
    expect(await readFile(join(hostRoot, 'tree', 'user.txt'), 'utf8')).toBe('sandbox user file');
  });

  it('reviews a directory replacing a link without capturing files through that link', async () => {
    const protectedDirectory = join(hostRoot, 'person-files');
    await mkdir(protectedDirectory);
    await writeFile(join(protectedDirectory, 'notes.txt'), 'person notes\n');
    await symlink('person-files', join(hostRoot, 'link'));
    await mkdir(join(targetRoot, 'link'));
    await writeFile(join(targetRoot, 'link', 'notes.txt'), 'Session notes\n');

    const baseline = await scanWorkspaceManifest({ workspaceRoot: hostRoot, safeFilterPolicy: { excludeAdministrativePaths: false } });
    const preview = await prepareManagedWorkspaceReturnFromStage({
      sessionId, activeServerDir: directory, hostRoot, stageRoot: targetRoot, registry, baseline,
    });
    expect(preview.paths.find(group => group.path === 'link')?.files).toContainEqual(expect.objectContaining({
      path: 'link/notes.txt', changeKind: 'added',
      evidence: { state: 'available', unifiedDiff: expect.stringContaining('+Session notes\n') },
    }));
    await expect(readFile(join(protectedDirectory, 'notes.txt'), 'utf8')).resolves.toBe('person notes\n');
  });

  it('reports files already applied if retaining the remaining review fails', async () => {
    await writeFile(join(hostRoot, 'file.txt'), 'copied');
    await recordBaseline();
    await writeFile(join(targetRoot, 'file.txt'), 'sandbox');
    const preview = await prepareManagedWorkspaceReturn({ sessionId, activeServerDir: directory, registry });
    const storageDirectory = dirname(resolveStoredScmComparisonPath({ activeServerDir: directory, sessionId, comparisonId: preview.returnId }));
    await chmod(storageDirectory, 0o500);
    try {
      await expect(applyManagedWorkspaceReturn({ sessionId, activeServerDir: directory, returnId: preview.returnId, paths: ['file.txt'] }))
        .rejects.toMatchObject({ details: { appliedPaths: ['file.txt'] } });
      expect(await readFile(join(hostRoot, 'file.txt'), 'utf8')).toBe('sandbox');
    } finally { await chmod(storageDirectory, 0o700); }
  });

  it('preserves the conditional-write failure and applied paths when review retention also fails', async () => {
    await writeFile(join(hostRoot, 'first.txt'), 'copied first');
    await writeFile(join(hostRoot, 'second.txt'), 'copied second');
    await recordBaseline();
    await writeFile(join(targetRoot, 'first.txt'), 'sandbox first');
    await writeFile(join(targetRoot, 'second.txt'), 'sandbox second');
    const preview = await prepareManagedWorkspaceReturn({ sessionId, activeServerDir: directory, registry });
    await writeFile(join(hostRoot, 'second.txt'), 'person later edit');
    const storageDirectory = dirname(resolveStoredScmComparisonPath({ activeServerDir: directory, sessionId, comparisonId: preview.returnId }));
    await chmod(storageDirectory, 0o500);
    try {
      await expect(applyManagedWorkspaceReturn({ sessionId, activeServerDir: directory, returnId: preview.returnId,
        paths: ['first.txt', 'second.txt'] })).rejects.toMatchObject({ code: 'conflict_changed',
        details: { appliedPaths: ['first.txt'], path: 'second.txt' } });
      expect(await readFile(join(hostRoot, 'first.txt'), 'utf8')).toBe('sandbox first');
      expect(await readFile(join(hostRoot, 'second.txt'), 'utf8')).toBe('person later edit');
    } finally { await chmod(storageDirectory, 0o700); }
  });

  it('retains a UTF-8 byte-order mark change in the complete review evidence', async () => {
    await writeFile(join(hostRoot, 'file.txt'), '\uFEFFsame text\n');
    await recordBaseline();
    await writeFile(join(targetRoot, 'file.txt'), 'same text\n');
    const preview = await prepareManagedWorkspaceReturn({ sessionId, activeServerDir: directory, registry });
    expect(preview.paths[0]?.files[0]?.evidence).toMatchObject({ state: 'available',
      unifiedDiff: expect.stringContaining('-\uFEFFsame text\n+same text\n') });
    await applyManagedWorkspaceReturn({ sessionId, activeServerDir: directory, returnId: preview.returnId, paths: ['file.txt'] });
    expect(await readFile(join(hostRoot, 'file.txt'))).toEqual(Buffer.from('same text\n'));
  });

  it('exposes the canonical nested-repository refusal path in the return Action failure', async () => {
    await mkdir(join(targetRoot, 'nested'));
    runScmExecutable(join(targetRoot, 'nested'), 'git', ['init', '-q']);
    await writeFile(join(targetRoot, 'nested', 'file.txt'), 'sandbox repository file');
    const failure = await prepareManagedWorkspaceReturn({ sessionId, activeServerDir: directory, registry })
      .catch(error => {
        if (!(error instanceof Error) || !('code' in error)) throw error;
        expect(error).toMatchObject({ code: 'workspace_file_unsupported', path: 'nested' });
        return projectManagedWorkspaceReturnFailure(error, 'workspace.return.prepare');
      });
    expect(failure).toMatchObject({ ok: false, errorCode: 'workspace_file_unsupported',
      details: { appliedPaths: [], path: 'nested' } });
  });
});
