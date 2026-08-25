export type PinnedRunnerSnapshotLocation = Readonly<{
  snapshotsDir: string;
  snapshotIdentity: string;
  snapshotRoot: string;
  snapshotEntrypoint: string;
  fingerprint: string;
  runtimeAssetIdentity: string;
  workspaceRuntimeIdentity: string;
}>;

export const PINNED_RUNNER_LAYOUT_VERSION: 'package-dist-v5';
export const PINNED_RUNNER_MANAGED_PROVIDER_RUNTIME_RELATIVE_PATH: readonly string[];
export const PINNED_RUNNER_NO_MANAGED_PROVIDER_RUNTIME_SHA256: string;

export function isPinnedRunnerSnapshotStructurallyReady(
  location: PinnedRunnerSnapshotLocation,
): boolean;

export function resolvePinnedRunnerSnapshotManagedProviderRuntimeIdentity(input?: Readonly<{
  entrypoint?: string;
  runtimeRoot?: string;
  manifest?: Readonly<{ runtimeAsset?: unknown }>;
}>): string | null;

/**
 * `null` when the snapshot is runnable; otherwise a human-readable reason that
 * names the exact refusing condition (missing files included).
 */
export function explainPinnedRunnerSnapshotUnreadiness(
  location: PinnedRunnerSnapshotLocation,
): string | null;

export function isPinnedRunnerSnapshotReady(
  location: PinnedRunnerSnapshotLocation,
): boolean;

type PinnedRunnerSnapshotReadOptions = Readonly<{
  fingerprint?: string | null;
  validateSnapshot?: ((location: PinnedRunnerSnapshotLocation) => boolean) | null;
  snapshotsDir?: string | null;
}>;

export function listReadyPinnedRunnerSnapshots(
  entrypoint: string,
  options?: PinnedRunnerSnapshotReadOptions,
): ReadonlyArray<Readonly<{ location: PinnedRunnerSnapshotLocation; mtimeMs: number }>>;

export function resolveNewestReadyPinnedRunnerSnapshot(
  entrypoint: string,
  options?: PinnedRunnerSnapshotReadOptions,
): PinnedRunnerSnapshotLocation | null;
