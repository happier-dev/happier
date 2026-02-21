import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { resolveConnectedServiceProfileLabel, connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { computeConnectedServiceQuotaSummaryBadges } from '@/sync/domains/connectedServices/connectedServiceQuotaBadges';
import type { ConnectedServiceId, ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import { ConnectedServiceQuotaBadgesView } from '../ConnectedServiceQuotaBadgesView';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

type ConnectedServiceProfileLike = Readonly<{
  profileId?: string;
  status?: string;
  providerEmail?: string | null;
}>;

export const ConnectedServiceDetailProfilesGroup = React.memo(function ConnectedServiceDetailProfilesGroup(props: Readonly<{
  title: string;
  serviceId: ConnectedServiceId;
  profiles: ReadonlyArray<ConnectedServiceProfileLike>;
  defaultProfileId: string;
  profileLabelsByKey: Readonly<Record<string, string>>;
  pinnedMeterIdsByKey: Readonly<Record<string, ReadonlyArray<string>>>;
  quotaSummaryStrategyByKey: Readonly<Record<string, 'primary' | 'min_remaining' | undefined>>;
  quotaSnapshotsByKey: Readonly<Record<string, ConnectedServiceQuotaSnapshotV1 | null>>;
  quotasEnabled: boolean;
  onDisconnect: (profileId: string) => void;
  onConnectOauth: (profileId: string) => void;
}>) {
  return (
    <ItemGroup title={props.title}>
      {props.profiles.length === 0 ? (
        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          <Text style={{ opacity: 0.7 }}>No profiles yet.</Text>
        </View>
      ) : null}

      {props.profiles.map((p) => {
        const profileId = typeof p?.profileId === 'string' ? p.profileId : '';
        if (!profileId) return null;

        const status = p?.status === 'connected' ? 'connected' : 'needs_reauth';
        const label = resolveConnectedServiceProfileLabel({
          labelsByKey: props.profileLabelsByKey,
          serviceId: props.serviceId,
          profileId,
        });

        const quotaKey = connectedServiceProfileKey({ serviceId: props.serviceId, profileId });
        const pinnedMeterIds = props.pinnedMeterIdsByKey[quotaKey] ?? [];
        const rawStrategy = props.quotaSummaryStrategyByKey[quotaKey];
        const strategy = rawStrategy === 'min_remaining' ? 'min_remaining' : 'primary';
        const badges = props.quotasEnabled
          ? computeConnectedServiceQuotaSummaryBadges({
            snapshot: props.quotaSnapshotsByKey[quotaKey] ?? null,
            pinnedMeterIds,
            strategy,
          })
          : [];

        const providerEmail = typeof p?.providerEmail === 'string' ? p.providerEmail : null;
        const connectedSubtitle = providerEmail ?? 'Connected';
        const subtitleParts = [
          profileId === props.defaultProfileId ? 'Default' : null,
          label ? profileId : null,
          label ? connectedSubtitle : connectedSubtitle,
        ].filter(Boolean) as string[];
        const subtitle = status === 'connected' ? subtitleParts.join(' • ') : 'Needs re-auth';

        const iconName = status === 'connected' ? 'checkmark-circle-outline' : 'warning-outline';
        const iconColor = status === 'connected' ? '#34C759' : '#FF9500';

        return (
          <Item
            key={profileId}
            title={label ?? profileId}
            subtitle={subtitle}
            icon={<Ionicons name={iconName as IoniconName} size={22} color={iconColor} />}
            rightElement={props.quotasEnabled ? <ConnectedServiceQuotaBadgesView badges={badges} /> : undefined}
            onPress={() => {
              if (status === 'connected') props.onDisconnect(profileId);
              else props.onConnectOauth(profileId);
            }}
          />
        );
      })}
    </ItemGroup>
  );
});
