import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { joinPathForPathShape } from '../path/pathShape.js';
import type { FirstPartyInstallLayout } from './installLayout.js';

export class FirstPartyPayloadMutationLockError extends Error {
  readonly code = 'FIRST_PARTY_PAYLOAD_MUTATION_IN_PROGRESS';
  readonly holderPid: number | null;

  constructor(params: Readonly<{ subject: string; holderPid: number | null; lockfilePath: string }>) {
    super(
      `Another Happier process is installing or updating ${params.subject}`
      + `${params.holderPid ? ` (pid ${params.holderPid})` : ''}. Try again when it finishes.`
      + ` If no Happier process is running, remove ${params.lockfilePath}.`,
    );
    this.name = 'FirstPartyPayloadMutationLockError';
    this.holderPid = params.holderPid;
  }
}

type LockHolder = Readonly<{ pid: number; token: string | null }>;

function readErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

async function readHolder(lockfilePath: string): Promise<LockHolder | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockfilePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const pid = Number((parsed as { pid?: unknown }).pid);
    const token = (parsed as { token?: unknown }).token;
    return Number.isInteger(pid) && pid > 0 ? { pid, token: typeof token === 'string' ? token : null } : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else — still a live holder.
    return readErrorCode(error) === 'EPERM';
  }
}

/** Create the lock file with its content in one step, so a reader never sees a half-written holder. */
async function tryCreateLockfile(lockfilePath: string, content: string): Promise<boolean> {
  const tempPath = `${lockfilePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, 'utf8');
  try {
    await link(tempPath, lockfilePath);
    return true;
  } catch (error) {
    if (readErrorCode(error) === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(tempPath, { force: true });
  }
}

/**
 * One process at a time holds `lockfilePath`. A second holder fails at once rather than waiting;
 * a lock whose holder process is gone is reclaimed.
 *
 * Reclaiming is serialized by `<lock>.reclaim`, created the same exclusive way and never judged
 * stale itself: two processes that both saw the dead holder cannot both remove the lock — the
 * second either fails to take the reclaim guard, or takes it after the first finished and then
 * finds the first's live lock. A reclaim guard left by a crash inside that few-step window blocks
 * only reclaiming, and the error names the file to remove.
 */
async function withOwnedLockfile<T>(params: Readonly<{
  lockfilePath: string;
  parentDir: string;
  subject: string;
  operation: () => Promise<T>;
  onReleaseFailure?: (error: unknown) => void;
}>): Promise<T> {
  const { lockfilePath, subject } = params;
  await mkdir(params.parentDir, { recursive: true });
  const token = randomUUID();
  const content = `${JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() })}\n`;
  const busy = async (path: string = lockfilePath) => new FirstPartyPayloadMutationLockError({
    subject,
    holderPid: (await readHolder(path))?.pid ?? null,
    lockfilePath: path,
  });

  if (!(await tryCreateLockfile(lockfilePath, content))) {
    const holder = await readHolder(lockfilePath);
    if (holder === null || holder.pid === process.pid || isProcessAlive(holder.pid)) {
      throw await busy();
    }
    const guardPath = `${lockfilePath}.reclaim`;
    if (!(await tryCreateLockfile(guardPath, content))) {
      throw await busy(guardPath);
    }
    try {
      const current = await readHolder(lockfilePath);
      if (current !== null && (current.pid === process.pid || isProcessAlive(current.pid))) {
        throw await busy();
      }
      await rm(lockfilePath, { force: true });
      if (!(await tryCreateLockfile(lockfilePath, content))) {
        throw await busy();
      }
    } finally {
      await rm(guardPath, { force: true });
    }
  }

  try {
    return await params.operation();
  } finally {
    // Remove only our own lock. A release that fails never replaces the operation's outcome — the
    // mutation already happened (or already failed) — it is reported as the cleanup failure it is;
    // the lock it leaves names this process, so the next holder reclaims it once this one exits.
    try {
      if ((await readHolder(lockfilePath))?.token === token) {
        await rm(lockfilePath, { force: true });
      }
    } catch (releaseError) {
      (params.onReleaseFailure ?? reportReleaseFailure)(
        new Error(`The lock ${lockfilePath} could not be released: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`, { cause: releaseError }),
      );
    }
  }
}

function reportReleaseFailure(error: unknown): void {
  process.stderr.write(`[happier] ${error instanceof Error ? error.message : String(error)}\n`);
}

/**
 * The install mutation owner for one install root (plan R13 d/f): one process at a time installs
 * into, updates or restores it. Same name and call shape as the 0.3 owner; 0.2 has no
 * `proper-lockfile`, so this is the minimal equivalent — `<installRoot>.mutation.lock` naming its
 * holder's pid. Concurrent writers are a second click on another surface or an installer run, and
 * either should be told, not queued, so a busy lock fails at once
 * (`FIRST_PARTY_PAYLOAD_MUTATION_IN_PROGRESS`) and needs no staleness timer.
 */
export async function withFirstPartyPayloadMutationLock<T>(params: Readonly<{
  operation: () => Promise<T>;
  /** A release that failed after the operation settled; the default reports it on stderr. */
  onReleaseFailure?: (error: unknown) => void;
}> & (Readonly<{ layout: FirstPartyInstallLayout }> | Readonly<{ installRoot: string; lockParentDir: string }>)): Promise<T> {
  const installRoot = 'layout' in params ? params.layout.installRoot : params.installRoot;
  const lockParentDir = 'layout' in params ? params.layout.happyHomeDir : params.lockParentDir;
  return await withOwnedLockfile({
    lockfilePath: `${installRoot}.mutation.lock`,
    parentDir: lockParentDir,
    subject: `'${installRoot}'`,
    operation: params.operation,
    onReleaseFailure: params.onReleaseFailure,
  });
}

/**
 * The home-wide activation owner: command shims (`<home>/bin`), the default-channel record and the
 * update transactions' set-aside launchers are shared by every channel's install, so any activation
 * that writes them — and an update transaction from capture to commit or restore — holds this one
 * lock (`<home>/first-party-activation.lock`), inside its install root's lock.
 */
export async function withFirstPartyActivationLock<T>(params: Readonly<{
  happyHomeDir: string;
  operation: () => Promise<T>;
  onReleaseFailure?: (error: unknown) => void;
}>): Promise<T> {
  return await withOwnedLockfile({
    lockfilePath: joinPathForPathShape(params.happyHomeDir, 'first-party-activation.lock'),
    parentDir: params.happyHomeDir,
    subject: `the Happier commands in '${params.happyHomeDir}'`,
    operation: params.operation,
    onReleaseFailure: params.onReleaseFailure,
  });
}
