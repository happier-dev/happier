import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/StyledText';
import { useAuth } from '@/auth/context/AuthContext';
import { getConnectedServiceQuotaSnapshotSealed, requestConnectedServiceQuotaSnapshotRefresh } from '@/sync/api/account/apiConnectedServicesQuotasV2';
import { openConnectedServiceQuotaSnapshot } from '@/sync/domains/connectedServices/openConnectedServiceQuotaSnapshot';
import type { ConnectedServiceId, ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

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
  const auth = useAuth();
  const credentials = auth.credentials;

  const onSnapshotRef = React.useRef(props.onSnapshot);
  React.useEffect(() => {
    onSnapshotRef.current = props.onSnapshot;
  }, [props.onSnapshot]);

  const [snapshot, setSnapshot] = React.useState<ConnectedServiceQuotaSnapshotV1 | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const loadPromiseRef = React.useRef<Promise<ConnectedServiceQuotaSnapshotV1 | null> | null>(null);

  const load = React.useCallback(async (): Promise<ConnectedServiceQuotaSnapshotV1 | null> => {
    if (!credentials) return null;
    setLoading(true);
    setError(null);
    try {
      const sealed = await getConnectedServiceQuotaSnapshotSealed(credentials, {
        serviceId: props.serviceId,
        profileId: props.profileId,
      });
      const opened = sealed ? openConnectedServiceQuotaSnapshot(credentials, sealed.sealed) : null;
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
      await requestConnectedServiceQuotaSnapshotRefresh(credentials, {
        serviceId: props.serviceId,
        profileId: props.profileId,
      });
    } catch {
      // Best-effort only.
    }
    const delaysMs = [0, 250, 500, 1_000, 2_000, 3_000, 4_000];
    for (const delayMs of delaysMs) {
      await sleep(delayMs);
      const opened = await loadTracked();
      if (opened && opened.fetchedAt > sinceFetchedAt) break;
    }
  }, [credentials, props.serviceId, props.profileId, loadTracked, snapshot?.fetchedAt]);

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
        title="Refresh"
        subtitle={loading ? 'Loading…' : error ? `Error: ${error}` : snapshot ? `Last updated: ${formatTimestamp(snapshot.fetchedAt)}${isStale ? ' • stale' : ''}` : 'No quota data yet'}
        icon={<Ionicons name="refresh-outline" size={22} color="#007AFF" />}
        onPress={() => void requestRefreshAndReload()}
        showChevron={false}
      />

      {snapshot?.planLabel ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 2 }}>
          <Text style={{ opacity: 0.7 }}>{`Plan: ${snapshot.planLabel}`}</Text>
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
