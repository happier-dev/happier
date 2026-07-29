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

// `proper-lockfile` is CommonJS and ships no declarations. Keep the cast at that package boundary.
const properLockfile = createRequire(import.meta.url)('proper-lockfile') as ProperLockfileApi;

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
  layout: FirstPartyInstallLayout;
  operation: () => Promise<T>;
}>): Promise<T> {
  await mkdir(params.layout.happyHomeDir, { recursive: true });
  const lockfilePath = `${params.layout.installRoot}.mutation.lock`;
  let compromisedError: Error | null = null;
  const release = await properLockfile.lock(params.layout.installRoot, {
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
        message: `First-party payload mutation lock was compromised for '${params.layout.installRoot}'.`,
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
      message: `First-party payload mutation lock could not be released for '${params.layout.installRoot}'.`,
      cause: releaseError,
    });
    if (outcome && !outcome.ok) {
      throw new AggregateError(
        [outcome.error, wrappedReleaseError],
        'First-party payload mutation and lock release both failed.',
      );
    }
    throw wrappedReleaseError;
  }

  if (!outcome) {
    throw new Error('First-party payload mutation completed without an outcome.');
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
