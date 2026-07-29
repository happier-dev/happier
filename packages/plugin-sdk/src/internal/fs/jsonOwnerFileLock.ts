/**
 * Internal exact-owner filesystem lock implementation shared by the CLI host and the narrow
 * experimental author helper. Compatibility controls in this module are not author-facing API.
 */
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

type JsonOwnerFileLockOptions = Readonly<{
  lockPath: string;
  timeoutMs: number;
  staleAfterMs: number;
  errorCode: string;
  pollIntervalMs?: number;
  readQuarantinedRaw?: (path: string) => Promise<string>;
  readProcessStartedAtMs?: (pid: number) => Promise<number | null>;
  predecessorCompatibleDirectoryOwner?: Readonly<{
    providerId: string | null;
  }>;
}>;

type JsonOwnerFileLockRecord = Readonly<{
  pid: number;
  ownerToken: string;
  processStartedAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
}>;

type PredecessorDirectoryOwnerRecord = Readonly<{
  pid: number;
  providerId: string | null;
  acquiredAt: string;
  acquiredAtMs: number;
}>;

type FileIdentity = Readonly<{ dev: number; ino: number }>;
type FileSnapshot = Readonly<{
  raw: string;
  identity: FileIdentity;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}>;

type ReclaimResult = 'reclaimed' | 'successor_preserved' | 'ownership_unknown';

type PreparedPredecessorDirectory = Readonly<{
  path: string;
  identitySuffix: string;
  directoryIdentity: FileIdentity;
  ownerSnapshot: FileSnapshot;
}>;

type LockArtifact = Readonly<{
  path: string;
  kind: 'private' | 'quarantine';
  label: 'private' | 'reclaim' | 'publication' | 'legacy' | 'cleanup' | 'stale';
  actorPid: number;
  createdAtMs: number;
  identitySuffix: string;
  isLegacyDirectory: boolean;
}>;

const currentProcessStartedAtMs = Math.max(0, Math.trunc(Date.now() - (process.uptime() * 1_000)));

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseCurrentOwner(raw: string): JsonOwnerFileLockRecord | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    if (!hasExactKeys(record, ['pid', 'ownerToken', 'processStartedAtMs', 'createdAtMs', 'updatedAtMs'])) return null;
    if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return null;
    if (typeof record.ownerToken !== 'string' || record.ownerToken.length === 0) return null;
    if (!Number.isFinite(record.processStartedAtMs) || !Number.isFinite(record.createdAtMs) || !Number.isFinite(record.updatedAtMs)) return null;
    return {
      pid: record.pid as number,
      ownerToken: record.ownerToken,
      processStartedAtMs: Math.trunc(record.processStartedAtMs as number),
      createdAtMs: Math.trunc(record.createdAtMs as number),
      updatedAtMs: Math.trunc(record.updatedAtMs as number),
    };
  } catch {
    return null;
  }
}

/**
 * Read compatibility for the directory writer at Remote HEAD 490a27a and Dev HEAD 877ee97a.
 * Remove after those prospective predecessors can no longer coexist with or leave local state for
 * this reader. New writes always use JsonOwnerFileLockRecord.
 */
