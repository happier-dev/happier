import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';

import type { FirstPartyInstallLayout } from './installLayout.js';

type ProperLockfileRelease = () => Promise<void>;
type ProperLockfileApi = Readonly<{
  lock: (
    path: string,
    options: Readonly<{
      lockfilePath: string;
      onCompromised: (error: Error) => void;
      realpath: boolean;
      retries: Readonly<{
        factor: number;
        maxTimeout: number;
        minTimeout: number;
        retries: number;
      }>;
      stale: number;
      update: number;
    }>,
  ) => Promise<ProperLockfileRelease>;
}>;

const PAYLOAD_MUTATION_LOCK_STALE_MS = 10 * 60_000;
const PAYLOAD_MUTATION_LOCK_UPDATE_MS = 30_000;

export class FirstPartyPayloadMutationLockError extends Error {
  readonly code: 'FIRST_PARTY_PAYLOAD_MUTATION_LOCK_COMPROMISED' | 'FIRST_PARTY_PAYLOAD_MUTATION_LOCK_RELEASE_FAILED';

  constructor(params: Readonly<{
    code: FirstPartyPayloadMutationLockError['code'];
    message: string;
    cause: unknown;
  }>) {
    super(params.message, { cause: params.cause });
    this.name = 'FirstPartyPayloadMutationLockError';
    this.code = params.code;
  }
}

export async function withFirstPartyPayloadMutationLock<T>(params: Readonly<{
  operation: () => Promise<T>;
  /** A release that failed after the mutation completed; the default reports it on stderr. */
  onReleaseFailure?: (error: unknown) => void;
}> & (
  | Readonly<{ layout: FirstPartyInstallLayout }>
  | Readonly<{ installRoot: string; lockParentDir: string }>
)): Promise<T> {
  // `proper-lockfile` is CommonJS and ships no declarations. Load it only for the
  // mutation path so unrelated consumers of the first-party-runtime barrel stay side-effect-free.
  const installRoot = 'layout' in params ? params.layout.installRoot : params.installRoot;
  const lockParentDir = 'layout' in params ? params.layout.happyHomeDir : params.lockParentDir;
  return await withProperLockfile({
    target: installRoot,
    lockfilePath: `${installRoot}.mutation.lock`,
    lockParentDir,
    operation: params.operation,
    onReleaseFailure: params.onReleaseFailure,
  });
}

/**
 * The home-wide activation owner (plan R13 d/f): the command shims in `<home>/bin`, the
 * default-channel record and an update transaction's set-aside launchers are shared by every
 * channel's install, so every activation that writes them — and an update transaction from capture
 * to commit or restore — holds this one lock (`<home>/first-party-activation.lock`), always inside
 * its install root's own lock (root → activation, never the reverse).
 */
export async function withFirstPartyActivationLock<T>(params: Readonly<{
  /** `resolveFirstPartyActivationLockTarget(layout)`: `<home>/first-party-activation`. */
  activationLockTarget: string;
  happyHomeDir: string;
  operation: () => Promise<T>;
  onReleaseFailure?: (error: unknown) => void;
}>): Promise<T> {
  return await withProperLockfile({
    target: params.activationLockTarget,
    lockfilePath: `${params.activationLockTarget}.lock`,
    lockParentDir: params.happyHomeDir,
    operation: params.operation,
    onReleaseFailure: params.onReleaseFailure,
  });
}

/** Whether a lock attempt gave up because another process holds it (proper-lockfile `ELOCKED`). */
export function isFirstPartyLockHeldError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ELOCKED');
}

function reportReleaseFailure(error: unknown): void {
  const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
  process.stderr.write(`[happier] ${error instanceof Error ? error.message : String(error)}${cause}\n`);
}

async function withProperLockfile<T>(params: Readonly<{
  target: string;
  lockfilePath: string;
  lockParentDir: string;
  operation: () => Promise<T>;
  onReleaseFailure?: (error: unknown) => void;
}>): Promise<T> {
  const properLockfile = createRequire(import.meta.url)('proper-lockfile') as ProperLockfileApi;
  const installRoot = params.target;
  const lockfilePath = params.lockfilePath;
  await mkdir(params.lockParentDir, { recursive: true });
  let compromisedError: Error | null = null;
  const release = await properLockfile.lock(installRoot, {
    lockfilePath,
    realpath: false,
    stale: PAYLOAD_MUTATION_LOCK_STALE_MS,
    update: PAYLOAD_MUTATION_LOCK_UPDATE_MS,
    retries: {
      retries: 600,
      factor: 1.1,
      minTimeout: 25,
      maxTimeout: 250,
    },
    onCompromised: (error) => {
      compromisedError = error;
    },
  });

  let outcome:
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ error: unknown; ok: false }>
    | null = null;
  try {
    const value = await params.operation();
    if (compromisedError) {
      throw new FirstPartyPayloadMutationLockError({
        code: 'FIRST_PARTY_PAYLOAD_MUTATION_LOCK_COMPROMISED',
        message: `First-party payload mutation lock was compromised for '${installRoot}'.`,
        cause: compromisedError,
      });
    }
    outcome = { ok: true, value };
  } catch (error) {
    outcome = { error, ok: false };
  }

  try {
    await release();
  } catch (releaseError) {
    const wrappedReleaseError = new FirstPartyPayloadMutationLockError({
      code: 'FIRST_PARTY_PAYLOAD_MUTATION_LOCK_RELEASE_FAILED',
      message: `First-party payload mutation lock could not be released for '${installRoot}'.`,
      cause: releaseError,
    });
    if (outcome && !outcome.ok) {
      throw new AggregateError(
        [outcome.error, wrappedReleaseError],
        'First-party payload mutation and lock release both failed.',
      );
    }
    // The mutation completed (and was not compromised): releasing is cleanup. It never replaces
    // that outcome; it is reported as the diagnostic it is, and proper-lockfile reclaims the stale
    // lock after its staleness window.
    (params.onReleaseFailure ?? reportReleaseFailure)(wrappedReleaseError);
  }

  if (!outcome) {
    throw new Error('First-party payload mutation completed without an outcome.');
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
