import type { AgentId } from '@happier-dev/agents';
import type { BackendTargetRefV1, BackendTargetRefV2 } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import {
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
} from './activeAccountSettingsSnapshot';
import type { ActiveAccountSettingsSnapshot } from './activeAccountSettingsSnapshot';
import { AccountSettingsStaleError } from './accountSettingsRefreshError';
import { resolveAccountSettingsScopeKey } from './accountSettingsScopeKey';
import {
  isAccountSettingsVersionAtLeast,
  normalizeAccountSettingsVersionHint,
} from './accountSettingsVersion';
import {
  bootstrapAccountSettingsContext,
  type AccountSettingsBootstrapMode,
  type AccountSettingsContext,
} from './bootstrapAccountSettingsContext';

type RefreshDeps = Readonly<{
  getActiveSnapshot: typeof getActiveAccountSettingsSnapshot;
  getActiveLifetimeToken: typeof getActiveAccountSettingsSnapshotLifetimeToken;
  bootstrapAccountSettingsContext: typeof bootstrapAccountSettingsContext;
  resolveScopeKey: typeof resolveAccountSettingsScopeKey;
}>;

type RefreshParams = Readonly<{
  credentials: StoredCredentials;
  minSettingsVersion?: number | null;
  agentId?: AgentId;
  backendTarget?: BackendTargetRefV1 | BackendTargetRefV2;
  mode?: AccountSettingsBootstrapMode;
  forceRefresh?: boolean;
  shouldCommit?: () => boolean;
  deps?: Partial<RefreshDeps>;
}>;

type InFlightRefresh = Readonly<{
  minimum: number | null;
  forceRefresh: boolean;
  promise: Promise<AccountSettingsContext>;
}>;

const inFlightByScope = new Map<string, InFlightRefresh>();

function assertMinimumSatisfied(ctx: AccountSettingsContext, minSettingsVersion: number | null): AccountSettingsContext {
  if (!isAccountSettingsVersionAtLeast(ctx.settingsVersion, minSettingsVersion)) {
    throw new AccountSettingsStaleError();
  }
  return ctx;
}

function contextFromActiveSnapshot(active: ActiveAccountSettingsSnapshot): AccountSettingsContext {
  return {
    ...active,
    whenRefreshed: null,
  };
}

export async function refreshAccountSettingsForMinimumVersion(params: RefreshParams): Promise<AccountSettingsContext> {
  const deps: RefreshDeps = {
    getActiveSnapshot: params.deps?.getActiveSnapshot ?? getActiveAccountSettingsSnapshot,
    getActiveLifetimeToken: params.deps?.getActiveLifetimeToken ?? getActiveAccountSettingsSnapshotLifetimeToken,
    bootstrapAccountSettingsContext: params.deps?.bootstrapAccountSettingsContext ?? bootstrapAccountSettingsContext,
    resolveScopeKey: params.deps?.resolveScopeKey ?? resolveAccountSettingsScopeKey,
  };
  const minSettingsVersion = normalizeAccountSettingsVersionHint(params.minSettingsVersion);
  const forceRefresh = params.forceRefresh === true;
  const scopeKey = deps.resolveScopeKey(params.credentials);

  const active = deps.getActiveSnapshot();
  if (
    !forceRefresh
    && active
    && active.scopeKey === scopeKey
    && isAccountSettingsVersionAtLeast(active.settingsVersion, minSettingsVersion)
  ) {
    return contextFromActiveSnapshot(active);
  }

  const refreshKey = `${scopeKey}\u0000${deps.getActiveLifetimeToken()}`;
  const inFlight = inFlightByScope.get(refreshKey);
  if (
    !params.shouldCommit
    && inFlight
    // A forced refresh must not be satisfied by an older opportunistic one,
    // while an opportunistic caller may safely join the stronger forced work.
    && (!forceRefresh || inFlight.forceRefresh)
    && (
      minSettingsVersion === null
      || (inFlight.minimum !== null && inFlight.minimum >= minSettingsVersion)
    )
  ) {
    return inFlight.promise.then((ctx) => assertMinimumSatisfied(ctx, minSettingsVersion));
  }

  const promise = deps.bootstrapAccountSettingsContext({
    credentials: params.credentials,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.backendTarget && params.backendTarget.kind !== 'backend' ? { backendTarget: params.backendTarget } : {}),
    mode: params.mode ?? 'blocking',
    refresh: forceRefresh ? 'force' : 'auto',
    ...(minSettingsVersion !== null ? { minSettingsVersion } : {}),
    ...(params.shouldCommit ? { shouldCommit: params.shouldCommit } : {}),
  }).then((ctx) => assertMinimumSatisfied(ctx, minSettingsVersion));

  const tracksSharedRefresh = !params.shouldCommit;
  if (tracksSharedRefresh) {
    inFlightByScope.set(refreshKey, {
      minimum: minSettingsVersion,
      forceRefresh,
      promise,
    });
  }
  try {
    return await promise;
  } finally {
    if (tracksSharedRefresh && inFlightByScope.get(refreshKey)?.promise === promise) {
      inFlightByScope.delete(refreshKey);
    }
  }
}