function parsePredecessorDirectoryOwner(raw: string): PredecessorDirectoryOwnerRecord | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    if (!hasExactKeys(record, ['pid', 'providerId', 'acquiredAt'])) return null;
    if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return null;
    if (record.providerId !== null && typeof record.providerId !== 'string') return null;
    if (typeof record.acquiredAt !== 'string') return null;
    const acquiredAtMs = Date.parse(record.acquiredAt);
    if (!Number.isFinite(acquiredAtMs)) return null;
    return {
      pid: record.pid as number,
      providerId: record.providerId,
      acquiredAt: record.acquiredAt,
      acquiredAtMs,
    };
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM';
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseLockArtifact(lockPath: string, name: string): LockArtifact | null {
  const lockName = escapeRegExp(basename(lockPath));
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const privateMatch = name.match(new RegExp(`^${lockName}(?:\\.reclaim)?\\.owner-(\\d+)-(\\d+)-(${uuid})$`, 'i'));
  if (privateMatch) {
    return {
      path: join(dirname(lockPath), name),
      kind: 'private',
      label: 'private',
      actorPid: Number(privateMatch[1]),
      createdAtMs: Number(privateMatch[2]),
      identitySuffix: `${privateMatch[1]}-${privateMatch[2]}-${privateMatch[3]}`,
      isLegacyDirectory: false,
    };
  }
  const quarantineMatch = name.match(new RegExp(`^${lockName}(?:\\.reclaim)?\\.(reclaim|publication|legacy|cleanup|stale)-(\\d+)-(\\d+)-(${uuid})$`, 'i'));
  if (!quarantineMatch) return null;
  return {
    path: join(dirname(lockPath), name),
    kind: 'quarantine',
    label: quarantineMatch[1] as LockArtifact['label'],
    actorPid: Number(quarantineMatch[2]),
    createdAtMs: Number(quarantineMatch[3]),
    identitySuffix: `${quarantineMatch[2]}-${quarantineMatch[3]}-${quarantineMatch[4]}`,
    isLegacyDirectory: quarantineMatch[1] === 'legacy',
  };
}

async function readArtifactOwner(artifact: LockArtifact): Promise<JsonOwnerFileLockRecord | PredecessorDirectoryOwnerRecord | null> {
  const artifactInfo = await stat(artifact.path).catch(() => null);
  const raw = artifact.isLegacyDirectory || artifactInfo?.isDirectory()
    ? await readFile(join(artifact.path, 'owner.json'), 'utf8').catch(() => null)
    : await readFile(artifact.path, 'utf8').catch(() => null);
  if (raw === null) return null;
  return parseCurrentOwner(raw) ?? parsePredecessorDirectoryOwner(raw);
}

