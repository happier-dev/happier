import type {
  DatabaseAccessReadResultV1,
  DatabaseDescriptorV1,
  DatabaseStatsCounterComparisonV1,
  DatabaseStatsObservationV1,
  DatabaseTargetV1,
  DatabaseTargetsListInputV1,
} from '@happier-dev/plugin-sdk/database';
import type { ReactNode } from 'react';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';

/** One selected Resource's host-owned presented-demand lifetime. */
export type HostDatabaseActivityResource<T> = Readonly<{
  getSnapshot(): Readonly<{ value: T | null; loading: boolean; error: unknown }>;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  retainAutoRefresh(demand: Readonly<{ intervalMs: number }>): () => void;
  invalidate(): void;
  dispose(): void;
}>;

/** Viewer-device-local counter comparisons; the host retains parsing and persistence. */
export type HostDatabaseLastLook = Readonly<{
  observe(
    observation: Extract<DatabaseStatsObservationV1, { status: 'available'; group: 'statements' }>
      | Extract<DatabaseStatsObservationV1, { status: 'unavailable' }>,
    shownKeys: readonly string[],
  ): Readonly<{ comparison: DatabaseStatsCounterComparisonV1; persistenceError: Error | null }>;
}>;

type DeploymentDatabaseTarget = Extract<DatabaseTargetV1, { kind: 'deployment_service' | 'managed_deployment' }>;
type EnvironmentAccessPolicy = Extract<DatabaseAccessReadResultV1, { setBy: 'environment' }>;

export type HostDatabaseWorkbench = Readonly<{
  /** Native service membership changes for the presented checkout's discovery list. */
  useWorktreeTargetChanges?(
    scope: Extract<DatabaseTargetsListInputV1['scope'], { kind: 'worktree' }> | null,
    onChanged: () => void,
  ): void;
  /** Cadence for presented Activity. Null means the Account preference is loading. */
  useActivityRefreshIntervalMs?(presented: boolean): number | null;
  /** The selected Machine's published reachability, only while Activity is presented. */
  useActivityMachineOffline?(serverId: string | undefined, machineId: string | undefined): boolean;
  activityResource<T>(source: Readonly<{
    read(options: Readonly<{ signal: AbortSignal }>): Promise<T>;
  }>): HostDatabaseActivityResource<T>;
  /** Scope is the mounted viewer's explicit Home/Account, never the focused tab. */
  lastLook(scope: Readonly<{ serverId: string; accountId: string }>, target: DatabaseTargetV1): HostDatabaseLastLook;
  renderEnvironmentAccessObserver?(input: Readonly<{
    target: DeploymentDatabaseTarget;
    environment?: DatabaseDescriptorV1['origin']['environment'];
    policyEnvironmentId?: string;
    onChanged(): void;
  }>): ReactNode;
  renderEnvironmentAccessSettings?(input: Readonly<{
    target: DeploymentDatabaseTarget;
    policy: EnvironmentAccessPolicy;
    /** The subscribed Environment record now permits this person to edit. */
    onEditingAllowed?(): void;
  }>): ReactNode;
  renderProductionBackup?(target: DeploymentDatabaseTarget): ReactNode;
  /** The host's Environment binding setup, including the native read role. */
  renderWriteSetup?(input: Readonly<{
    target: DeploymentDatabaseTarget;
    code: 'read_role_setup_required' | 'write_role_setup_required' | 'write_connection_setup_required';
    /** The binding settled successfully and the operation can be attempted again. */
    onConfigured(): void;
  }>): ReactNode;
}>;

/** Same-realm factories; unsupported hosts expose no replacement controller or persistence. */
export function useHostDatabaseWorkbench(): HostDatabaseWorkbench | null {
  return useOptionalPluginUiPresentationHost()?.databaseWorkbench ?? null;
}
