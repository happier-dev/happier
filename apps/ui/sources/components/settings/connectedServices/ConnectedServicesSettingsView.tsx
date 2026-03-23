import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useProfile } from '@/sync/store/hooks';
import { useSettings } from '@/sync/store/hooks';
import { Modal } from '@/modal';
import { CONNECTED_SERVICES_REGISTRY, getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import type { ConnectedServiceId } from '@happier-dev/protocol';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { ConnectedServiceQuotaBadgesView } from '@/components/settings/connectedServices/ConnectedServiceQuotaBadgesView';
import { useConnectedServiceQuotaBadges } from '@/hooks/server/connectedServices/useConnectedServiceQuotaBadges';
import { connectedServiceProfileKey, resolveConnectedServiceDefaultProfileId } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { resolveConnectedServiceDisplayName } from './model/resolveConnectedServiceDisplayName';

export const ConnectedServicesSettingsView = React.memo(function ConnectedServicesSettingsView() {
  const { theme } = useUnistyles();
  const profile = useProfile();
  const settings = useSettings();
  const router = useRouter();
  const connectedServicesEnabled = useFeatureEnabled('connectedServices');

  const services = profile.connectedServicesV2;
  const serviceIdsFromProfile = services.map((svc) => svc.serviceId);
  const allServiceIds = Array.from(new Set<ConnectedServiceId>([
    ...CONNECTED_SERVICES_REGISTRY.map((entry) => entry.serviceId),
    ...serviceIdsFromProfile,
  ]));

  const quotaRequestedProfiles = React.useMemo(() => {
    if (!connectedServicesEnabled) return [];
    const next: Array<{ serviceId: ConnectedServiceId; profileId: string }> = [];
    for (const serviceId of allServiceIds) {
      const svc = services.find((s) => s.serviceId === serviceId) ?? null;
      const profiles = svc?.profiles ?? [];
      const connectedIds = profiles.filter((p) => p.status === 'connected').map((p) => p.profileId);
      const effectiveProfileId = resolveConnectedServiceDefaultProfileId({
        serviceId,
        connectedProfileIds: connectedIds,
        defaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
      });
      if (!effectiveProfileId) continue;
      next.push({ serviceId, profileId: effectiveProfileId });
    }
    return next;
  }, [allServiceIds, services, settings.connectedServicesDefaultProfileByServiceId]);

  const quotaBadgesByKey = useConnectedServiceQuotaBadges(connectedServicesEnabled ? quotaRequestedProfiles : []);

  if (!connectedServicesEnabled) {
    return (
      <ItemList>
        <ItemGroup title={t('connectedServices.title')}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ color: theme.colors.textSecondary }}>
              {t('settings.connectedAccountsDisabled')}
            </Text>
          </View>
        </ItemGroup>
      </ItemList>
    );
  }

  return (
    <ItemList>
      <ItemGroup title={t('connectedServices.title')}>
        {services.length === 0 ? (
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ color: theme.colors.textSecondary }}>{t('connectedServices.list.empty')}</Text>
          </View>
        ) : null}

        {allServiceIds.map((serviceIdRaw) => {
          const serviceId = serviceIdRaw;
          const svc = services.find((s) => s.serviceId === serviceId) ?? null;
          const entry = getConnectedServiceRegistryEntry(serviceId);
          const label = resolveConnectedServiceDisplayName(serviceId, t);
          const profiles = svc?.profiles ?? [];
          const connected = profiles.filter((p) => p.status === 'connected');
          const connectedIds = connected
            .map((p) => p.profileId);
          const effectiveProfileId = resolveConnectedServiceDefaultProfileId({
            serviceId,
            connectedProfileIds: connectedIds,
            defaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
          });
          const quotaKey = effectiveProfileId ? connectedServiceProfileKey({ serviceId, profileId: effectiveProfileId }) : '';
          const badges = quotaKey ? (quotaBadgesByKey[quotaKey] ?? []) : [];
          const subtitle =
            connected.length > 0
              ? t('connectedServices.list.connectedCount', { count: connected.length })
              : profiles.length > 0
                ? t('connectedServices.list.needsReauth')
                : t('connectedServices.list.notConnected');

          return (
            <Item
              key={serviceId}
              title={label}
              subtitle={subtitle}
              icon={<Ionicons name="key-outline" size={22} color={theme.colors.accent.blue} />}
              rightElement={badges.length > 0 ? <ConnectedServiceQuotaBadgesView badges={badges} /> : undefined}
              onPress={async () => {
                try {
                  router.push({ pathname: '/(app)/settings/connected-services/[serviceId]', params: { serviceId } });
                } catch {
                  // Fallback for environments without route support.
                  await Modal.alert(
                    t('connect.unsupported.connectTitle', { name: label }),
                    t('connect.unsupported.runCommandInTerminal'),
                    [{ text: entry.connectCommand, style: 'default' }, { text: t('common.ok'), style: 'cancel' }],
                  );
                }
              }}
            />
          );
        })}
      </ItemGroup>
    </ItemList>
  );
});
