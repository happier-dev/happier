import type { PluginStorePaths } from '../paths';
import { readPluginRegistryCommitRecord, type PluginRegistryCommitRecord } from './commitRecord';

export type PluginRegistryReconcileSurface = Readonly<{
  name: string;
  apply: (input: Readonly<{
    commit: PluginRegistryCommitRecord;
    installationState: unknown;
    isCurrent: () => Promise<boolean>;
  }>) => Promise<void>;
}>;

export type PluginRegistryReconcileResult = Readonly<{
  status: 'reconciled' | 'retryable' | 'no_commit';
  revision: number | null;
  surfaces: Readonly<Record<string, Readonly<{
    status: 'applied' | 'failed' | 'stale';
    message?: string;
  }>>>;
}>;

export function createPluginRegistryReconciler(input: Readonly<{
  paths: PluginStorePaths;
  readState: (commit: PluginRegistryCommitRecord) => Promise<unknown>;
  surfaces: readonly PluginRegistryReconcileSurface[];
}>): Readonly<{ reconcile: () => Promise<PluginRegistryReconcileResult> }> {
  const surfaceNames = new Set<string>();
  for (const surface of input.surfaces) {
    if (!surface.name || surfaceNames.has(surface.name)) throw new Error(`Duplicate plugin registry reconciliation surface '${surface.name}'`);
    surfaceNames.add(surface.name);
  }
  const appliedRevision = new Map<string, number>();
  let inFlight: Promise<PluginRegistryReconcileResult> | null = null;

  async function run(): Promise<PluginRegistryReconcileResult> {
    const commit = await readPluginRegistryCommitRecord(input.paths);
    if (!commit) return { status: 'no_commit', revision: null, surfaces: {} };
    const installationState = await input.readState(commit);
    const results: Record<string, { status: 'applied' | 'failed' | 'stale'; message?: string }> = {};
    const committedIdentity = JSON.stringify(commit);
    const isCurrent = async (): Promise<boolean> => JSON.stringify(await readPluginRegistryCommitRecord(input.paths)) === committedIdentity;

    for (const surface of input.surfaces) {
      if (appliedRevision.get(surface.name) === commit.revision) {
        results[surface.name] = { status: 'applied' };
        continue;
      }
      if (!(await isCurrent())) {
        results[surface.name] = { status: 'stale', message: 'A newer durable registry revision became current' };
        continue;
      }
      try {
        await surface.apply({ commit, installationState, isCurrent });
        if (!(await isCurrent())) {
          results[surface.name] = { status: 'stale', message: 'Surface completed after its generation fence changed' };
          continue;
        }
        appliedRevision.set(surface.name, commit.revision);
        results[surface.name] = { status: 'applied' };
      } catch (error) {
        results[surface.name] = {
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const reconciled = Object.values(results).every((result) => result.status === 'applied');
    return Object.freeze({
      status: reconciled ? 'reconciled' : 'retryable',
      revision: commit.revision,
      surfaces: Object.freeze(results),
    });
  }

  function reconcile(): Promise<PluginRegistryReconcileResult> {
    if (inFlight) return inFlight;
    const operation = run();
    inFlight = operation;
    void operation.finally(() => {
      if (inFlight === operation) inFlight = null;
    });
    return operation;
  }

  return Object.freeze({ reconcile });
}
