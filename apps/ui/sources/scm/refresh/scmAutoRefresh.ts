import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmWorkspaceWatchUnavailable } from '@happier-dev/protocol/scm';
import { PresentedAutoRefresh, type PresentedAutoRefreshDemand, type PresentedAutoRefreshWatchCallbacks } from '@/utils/runtime/presentedAutoRefresh';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export type ScmAutoRefreshDemand = Readonly<({ sessionId: string; serverId?: string | null } | { scope: WorkspaceScopeBase }) & PresentedAutoRefreshDemand>;

export type ScmAutoRefreshWatchCallbacks = PresentedAutoRefreshWatchCallbacks<ScmWorkspaceWatchUnavailable>;
export class ScmAutoRefresh extends PresentedAutoRefresh<ScmAutoRefreshDemand, ScmWorkingSnapshot | null, ScmWorkspaceWatchUnavailable> {}
