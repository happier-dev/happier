export type PinnedRunnerSnapshotLocation = Readonly<{
  snapshotsDir: string;
  snapshotIdentity: string;
  snapshotRoot: string;
  snapshotEntrypoint: string;
  fingerprint: string;
  runtimeAssetIdentity: string;
  workspaceRuntimeIdentity: string;
}>;

export const PINNED_RUNNER_LAYOUT_VERSION: 'package-dist-v4';
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

export function isPinnedRunnerSnapshotReady(
  location: PinnedRunnerSnapshotLocation,
): boolean;

export function listReadyPinnedRunnerSnapshots(
  entrypoint: string,
  options?: Readonly<{
    fingerprint?: string | null;
    validateSnapshot?: ((location: PinnedRunnerSnapshotLocation) => boolean) | null;
  }>,
): ReadonlyArray<Readonly<{ location: PinnedRunnerSnapshotLocation; mtimeMs: number }>>;

export function resolveNewestReadyPinnedRunnerSnapshot(
  entrypoint: string,
  options?: Readonly<{
    fingerprint?: string | null;
    validateSnapshot?: ((location: PinnedRunnerSnapshotLocation) => boolean) | null;
  }>,
): PinnedRunnerSnapshotLocation | null;
