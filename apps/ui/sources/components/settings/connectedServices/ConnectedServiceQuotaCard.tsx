import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { useAuth } from '@/auth/context/AuthContext';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { getConnectedServiceQuotaSnapshotSealed, requestConnectedServiceQuotaSnapshotRefresh } from '@/sync/api/account/apiConnectedServicesQuotasV2';
import { getConnectedServiceQuotaSnapshotPlain, requestConnectedServiceQuotaSnapshotRefreshV3 } from '@/sync/api/account/apiConnectedServicesQuotasV3';
import { openConnectedServiceQuotaSnapshot } from '@/sync/domains/connectedServices/openConnectedServiceQuotaSnapshot';
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

  type AccountMode = 'plain' | 'e2ee';
  const accountModeRef = React.useRef<'plain' | 'e2ee' | null>(null);
  const accountModePromiseRef = React.useRef<Promise<AccountMode> | null>(null);
  React.useEffect(() => {
    accountModeRef.current = null;
    accountModePromiseRef.current = null;
  }, [credentials?.token]);

  const onSnapshotRef = React.useRef(props.onSnapshot);
  React.useEffect(() => {
    onSnapshotRef.current = props.onSnapshot;
  }, [props.onSnapshot]);

  const [snapshot, setSnapshot] = React.useState<ConnectedServiceQuotaSnapshotV1 | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const loadPromiseRef = React.useRef<Promise<ConnectedServiceQuotaSnapshotV1 | null> | null>(null);

  const resolveAccountMode = React.useCallback(async (): Promise<AccountMode> => {
    const cached = accountModeRef.current;
    if (cached) return cached;
    if (!credentials) return 'e2ee';

    const promise =
      accountModePromiseRef.current ??
      (accountModePromiseRef.current = fetchAccountEncryptionMode(credentials)
        .then((res): AccountMode => (res.mode === 'plain' ? 'plain' : 'e2ee'))
        .catch((): AccountMode => 'e2ee')
        .then((mode): AccountMode => {
          accountModeRef.current = mode;
          return mode;
        }));

    return await promise;
  }, [credentials]);

  const load = React.useCallback(async (): Promise<ConnectedServiceQuotaSnapshotV1 | null> => {
    if (!credentials) return null;
    setLoading(true);
    setError(null);
    try {
      const mode = await resolveAccountMode();
      let opened: ConnectedServiceQuotaSnapshotV1 | null = null;
      if (mode === 'plain') {
        opened = await getConnectedServiceQuotaSnapshotPlain(credentials, {
          serviceId: props.serviceId,
          profileId: props.profileId,
        });
      }

      if (mode !== 'plain' || !opened) {
        const sealed = await getConnectedServiceQuotaSnapshotSealed(credentials, {
          serviceId: props.serviceId,
          profileId: props.profileId,
        });
        const fallback = sealed ? openConnectedServiceQuotaSnapshot(credentials, sealed.sealed) : null;
        setSnapshot(fallback);
        onSnapshotRef.current?.(fallback);
        return fallback;
      }
      setSnapshot(opened);
      onSnapshotRef.current?.(opened);
      return opened;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSnapshot(null);
      onSnapshotRef.current?.(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [credentials, props.serviceId, props.profileId]);

  const loadTracked = React.useCallback(() => {
    const promise = load();
    loadPromiseRef.current = promise;
    return promise;
  }, [load]);

  React.useEffect(() => {
    void loadTracked();
  }, [loadTracked]);

  const requestRefreshAndReload = React.useCallback(async () => {
    if (!credentials) return;
    const inFlightFetchedAt = (await loadPromiseRef.current
      ?.then((s) => s?.fetchedAt ?? 0)
      .catch(() => 0)) ?? 0;
    const sinceFetchedAt = Math.max(snapshot?.fetchedAt ?? 0, inFlightFetchedAt);
    try {
      const mode = await resolveAccountMode();
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
      const opened = await loadTracked();
      if (opened && opened.fetchedAt > sinceFetchedAt) break;
    }
  }, [credentials, props.serviceId, props.profileId, loadTracked, snapshot?.fetchedAt, resolveAccountMode]);

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
          <Text style={{ opacity: 0.7 }}>{t('connectedServices.quota.planLabel', { plan: snapshot.planLabel })}</Text>
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
