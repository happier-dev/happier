import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/StyledText';
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

export const ConnectedServicesSettingsView = React.memo(function ConnectedServicesSettingsView() {
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
        <ItemGroup title={t('settings.connectedAccounts') ?? 'Connected Services'}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ opacity: 0.7 }}>
              {t('settings.connectedAccountsDisabled') ?? 'Connected services are disabled.'}
            </Text>
          </View>
        </ItemGroup>

        <ItemGroup>
          <Item
            title={t('common.close') ?? 'Done'}
            icon={<Ionicons name="close-outline" size={22} color="#007AFF" />}
            onPress={() => router.back()}
            showChevron={false}
          />
        </ItemGroup>
      </ItemList>
    );
  }

  return (
    <ItemList>
      <ItemGroup title={t('settings.connectedAccounts') ?? 'Connected Services'}>
        {services.length === 0 ? (
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ opacity: 0.7 }}>No connected services yet.</Text>
          </View>
        ) : null}

        {allServiceIds.map((serviceIdRaw) => {
          const serviceId = serviceIdRaw;
          const svc = services.find((s) => s.serviceId === serviceId) ?? null;
          const entry = getConnectedServiceRegistryEntry(serviceId);
          const label = entry.displayName;
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
              ? `${connected.length} connected`
              : profiles.length > 0
                ? 'needs re-auth'
                : 'not connected';

          return (
            <Item
              key={serviceId}
              title={label}
              subtitle={subtitle}
              icon={<Ionicons name="key-outline" size={22} color="#007AFF" />}
              rightElement={badges.length > 0 ? <ConnectedServiceQuotaBadgesView badges={badges} /> : undefined}
              onPress={async () => {
                try {
                  router.push({ pathname: '/(app)/settings/connected-services/[serviceId]', params: { serviceId } });
                } catch {
                  // Fallback for environments without route support.
                  await Modal.alert(
                    t('connect.unsupported.connectTitle', { name: label }) ?? `Connect ${label}`,
                    t('connect.unsupported.runCommandInTerminal') ?? 'Run this in your terminal:',
                    [{ text: entry.connectCommand, style: 'default' }, { text: t('common.ok') ?? 'OK', style: 'cancel' }],
                  );
                }
              }}
            />
          );
        })}
      </ItemGroup>

      <ItemGroup>
        <Item
          title={t('common.close') ?? 'Done'}
          icon={<Ionicons name="close-outline" size={22} color="#007AFF" />}
          onPress={() => router.back()}
          showChevron={false}
        />
      </ItemGroup>
    </ItemList>
  );
});
