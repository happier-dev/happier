import { readFileSync } from 'node:fs';
import {
  withWorkspaceBundleLock,
  type WorkspaceBundleLockContext,
  type WorkspaceBundleLockOptions,
} from '../../../../../packages/cli-common/workspaceBundleLock.mjs';
import { writeFileAtomic } from './outputs.ts';
import {
  BuildInputDriftError,
  isTerminalBuildFailure,
  withSingleTrailingBuildPass,
} from '../../../../../scripts/workspaces/buildInputConvergence.mjs';

function readPreparationStamp(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && 'code' in error && error.code === 'ENOENT')) return {};
    throw error;
  }
}

function readCompletion(path: string) {
  const value = readPreparationStamp(path).publication;
  if (typeof value !== 'object' || value === null) return null;
  if (!('lease' in value) || typeof value.lease !== 'string'
    || !('fingerprint' in value) || typeof value.fingerprint !== 'string'
    || !('currentness' in value) || typeof value.currentness !== 'string'
    || !('error' in value) || (value.error !== null && typeof value.error !== 'string')) return null;
  return { lease: value.lease, fingerprint: value.fingerprint, currentness: value.currentness, error: value.error };
}

export async function withGeneratorSingleFlight(input: Readonly<{
  prepare?: () => Promise<void>;
  run: (lease: WorkspaceBundleLockContext) => Promise<void>;
  readFingerprint: () => string;
  readPreparationFingerprint?: () => string;
  readCurrentness?: () => string;
  stampPath: string;
  lockOptions: WorkspaceBundleLockOptions<void>;
}>): Promise<void> {
  // Fingerprinting can fail before admission; do not claim publication for an
  // invalid request. A completion is reusable only by overlapping requests,
  // never as a durable compiler-failure memo or a blanket warm-output cache.
  input.readFingerprint();
  const previousLease = readCompletion(input.stampPath)?.lease;
  const readCurrentness = input.readCurrentness ?? input.readFingerprint;
  const reuseCompletion = () => {
    const completion = readCompletion(input.stampPath);
    if (!completion || completion.lease === previousLease
      || completion.fingerprint !== input.readFingerprint()
      || completion.currentness !== readCurrentness()) return false;
    if (completion.error !== null) throw new Error(completion.error);
    return true;
  };
  // Compilation belongs to package build owners, not publication admission.
  // Release admission before the trailing preparation too: holding it while
  // waiting for a package dist lock would recreate the publisher convoy.
  await withSingleTrailingBuildPass({
    run: async (trailing: boolean) => {
      const preparationFingerprint = (input.readPreparationFingerprint ?? input.readFingerprint)();
      try {
        await input.prepare?.();
      } catch (error) {
        // A failed child can have read a graph that moved during preparation.
        // Reuse the existing single trailing pass; package owners admit unchanged
        // outputs and rebuild only their stale inputs. Stable failures propagate.
        if (!isTerminalBuildFailure(error) && !trailing && (input.readPreparationFingerprint ?? input.readFingerprint)() !== preparationFingerprint) {
          process.stderr.write('bundled-plugins: inputs changed during failed preparation; preparing the trailing publication\n');
          throw new BuildInputDriftError(error instanceof Error ? error.message : String(error), { cause: error });
        }
        throw error;
      }
      // The phase consumes the prepared outputs, not the superseded source or
      // outputs present before preparation. Pin the actual publication inputs.
      const fingerprint = input.readFingerprint();
      let changed = false;
      await withWorkspaceBundleLock(async (lease) => {
        if (input.lockOptions.heldLockValue && !lease.inherited) {
          throw new Error('Bundled plugin inherited publication lease is not authentic');
        }
        if (reuseCompletion()) return;
        const complete = (fingerprint: string, error: string | null) => {
          lease.assertOwned();
          writeFileAtomic(input.stampPath, JSON.stringify({
            ...readPreparationStamp(input.stampPath),
            publication: { lease: lease.heldLockValue, fingerprint, currentness: readCurrentness(), error },
          }));
        };
        // Do not publish a prepared graph whose inputs changed before admission.
        // The same single trailing pass covers edits in preparation/publication.
        if (input.readFingerprint() !== fingerprint) {
          changed = true;
        } else {
          try {
            await input.run(lease);
          } catch (error) {
            if (!isTerminalBuildFailure(error) && !trailing && input.readFingerprint() !== fingerprint) {
              process.stderr.write('bundled-plugins: inputs changed during failed publication; preparing the trailing publication\n');
              changed = true;
              return;
            }
            complete(fingerprint, error instanceof Error ? error.message : String(error));
            throw error;
          }
          lease.assertOwned();
          if (input.readFingerprint() === fingerprint) {
            complete(fingerprint, null);
            return;
          }
          changed = true;
        }
        if (trailing && changed) {
          const error = new BuildInputDriftError('Bundled plugin inputs changed during the trailing publication; rerun the publisher');
          complete(fingerprint, error.message);
          throw error;
        }
      }, {
        ...input.lockOptions,
        tryResolveWaiter: async () => reuseCompletion() ? { resolved: true, value: undefined } : { resolved: false },
      });
      if (changed) throw new BuildInputDriftError('Bundled plugin inputs changed before publication completed');
    },
  });
}

/** One publisher; preparation supplies its currentness check at the commit boundary. */
export async function withPreparedGeneratorPublication<T>(input: Readonly<{
  prepare: () => Promise<() => void>;
  publish: (lease: WorkspaceBundleLockContext) => Promise<T>;
  preparationLease?: Pick<WorkspaceBundleLockContext, 'assertOwned'>;
  lockOptions: WorkspaceBundleLockOptions<T>;
}>): Promise<T> {
  input.preparationLease?.assertOwned();
  const assertCurrent = await input.prepare();
  return await withWorkspaceBundleLock(async (lease) => {
    input.preparationLease?.assertOwned();
    lease.assertOwned();
    assertCurrent();
    return await input.publish({
      ...lease,
      assertOwned: () => {
        input.preparationLease?.assertOwned();
        lease.assertOwned();
        assertCurrent();
      },
    });
  }, input.lockOptions);
}
