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
import { getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { useProjectedConnectedServicesRegistry } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { AGENT_IDS, getAgentCore } from '@/agents/catalog/catalog';
import {
  ConnectedServiceIdSchema,
  ConnectedServicesProviderStateSharingSettingsV1Schema,
  isConnectedServiceCredentialHealthStatusUsable,
  type ConnectedServiceId,
} from '@happier-dev/protocol';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { ConnectedServiceQuotaBadgesView } from '@/components/settings/connectedServices/ConnectedServiceQuotaBadgesView';
import { useConnectedServiceQuotaBadges } from '@/hooks/server/connectedServices/useConnectedServiceQuotaBadges';
import { useConnectedServiceQuotaSummaries } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';
import { connectedServiceProfileKey, resolveConnectedServiceDefaultProfileId } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { resolveConnectedServiceCredentialHealthStatus } from '@/sync/domains/connectedServices/resolveConnectedServiceCredentialHealthStatus';
import { buildConnectedAccountSettingsRoute } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import { resolveConnectedServiceDisplayName } from './model/resolveConnectedServiceDisplayName';
import { buildConnectedServiceQuotaSummaryCards } from './buildConnectedServiceQuotaSummaryCards';
import { ConnectedServiceQuotaSummaryCardSection } from './ConnectedServiceQuotaSummaryCardSection';
import { ConnectedServicesDefaultAuthRow } from './ConnectedServicesDefaultAuthRow';
import { ConnectedServicesProviderStateSharingDefaultsGroup } from './ConnectedServicesProviderStateSharingSettings';

export const ConnectedServicesSettingsView = React.memo(function ConnectedServicesSettingsView() {
  const { theme } = useUnistyles();
  const profile = useProfile();
  const connectedServicesRegistrySnapshot = useProjectedConnectedServicesRegistry();
  const connectedServicesRegistry = connectedServicesRegistrySnapshot.entries;
  const settings = useSettings();
  const [providerStateSharingSettings, setProviderStateSharingSettings] =
    useSettingMutable('connectedServicesProviderStateSharingSettingsV1');
  const [defaultAuthSettings, setDefaultAuthSettings] =
    useSettingMutable('connectedServicesDefaultAuthByAgentIdV1');
  const [poolAdoptionDismissedByKey, setPoolAdoptionDismissedByKey] =
    useSettingMutable('connectedServicesDefaultAuthPoolAdoptionDismissedByKey');
  const dismissPoolAdoptionSuggestion = React.useCallback((key: string) => {
    setPoolAdoptionDismissedByKey({
      ...(poolAdoptionDismissedByKey ?? {}),
      [key]: true,
    });
  }, [poolAdoptionDismissedByKey, setPoolAdoptionDismissedByKey]);
  const router = useRouter();
  const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
  const normalizedProviderStateSharingSettings = React.useMemo(
    () => ConnectedServicesProviderStateSharingSettingsV1Schema.parse(providerStateSharingSettings),
    [providerStateSharingSettings],
  );

  const services = profile.connectedServicesV2;
  const serviceIdsFromProfile = services.map((svc) => svc.serviceId);
  const allServiceIds = Array.from(new Set<string>([
    ...connectedServicesRegistry.map((entry) => entry.serviceId),
    ...serviceIdsFromProfile,
  ]));

  const quotaRequestedProfiles = React.useMemo(() => {
    const next: Array<{ serviceId: ConnectedServiceId; profileId: string }> = [];
    for (const serviceIdRaw of allServiceIds) {
      const parsedServiceId = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
      if (!parsedServiceId.success) continue;
      const serviceId = parsedServiceId.data;
      const svc = services.find((s) => s.serviceId === serviceId) ?? null;
      const profiles = svc?.profiles ?? [];
      const connectedIds = profiles
        .filter((p) => isConnectedServiceCredentialHealthStatusUsable(resolveConnectedServiceCredentialHealthStatus(p.status)))
        .map((p) => p.profileId);
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

  const quotaBadgesByKey = useConnectedServiceQuotaBadges(quotaRequestedProfiles);
  const {
    summaries: quotaSummaries,
    isRefreshing: quotaSummariesRefreshing,
    hasConnectedProfiles: hasConnectedQuotaProfiles,
  } = useConnectedServiceQuotaSummaries();
  const quotaCards = React.useMemo(
    () => buildConnectedServiceQuotaSummaryCards(quotaSummaries),
    [quotaSummaries],
  );
  const openProjectedConnectedServiceSettings = React.useCallback(async (serviceId: string) => {
    const entry = connectedServicesRegistry.find((candidate) => candidate.serviceId === serviceId);
    if (!entry?.service || entry.executable !== true) {
      await Modal.alert(
        t('errors.daemonUnavailableTitle'),
        t('errors.daemonUnavailableBody'),
      );
      return;
    }
    router.push(buildConnectedAccountSettingsRoute(entry.service));
  }, [connectedServicesRegistry, router]);

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
        {connectedServicesRegistrySnapshot.status === 'loading' ? (
          <Item
            testID="connected-services-projection-loading"
            title={t('common.loading')}
            mode="info"
          />
        ) : null}
        {connectedServicesRegistrySnapshot.status === 'error' ? (
          <Item
            testID="connected-services-projection-error"
            title={t('common.requestFailed')}
            subtitle={connectedServicesRegistrySnapshot.errorReason ?? t('common.unavailable')}
            mode="info"
          />
        ) : null}
        {services.length === 0 && allServiceIds.length === 0 ? (
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
          const connected = profiles.filter((p) =>
            isConnectedServiceCredentialHealthStatusUsable(resolveConnectedServiceCredentialHealthStatus(p.status))
          );
          const connectedIds = connected
            .map((p) => p.profileId);
          const effectiveProfileId = resolveConnectedServiceDefaultProfileId({
            serviceId,
            connectedProfileIds: connectedIds,
            defaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
          });
          const quotaKey = effectiveProfileId ? connectedServiceProfileKey({ serviceId, profileId: effectiveProfileId }) : '';
          const badges = quotaKey ? (quotaBadgesByKey[quotaKey] ?? []) : [];
          const projectedDiagnostic = entry.projectedDescriptor
            ? [
                entry.projectionStatus === 'conflict' ? t('common.blocked') : null,
                entry.projectionStatus === 'stale' ? t('common.unavailable') : null,
                entry.availability?.state === 'blocked' ? t('common.blocked') : null,
                entry.availability?.state === 'disabled' ? t('common.disabled') : null,
                ...(entry.diagnostics ?? []),
                entry.projectionStatus === 'stale' ? connectedServicesRegistrySnapshot.errorReason : null,
                entry.availability?.state !== 'available' ? entry.availability?.reason : null,
              ].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' · ')
            : '';
          const subtitle = projectedDiagnostic || (
            connected.length > 0
              ? t('connectedServices.list.connectedCount', { count: connected.length })
              : profiles.length > 0
                ? t('connectedServices.list.needsReauth')
                : t('connectedServices.list.notConnected')
          );

          return (
            <Item
              key={serviceId}
              title={label}
              subtitle={subtitle}
              icon={<Ionicons name="key-outline" size={22} color={theme.colors.accent.blue} />}
              rightElement={badges.length > 0 ? <ConnectedServiceQuotaBadgesView badges={badges} /> : undefined}
              disabled={entry.executable === false}
              onPress={entry.executable === false ? undefined : async () => {
                try {
                  router.push(entry.service
                    ? buildConnectedAccountSettingsRoute(entry.service)
                    : {
                        pathname: '/(app)/settings/connected-services/[serviceId]',
                        params: { serviceId },
                      });
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
              accountGroupsEnabled={accountGroupsEnabled}
              accountProfileConnectedServicesV2={services}
              settings={{
                connectedServicesProfileLabelByKey: settings.connectedServicesProfileLabelByKey,
                connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
                connectedServicesDefaultAuthByAgentIdV1: defaultAuthSettings,
              }}
              setDefaultAuthSettings={setDefaultAuthSettings}
              onOpenConnectedServicesSettings={openProjectedConnectedServiceSettings}
              dismissedPoolAdoptionSuggestionKeys={poolAdoptionDismissedByKey}
              onDismissPoolAdoptionSuggestion={dismissPoolAdoptionSuggestion}
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
