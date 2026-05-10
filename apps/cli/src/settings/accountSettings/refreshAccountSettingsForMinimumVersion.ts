import type { AgentId } from '@happier-dev/agents';
import type { BackendTargetRefV1, BackendTargetRefV2 } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from './activeAccountSettingsSnapshot';
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
  bootstrapAccountSettingsContext: typeof bootstrapAccountSettingsContext;
  resolveScopeKey: typeof resolveAccountSettingsScopeKey;
}>;

type RefreshParams = Readonly<{
  credentials: Credentials;
  minSettingsVersion?: number | null;
  agentId?: AgentId;
  backendTarget?: BackendTargetRefV1 | BackendTargetRefV2;
  mode?: AccountSettingsBootstrapMode;
  forceRefresh?: boolean;
  deps?: Partial<RefreshDeps>;
}>;

type InFlightRefresh = Readonly<{
  minimum: number | null;
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

  const refreshKey = scopeKey;
  const inFlight = inFlightByScope.get(refreshKey);
  if (
    !forceRefresh
    &&
    inFlight
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
  }).then((ctx) => assertMinimumSatisfied(ctx, minSettingsVersion));

  inFlightByScope.set(refreshKey, { minimum: minSettingsVersion, promise });
  try {
    return await promise;
  } finally {
    if (inFlightByScope.get(refreshKey)?.promise === promise) {
      inFlightByScope.delete(refreshKey);
    }
  }
}
