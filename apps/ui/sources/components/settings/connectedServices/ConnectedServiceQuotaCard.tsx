import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { useAuth } from '@/auth/context/AuthContext';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { useCredentialScopedAccountModeResolver } from '@/hooks/server/connectedServices/useCredentialScopedAccountModeResolver';
import { getConnectedServiceQuotaSnapshotSealed, requestConnectedServiceQuotaSnapshotRefresh } from '@/sync/api/account/apiConnectedServicesQuotasV2';
import { getConnectedServiceQuotaSnapshotPlain, requestConnectedServiceQuotaSnapshotRefreshV3 } from '@/sync/api/account/apiConnectedServicesQuotasV3';
import { openConnectedServiceQuotaSnapshot } from '@/sync/domains/connectedServices/openConnectedServiceQuotaSnapshot';
import { sanitizeEndpointErrorMessage } from '@/sync/runtime/connectivity/sanitizeEndpointErrorMessage';
import type { ConnectedServiceId, ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import { t } from '@/text';

import { ConnectedServiceQuotaMeterRow } from './ConnectedServiceQuotaMeterRow';

function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type QuotaCardLoadScope = Readonly<{
  credentialScopeKey: string;
  serviceId: ConnectedServiceId;
  profileId: string;
}>;
type QuotaCardRefreshAndReloadInFlight = Readonly<{
  scope: QuotaCardLoadScope;
  promise: Promise<void>;
}>;

function resolveQuotaCardLoadScopeKey(scope: QuotaCardLoadScope): string {
  return [
    scope.credentialScopeKey,
    scope.serviceId,
    scope.profileId,
  ].join('\u0000');
}

function isSameQuotaCardLoadScope(a: QuotaCardLoadScope | null, b: QuotaCardLoadScope): boolean {
  return a?.credentialScopeKey === b.credentialScopeKey
    && a.serviceId === b.serviceId
    && a.profileId === b.profileId;
}

export const ConnectedServiceQuotaCard = React.memo(function ConnectedServiceQuotaCard(props: Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  title: string;
  pinnedMeterIds: ReadonlyArray<string>;
  onSetPinnedMeterIds: (next: ReadonlyArray<string>) => void;
  onSnapshot?: (snapshot: ConnectedServiceQuotaSnapshotV1 | null) => void;
}>) {
  const { theme } = useUnistyles();
  const auth = useAuth();
  const credentials = auth.credentials;

  const onSnapshotRef = React.useRef(props.onSnapshot);
  React.useEffect(() => {
    onSnapshotRef.current = props.onSnapshot;
  }, [props.onSnapshot]);

  const [snapshot, setSnapshot] = React.useState<ConnectedServiceQuotaSnapshotV1 | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const snapshotRef = React.useRef<ConnectedServiceQuotaSnapshotV1 | null>(null);
  const loadPromiseRef = React.useRef<Promise<ConnectedServiceQuotaSnapshotV1 | null> | null>(null);
  const refreshAndReloadPromisesRef = React.useRef<Map<string, QuotaCardRefreshAndReloadInFlight>>(new Map());
  const lastAutomaticLoadScopeRef = React.useRef<QuotaCardLoadScope | null>(null);
  const automaticLoadScope = React.useMemo<QuotaCardLoadScope | null>(() => {
    if (!credentials) return null;
    return {
      credentialScopeKey: resolveAuthCredentialsScopeKey(credentials),
      serviceId: props.serviceId,
      profileId: props.profileId,
    };
  }, [credentials, props.serviceId, props.profileId]);
  const currentLoadScopeRef = React.useRef<QuotaCardLoadScope | null>(automaticLoadScope);
  currentLoadScopeRef.current = automaticLoadScope;

  const isCurrentLoadScope = React.useCallback((scope: QuotaCardLoadScope): boolean => (
    isSameQuotaCardLoadScope(currentLoadScopeRef.current, scope)
  ), []);
  const commitSnapshot = React.useCallback((nextSnapshot: ConnectedServiceQuotaSnapshotV1 | null) => {
    snapshotRef.current = nextSnapshot;
    setSnapshot(nextSnapshot);
    onSnapshotRef.current?.(nextSnapshot);
  }, []);
  const resolveAccountMode = useCredentialScopedAccountModeResolver({
    credentials,
    credentialScope: automaticLoadScope?.credentialScopeKey ?? '',
  });

  const load = React.useCallback(async (): Promise<ConnectedServiceQuotaSnapshotV1 | null> => {
    if (!credentials || !automaticLoadScope) return null;
    const loadScope = automaticLoadScope;
    if (!isCurrentLoadScope(loadScope)) return null;
    setLoading(true);
    setError(null);
    try {
      const mode = await resolveAccountMode();
      if (!isCurrentLoadScope(loadScope)) return null;
      let opened: ConnectedServiceQuotaSnapshotV1 | null = null;
      if (mode === 'plain') {
        opened = await getConnectedServiceQuotaSnapshotPlain(credentials, {
          serviceId: props.serviceId,
          profileId: props.profileId,
        });
      }

      if (!isCurrentLoadScope(loadScope)) return null;
      if (mode !== 'plain' || !opened) {
        const sealed = await getConnectedServiceQuotaSnapshotSealed(credentials, {
          serviceId: props.serviceId,
          profileId: props.profileId,
        });
        const fallback = sealed ? openConnectedServiceQuotaSnapshot(credentials, sealed.sealed) : null;
        if (!isCurrentLoadScope(loadScope)) return null;
        commitSnapshot(fallback);
        return fallback;
      }
      if (!isCurrentLoadScope(loadScope)) return null;
      commitSnapshot(opened);
      return opened;
    } catch (e) {
      if (!isCurrentLoadScope(loadScope)) return null;
      setError(sanitizeEndpointErrorMessage(e) ?? t('common.error'));
      if (!snapshotRef.current) {
        commitSnapshot(null);
      }
      return null;
    } finally {
      if (isCurrentLoadScope(loadScope)) {
        setLoading(false);
      }
    }
  }, [automaticLoadScope, commitSnapshot, credentials, props.serviceId, props.profileId, isCurrentLoadScope, resolveAccountMode]);

  const loadTracked = React.useCallback(() => {
    const promise = load();
    loadPromiseRef.current = promise;
    return promise;
  }, [load]);

  React.useEffect(() => {
    if (!automaticLoadScope) {
      if (lastAutomaticLoadScopeRef.current) {
        commitSnapshot(null);
        setError(null);
        setLoading(false);
      }
      lastAutomaticLoadScopeRef.current = null;
      return;
    }
    if (isSameQuotaCardLoadScope(lastAutomaticLoadScopeRef.current, automaticLoadScope)) return;
    if (lastAutomaticLoadScopeRef.current) {
      commitSnapshot(null);
      setError(null);
    }
    lastAutomaticLoadScopeRef.current = automaticLoadScope;
    void loadTracked();
  }, [automaticLoadScope, commitSnapshot, loadTracked]);

  const requestRefreshAndReload = React.useCallback(async () => {
    if (!credentials || !automaticLoadScope) return;
    const refreshScopeKey = resolveQuotaCardLoadScopeKey(automaticLoadScope);
    const existing = refreshAndReloadPromisesRef.current.get(refreshScopeKey);
    if (existing && isSameQuotaCardLoadScope(existing.scope, automaticLoadScope)) {
      await existing.promise;
      return;
    }
    const refreshScope = automaticLoadScope;
    const promise = (async () => {
      const inFlightFetchedAt = (await loadPromiseRef.current
        ?.then((s) => s?.fetchedAt ?? 0)
        .catch(() => 0)) ?? 0;
      if (!isCurrentLoadScope(refreshScope)) return;
      const sinceFetchedAt = Math.max(snapshot?.fetchedAt ?? 0, inFlightFetchedAt);
      try {
        const mode = await resolveAccountMode();
        if (!isCurrentLoadScope(refreshScope)) return;
        const ok = mode === 'plain'
          ? await requestConnectedServiceQuotaSnapshotRefreshV3(credentials, { serviceId: props.serviceId, profileId: props.profileId })
          : await requestConnectedServiceQuotaSnapshotRefresh(credentials, { serviceId: props.serviceId, profileId: props.profileId });

        if (!ok && mode === 'plain') {
          await requestConnectedServiceQuotaSnapshotRefresh(credentials, { serviceId: props.serviceId, profileId: props.profileId });
        }
      } catch {
        // Best-effort only.
      }
      const delaysMs = [0, 250, 500, 1_000, 2_000, 3_000, 4_000];
      for (const delayMs of delaysMs) {
        await sleep(delayMs);
        if (!isCurrentLoadScope(refreshScope)) break;
        const opened = await loadTracked();
        if (opened && opened.fetchedAt > sinceFetchedAt) break;
      }
    })();
    refreshAndReloadPromisesRef.current.set(refreshScopeKey, { scope: refreshScope, promise });
    try {
      await promise;
    } finally {
      if (refreshAndReloadPromisesRef.current.get(refreshScopeKey)?.promise === promise) {
        refreshAndReloadPromisesRef.current.delete(refreshScopeKey);
      }
    }
  }, [automaticLoadScope, credentials, props.serviceId, props.profileId, isCurrentLoadScope, loadTracked, snapshot?.fetchedAt, resolveAccountMode]);

  const nowMs = Date.now();
  const isStale = snapshot ? nowMs - snapshot.fetchedAt > snapshot.staleAfterMs : false;

  const togglePin = (meterId: string) => {
    const existing = props.pinnedMeterIds ?? [];
    if (existing.includes(meterId)) {
      props.onSetPinnedMeterIds(existing.filter((id) => id !== meterId));
      return;
    }
    props.onSetPinnedMeterIds([...existing, meterId]);
  };

  return (
    <ItemGroup title={props.title}>
      <Item
        title={t('common.refresh')}
        subtitle={loading
          ? t('connectedServices.quota.loading')
          : error
            ? t('connectedServices.quota.error', { message: error })
            : snapshot
              ? (isStale
                ? t('connectedServices.quota.lastUpdatedStale', { time: formatTimestamp(snapshot.fetchedAt) })
                : t('connectedServices.quota.lastUpdated', { time: formatTimestamp(snapshot.fetchedAt) }))
              : t('connectedServices.quota.noData')}
        icon={<Ionicons name="refresh-outline" size={22} color={theme.colors.accent.blue} />}
        onPress={() => void requestRefreshAndReload()}
        showChevron={false}
      />

      {snapshot?.planLabel ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 2 }}>
          <Text style={{ color: theme.colors.text.secondary }}>{t('connectedServices.quota.planLabel', { plan: snapshot.planLabel })}</Text>
        </View>
      ) : null}

      {snapshot?.meters?.map((meter) => (
        <ConnectedServiceQuotaMeterRow
          key={meter.meterId}
          meter={meter}
          nowMs={nowMs}
          pinned={(props.pinnedMeterIds ?? []).includes(meter.meterId)}
          onTogglePin={() => togglePin(meter.meterId)}
        />
      ))}
    </ItemGroup>
  );
});
