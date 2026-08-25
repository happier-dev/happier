import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { SvgXml } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useProfile } from '@/sync/store/hooks';
import { useSettingMutable, useSettings } from '@/sync/store/hooks';
import { Modal } from '@/modal';
import { getLegacyConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import {
  useProjectedPluginLocalizedTextResolver,
  useProjectedConnectedServicesRegistry,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { AGENT_IDS, getAgentCore } from '@/agents/catalog/catalog';
import {
  buildQualifiedPluginContributionKey,
  ConnectedServicesProviderStateSharingSettingsV1Schema,
  isConnectedServiceCredentialHealthStatusUsable,
  normalizeConnectedServiceCredentialHealthStatus,
} from '@happier-dev/protocol';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { ConnectedServiceQuotaBadgesView } from '@/components/settings/connectedServices/ConnectedServiceQuotaBadgesView';
import { useConnectedServiceQuotaBadges } from '@/hooks/server/connectedServices/useConnectedServiceQuotaBadges';
import { useConnectedServiceQuotaSummaries } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';
import {
  connectedServiceProfileKey,
  qualifiedConnectedAccountPreferenceServiceKey,
  resolveConnectedServiceDefaultProfileId,
  resolveQualifiedConnectedAccountDefaultId,
} from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { buildConnectedAccountSettingsRoute } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import { resolveConnectedAccountUiNegotiation } from '@/sync/domains/connectedServices/resolveConnectedAccountUiNegotiation';
import { useServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { resolveConnectedServiceBrandIconXml } from '@/agents/registry/resolveConnectedServiceBrandIconXml';
import {
  compareAccountHealthSeverity,
  deriveAccountHealth,
  worstAccountHealth,
  type AccountHealth,
} from '@/sync/domains/connectedServices/deriveAccountHealth';
import { resolveAccountHealthDotColor } from './account/accountBlockModel';
import {
  resolveConnectedServiceRegistryEntryDisplayName,
} from './model/resolveConnectedServiceDisplayName';
import {
  presentConnectedServiceIndexDiagnosticCopy,
  presentConnectedServiceIndexDiagnostics,
} from './model/presentConnectedServiceIndexDiagnostics';
import { buildConnectedServiceQuotaSummaryCards } from './buildConnectedServiceQuotaSummaryCards';
import { ConnectedServiceQuotaSummaryCardSection } from './ConnectedServiceQuotaSummaryCardSection';
import { ConnectedServicesDefaultAuthRow } from './ConnectedServicesDefaultAuthRow';
import { ConnectedServicesProviderStateSharingDefaultsGroup } from './ConnectedServicesProviderStateSharingSettings';
import { Icon } from '@/components/ui/icons/Icon';

const BRAND_ICON_SIZE = 24;

const stylesheet = StyleSheet.create((theme) => ({
  iconBox: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  healthDot: {
    position: 'absolute',
    bottom: -1,
    right: -1,
    borderWidth: 1.5,
    borderColor: theme.colors.surface.base,
  },
}));

/**
 * Derive a service row's health as the worst-of the credential statuses across its
 * accounts. Quota capacity is left out here — the index surfaces pinned-meter
 * badges and does not mount per-account quota snapshots — so the row dot reflects
 * connection health only. It reuses the canonical `deriveAccountHealth` owner so
 * the index can never disagree with the account detail view.
 */
function deriveServiceRowHealth(profiles: ReadonlyArray<{ status?: unknown }>): AccountHealth {
  return worstAccountHealth(profiles.map((profile) => deriveAccountHealth({
    status: normalizeConnectedServiceCredentialHealthStatus(profile?.status),
    capacityPct: null,
  })));
}

export const ConnectedServicesSettingsView = React.memo(function ConnectedServicesSettingsView() {
  const { theme } = useUnistyles();
  const styles = stylesheet;
  const profile = useProfile();
  const connectedServicesRegistrySnapshot = useProjectedConnectedServicesRegistry();
  const localizePluginText = useProjectedPluginLocalizedTextResolver();
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

  const serverFeatures = useServerFeaturesRuntimeSnapshot({ enabled: true });
  const accountTransport = resolveConnectedAccountUiNegotiation(serverFeatures);
  // V2 is a released built-in compatibility projection only. New rows read
  // qualified V4 account/group state; a feature response still in flight must
  // not be mistaken for an empty legacy list.
  const services = profile.connectedServicesV2;
  const qualifiedAccounts = accountTransport === 'advertised-v4'
    ? profile.connectedAccountsV4 ?? []
    : [];
  const qualifiedGroups = accountTransport === 'advertised-v4'
    ? profile.connectedAccountGroupsV4 ?? []
    : [];
  // "Nothing is connected" is a conclusion, not a waiting state: while the
  // descriptor projection is still loading — or has failed — the status row
  // above already explains the screen, and the empty copy would both contradict
  // it and take a second half-width card in the columned group.
  const isProjectionSettled = connectedServicesRegistrySnapshot.status !== 'loading'
    && connectedServicesRegistrySnapshot.status !== 'error';
  const projectionErrorDetails = connectedServicesRegistrySnapshot.errorReason
    ? presentConnectedServiceIndexDiagnosticCopy(connectedServicesRegistrySnapshot.errorReason)
    : null;
  const visibleRegistryEntries = React.useMemo(() => {
    if (accountTransport !== 'legacy') return connectedServicesRegistry;
    // A released V2 profile becomes a row only through the generated built-in
    // adapter. This retains old-server access without allowing a scalar id to
    // select a foreign or novel V4 descriptor.
    const byQualifiedService = new Map<string, typeof connectedServicesRegistry[number]>();
    for (const entry of connectedServicesRegistry) {
      if (!entry.service || !entry.legacyServiceId) continue;
      byQualifiedService.set(buildQualifiedPluginContributionKey(entry.service), entry);
    }
    for (const service of services) {
      const entry = getLegacyConnectedServiceRegistryEntry(service.serviceId);
      if (!entry.service || !entry.legacyServiceId) continue;
      byQualifiedService.set(buildQualifiedPluginContributionKey(entry.service), entry);
    }
    return [...byQualifiedService.values()];
  }, [accountTransport, connectedServicesRegistry, services]);
  const quotaRequestedProfiles = React.useMemo(() => {
    const next: Array<
      | { serviceId: string; profileId: string }
      | { ref: { service: { pluginId: string; localId: string }; accountId: string } }
    > = [];
    for (const entry of visibleRegistryEntries) {
      if (!entry.service) continue;
      if (accountTransport === 'advertised-v4') {
        const connectedIds = qualifiedAccounts
          .filter((account) => (
            account.ref.service.pluginId === entry.service!.pluginId
            && account.ref.service.localId === entry.service!.localId
            && isConnectedServiceCredentialHealthStatusUsable(
              normalizeConnectedServiceCredentialHealthStatus(account.status),
            )
          ))
          .map((account) => account.ref.accountId);
        const accountId = resolveQualifiedConnectedAccountDefaultId({
          service: entry.service,
          legacyServiceId: entry.legacyServiceId ?? null,
          connectedAccountIds: connectedIds,
          defaultAccountByServiceKey: settings.connectedServicesDefaultProfileByServiceId,
        });
        if (accountId) next.push({ ref: { service: entry.service, accountId } });
        continue;
      }
      if (accountTransport !== 'legacy' || !entry.legacyServiceId) continue;
      const svc = services.find((candidate) => candidate.serviceId === entry.legacyServiceId) ?? null;
      const connectedIds = (svc?.profiles ?? [])
        .filter((profileEntry) => isConnectedServiceCredentialHealthStatusUsable(
          normalizeConnectedServiceCredentialHealthStatus(profileEntry.status),
        ))
        .map((profileEntry) => profileEntry.profileId);
      const profileId = resolveConnectedServiceDefaultProfileId({
        serviceId: entry.legacyServiceId,
        connectedProfileIds: connectedIds,
        defaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
      });
      if (profileId) next.push({ serviceId: entry.legacyServiceId, profileId });
    }
    return next;
  }, [
    accountTransport,
    visibleRegistryEntries,
    qualifiedAccounts,
    services,
    settings.connectedServicesDefaultProfileByServiceId,
  ]);

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
  /** Every index row routes through its exact V4 identity. */
  const openProjectedConnectedServiceSettings = React.useCallback(async (entry: typeof connectedServicesRegistry[number]) => {
    const canOpen = entry.executable === true
      || (
        accountTransport === 'legacy'
        && Boolean(entry.legacyServiceId)
        && !entry.projectedDescriptor
      );
    if (!entry.service || !canOpen) {
      await Modal.alert(
        t('errors.daemonUnavailableTitle'),
        t('errors.daemonUnavailableBody'),
      );
      return;
    }
    try {
      router.push(buildConnectedAccountSettingsRoute(entry.service));
    } catch {
      // Fallback for environments without route support.
      await Modal.alert(
        t('connect.unsupported.connectTitle', {
          name: resolveConnectedServiceRegistryEntryDisplayName(entry, t, localizePluginText),
        }),
        t('connect.unsupported.runCommandInTerminal'),
        [
          { text: entry.connectCommand, style: 'default' },
          { text: t('common.ok'), style: 'cancel' },
        ],
      );
    }
  }, [accountTransport, localizePluginText, router]);

  /** Released V2/V3 default-auth ingress, explicitly resolved by the adapter. */
  const openLegacyConnectedServiceSettings = React.useCallback(async (serviceId: string) => {
    await openProjectedConnectedServiceSettings(
      getLegacyConnectedServiceRegistryEntry(serviceId),
    );
  }, [openProjectedConnectedServiceSettings]);

  // Service rows carry a brand mark + worst-of-status health dot, ordered
  // attention-first so anything needing the user sits at the top of the list.
  const serviceRows = React.useMemo(() => visibleRegistryEntries
    .flatMap((entry) => {
      if (!entry.service) return [];
      const serviceKey = buildQualifiedPluginContributionKey(entry.service);
      const label = resolveConnectedServiceRegistryEntryDisplayName(entry, t, localizePluginText);
      const v4Profiles = qualifiedAccounts.filter((account) => (
        account.ref.service.pluginId === entry.service!.pluginId
        && account.ref.service.localId === entry.service!.localId
      ));
      const v4Groups = qualifiedGroups.filter((group) => (
        group.ref.service.pluginId === entry.service!.pluginId
        && group.ref.service.localId === entry.service!.localId
      ));
      const legacyService = accountTransport === 'legacy' && entry.legacyServiceId
        ? services.find((candidate) => candidate.serviceId === entry.legacyServiceId) ?? null
        : null;
      const profiles = accountTransport === 'advertised-v4'
        ? v4Profiles
        : legacyService?.profiles ?? [];
      const connected = profiles.filter((profileEntry) =>
        isConnectedServiceCredentialHealthStatusUsable(
          normalizeConnectedServiceCredentialHealthStatus(profileEntry.status),
        )
      );
      const effectiveProfileId = accountTransport === 'advertised-v4'
        ? resolveQualifiedConnectedAccountDefaultId({
            service: entry.service,
            legacyServiceId: entry.legacyServiceId ?? null,
            connectedAccountIds: connected.map((profileEntry) => (
              'ref' in profileEntry ? profileEntry.ref.accountId : profileEntry.profileId
            )),
            defaultAccountByServiceKey: settings.connectedServicesDefaultProfileByServiceId,
          })
        : entry.legacyServiceId
          ? resolveConnectedServiceDefaultProfileId({
              serviceId: entry.legacyServiceId,
              connectedProfileIds: connected.map((profileEntry) => (
                'profileId' in profileEntry ? profileEntry.profileId : profileEntry.ref.accountId
              )),
              defaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
            })
          : null;
      const quotaKey = effectiveProfileId
        ? accountTransport === 'advertised-v4'
          ? connectedServiceProfileKey({
              serviceId: qualifiedConnectedAccountPreferenceServiceKey(entry.service),
              profileId: effectiveProfileId,
            })
          : entry.legacyServiceId
            ? connectedServiceProfileKey({ serviceId: entry.legacyServiceId, profileId: effectiveProfileId })
            : ''
        : '';
      const badges = quotaKey ? (quotaBadgesByKey[quotaKey] ?? []) : [];
      const diagnostics = presentConnectedServiceIndexDiagnostics({
        entry,
        registryErrorReason: connectedServicesRegistrySnapshot.errorReason,
      });
      const readyGroupCount = v4Groups.filter((group) => group.state.status === 'ready').length;
      const subtitle = diagnostics.primary ?? (
        accountTransport === 'indeterminate'
          ? t('common.loading')
          : connected.length > 0
            ? t('connectedServices.list.connectedCount', { count: connected.length })
            : profiles.length > 0
              ? t('connectedServices.list.needsReauth')
              : v4Groups.length > 0
                ? readyGroupCount > 0
                  ? t('connectedServices.detail.groups.title')
                  : t('common.unavailable')
                : t('connectedServices.list.notConnected')
      );
      // A service with no accounts at all is "not connected" — neutral, no dot.
      const health: AccountHealth = profiles.length > 0 ? deriveServiceRowHealth(profiles) : 'healthy';
      const canOpen = entry.executable === true
        || (
          accountTransport === 'legacy'
          && Boolean(entry.legacyServiceId)
          && !entry.projectedDescriptor
        );
      return [{
        serviceKey,
        entry,
        label,
        badges,
        subtitle,
        supportDetails: diagnostics.supportDetails,
        canOpen,
        health,
        hasProfiles: profiles.length > 0,
      }];
    })
    .sort((a, b) => {
      const rank = compareAccountHealthSeverity(a.health, b.health);
      if (rank !== 0) return rank;
      return a.label.localeCompare(b.label);
    }),
  [
    accountTransport,
    visibleRegistryEntries,
    services,
    qualifiedAccounts,
    qualifiedGroups,
    localizePluginText,
    settings.connectedServicesDefaultProfileByServiceId,
    quotaBadgesByKey,
    connectedServicesRegistrySnapshot.errorReason,
  ]);

  return (
    <ItemList>
      <ConnectedServiceQuotaSummaryCardSection
        title={t('settings.usage')}
        cards={quotaCards}
        isRefreshing={quotaSummariesRefreshing}
        showWhenEmpty={hasConnectedQuotaProfiles}
        testID="connected-services-quota-summary-section"
      />
      <ItemGroup title={t('connectedServices.title')} columns={2}>
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
            subtitle={t('common.unavailable')}
            mode="info"
            onPress={projectionErrorDetails
              ? () => void Modal.alert(
                  t('common.details'),
                  projectionErrorDetails,
                )
              : undefined}
          />
        ) : null}
        {isProjectionSettled
          && services.length === 0
          && qualifiedAccounts.length === 0
          && qualifiedGroups.length === 0
          && serviceRows.length === 0 ? (
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ color: theme.colors.text.secondary }}>{t('connectedServices.list.empty')}</Text>
          </View>
        ) : null}

        {serviceRows.map((row) => {
          const { serviceKey, entry, label, badges, subtitle, supportDetails, health, hasProfiles, canOpen } = row;
          // Brand aliases are a visual affordance only; only a generated legacy
          // adapter can opt a qualified owner into a built-in mark.
          const brandXml = resolveConnectedServiceBrandIconXml(entry.legacyServiceId, theme);
          const leadingIcon = (
            <View style={styles.iconBox}>
              {brandXml
                ? <SvgXml xml={brandXml} width={BRAND_ICON_SIZE} height={BRAND_ICON_SIZE} />
                : <Icon name="key" size={20} color={theme.colors.text.primary} />}
              {hasProfiles ? (
                <StatusDot
                  testID={`connected-services-index:${serviceKey}:health-dot`}
                  color={resolveAccountHealthDotColor(theme, health)}
                  size={8}
                  style={styles.healthDot}
                />
              ) : null}
            </View>
          );

          return (
            <React.Fragment key={serviceKey}>
              <Item
                title={label}
                subtitle={subtitle}
                leftElement={leadingIcon}
                rightElement={badges.length > 0 ? <ConnectedServiceQuotaBadgesView badges={badges} /> : undefined}
                disabled={!canOpen}
                onPress={!canOpen
                  ? undefined
                  : () => openProjectedConnectedServiceSettings(entry)}
              />
              {supportDetails ? (
                <Item
                  testID={`connected-services-index:${serviceKey}:support-details`}
                  title={t('common.details')}
                  subtitle={t('common.unavailable')}
                  onPress={() => void Modal.alert(t('common.details'), supportDetails)}
                />
              ) : null}
            </React.Fragment>
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
              onOpenConnectedServicesSettings={openLegacyConnectedServiceSettings}
              dismissedPoolAdoptionSuggestionKeys={poolAdoptionDismissedByKey}
              onDismissPoolAdoptionSuggestion={dismissPoolAdoptionSuggestion}
            />
          );
        })}
      </ItemGroup>
      <ConnectedServicesProviderStateSharingDefaultsGroup
        settings={normalizedProviderStateSharingSettings}
        setSettings={setProviderStateSharingSettings}
        onOpenBackendOverrides={() => router.push('/(app)/settings/connected-services/provider-state-sharing')}
      />
    </ItemList>
  );
});
