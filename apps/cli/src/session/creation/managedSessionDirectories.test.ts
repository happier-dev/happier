import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedSessionDirectories } from './managedSessionDirectories';
import { readSessionCreationTerminalSpawnErrorDetail } from '@/api/session/sessionCreationTerminalSpawnErrorDetail';

// The environment/configuration and file logger are OS boundaries. Every owner call
// below uses its actual temp-directory root. Only the locked-file case substitutes
// the OS rm boundary; protection, containment and ownership remain real.
vi.mock('@/configuration', () => ({ configuration: { activeServerDir: '/unused' } }));
vi.mock('@/ui/logger', () => ({ logger: { warn: vi.fn() } }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rm: vi.fn(actual.rm), readdir: vi.fn(actual.readdir), lstat: vi.fn(actual.lstat) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.rm).mockReset();
  vi.mocked(fs.readdir).mockReset();
  vi.mocked(fs.lstat).mockReset();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-managed-session-'));
  roots.push(activeServerDir);
  return { activeServerDir, owner: createManagedSessionDirectories({ activeServerDir }) };
}

describe('managed session directory ownership', () => {
  it('reads known ownership fields from retained records and rewrites only canonical fields', async () => {
    const { activeServerDir, owner } = await fixture();
    const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'additive-owner' });
    const recordPath = join(activeServerDir, 'session-directories', '.owners', `${allocation.allocationId}.json`);
    const stored = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
    await writeFile(recordPath, JSON.stringify({ ...stored, futureField: { retained: true } }), { mode: 0o600 });

    expect(await owner.listRecords()).toMatchObject([{ allocationId: allocation.allocationId, sessionId: null }]);
    expect(await owner.resolveForSession({ sessionId: 'session', sessionCreationTag: 'additive-owner', path: allocation.directory })).toMatchObject({ ok: true });
    expect(JSON.parse(await readFile(recordPath, 'utf8'))).not.toHaveProperty('futureField');
    await owner.removeForSession({ sessionId: 'session', stopSession: async () => ({ status: 'not_found' }) });
    await expect(access(allocation.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('repairs permission drift on proven directories without losing their files', async () => {
    if (process.platform === 'win32') return;
    const { activeServerDir, owner } = await fixture();
    const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'permissions' });
    await owner.bind({ allocationId: allocation.allocationId, sessionId: 'session' });
    await writeFile(join(allocation.directory, 'keep'), 'retained');
    await chmod(allocation.directory, 0o755);
    expect(await owner.resolveForSession({ sessionId: 'session', path: allocation.directory })).toMatchObject({ ok: true });
    expect((await stat(allocation.directory)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(allocation.directory, 'keep'), 'utf8')).toBe('retained');
    await chmod(join(activeServerDir, 'session-directories', '.owners'), 0o755);
    expect(await owner.resolveForSession({ sessionId: 'session', path: allocation.directory })).toMatchObject({ ok: true });
    expect((await stat(join(activeServerDir, 'session-directories', '.owners'))).mode & 0o777).toBe(0o700);
    await chmod(join(activeServerDir, 'session-directories'), 0o755);
    expect(await owner.listRecords()).toHaveLength(1);
    expect((await stat(join(activeServerDir, 'session-directories'))).mode & 0o777).toBe(0o700);
  });

  it('reports protection failure on a proven existing folder instead of claiming it disappeared', async () => {
    const { activeServerDir } = await fixture();
    let refusedPath: string | null = null;
    const owner = createManagedSessionDirectories({ activeServerDir, protection: {
      platform: 'win32', windowsAclBoundary: {
        async applyAndVerify({ path }) { if (path === refusedPath) throw new Error('ACL refused'); },
        async verify() {},
      },
    } });
    const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'protection-failure' });
    await owner.bind({ allocationId: allocation.allocationId, sessionId: 'session' });
    refusedPath = allocation.directory;
    await expect(owner.resolveForSession({ sessionId: 'session', path: allocation.directory,
      approvedNewDirectoryCreation: true })).rejects.toThrow('ACL refused');
    await expect(access(allocation.directory)).resolves.toBeUndefined();
  });

  it('repairs protection while reusing unbound creation and handoff allocations', async () => {
    if (process.platform === 'win32') return;
    const { owner } = await fixture();
    const creation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'retry-protection' });
    const handoff = await owner.allocateForHandoff({ operationId: 'retry-protection', sessionId: 'session' });
    await writeFile(join(creation.directory, 'keep'), 'creation-data');
    await writeFile(join(handoff.directory, 'keep'), 'handoff-data');
    await chmod(creation.directory, 0o755);
    await chmod(handoff.directory, 0o755);
    expect(await owner.materializeForFreshSpawn({ sessionCreationTag: 'retry-protection' })).toMatchObject({ ...creation, created: false });
    expect(await owner.allocateForHandoff({ operationId: 'retry-protection', sessionId: 'session' })).toMatchObject({ ...handoff, created: false });
    for (const directory of [creation.directory, handoff.directory]) expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(creation.directory, 'keep'), 'utf8')).toBe('creation-data');
    expect(await readFile(join(handoff.directory, 'keep'), 'utf8')).toBe('handoff-data');
  });

  it('retains crash-before-bind ownership when the filesystem rejects the post-spawn binding write', async () => {
    const { activeServerDir } = await fixture();
    let failWrites = false;
    const owner = createManagedSessionDirectories({ activeServerDir, protection: {
      platform: 'win32', windowsAclBoundary: {
        async applyAndVerify({ path }) {
          if (failWrites && path.endsWith('.tmp')) throw new Error('binding write unavailable');
        },
        async verify() {},
      },
    } });
    const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'post-spawn-bind' });
    failWrites = true;
    await expect(owner.bind({ allocationId: allocation.allocationId, sessionId: 'session' })).rejects.toThrow('binding write unavailable');
    expect(await owner.listRecords()).toMatchObject([{ allocationId: allocation.allocationId, sessionId: null }]);
    await expect(access(allocation.directory)).resolves.toBeUndefined();
    failWrites = false;
    expect(await owner.resolveForSession({ sessionId: 'session', sessionCreationTag: 'post-spawn-bind', path: allocation.directory })).toMatchObject({ ok: true });
    expect(await owner.listRecords()).toMatchObject([{ allocationId: allocation.allocationId, sessionId: 'session' }]);
  });

  it('deletes healthy ownership records even when a neighboring record is malformed', async () => {
    const { activeServerDir, owner } = await fixture();
    const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'healthy' });
    await owner.bind({ allocationId: allocation.allocationId, sessionId: 'session' });
    const malformed = owner.prepareForCreation({ sessionCreationTag: 'malformed' });
    await writeFile(join(activeServerDir, 'session-directories', '.owners', `${malformed.allocationId}.json`), '{', { mode: 0o600 });
    expect(await owner.listRecords()).toMatchObject([{ allocationId: allocation.allocationId }]);
    await owner.removeForSession({ sessionId: 'session', stopSession: async () => ({ status: 'not_found' }) });
    await expect(access(allocation.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(activeServerDir, 'session-directories', '.owners', `${malformed.allocationId}.json`), 'utf8')).toBe('{');
  });

  it('resolves the current allocation without enumerating unrelated ownership records', async () => {
    const { owner } = await fixture();
    const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'direct-resume' });
    await owner.bind({ allocationId: allocation.allocationId, sessionId: 'session' });
    vi.mocked(fs.readdir).mockRejectedValue(new Error('inventory unavailable'));
    expect(await owner.resolveForSession({ sessionId: 'session', path: allocation.directory })).toMatchObject({ ok: true });
  });

  it('does not recreate an allocation removed between ownership proof and protection repair', async () => {
    const { owner } = await fixture();
    const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'removed-during-resume' });
    await owner.bind({ allocationId: allocation.allocationId, sessionId: 'session' });
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    let allocationReads = 0;
    // OS boundary: an external filesystem operation removes the directory
    // after the existence probe used by the resume's ownership/protection path.
    vi.mocked(fs.lstat).mockImplementation(async (path, options) => {
      const result = await actual.lstat(path, options);
      if (path === allocation.directory && ++allocationReads === 2) await actual.rm(path, { recursive: true });
      return result;
    });
    expect(await owner.resolveForSession({ sessionId: 'session', path: allocation.directory })).toEqual({ ok: false, errorCode: 'SESSION_DIRECTORY_MISSING' });
    await expect(access(allocation.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('compensates a newly allocated consent resume after a definite pre-admission failure', async () => {
    const { owner } = await fixture();
    const original = await owner.materializeForFreshSpawn({ sessionCreationTag: 'original' });
    await owner.bind({ allocationId: original.allocationId, sessionId: 'session' });
    const replacement = await owner.prepareForSpawn({ directory: '/unproven', existingSessionId: 'session',
      approvedNewDirectoryCreation: true, resumeRequestId: 'consent-request' });
    expect(replacement).toMatchObject({ ok: true, created: true });
    if (!replacement.ok) throw new Error('Consent resume was refused');
    await owner.rollbackFreshSpawn({ allocationId: original.allocationId, created: true, sessionId: 'session' });
    await expect(access(original.directory)).resolves.toBeUndefined();
    await owner.rollbackFreshSpawn({ allocationId: replacement.allocationId, created: false, sessionId: 'session' });
    await expect(access(replacement.directory)).resolves.toBeUndefined();
    await owner.rollbackFreshSpawn({ allocationId: replacement.allocationId, created: replacement.created === true, sessionId: 'session' });
    await expect(access(replacement.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(original.directory)).resolves.toBeUndefined();
    expect(await owner.listRecords()).toMatchObject([{ allocationId: original.allocationId }]);
  });

  it('compensates a new consent allocation when its pre-admission binding write fails', async () => {
    const { activeServerDir } = await fixture();
    let recordWrites = 0;
    const owner = createManagedSessionDirectories({ activeServerDir, protection: {
      platform: 'win32', windowsAclBoundary: {
        async applyAndVerify({ path }) {
          if (path.endsWith('.tmp') && ++recordWrites === 2) throw new Error('binding write unavailable');
        },
        async verify() {},
      },
    } });
    const replacement = owner.prepareForCreation({ sessionCreationTag: 'resume:session:consent-request' });
    await expect(owner.prepareForSpawn({ directory: '/unproven', existingSessionId: 'session',
      approvedNewDirectoryCreation: true, resumeRequestId: 'consent-request' })).rejects.toThrow('binding write unavailable');
    expect(await owner.listRecords()).toEqual([]);
    await expect(access(replacement.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('admits fresh replay creation but cannot silently recreate a bound Session on retry', async () => {
    const { owner } = await fixture();
    const prepared = owner.prepareForCreation({ sessionCreationTag: 'replay-tag' });
    const request = { directory: prepared.directory, sessionCreationTag: 'replay-tag', existingSessionId: 'replay-session' };
    const admitted = await owner.prepareForSpawn({ ...request, freshSessionCreation: true });
    expect(admitted).toMatchObject({ ok: true, directory: prepared.directory, created: true });
    if (!admitted.ok) throw new Error('Fresh replay creation was not admitted');
    await owner.bind({ allocationId: admitted.allocationId, sessionId: 'replay-session' });
    await rm(admitted.directory, { recursive: true });
    expect(await owner.prepareForSpawn(request)).toEqual({ ok: false, errorCode: 'SESSION_DIRECTORY_MISSING' });
    await expect(access(admitted.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('materializes a private allocation only after pure preparation, keyed by the namespaced tag', async () => {
    const { activeServerDir, owner } = await fixture();
    const prepared = owner.prepareForCreation({ sessionCreationTag: 'namespace-a:key' });
    expect(owner.prepareForCreation({ sessionCreationTag: 'namespace-a:key' })).toEqual(prepared);
    expect(owner.prepareForCreation({ sessionCreationTag: 'namespace-b:key' }).directory).not.toBe(prepared.directory);
    await expect(access(join(activeServerDir, 'session-directories'))).rejects.toMatchObject({ code: 'ENOENT' });
    const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'namespace-a:key' });
    expect(allocation).toEqual({ ...prepared, created: true });
    expect((await stat(allocation.directory)).isDirectory()).toBe(true);
    if (process.platform !== 'win32') expect((await stat(allocation.directory)).mode & 0o777).toBe(0o700);
    expect(await owner.listRecords()).toMatchObject([{ allocationId: allocation.allocationId, sessionId: null }]);
  });

  it('never overwrites a bound allocation and never recreates it on a missing-folder resume without consent', async () => {
    const { owner } = await fixture();
    const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'tag' });
    await owner.bind({ allocationId: allocation.allocationId, sessionId: 'session-a' });
    await expect(owner.bind({ allocationId: allocation.allocationId, sessionId: 'session-b' })).rejects.toMatchObject({ code: 'creation_conflict' });
    await expect(owner.materializeForFreshSpawn({ sessionCreationTag: 'tag' })).rejects.toMatchObject({ code: 'creation_conflict' });
    try {
      await owner.materializeForFreshSpawn({ sessionCreationTag: 'tag' });
      throw new Error('Expected ownership conflict');
    } catch (error) {
      expect(readSessionCreationTerminalSpawnErrorDetail(error)).toEqual({
        kind: 'session_creation_correspondence_conflict', code: 'creation_conflict',
      });
    }
    await rm(allocation.directory, { recursive: true });
    const request = { sessionId: 'session-a', sessionCreationTag: 'tag', path: allocation.directory };
    expect(await owner.resolveForSession(request)).toEqual({ ok: false, errorCode: 'SESSION_DIRECTORY_MISSING' });
    await expect(access(allocation.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await owner.resolveForSession({ ...request, approvedNewDirectoryCreation: true })).toMatchObject({ ok: true, directory: allocation.directory });
    if (process.platform !== 'win32') expect((await stat(allocation.directory)).mode & 0o777).toBe(0o700);
  });

  it('adopts only a matching crash-before-bind tag and never adopts another session or a forged path', async () => {
    const { owner } = await fixture();
    const first = await owner.materializeForFreshSpawn({ sessionCreationTag: 'first' });
    expect(await owner.resolveForSession({ sessionId: 'a', sessionCreationTag: 'first', path: first.directory })).toMatchObject({ ok: true });
    const second = await owner.materializeForFreshSpawn({ sessionCreationTag: 'second' });
    await owner.bind({ allocationId: second.allocationId, sessionId: 'b' });
    expect(await owner.resolveForSession({ sessionId: 'a', path: second.directory })).toEqual({ ok: false, errorCode: 'SESSION_DIRECTORY_MISSING' });
    const replacement = await owner.resolveForSession({ sessionId: 'a', path: '/unproven', approvedNewDirectoryCreation: true, resumeRequestId: 'request' });
    expect(replacement.ok).toBe(true);
    if (replacement.ok) expect(replacement.directory).not.toBe(first.directory);
    expect(await owner.resolveForSession({ sessionId: 'a', path: '/unproven' })).toEqual({ ok: false, errorCode: 'SESSION_DIRECTORY_MISSING' });
  });

  it('stops the tracked process before removing every session allocation; repeat delivery is harmless', async () => {
    const { owner } = await fixture();
    const first = await owner.materializeForFreshSpawn({ sessionCreationTag: 'first' });
    await owner.bind({ allocationId: first.allocationId, sessionId: 'a' });
    const second = await owner.allocateForHandoff({ operationId: 'return-to-a', sessionId: 'a' });
    const other = await owner.materializeForFreshSpawn({ sessionCreationTag: 'other' });
    await owner.bind({ allocationId: other.allocationId, sessionId: 'b' });
    await writeFile(join(other.directory, 'keep.txt'), 'keep');
    let stopped = false;
    await owner.removeForSession({ sessionId: 'a', stopSession: async () => {
      await expect(access(first.directory)).resolves.toBeUndefined();
      await expect(access(second.directory)).resolves.toBeUndefined();
      stopped = true;
      return { status: 'stopped' };
    } });
    expect(stopped).toBe(true);
    await expect(access(first.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(second.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(other.directory, 'keep.txt'), 'utf8')).toBe('keep');
    await owner.removeForSession({ sessionId: 'a', stopSession: async () => { throw new Error('already removed'); } });
  });

  it('refuses symlink removal without touching files outside the root', async () => {
    const { activeServerDir, owner } = await fixture();
    const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'tag' });
    await owner.bind({ allocationId: allocation.allocationId, sessionId: 'a' });
    const outside = join(activeServerDir, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'keep'), 'safe');
    await rm(allocation.directory, { recursive: true });
    await symlink(outside, allocation.directory, process.platform === 'win32' ? 'junction' : 'dir');
    await owner.removeForSession({ sessionId: 'a', stopSession: async () => ({ status: 'stopped' }) });
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('safe');
    expect(await owner.listRecords()).toMatchObject([{ pendingRemoval: true }]);
  });

  it('retains pending removal on persistent Windows locks without rejecting the cursor, and retries later', async () => {
    const { owner } = await fixture();
    const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'tag' });
    await owner.bind({ allocationId: allocation.allocationId, sessionId: 'a' });
    const originalRm = (await vi.importActual<typeof fs>('node:fs/promises')).rm;
    vi.mocked(fs.rm).mockImplementation(async (path, options) => {
      if (path === allocation.directory) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      return originalRm(path, options);
    });
    await expect(owner.removeForSession({ sessionId: 'a', stopSession: async () => ({ status: 'stopped' }) })).resolves.toBeUndefined();
    expect(await owner.listRecords()).toMatchObject([{ pendingRemoval: true }]);
    vi.mocked(fs.rm).mockReset();
    await owner.retryPendingRemovals({ stopSession: async () => ({ status: 'not_found' }) });
    expect(await owner.listRecords()).toEqual([]);
    await expect(access(allocation.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the native recursive-removal retry contract for a transient Windows lock', async () => {
    const { owner } = await fixture();
    const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'transient' });
    await owner.bind({ allocationId: allocation.allocationId, sessionId: 'a' });
    const originalRm = (await vi.importActual<typeof fs>('node:fs/promises')).rm;
    vi.mocked(fs.rm).mockImplementation(async (path, options) => {
      // Node's OS boundary retries EBUSY only with recursive + positive maxRetries.
      if (path === allocation.directory && !(options?.recursive && (options.maxRetries ?? 0) > 0)) {
        throw Object.assign(new Error('transient lock'), { code: 'EBUSY' });
      }
      return originalRm(path, options);
    });
    await owner.removeForSession({ sessionId: 'a', stopSession: async () => ({ status: 'stopped' }) });
    expect(await owner.listRecords()).toEqual([]);
    await expect(access(allocation.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries only recorded removals, preserving a later bound allocation after access is restored', async () => {
    const { owner } = await fixture();
    const old = await owner.materializeForFreshSpawn({ sessionCreationTag: 'old' });
    await owner.bind({ allocationId: old.allocationId, sessionId: 'a' });
    await owner.removeForSession({ sessionId: 'a', stopSession: async () => { throw new Error('stop incomplete'); } });
    const current = await owner.allocateForHandoff({ operationId: 'access-restored', sessionId: 'a' });
    await owner.commitHandoff({ operationId: 'access-restored', sessionId: 'a' });
    await writeFile(join(current.directory, 'keep'), 'current-session-data');
    await owner.retryPendingRemovals({ stopSession: async () => ({ status: 'stopped' }) });
    expect(await readFile(join(current.directory, 'keep'), 'utf8')).toBe('current-session-data');
    expect(await owner.listRecords()).toMatchObject([{ allocationId: current.allocationId }]);
    await expect(access(old.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('aborts only its own uncommitted handoff and proves the current path after returning to a machine', async () => {
    const { owner } = await fixture();
    const original = await owner.materializeForFreshSpawn({ sessionCreationTag: 'tag' });
    await owner.bind({ allocationId: original.allocationId, sessionId: 'a' });
    const returned = await owner.allocateForHandoff({ operationId: 'back', sessionId: 'a' });
    expect(await owner.resolveForSession({ sessionId: 'a', path: returned.directory })).toMatchObject({ ok: true, allocationId: returned.allocationId });
    await owner.commitHandoff({ operationId: 'back', sessionId: 'a' });
    await owner.abortHandoff({ operationId: 'back', sessionId: 'a' });
    await expect(access(returned.directory)).resolves.toBeUndefined();
    const aborted = await owner.allocateForHandoff({ operationId: 'aborted', sessionId: 'a' });
    await owner.abortHandoff({ operationId: 'aborted', sessionId: 'a' });
    await expect(access(aborted.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(original.directory)).resolves.toBeUndefined();
  });

  it('applies and verifies the existing Windows ACL boundary before admitting allocation state', async () => {
    const { activeServerDir } = await fixture();
    const protectedPaths = new Set<string>();
    const owner = createManagedSessionDirectories({ activeServerDir, protection: {
      platform: 'win32',
      windowsAclBoundary: {
        async applyAndVerify({ path }) { protectedPaths.add(path); },
        async verify({ path }) { if (!protectedPaths.has(path) && !path.endsWith('.json')) throw new Error('unprotected'); },
      },
    } });
    const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'tag' });
    expect(protectedPaths.has(allocation.directory)).toBe(true);
    const refused = createManagedSessionDirectories({ activeServerDir: join(activeServerDir, 'refused'), protection: {
      platform: 'win32', windowsAclBoundary: {
        async applyAndVerify() { throw new Error('ACL refused'); }, async verify() { throw new Error('ACL refused'); },
      },
    } });
    await expect(refused.materializeForFreshSpawn({ sessionCreationTag: 'tag' })).rejects.toThrow('ACL refused');
  });
});