async function inspectAndScavengeLockArtifacts(lockPath: string, staleAfterMs: number): Promise<boolean> {
  const entries = await readdir(dirname(lockPath)).catch(() => [] as string[]);
  const artifacts = entries
    .map((name) => parseLockArtifact(lockPath, name))
    .filter((artifact): artifact is LockArtifact => artifact !== null)
    .sort((left, right) => Number(right.isLegacyDirectory) - Number(left.isLegacyDirectory));
  let hasArbitratingQuarantine = false;
  for (const artifact of artifacts) {
    const owner = await readArtifactOwner(artifact);
    const oldEnough = Number.isFinite(artifact.createdAtMs)
      && Date.now() - artifact.createdAtMs >= staleAfterMs;
    const actorIsDead = !isPidAlive(artifact.actorPid);
    const exactDeadOwner = owner !== null && !isPidAlive(owner.pid);
    if (artifact.kind === 'private' && oldEnough && actorIsDead) {
      const directoryInfo = await stat(artifact.path).catch(() => null);
      if (directoryInfo?.isDirectory()) {
        const ownerSnapshot = await readSnapshot(join(artifact.path, 'owner.json'));
        const predecessorOwner = ownerSnapshot ? parsePredecessorDirectoryOwner(ownerSnapshot.raw) : null;
        if (ownerSnapshot && predecessorOwner?.pid === artifact.actorPid && !isPidAlive(predecessorOwner.pid)) {
          if (await removeExactPredecessorDirectory(
            artifact.path,
            lockPath,
            artifact.identitySuffix,
            { dev: directoryInfo.dev, ino: directoryInfo.ino },
            ownerSnapshot,
          )) continue;
        } else if (!ownerSnapshot) {
          const before = { dev: directoryInfo.dev, ino: directoryInfo.ino };
          const empty = await readdir(artifact.path).then((names) => names.length === 0, () => false);
          if (empty && await sameDirectoryIdentity(artifact.path, before)) {
            await rmdir(artifact.path).catch(() => {});
            continue;
          }
        }
      }
    }
    if (artifact.isLegacyDirectory && owner === null && oldEnough && actorIsDead) {
      const sidecar = artifacts.find((candidate) => candidate.label === 'cleanup'
        && candidate.identitySuffix === artifact.identitySuffix);
      const sidecarOwner = sidecar ? await readArtifactOwner(sidecar) : null;
      if (sidecar && sidecarOwner && !isPidAlive(sidecarOwner.pid)) {
        const before = await stat(artifact.path).catch(() => null);
        const empty = before?.isDirectory() && await readdir(artifact.path).then((names) => names.length === 0, () => false);
        const after = empty ? await stat(artifact.path).catch(() => null) : null;
        if (before?.isDirectory() && after?.isDirectory()
          && before.dev === after.dev && before.ino === after.ino) {
          await rmdir(artifact.path).catch(() => {});
        }
      }
    }
    if (oldEnough && actorIsDead && exactDeadOwner) {
      if (artifact.isLegacyDirectory) {
        const ownerSnapshot = await readSnapshot(join(artifact.path, 'owner.json'));
        if (ownerSnapshot && parsePredecessorDirectoryOwner(ownerSnapshot.raw)) {
          const directoryInfo = await stat(artifact.path).catch(() => null);
          if (directoryInfo?.isDirectory() && await removeExactPredecessorDirectory(
            artifact.path,
            lockPath,
            artifact.identitySuffix,
            { dev: directoryInfo.dev, ino: directoryInfo.ino },
            ownerSnapshot,
          )) continue;
        }
      } else {
        const snapshot = await readSnapshot(artifact.path);
        const parsed = snapshot ? parseCurrentOwner(snapshot.raw) ?? parsePredecessorDirectoryOwner(snapshot.raw) : null;
        const privateOwnerMatchesActor = artifact.kind !== 'private' || parseCurrentOwner(snapshot?.raw ?? '')?.pid === artifact.actorPid;
        if (snapshot && parsed && privateOwnerMatchesActor
          && await unlinkExactFile(artifact.path, snapshot)) continue;
      }
    }
    if (artifact.kind === 'quarantine') hasArbitratingQuarantine = true;
  }
  return hasArbitratingQuarantine;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameContentVersion(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.raw === right.raw
    && sameIdentity(left.identity, right.identity)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

async function readSnapshot(path: string): Promise<FileSnapshot | null> {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const before = await handle.stat();
    const raw = await handle.readFile('utf8');
    const after = await handle.stat();
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) return null;
    return {
      raw,
      identity: { dev: after.dev, ino: after.ino },
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function snapshotStillMatches(path: string, expected: FileSnapshot): Promise<boolean> {
  const current = await readSnapshot(path);
  return current !== null
    && current.raw === expected.raw
    && sameIdentity(current.identity, expected.identity)
    && current.size === expected.size
    && current.mtimeMs === expected.mtimeMs
    && current.ctimeMs === expected.ctimeMs;
}

async function unlinkExactFile(path: string, expected: FileSnapshot): Promise<boolean> {
  if (!(await snapshotStillMatches(path, expected))) return false;
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

async function restoreQuarantinedFile(quarantinePath: string, destinationPath: string, moved: FileSnapshot): Promise<boolean> {
  if (!(await snapshotStillMatches(quarantinePath, moved))) return false;
  try {
    await link(quarantinePath, destinationPath);
  } catch {
    return false;
  }
  const linked = await readSnapshot(quarantinePath);
  if (!linked || !sameContentVersion(linked, moved)) return false;
  await unlinkExactFile(quarantinePath, linked);
  return true;
}

async function quarantineExactFile(
  path: string,
  expected: FileSnapshot,
  quarantineLabel: string,
  readQuarantinedRaw: (path: string) => Promise<string>,
): Promise<ReclaimResult> {
  if (!(await snapshotStillMatches(path, expected))) return 'successor_preserved';
  const quarantinePath = `${path}.${quarantineLabel}-${process.pid}-${Date.now()}-${randomUUID()}`;
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'reclaimed' : 'successor_preserved';
  }

  let movedRaw: string;
  try {
    movedRaw = await readQuarantinedRaw(quarantinePath);
  } catch {
    const moved = await readSnapshot(quarantinePath);
    if (moved) await restoreQuarantinedFile(quarantinePath, path, moved);
    return 'ownership_unknown';
  }
  const moved = await readSnapshot(quarantinePath);
  if (!moved) return 'ownership_unknown';
  if (movedRaw !== expected.raw || !sameContentVersion(moved, expected)) {
    await restoreQuarantinedFile(quarantinePath, path, moved);
    return 'successor_preserved';
  }
  return await unlinkExactFile(quarantinePath, moved) ? 'reclaimed' : 'ownership_unknown';
}

async function publishReclaimGuard(path: string): Promise<{ snapshot: FileSnapshot; privatePath: string } | ReclaimResult> {
  const privatePath = `${path}.reclaim.owner-${process.pid}-${Date.now()}-${randomUUID()}`;
  const raw = serializeOwner(Date.now());
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let snapshot: FileSnapshot | null = null;
  try {
    handle = await open(privatePath, 'wx', 0o600);
    await handle.writeFile(raw, 'utf8');
    await handle.sync();
    const info = await handle.stat();
    snapshot = {
      raw,
      identity: { dev: info.dev, ino: info.ino },
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
    };
    await handle.close();
    handle = null;
    await link(privatePath, `${path}.reclaim`);
    const linkedPrivate = await readSnapshot(privatePath);
    if (!linkedPrivate || !sameContentVersion(linkedPrivate, snapshot)) return 'ownership_unknown';
    await unlinkExactFile(privatePath, linkedPrivate);
    const published = await readSnapshot(`${path}.reclaim`);
    if (!published || published.raw !== raw || !sameIdentity(published.identity, snapshot.identity)) return 'ownership_unknown';
    return { snapshot: published, privatePath };
  } catch (error) {
    await handle?.close().catch(() => {});
    const privateSnapshot = await readSnapshot(privatePath);
    if (privateSnapshot) await unlinkExactFile(privatePath, privateSnapshot);
    return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST' ? 'successor_preserved' : 'ownership_unknown';
  }
}

export async function reclaimJsonOwnerFileLockSnapshot(
  path: string,
  expectedRaw: string,
  readQuarantinedRaw: (path: string) => Promise<string> = async (quarantinePath) => await readFile(quarantinePath, 'utf8'),
): Promise<ReclaimResult> {
  // A reclaimer can die after publishing its guard but before removing it. Recover a
  // guard whose owner is proven dead (or whose unparseable bytes are safely stale)
  // before attempting to publish the next exact-owner reclaim.
  await recoverStaleReclaimGuard(path, 60_000, readQuarantinedRaw);
  const guard = await publishReclaimGuard(path);
  if (typeof guard === 'string') return guard;

  try {
    const current = await readSnapshot(path);
    if (!current) return 'reclaimed';
    if (current.raw !== expectedRaw) return 'successor_preserved';
    return await quarantineExactFile(path, current, 'reclaim', readQuarantinedRaw);
  } finally {
    await quarantineExactFile(`${path}.reclaim`, guard.snapshot, 'cleanup', async (quarantinePath) => await readFile(quarantinePath, 'utf8'));
  }
}

async function shouldReclaimCurrent(
  snapshot: FileSnapshot,
  staleAfterMs: number,
  readProcessStartedAtMs?: (pid: number) => Promise<number | null>,
): Promise<boolean> {
  const owner = parseCurrentOwner(snapshot.raw);
  if (owner) {
    if (!isPidAlive(owner.pid)) return true;
    if (owner.pid === process.pid) {
      return Math.abs(owner.processStartedAtMs - currentProcessStartedAtMs) > 1_000;
    }
    if (!readProcessStartedAtMs) return false;
    const observedProcessStartedAtMs = await readProcessStartedAtMs(owner.pid).catch(() => null);
    return observedProcessStartedAtMs !== null
      && Math.abs(owner.processStartedAtMs - observedProcessStartedAtMs) > 1_000;
  }
  return Number.isFinite(snapshot.mtimeMs) && Date.now() - snapshot.mtimeMs > staleAfterMs;
}

async function recoverStaleReclaimGuard(
  path: string,
  staleAfterMs: number,
  readQuarantinedRaw: (path: string) => Promise<string>,
  readProcessStartedAtMs?: (pid: number) => Promise<number | null>,
): Promise<boolean> {
  const guardPath = `${path}.reclaim`;
  const snapshot = await readSnapshot(guardPath);
  if (!snapshot || !(await shouldReclaimCurrent(
    snapshot,
    staleAfterMs,
    readProcessStartedAtMs,
  ))) return false;
  return await quarantineExactFile(guardPath, snapshot, 'stale', readQuarantinedRaw) === 'reclaimed';
}

async function sameDirectoryIdentity(path: string, expected: FileIdentity): Promise<boolean> {
  const current = await stat(path).catch(() => null);
  return current?.isDirectory() === true
    && current.dev === expected.dev
    && current.ino === expected.ino;
}

async function removeExactPredecessorDirectory(
  quarantinePath: string,
  path: string,
  identitySuffix: string,
  directoryIdentity: FileIdentity,
  ownerSnapshot: FileSnapshot,
): Promise<boolean> {
  if (!(await sameDirectoryIdentity(quarantinePath, directoryIdentity))
    || !(await snapshotStillMatches(join(quarantinePath, 'owner.json'), ownerSnapshot))) return false;

  const cleanupPath = `${path}.cleanup-${identitySuffix}`;
  try {
    await link(join(quarantinePath, 'owner.json'), cleanupPath);
  } catch {
    return false;
  }
  const cleanupSnapshot = await readSnapshot(cleanupPath);
  if (!cleanupSnapshot || !sameContentVersion(cleanupSnapshot, ownerSnapshot)) {
    return false;
  }
  const linkedOwnerSnapshot = await readSnapshot(join(quarantinePath, 'owner.json'));
  if (!linkedOwnerSnapshot
    || !sameContentVersion(linkedOwnerSnapshot, ownerSnapshot)
    || !sameContentVersion(linkedOwnerSnapshot, cleanupSnapshot)
    || !(await unlinkExactFile(join(quarantinePath, 'owner.json'), linkedOwnerSnapshot))) {
    await unlinkExactFile(cleanupPath, cleanupSnapshot);
    return false;
  }

  try {
    await rmdir(quarantinePath);
  } catch {
    if (await sameDirectoryIdentity(quarantinePath, directoryIdentity)) {
      await link(cleanupPath, join(quarantinePath, 'owner.json')).catch(() => {});
    }
    return false;
  } finally {
    const currentCleanup = await readSnapshot(cleanupPath);
    if (currentCleanup && sameContentVersion(currentCleanup, cleanupSnapshot)) {
      await unlinkExactFile(cleanupPath, currentCleanup);
    }
  }
  return true;
}

async function restorePredecessorDirectory(
  quarantinePath: string,
  path: string,
  directoryIdentity: FileIdentity,
  ownerSnapshot: FileSnapshot,
): Promise<void> {
  try {
    if (!(await sameDirectoryIdentity(quarantinePath, directoryIdentity))
      || !(await snapshotStillMatches(join(quarantinePath, 'owner.json'), ownerSnapshot))
      || await lstat(path).then(() => true, () => false)) return;
    await rename(quarantinePath, path);
    if (!(await sameDirectoryIdentity(path, directoryIdentity))
      || !(await snapshotStillMatches(join(path, 'owner.json'), ownerSnapshot))) return;
  } catch {
    // Ownership changed while restoring. Preserve whichever complete path won publication.
  }
}

async function quarantineExactPredecessorDirectory(
  path: string,
  directoryIdentity: FileIdentity,
  ownerSnapshot: FileSnapshot,
): Promise<ReclaimResult> {
  if (!(await sameDirectoryIdentity(path, directoryIdentity))
    || !(await snapshotStillMatches(join(path, 'owner.json'), ownerSnapshot))) return 'successor_preserved';
  const identitySuffix = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const quarantinePath = `${path}.legacy-${identitySuffix}`;
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'reclaimed' : 'successor_preserved';
  }
  const movedDirectory = await stat(quarantinePath).catch(() => null);
  const movedOwner = await readSnapshot(join(quarantinePath, 'owner.json'));
  const movedIdentity = movedDirectory?.isDirectory()
    ? { dev: movedDirectory.dev, ino: movedDirectory.ino }
    : null;
  if (!movedIdentity || !movedOwner
    || !sameIdentity(movedIdentity, directoryIdentity)
    || !sameContentVersion(movedOwner, ownerSnapshot)) {
    if (movedIdentity && movedOwner) {
      await restorePredecessorDirectory(quarantinePath, path, movedIdentity, movedOwner);
    }
    return 'successor_preserved';
  }
  return await removeExactPredecessorDirectory(
    quarantinePath,
    path,
    identitySuffix,
    movedIdentity,
    movedOwner,
  ) ? 'reclaimed' : 'ownership_unknown';
}

async function recoverLegacyDirectory(path: string, staleAfterMs: number): Promise<void> {
  const directoryInfo = await stat(path).catch(() => null);
  if (!directoryInfo?.isDirectory()) return;
  const ownerPath = join(path, 'owner.json');
  const ownerSnapshot = await readSnapshot(ownerPath);
  if (!ownerSnapshot) return;
  const owner = parsePredecessorDirectoryOwner(ownerSnapshot.raw);
  if (!owner || isPidAlive(owner.pid) || Date.now() - owner.acquiredAtMs < staleAfterMs) return;

  await quarantineExactPredecessorDirectory(
    path,
    { dev: directoryInfo.dev, ino: directoryInfo.ino },
    ownerSnapshot,
  );
}

async function releasePredecessorCompatibleDirectory(path: string, expectedRaw: string): Promise<boolean> {
  const directoryInfo = await stat(path).catch(() => null);
  const ownerPath = join(path, 'owner.json');
  const ownerSnapshot = await readSnapshot(ownerPath);
  if (!directoryInfo?.isDirectory() || !ownerSnapshot || ownerSnapshot.raw !== expectedRaw) return false;
  return await quarantineExactPredecessorDirectory(
    path,
    { dev: directoryInfo.dev, ino: directoryInfo.ino },
    ownerSnapshot,
  ) === 'reclaimed';
}

async function discardPreparedPredecessorDirectory(prepared: PreparedPredecessorDirectory): Promise<void> {
  await removeExactPredecessorDirectory(
    prepared.path,
    prepared.path.slice(0, -`.owner-${prepared.identitySuffix}`.length),
    prepared.identitySuffix,
    prepared.directoryIdentity,
    prepared.ownerSnapshot,
  );
}

async function preparePredecessorDirectory(path: string, raw: string): Promise<PreparedPredecessorDirectory> {
  const identitySuffix = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const privatePath = `${path}.owner-${identitySuffix}`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let directoryIdentity: FileIdentity | null = null;
  try {
    await mkdir(privatePath, { mode: 0o700 });
    const directoryInfo = await stat(privatePath);
    if (!directoryInfo.isDirectory()) throw new Error('predecessor lock preparation is not a directory');
    directoryIdentity = { dev: directoryInfo.dev, ino: directoryInfo.ino };
    handle = await open(join(privatePath, 'owner.json'), 'wx', 0o600);
    await handle.writeFile(raw, 'utf8');
    await handle.sync();
    await handle.chmod(0o400);
    await handle.sync();
    const ownerInfo = await handle.stat();
    const ownerSnapshot = {
      raw,
      identity: { dev: ownerInfo.dev, ino: ownerInfo.ino },
      size: ownerInfo.size,
      mtimeMs: ownerInfo.mtimeMs,
      ctimeMs: ownerInfo.ctimeMs,
    } satisfies FileSnapshot;
    await handle.close();
    handle = null;
    return { path: privatePath, identitySuffix, directoryIdentity, ownerSnapshot };
  } catch (error) {
    await handle?.close().catch(() => {});
    const ownerSnapshot = await readSnapshot(join(privatePath, 'owner.json'));
    if (ownerSnapshot) await unlinkExactFile(join(privatePath, 'owner.json'), ownerSnapshot);
    if (directoryIdentity && await sameDirectoryIdentity(privatePath, directoryIdentity)) {
      const empty = await readdir(privatePath).then((names) => names.length === 0, () => false);
      if (empty && await sameDirectoryIdentity(privatePath, directoryIdentity)) {
        await rmdir(privatePath).catch(() => {});
      }
    }
    throw error;
  }
}

async function isOccupiedPathError(error: unknown, path: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'EEXIST' || code === 'ENOTEMPTY') return true;
  return (code === 'EPERM' || code === 'EACCES')
    && await lstat(path).then(() => true, () => false);
}

async function withPredecessorCompatibleDirectoryLock<TResult>(
  options: JsonOwnerFileLockOptions,
  effect: () => Promise<TResult>,
): Promise<TResult> {
  const predecessorOwner = options.predecessorCompatibleDirectoryOwner;
  if (!predecessorOwner) throw new Error('predecessor-compatible owner is required');
  const startedAtMs = Date.now();
  const pollIntervalMs = Math.max(1, Math.trunc(options.pollIntervalMs ?? 10));
  for (;;) {
    if (Date.now() - startedAtMs >= options.timeoutMs) throw new Error(options.errorCode);
    if (await inspectAndScavengeLockArtifacts(options.lockPath, options.staleAfterMs)) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      continue;
    }
    await recoverLegacyDirectory(options.lockPath, options.staleAfterMs);
    const currentFile = await readSnapshot(options.lockPath);
    if (currentFile && await shouldReclaimCurrent(
      currentFile,
      options.staleAfterMs,
      options.readProcessStartedAtMs,
    )) {
      const reclaim = await reclaimJsonOwnerFileLockSnapshot(options.lockPath, currentFile.raw);
      if (reclaim === 'ownership_unknown') throw new Error(`${options.errorCode}_compromised`);
      continue;
    }
    const acquiredAt = new Date().toISOString();
    const raw = JSON.stringify({
      pid: process.pid,
      providerId: predecessorOwner.providerId,
      acquiredAt,
    });
    let prepared: PreparedPredecessorDirectory | null = null;
    let published = false;
    try {
      prepared = await preparePredecessorDirectory(options.lockPath, raw);
      if (await lstat(options.lockPath).then(() => true, () => false)) {
        throw Object.assign(new Error('lock path occupied before publication'), { code: 'EEXIST' });
      }
      await rename(prepared.path, options.lockPath);
      published = true;
      if (!(await sameDirectoryIdentity(options.lockPath, prepared.directoryIdentity))
        || !(await snapshotStillMatches(join(options.lockPath, 'owner.json'), prepared.ownerSnapshot))) {
        throw new Error(`${options.errorCode}_compromised`);
      }
      if (await inspectAndScavengeLockArtifacts(options.lockPath, options.staleAfterMs)) {
        if (!(await releasePredecessorCompatibleDirectory(options.lockPath, raw))) {
          throw new Error(`${options.errorCode}_compromised`);
        }
        published = false;
        throw Object.assign(new Error('lock quarantine raced publication'), { code: 'EEXIST' });
      }
      try {
        return await effect();
      } finally {
        if (!(await releasePredecessorCompatibleDirectory(options.lockPath, raw))) {
          throw new Error(`${options.errorCode}_compromised`);
        }
        published = false;
      }
    } catch (error) {
      if (prepared && !published) await discardPreparedPredecessorDirectory(prepared);
      if (published) {
        if (!(await releasePredecessorCompatibleDirectory(options.lockPath, raw))) {
          throw new Error(`${options.errorCode}_compromised`);
        }
        published = false;
      }
      if (!(await isOccupiedPathError(error, options.lockPath))) throw error;
      if (Date.now() - startedAtMs >= options.timeoutMs) throw new Error(options.errorCode);
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

function serializeOwner(nowMs: number): string {
  return JSON.stringify({
    pid: process.pid,
    ownerToken: randomUUID(),
    processStartedAtMs: currentProcessStartedAtMs,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  } satisfies JsonOwnerFileLockRecord);
}

export async function withJsonOwnerFileLock<TResult>(
  options: JsonOwnerFileLockOptions,
  effect: () => Promise<TResult>,
): Promise<TResult> {
  const startedAtMs = Date.now();
  const pollIntervalMs = Math.max(1, Math.trunc(options.pollIntervalMs ?? 10));
  const readQuarantinedRaw = options.readQuarantinedRaw ?? (async (path) => await readFile(path, 'utf8'));
  await mkdir(dirname(options.lockPath), { recursive: true });

  if (options.predecessorCompatibleDirectoryOwner) {
    return await withPredecessorCompatibleDirectoryLock(options, effect);
  }

  let ownRaw: string | null = null;
  for (;;) {
    if (Date.now() - startedAtMs >= options.timeoutMs) throw new Error(options.errorCode);
    if (await inspectAndScavengeLockArtifacts(options.lockPath, options.staleAfterMs)) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      continue;
    }
    await recoverLegacyDirectory(options.lockPath, options.staleAfterMs);
    await recoverStaleReclaimGuard(
      options.lockPath,
      options.staleAfterMs,
      readQuarantinedRaw,
      options.readProcessStartedAtMs,
    );
    const ownerTempPath = `${options.lockPath}.owner-${process.pid}-${Date.now()}-${randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let ownerSnapshot: FileSnapshot | null = null;
    let ownerPublished = false;
    try {
      ownRaw = serializeOwner(Date.now());
      handle = await open(ownerTempPath, 'wx', 0o600);
      await handle.writeFile(ownRaw, 'utf8');
      await handle.sync();
      const info = await handle.stat();
      ownerSnapshot = {
        raw: ownRaw,
        identity: { dev: info.dev, ino: info.ino },
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
      };
      await handle.close();
      handle = null;
      if (await stat(`${options.lockPath}.reclaim`).then(() => true, () => false)) {
        throw Object.assign(new Error('lock reclaim in progress'), { code: 'EEXIST' });
      }
      await link(ownerTempPath, options.lockPath);
      ownerPublished = true;
      if (await stat(`${options.lockPath}.reclaim`).then(() => true, () => false)
        || await inspectAndScavengeLockArtifacts(options.lockPath, options.staleAfterMs)) {
        const canonicalSnapshot = await readSnapshot(options.lockPath);
        const removed = canonicalSnapshot
          && canonicalSnapshot.raw === ownRaw
          && sameIdentity(canonicalSnapshot.identity, ownerSnapshot.identity)
          ? await quarantineExactFile(options.lockPath, canonicalSnapshot, 'publication', readQuarantinedRaw)
          : 'successor_preserved';
        if (removed === 'reclaimed') ownerPublished = false;
        throw Object.assign(new Error('lock reclaim raced publication'), { code: 'EEXIST' });
      }
      const linkedPrivate = await readSnapshot(ownerTempPath);
      if (linkedPrivate) await unlinkExactFile(ownerTempPath, linkedPrivate);
      break;
    } catch (error) {
      await handle?.close().catch(() => {});
      const privateSnapshot = await readSnapshot(ownerTempPath);
      if (privateSnapshot) await unlinkExactFile(ownerTempPath, privateSnapshot);
      if (ownerPublished && ownRaw !== null) {
        const release = await reclaimJsonOwnerFileLockSnapshot(options.lockPath, ownRaw, readQuarantinedRaw);
        if (release === 'ownership_unknown') throw new Error(`${options.errorCode}_compromised`);
        throw error;
      }
      ownRaw = null;
      if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error;
      if (Date.now() - startedAtMs >= options.timeoutMs) throw new Error(options.errorCode);
      const observed = await readSnapshot(options.lockPath);
      if (observed && await shouldReclaimCurrent(
        observed,
        options.staleAfterMs,
        options.readProcessStartedAtMs,
      )) {
        const reclaim = await reclaimJsonOwnerFileLockSnapshot(options.lockPath, observed.raw, readQuarantinedRaw);
        if (reclaim === 'ownership_unknown') throw new Error(`${options.errorCode}_compromised`);
      }
      if (Date.now() - startedAtMs >= options.timeoutMs) throw new Error(options.errorCode);
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  try {
    return await effect();
  } finally {
    if (ownRaw !== null) {
      const release = await reclaimJsonOwnerFileLockSnapshot(options.lockPath, ownRaw, readQuarantinedRaw);
      if (release === 'ownership_unknown') throw new Error(`${options.errorCode}_compromised`);
    }
  }
}
