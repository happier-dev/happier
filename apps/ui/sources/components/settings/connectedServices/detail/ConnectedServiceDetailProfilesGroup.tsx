import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { resolveConnectedServiceProfileLabel, connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { computeConnectedServiceQuotaSummaryBadges } from '@/sync/domains/connectedServices/connectedServiceQuotaBadges';
import type { ConnectedServiceId, ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import { t } from '@/text';

import { ConnectedServiceQuotaBadgesView } from '../ConnectedServiceQuotaBadgesView';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';

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
  onOpenProfile: (profileId: string) => void;
  onSetDefaultProfile: (profileId: string) => void;
  onEditProfileLabel: (profileId: string) => void;
}>) {
  const { theme } = useUnistyles();

  return (
    <ItemGroup title={props.title}>
      {props.profiles.length === 0 ? (
        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          <Text style={{ color: theme.colors.textSecondary }}>{t('connectedServices.detail.profiles.empty')}</Text>
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
        const connectedSubtitle = providerEmail ?? t('connectedServices.detail.profiles.connected');
        const subtitleParts = [
          profileId === props.defaultProfileId ? t('connectedServices.detail.profiles.defaultBadge') : null,
          label ? profileId : null,
          label ? connectedSubtitle : connectedSubtitle,
        ].filter(Boolean) as string[];
        const subtitle = status === 'connected' ? subtitleParts.join(' • ') : t('connectedServices.detail.profiles.needsReauth');

        const iconName = status === 'connected' ? 'checkmark-circle-outline' : 'warning-outline';
        const iconColor = status === 'connected' ? theme.colors.success : theme.colors.accent.orange;
        const isDefault = profileId === props.defaultProfileId;

        const actions: ItemAction[] = [
          {
            id: 'default',
            title: isDefault ? t('connectedServices.detail.actions.unsetDefault') : t('connectedServices.detail.actions.setDefault'),
            icon: isDefault ? 'star' : 'star-outline',
            color: isDefault ? theme.colors.button.primary.background : theme.colors.textSecondary,
            onPress: () => props.onSetDefaultProfile(isDefault ? '' : profileId),
          },
          {
            id: 'label',
            title: t('connectedServices.detail.actions.editLabel'),
            icon: 'pencil-outline',
            onPress: () => props.onEditProfileLabel(profileId),
          },
          ...(status === 'connected'
            ? [{
              id: 'disconnect',
              title: t('modals.disconnect'),
              icon: 'trash-outline',
              destructive: true,
              onPress: () => props.onDisconnect(profileId),
            } satisfies ItemAction]
            : [{
              id: 'reconnect',
              title: t('connectedServices.detail.actions.reconnect'),
              icon: 'refresh-outline',
              onPress: () => props.onConnectOauth(profileId),
            } satisfies ItemAction]),
        ];

        return (
          <Item
            key={profileId}
            title={label ?? profileId}
            subtitle={subtitle}
            icon={<Ionicons name={iconName as IoniconName} size={22} color={iconColor} />}
            rightElement={(
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                {props.quotasEnabled ? <ConnectedServiceQuotaBadgesView badges={badges} /> : null}
                <ItemRowActions
                  title={label ?? profileId}
                  compactActionIds={['default', 'label']}
                  pinnedActionIds={['default']}
                  overflowPosition="beforePinned"
                  iconSize={18}
                  actions={actions}
                />
              </View>
            )}
            onPress={() => props.onOpenProfile(profileId)}
          />
        );
      })}
    </ItemGroup>
  );
});
