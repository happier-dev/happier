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
import { useSettingMutable, useSettings } from '@/sync/store/hooks';
import { Modal } from '@/modal';
import { CONNECTED_SERVICES_REGISTRY, getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { AGENT_IDS, getAgentCore } from '@/agents/catalog/catalog';
import {
  ConnectedServicesProviderStateSharingSettingsV1Schema,
  type ConnectedServiceId,
} from '@happier-dev/protocol';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { ConnectedServiceQuotaBadgesView } from '@/components/settings/connectedServices/ConnectedServiceQuotaBadgesView';
import { useConnectedServiceQuotaBadges } from '@/hooks/server/connectedServices/useConnectedServiceQuotaBadges';
import { useConnectedServiceQuotaSummaries } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';
import { connectedServiceProfileKey, resolveConnectedServiceDefaultProfileId } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { resolveConnectedServiceDisplayName } from './model/resolveConnectedServiceDisplayName';
import { buildConnectedServiceQuotaSummaryCards } from './buildConnectedServiceQuotaSummaryCards';
import { ConnectedServiceQuotaSummaryCardSection } from './ConnectedServiceQuotaSummaryCardSection';
import { ConnectedServicesDefaultAuthRow } from './ConnectedServicesDefaultAuthRow';
import { ConnectedServicesProviderStateSharingDefaultsGroup } from './ConnectedServicesProviderStateSharingSettings';

export const ConnectedServicesSettingsView = React.memo(function ConnectedServicesSettingsView() {
  const { theme } = useUnistyles();
  const profile = useProfile();
  const settings = useSettings();
  const [providerStateSharingSettings, setProviderStateSharingSettings] =
    useSettingMutable('connectedServicesProviderStateSharingSettingsV1');
  const [defaultAuthSettings, setDefaultAuthSettings] =
    useSettingMutable('connectedServicesDefaultAuthByAgentIdV1');
  const router = useRouter();
  const connectedServicesEnabled = useFeatureEnabled('connectedServices');
  const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
  const normalizedProviderStateSharingSettings = React.useMemo(
    () => ConnectedServicesProviderStateSharingSettingsV1Schema.parse(providerStateSharingSettings),
    [providerStateSharingSettings],
  );

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
  const {
    summaries: quotaSummaries,
    isRefreshing: quotaSummariesRefreshing,
    hasConnectedProfiles: hasConnectedQuotaProfiles,
  } = useConnectedServiceQuotaSummaries();
  const quotaCards = React.useMemo(
    () => buildConnectedServiceQuotaSummaryCards(quotaSummaries),
    [quotaSummaries],
  );

  if (!connectedServicesEnabled) {
    return (
      <ItemList>
        <ItemGroup title={t('connectedServices.title')}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ color: theme.colors.text.secondary }}>
              {t('settings.connectedAccountsDisabled')}
            </Text>
          </View>
        </ItemGroup>
      </ItemList>
    );
  }

  return (
    <ItemList>
      <ConnectedServiceQuotaSummaryCardSection
        title={t('connectedServices.title')}
        cards={quotaCards}
        isRefreshing={quotaSummariesRefreshing}
        showWhenEmpty={hasConnectedQuotaProfiles}
        testID="connected-services-quota-summary-section"
      />
      <ItemGroup title={t('connectedServices.title')}>
        {services.length === 0 ? (
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ color: theme.colors.text.secondary }}>{t('connectedServices.list.empty')}</Text>
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
      <ItemGroup
        title={t('connectedServices.defaultAuth.title')}
        footer={t('connectedServices.defaultAuth.footer')}
      >
        {AGENT_IDS.map((agentId) => {
          const agentCore = getAgentCore(agentId);
          if ((agentCore.connectedServices?.supportedServiceIds ?? []).length === 0) return null;
          return (
            <ConnectedServicesDefaultAuthRow
              key={agentId}
              agentId={agentId}
              agentTitle={t(agentCore.displayNameKey)}
              agentCore={agentCore}
              connectedServicesEnabled={connectedServicesEnabled}
              accountGroupsEnabled={accountGroupsEnabled}
              accountProfileConnectedServicesV2={services}
              settings={{
                connectedServicesProfileLabelByKey: settings.connectedServicesProfileLabelByKey,
                connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
                connectedServicesDefaultAuthByAgentIdV1: defaultAuthSettings,
              }}
              setDefaultAuthSettings={setDefaultAuthSettings}
              onOpenConnectedServicesSettings={(serviceId) => router.push({
                pathname: '/(app)/settings/connected-services/[serviceId]',
                params: { serviceId },
              } as any)}
            />
          );
        })}
      </ItemGroup>
      <ConnectedServicesProviderStateSharingDefaultsGroup
        settings={normalizedProviderStateSharingSettings}
        setSettings={setProviderStateSharingSettings}
        onOpenBackendOverrides={() => router.push('/(app)/settings/connected-services/provider-state-sharing' as any)}
      />
    </ItemList>
  );
});
