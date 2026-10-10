import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { reclaimJsonOwnerFileLockSnapshot } from '@/utils/fs/jsonOwnerFileLock';
import { createWorkspaceRootOwnershipManager } from './workspaceSyncRootOwnership';

const childFixturePath = join(dirname(fileURLToPath(import.meta.url)), 'workspaceSyncRootOwnership.child.ts');

function startOwnershipChild(input: Readonly<{
  lockDirectory: string;
  ownerId: string;
  canonicalRoot: string;
  resultPath: string;
  releasePath: string;
}>): Readonly<{ child: ChildProcess; completion: Promise<void> }> {
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    childFixturePath,
    input.lockDirectory,
    input.ownerId,
    input.canonicalRoot,
    input.resultPath,
    input.releasePath,
  ], {
    cwd: join(dirname(childFixturePath), '../../..'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`workspace ownership child exited ${String(code)} (${String(signal)}): ${stderr}`));
    });
  });
  return { child, completion };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await access(path).then(() => true, () => false))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('workspace root ownership', () => {
  it('keeps bytes on release and refuses a replaced root under an existing removal handle', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-root-reviewed-removal-'));
    try {
      const root = join(fixture, 'workspace');
      await mkdir(root);
      await writeFile(join(root, 'copy.txt'), 'committed');
      const manager = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') });
      const handle = await manager.tryAcquire({ ownerId: 'relationship', canonicalRoot: root, operation: 'bootstrap' });
      if ('kind' in handle || !handle.owner.rootFingerprint) throw new Error('fixture did not acquire root');
      await handle.assertCurrentRootIdentity(handle.owner.rootFingerprint);
      await rename(root, join(fixture, 'old-copy'));
      await mkdir(root);
      await writeFile(join(root, 'user.txt'), 'user');
      await expect(handle.assertCurrentRootIdentity(handle.owner.rootFingerprint)).rejects.toMatchObject({ code: 'workspace_root_ownership_lost' });
      await handle.release();
      await expect(readFile(join(root, 'user.txt'), 'utf8')).resolves.toBe('user');
      await expect(readFile(join(fixture, 'old-copy', 'copy.txt'), 'utf8')).resolves.toBe('committed');
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it.each(['EACCES', 'EIO'])('retains an existing writer when process presence cannot be established (%s)', async (code) => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-root-unverifiable-owner-'));
    const lockDirectory = join(fixture, 'locks');
    const root = join(fixture, 'workspace');
    await mkdir(root);
    const ownerPid = 2_147_483_000;
    const original = createWorkspaceRootOwnershipManager({
      lockDirectory,
      processOwner: {
        pid: ownerPid,
        processStartedAtMs: 1_000,
        ownerToken: '11111111-1111-4111-8111-111111111111',
      },
    });
    const acquired = await original.tryAcquire({ ownerId: 'first', canonicalRoot: root, operation: 'sync' });
    if ('kind' in acquired) throw new Error('fixture did not acquire root');
    const [recordName] = (await readdir(lockDirectory)).filter((name) => name.endsWith('.json'));
    if (!recordName) throw new Error('fixture did not persist ownership');
    const recordPath = join(lockDirectory, recordName);
    const before = await readFile(recordPath, 'utf8');
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === ownerPid && signal === 0) throw Object.assign(new Error(code), { code });
      return realKill(pid, signal);
    });
    try {
      const replacement = createWorkspaceRootOwnershipManager({ lockDirectory });
      await expect(replacement.tryAcquire({ ownerId: 'second', canonicalRoot: root, operation: 'sync' }))
        .resolves.toMatchObject({ kind: 'overlap', existing: { ownerId: 'first' } });
      expect(await readFile(recordPath, 'utf8')).toBe(before);
    } finally {
      kill.mockRestore();
      await acquired.release();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rejects a missing root unless absent-target identity binding was explicitly deferred', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-root-missing-'));
    const manager = createWorkspaceRootOwnershipManager({
      lockDirectory: join(fixture, 'locks'),
      processOwner: { pid: process.pid, processStartedAtMs: 1, ownerToken: '00000000-0000-4000-8000-000000000001' },
    });
    const missing = join(fixture, 'missing');

    await expect(manager.tryAcquire({
      ownerId: 'ordinary',
      canonicalRoot: missing,
      operation: 'sync',
    })).rejects.toMatchObject({ code: 'workspace_root_identity_unavailable' });

    const deferred = await manager.tryAcquire({
      ownerId: 'bootstrap',
      canonicalRoot: missing,
      operation: 'bootstrap',
      deferRootIdentityBinding: true,
    });
    expect(deferred).not.toHaveProperty('kind');
    if (!('kind' in deferred)) await deferred.release();
    await rm(fixture, { recursive: true, force: true });
  });
  it('retains active and persisted custody when release fails, then retries the same handle', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-root-release-retry-'));
    const lockDirectory = join(fixture, 'locks');
    const root = join(fixture, 'workspace');
    await mkdir(root);
    const releaseFailure = new Error('ownership record removal failed');
    let attempts = 0;
    const manager = createWorkspaceRootOwnershipManager({
      lockDirectory,
      reclaimRecordSnapshot: async (path, raw) => {
        attempts += 1;
        if (attempts === 1) throw releaseFailure;
        return await reclaimJsonOwnerFileLockSnapshot(path, raw);
      },
    });
    const acquired = await manager.tryAcquire({ ownerId: 'one', canonicalRoot: root, operation: 'sync' });
    if ('kind' in acquired) throw new Error('fixture did not acquire root');

    await expect(acquired.release()).rejects.toBe(releaseFailure);
    await expect(manager.tryAcquire({ ownerId: 'two', canonicalRoot: root, operation: 'sync' }))
      .resolves.toMatchObject({ kind: 'overlap', existing: { ownerId: 'one' } });

    await expect(acquired.release()).resolves.toBeUndefined();
    const replacement = await manager.tryAcquire({ ownerId: 'two', canonicalRoot: root, operation: 'sync' });
    expect('kind' in replacement).toBe(false);
    if (!('kind' in replacement)) await replacement.release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('allows bootstrap recovery to bind the restored root after overlap arbitration', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-root-ownership-deferred-'));
    const root = join(fixture, 'root');
    const replacement = join(fixture, 'replacement');
    await mkdir(root);
    await writeFile(join(root, 'new.txt'), 'new');
    await mkdir(replacement);
    await writeFile(join(replacement, 'old.txt'), 'old');
    const manager = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') });
    const acquired = await manager.tryAcquire({
      ownerId: 'bootstrap',
      canonicalRoot: root,
      operation: 'bootstrap',
      deferRootIdentityBinding: true,
    });
    expect('kind' in acquired).toBe(false);
    if ('kind' in acquired) throw new Error('unexpected overlap');
    await rm(root, { recursive: true, force: true });
    await rename(replacement, root);
    await expect(acquired.bindCurrentRootIdentity()).resolves.toBeUndefined();
    await acquired.release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('rejects both ancestor and descendant overlaps', async () => {
    const lockDirectory = await mkdtemp(join(tmpdir(), 'workspace-sync-root-locks-'));
    const manager = createWorkspaceRootOwnershipManager({ lockDirectory });
    const ownedRoot = join(lockDirectory, 'ws-owner');
    const parentRoot = join(lockDirectory, 'ws-owner-parent');
    await mkdir(ownedRoot);
    await mkdir(parentRoot);
    const root = await manager.tryAcquire({ ownerId: 'one', canonicalRoot: ownedRoot, operation: 'sync' });
    expect('kind' in root).toBe(false);
    const descendant = await manager.tryAcquire({ ownerId: 'two', canonicalRoot: join(ownedRoot, 'child'), operation: 'handoff' });
    expect(descendant).toMatchObject({ kind: 'overlap', existing: { ownerId: 'one' } });
    await (root as Exclude<typeof root, { kind: 'overlap' }>).release();
    const parent = await manager.tryAcquire({ ownerId: 'three', canonicalRoot: parentRoot, operation: 'sync' });
    expect('kind' in parent).toBe(false);
    const exact = await manager.tryAcquire({ ownerId: 'four', canonicalRoot: parentRoot, operation: 'bootstrap' });
    expect(exact).toMatchObject({ kind: 'overlap' });
    await (parent as Exclude<typeof parent, { kind: 'overlap' }>).release();
    await rm(lockDirectory, { recursive: true, force: true });
  });

  it('persists exact process ownership so a reconstructed manager cannot steal a live root', async () => {
    const lockDirectory = await mkdtemp(join(tmpdir(), 'workspace-sync-root-locks-'));
    const workspaceRoot = join(lockDirectory, 'workspace-a');
    await mkdir(workspaceRoot);
    const firstManager = createWorkspaceRootOwnershipManager({ lockDirectory });
    const first = await firstManager.tryAcquire({ ownerId: 'relationship-1', canonicalRoot: workspaceRoot, operation: 'sync' });
    expect('kind' in first).toBe(false);
    expect((await readdir(lockDirectory)).some((name) => name.endsWith('.json'))).toBe(true);
    if (process.platform !== 'win32') expect((await stat(lockDirectory)).mode & 0o777).toBe(0o700);

    const reconstructed = createWorkspaceRootOwnershipManager({ lockDirectory });
    await expect(reconstructed.tryAcquire({ ownerId: 'relationship-1', canonicalRoot: workspaceRoot, operation: 'sync' }))
      .resolves.toMatchObject({ kind: 'overlap', existing: { ownerId: 'relationship-1' } });
    await expect(reconstructed.tryAcquire({ ownerId: 'relationship-2', canonicalRoot: join(workspaceRoot, 'child'), operation: 'handoff' }))
      .resolves.toMatchObject({ kind: 'overlap', existing: { ownerId: 'relationship-1' } });

    await (first as Exclude<typeof first, { kind: 'overlap' }>).release();
    await rm(lockDirectory, { recursive: true, force: true });
  });

  it('serializes the complete overlap transaction across real child processes', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-root-locks-race-'));
    const lockDirectory = join(fixture, 'locks');
    const root = join(fixture, 'workspace');
    await mkdir(join(root, 'child'), { recursive: true });
    const releasePath = join(fixture, 'release');
    const firstResultPath = join(fixture, 'first.json');
    const secondResultPath = join(fixture, 'second.json');
    const children = [
      startOwnershipChild({ lockDirectory, ownerId: 'first', canonicalRoot: root, resultPath: firstResultPath, releasePath }),
      startOwnershipChild({ lockDirectory, ownerId: 'second', canonicalRoot: join(root, 'child'), resultPath: secondResultPath, releasePath }),
    ];
    try {
      await Promise.all([waitForFile(firstResultPath), waitForFile(secondResultPath)]);
      const results = await Promise.all([firstResultPath, secondResultPath].map(async (path) => (
        JSON.parse(await readFile(path, 'utf8')) as { kind: string }
      )));
      expect(results.filter((result) => result.kind === 'acquired')).toHaveLength(1);
      expect(results.filter((result) => result.kind === 'overlap')).toHaveLength(1);
      await writeFile(releasePath, 'release', 'utf8');
      await Promise.all(children.map(({ completion }) => completion));
    } finally {
      for (const { child } of children) child.kill('SIGKILL');
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('loses ownership when the filesystem object at the canonical root is replaced', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-root-identity-'));
    const lockDirectory = join(fixture, 'locks');
    const root = join(fixture, 'workspace');
    await mkdir(root);
    const manager = createWorkspaceRootOwnershipManager({ lockDirectory });
    const acquired = await manager.tryAcquire({ ownerId: 'relationship-1', canonicalRoot: root, operation: 'sync' });
    expect('kind' in acquired).toBe(false);
    if ('kind' in acquired) throw new Error('fixture did not acquire root');

    await rename(root, `${root}-replaced`);
    await mkdir(root);
    await expect(acquired.bindCurrentRootIdentity()).rejects.toMatchObject({ code: 'workspace_root_ownership_lost' });
    await acquired.release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('loses ownership when its persisted owner record disappears after binding', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-root-record-missing-'));
    const lockDirectory = join(fixture, 'locks');
    const root = join(fixture, 'workspace');
    await mkdir(root);
    const manager = createWorkspaceRootOwnershipManager({ lockDirectory });
    const acquired = await manager.tryAcquire({ ownerId: 'relationship-1', canonicalRoot: root, operation: 'sync' });
    if ('kind' in acquired) throw new Error('fixture did not acquire root');
    await acquired.bindCurrentRootIdentity();

    const [recordName] = (await readdir(lockDirectory)).filter((name) => name.endsWith('.json'));
    if (!recordName) throw new Error('fixture did not persist ownership');
    await rm(join(lockDirectory, recordName));

    await expect(acquired.bindCurrentRootIdentity()).rejects.toMatchObject({ code: 'workspace_root_ownership_lost' });
    await acquired.release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('loses ownership when its persisted owner record is replaced after binding', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-root-record-replaced-'));
    const lockDirectory = join(fixture, 'locks');
    const root = join(fixture, 'workspace');
    await mkdir(root);
    const manager = createWorkspaceRootOwnershipManager({ lockDirectory });
    const acquired = await manager.tryAcquire({ ownerId: 'relationship-1', canonicalRoot: root, operation: 'sync' });
    if ('kind' in acquired) throw new Error('fixture did not acquire root');
    await acquired.bindCurrentRootIdentity();

    const [recordName] = (await readdir(lockDirectory)).filter((name) => name.endsWith('.json'));
    if (!recordName) throw new Error('fixture did not persist ownership');
    const recordPath = join(lockDirectory, recordName);
    const replacement = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
    await writeFile(recordPath, JSON.stringify({ ...replacement, ownerId: 'relationship-2' }), 'utf8');

    await expect(acquired.bindCurrentRootIdentity()).rejects.toMatchObject({ code: 'workspace_root_ownership_lost' });
    await acquired.release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('rejects an exact root even for the same owner within one manager', async () => {
    const lockDirectory = await mkdtemp(join(tmpdir(), 'workspace-sync-root-locks-'));
    const workspaceRoot = join(lockDirectory, 'workspace-shared-owner');
    await mkdir(workspaceRoot);
    const manager = createWorkspaceRootOwnershipManager({ lockDirectory });
    const bootstrap = await manager.tryAcquire({
      ownerId: 'relationship-1',
      canonicalRoot: workspaceRoot,
      operation: 'bootstrap',
    });
    expect('kind' in bootstrap).toBe(false);

    const controller = await manager.tryAcquire({
      ownerId: 'relationship-1',
      canonicalRoot: workspaceRoot,
      operation: 'sync',
    });
    expect(controller).toMatchObject({
      kind: 'overlap',
      existing: { ownerId: 'relationship-1', operation: 'bootstrap' },
    });
    const sameOwnerDescendant = await manager.tryAcquire({
      ownerId: 'relationship-1',
      canonicalRoot: join(workspaceRoot, 'child'),
      operation: 'sync',
    });
    expect(sameOwnerDescendant).toMatchObject({ kind: 'overlap', existing: { ownerId: 'relationship-1' } });

    await (bootstrap as Exclude<typeof bootstrap, { kind: 'overlap' }>).release();
    const replacement = await manager.tryAcquire({
      ownerId: 'relationship-2',
      canonicalRoot: workspaceRoot,
      operation: 'sync',
    });
    expect('kind' in replacement).toBe(false);
    await (replacement as Exclude<typeof replacement, { kind: 'overlap' }>).release();
    await rm(lockDirectory, { recursive: true, force: true });
  });

  it('reclaims a live pid only when exact process-start evidence proves pid reuse', async () => {
    const lockDirectory = await mkdtemp(join(tmpdir(), 'workspace-sync-root-pid-reuse-'));
    const workspaceRoot = join(lockDirectory, 'workspace');
    await mkdir(workspaceRoot);
    const firstManager = createWorkspaceRootOwnershipManager({
      lockDirectory,
      processOwner: {
        pid: 424_241,
        processStartedAtMs: 1_000,
        ownerToken: '11111111-1111-4111-8111-111111111111',
      },
      inspectProcessOwner: async () => ({ kind: 'alive', processStartedAtMs: 1_000 }),
    });
    const first = await firstManager.tryAcquire({ ownerId: 'first', canonicalRoot: workspaceRoot, operation: 'sync' });
    expect('kind' in first).toBe(false);

    const replacementManager = createWorkspaceRootOwnershipManager({
      lockDirectory,
      processOwner: {
        pid: 424_242,
        processStartedAtMs: 3_000,
        ownerToken: '22222222-2222-4222-8222-222222222222',
      },
      inspectProcessOwner: async () => ({ kind: 'alive', processStartedAtMs: 2_000 }),
    });
    const replacement = await replacementManager.tryAcquire({
      ownerId: 'replacement',
      canonicalRoot: workspaceRoot,
      operation: 'sync',
    });
    expect('kind' in replacement).toBe(false);

    if (!('kind' in first)) await first.release();
    const probe = createWorkspaceRootOwnershipManager({
      lockDirectory,
      inspectProcessOwner: async () => ({ kind: 'alive', processStartedAtMs: 3_000 }),
    });
    await expect(probe.tryAcquire({ ownerId: 'probe', canonicalRoot: workspaceRoot, operation: 'sync' }))
      .resolves.toMatchObject({ kind: 'overlap', existing: { ownerId: 'replacement' } });
    if (!('kind' in replacement)) await replacement.release();
    await rm(lockDirectory, { recursive: true, force: true });
  });

  it('reclaims a proven-dead process owner immediately without a heartbeat age', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-root-dead-owner-'));
    const lockDirectory = join(fixture, 'locks');
    const root = join(fixture, 'workspace');
    const resultPath = join(fixture, 'owner.json');
    const releasePath = join(fixture, 'never-release');
    await mkdir(root);
    const owner = startOwnershipChild({
      lockDirectory,
      ownerId: 'dead-owner',
      canonicalRoot: root,
      resultPath,
      releasePath,
    });
    try {
      await waitForFile(resultPath);
      expect(JSON.parse(await readFile(resultPath, 'utf8'))).toMatchObject({ kind: 'acquired' });
      owner.child.kill('SIGKILL');
      await expect(owner.completion).rejects.toThrow();

      const manager = createWorkspaceRootOwnershipManager({ lockDirectory });
      const replacement = await manager.tryAcquire({ ownerId: 'replacement', canonicalRoot: root, operation: 'sync' });
      expect('kind' in replacement).toBe(false);
      if (!('kind' in replacement)) await replacement.release();
    } finally {
      owner.child.kill('SIGKILL');
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('physicalizes a missing root through its deepest existing ancestor so an aliased parent still overlaps', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-root-alias-'));
    const lockDirectory = join(fixture, 'locks');
    const physicalParent = join(fixture, 'physical');
    const root = join(physicalParent, 'workspace');
    await mkdir(root, { recursive: true });
    // The same existing directory reached through an aliased ancestor, which is
    // what macOS produces for `/var` versus `/private/var`.
    const aliasedParent = join(fixture, 'alias');
    await symlink(physicalParent, aliasedParent, 'dir');

    const manager = createWorkspaceRootOwnershipManager({ lockDirectory });
    const owner = await manager.tryAcquire({ ownerId: 'existing-root', canonicalRoot: root, operation: 'sync' });
    expect('kind' in owner).toBe(false);

    // The descendant does not exist yet, so its spelling can only be related to
    // the acquired root by physicalizing the deepest ancestor that does.
    await expect(manager.tryAcquire({
      ownerId: 'missing-descendant',
      canonicalRoot: join(aliasedParent, 'workspace', 'child'),
      operation: 'bootstrap',
    })).resolves.toMatchObject({ kind: 'overlap', existing: { ownerId: 'existing-root' } });

    await expect(manager.tryAcquire({
      ownerId: 'missing-ancestor',
      canonicalRoot: aliasedParent,
      operation: 'bootstrap',
    })).resolves.toMatchObject({ kind: 'overlap', existing: { ownerId: 'existing-root' } });

    await (owner as Exclude<typeof owner, { kind: 'overlap' }>).release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('fails closed when the canonical root cannot be resolved for a non-ENOENT reason', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-root-unresolvable-'));
    const lockDirectory = join(fixture, 'locks');
    const file = join(fixture, 'not-a-directory');
    await writeFile(file, 'occupied', 'utf8');
    const manager = createWorkspaceRootOwnershipManager({ lockDirectory });

    // ENOTDIR is not absence: refusing is the only safe answer, because a
    // silently normalized spelling would escape the overlap comparison.
    await expect(manager.tryAcquire({
      ownerId: 'unresolvable',
      canonicalRoot: join(file, 'workspace'),
      operation: 'sync',
    })).rejects.toMatchObject({ code: 'ENOTDIR' });

    await rm(fixture, { recursive: true, force: true });
  });

  it('reuses canonical carried-root safety and platform-aware containment', async () => {
    const lockDirectory = await mkdtemp(join(tmpdir(), 'workspace-sync-root-locks-'));
    const manager = createWorkspaceRootOwnershipManager({ lockDirectory });
    await expect(manager.tryAcquire({ ownerId: 'bad', canonicalRoot: '../relative', operation: 'sync' })).rejects.toThrow();
    await expect(manager.tryAcquire({ ownerId: 'bad', canonicalRoot: '/', operation: 'sync' })).rejects.toThrow();

    const windowsRoot = await manager.tryAcquire({ ownerId: 'windows', canonicalRoot: 'C:\\Users\\Alice\\repo', operation: 'sync', deferRootIdentityBinding: true });
    expect('kind' in windowsRoot).toBe(false);
    await expect(manager.tryAcquire({ ownerId: 'child', canonicalRoot: 'c:/users/alice/repo/child', operation: 'handoff' }))
      .resolves.toMatchObject({ kind: 'overlap', existing: { ownerId: 'windows' } });
    const sibling = await manager.tryAcquire({ ownerId: 'sibling', canonicalRoot: 'c:/users/alice/repository', operation: 'handoff', deferRootIdentityBinding: true });
    expect('kind' in sibling).toBe(false);

    await (windowsRoot as Exclude<typeof windowsRoot, { kind: 'overlap' }>).release();
    await (sibling as Exclude<typeof sibling, { kind: 'overlap' }>).release();
    await rm(lockDirectory, { recursive: true, force: true });
  });
});
