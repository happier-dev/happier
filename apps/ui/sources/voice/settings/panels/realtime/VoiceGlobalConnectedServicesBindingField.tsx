import type { PopoverAnchor } from '@/components/ui/popover';
import * as React from 'react';

import { ConnectedAccountServiceKeySchema, ConnectedServiceBindingsV1Schema, ConnectedServiceBindingsV2Schema, ConnectedServiceIdSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { PluginContributionIdentityV1Schema, buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import {
  isBundledAgentId,
  resolveBundledAgentIdFromContributionIdentity,
} from '@/agents/catalog/catalog';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { resolveQualifiedConnectedAccountServiceKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { ConnectedServicesBindingRow } from '@/components/settings/connectedServices/ConnectedServicesBindingRow';
import {
  buildConnectedServiceAccountGroupOptionsByServiceId,
  buildConnectedServiceProfileOptionsByServiceId,
  buildConnectedServicesBindingsPayload,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { Item } from '@/components/ui/lists/Item';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { storage, useSetting } from '@/sync/domains/state/storage';
import { useProfile } from '@/sync/store/hooks';
import { selectConnectedMetadataLabels, useConnectedMetadataCatalog } from '@/hooks/server/connectedServices/useConnectedMetadataCatalog';
import { t, tLoose } from '@/text';
import { useNewSessionConnectedServiceOptions, type NewSessionConnectedServiceOptionsInput } from '@/components/sessions/new/modules/useNewSessionConnectedServiceOptions';
import { NewSessionConnectedServicesSelectionContent, type NewSessionConnectedServicesSelectionContentProps } from '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { useTeamCredentialSelectionCoordinator } from '@/components/sessions/teamCredentials/useTeamCredentialSelectionCoordinator';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useProjectedConnectedServicesRegistry } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveQualifiedConnectedServiceRegistryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { teamCredentialDetailPath } from '@/components/settings/teams/teamsRoutes';
import { useDirectDeliveryDisclosure } from '@/components/sessions/teamCredentials/directDeliveryDisclosure';

const EMPTY_RECORD: Readonly<Record<string, never>> = Object.freeze({});
const EMPTY_CONNECTED_ACCOUNTS: NewSessionConnectedServiceOptionsInput['connectedAccounts'] = Object.freeze([]);
type TeamCatalogInput = Omit<Parameters<typeof useHomeTeamCredentialModelCatalog>[0], 'enabled'>;

function VoiceConnectedServicesSelectionContent(props: Readonly<{
  content: NewSessionConnectedServicesSelectionContentProps;
  inventoryInput: NewSessionConnectedServiceOptionsInput;
  teamCatalogInput?: TeamCatalogInput;
}>) {
  const router = useRouter();
  const catalog = useHomeTeamCredentialModelCatalog({ ...props.teamCatalogInput,
    serverId: props.teamCatalogInput?.serverId, enabled: props.teamCatalogInput !== undefined });
  const coordinateSelection = useTeamCredentialSelectionCoordinator(props.teamCatalogInput?.serverId);
  const directDelivery = useDirectDeliveryDisclosure(props.teamCatalogInput?.machineId ?? null, props.teamCatalogInput?.serverId ?? null);
  const currentCatalog = React.useRef(catalog);
  currentCatalog.current = catalog;
  return <NewSessionConnectedServicesSelectionContent {...props.content} inventoryInput={props.inventoryInput}
    teamCredentialResources={catalog.resources} teamCredentialDisplayNames={catalog.displayNames} teamCredentialResourceStatusByKey={catalog.resourceStatusByKey}
    teamNameById={catalog.teamNameById} directDelivery={directDelivery}
    onRecoverTeamCredentialResource={resource => {
      if (props.teamCatalogInput?.serverId) router.push(teamCredentialDetailPath({ serverId: props.teamCatalogInput.serverId, teamId: resource.teamId }, resource.id));
    }}
    setBindingForService={(serviceId, binding) => {
      if (binding.source !== 'team_resource') return props.content.setBindingForService(serviceId, binding);
      const resource = catalog.resources.find(resource => resource.id === binding.resourceId);
      if (!resource) return;
      void coordinateSelection({ resource, deliveryMode: binding.deliveryMode, selection: binding,
        isCurrent: () => currentCatalog.current.resourceStatusByKey.get(`${resource.teamId}:${resource.id}`)?.kind === 'current'
          && currentCatalog.current.resources.some(current => current.teamId === resource.teamId && current.id === resource.id
            && current.resourceRevision === resource.resourceRevision),
      }).then(outcome => {
        if (outcome.kind === 'continue') props.content.setBindingForService(serviceId, outcome.selection);
      });
    }}
  />;
}

export function VoiceGlobalConnectedServicesBindingField(props: Readonly<{
  agentId: unknown;
  serviceIds: unknown;
  titleKey?: unknown;
  subtitleKey?: unknown;
  title?: unknown;
  subtitle?: unknown;
  value: unknown;
  /** Local Voice uses current Session bindings; native realtime envelopes retain V1. */
  bindingVersion?: 1 | 2;
  connectedAccounts?: NewSessionConnectedServiceOptionsInput['connectedAccounts'];
  teamCatalogInput?: TeamCatalogInput;
  onChange: (value: unknown, expectedSettingsVersion: number | null) => void;
}>) {
  const legacyAccounts = useProfile(profile => props.bindingVersion === 2 ? null : profile.connectedServicesV2, ['connectedServicesV2']);
  const settingsScope = useAccountSettingsScope();
  const registry = useProjectedConnectedServicesRegistry();
  const connectedServicesDefaultProfileByServiceId = useSetting('connectedServicesDefaultProfileByServiceId');
  const labelsByKey = useConnectedMetadataCatalog(undefined, selectConnectedMetadataLabels, { enabled: props.bindingVersion !== 2 });
  const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
  const bundledAgentId = isBundledAgentId(props.agentId)
    ? props.agentId
    : resolveBundledAgentIdFromContributionIdentity(props.agentId);
  const qualifiedAgent = React.useMemo(() => {
    const parsed = PluginContributionIdentityV1Schema.safeParse(props.agentId);
    return parsed.success ? parsed.data : null;
  }, [props.agentId]);
  const legacyServiceIds = React.useMemo(
    () => props.bindingVersion !== 2 && Array.isArray(props.serviceIds)
      ? props.serviceIds.flatMap((serviceId) => {
        const parsed = ConnectedServiceIdSchema.safeParse(serviceId);
        return parsed.success ? [parsed.data] : [];
      })
      : [],
    [props.serviceIds, props.bindingVersion],
  );
  const supportedServiceIds = React.useMemo(
    () => [...new Set(props.bindingVersion === 2 && Array.isArray(props.serviceIds)
      ? props.serviceIds.flatMap(serviceId => {
        const parsed = ConnectedAccountServiceKeySchema.safeParse(serviceId);
        return parsed.success ? [parsed.data] : [];
      }) : legacyServiceIds)],
    [props.serviceIds, props.bindingVersion, legacyServiceIds],
  );
  const legacyProfileOptions = React.useMemo(
    () => buildConnectedServiceProfileOptionsByServiceId({
      accountProfileConnectedServicesV2: legacyAccounts ?? [],
      supportedConnectedServiceIds: legacyServiceIds,
      labelsByKey,
    }),
    [
      legacyAccounts,
      labelsByKey,
      supportedServiceIds,
      legacyServiceIds,
    ],
  );
  const legacyGroupOptions = React.useMemo(
    () => buildConnectedServiceAccountGroupOptionsByServiceId({
      accountGroupsFeatureEnabled: accountGroupsEnabled,
      accountProfileConnectedServicesV2: legacyAccounts ?? [],
      supportedConnectedServiceIds: legacyServiceIds,
    }),
    [accountGroupsEnabled, legacyAccounts, legacyServiceIds],
  );
  const parsedBinding = React.useMemo(() => {
    const parsed = (props.bindingVersion === 2 ? ConnectedServiceBindingsV2Schema : ConnectedServiceBindingsV1Schema).safeParse(props.value);
    return parsed.success ? parsed.data : null;
  }, [props.value, props.bindingVersion]);
  const bindingsByServiceId = parsedBinding?.bindingsByServiceId ?? EMPTY_RECORD;
  const resolveServiceTitle = React.useCallback((serviceId: string) => {
    const service = parseQualifiedPluginContributionKey(serviceId);
    return service ? resolveQualifiedConnectedServiceRegistryDisplayName(registry, service, t) : serviceId;
  }, [registry]);
  const inventoryInput = React.useMemo<NewSessionConnectedServiceOptionsInput | null>(() => props.bindingVersion === 2 ? ({
    connectedAccounts: props.connectedAccounts ?? EMPTY_CONNECTED_ACCOUNTS, supportedServiceIds, scope: settingsScope, resolveServiceTitle,
  }) : null, [props.bindingVersion, props.connectedAccounts, supportedServiceIds, settingsScope, resolveServiceTitle]);
  const selectedTargets = React.useMemo(() => [bindingsByServiceId], [bindingsByServiceId]);
  const personalOptions = useNewSessionConnectedServiceOptions(inventoryInput, selectedTargets);
  const profileOptionsByServiceId = inventoryInput ? personalOptions.profileOptionsByServiceId : legacyProfileOptions;
  const groupOptionsByServiceId = inventoryInput ? personalOptions.groupOptionsByServiceId : legacyGroupOptions;
  const defaultProfileIdByServiceId = connectedServicesDefaultProfileByServiceId ?? EMPTY_RECORD;
  // The value the picks build on, and the version and Account scope the card opened under.
  const valueRef = React.useRef(bindingsByServiceId);
  valueRef.current = bindingsByServiceId;
  const openRef = React.useRef<{ expectedSettingsVersion: number | null; scope: AccountSettingsScope | null } | null>(null);
  const commit = React.useCallback((next: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>) => {
    if (props.bindingVersion === 2) {
      props.onChange(ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: next }),
        openRef.current?.expectedSettingsVersion ?? null);
      return;
    }
    const sessionBindings = buildConnectedServicesBindingsPayload({
      supportedConnectedServiceIds: supportedServiceIds,
      connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
      connectedServiceAccountGroupOptionsByServiceId: groupOptionsByServiceId,
      connectedServicesBindingsByServiceId: next,
      defaultProfileByServiceId: { ...defaultProfileIdByServiceId },
      accountGroupsFeatureEnabled: accountGroupsEnabled,
    });
    props.onChange(sessionBindings === null
      ? null
      : ConnectedServiceBindingsV1Schema.parse({ v: 1, bindingsByServiceId: sessionBindings.bindingsByServiceId }),
    openRef.current?.expectedSettingsVersion ?? null);
  }, [accountGroupsEnabled, defaultProfileIdByServiceId, groupOptionsByServiceId, profileOptionsByServiceId, props, supportedServiceIds]);
  const openConnect = React.useCallback((serviceId: string, anchor?: PopoverAnchor) => {
    const serviceKey = resolveQualifiedConnectedAccountServiceKey(serviceId);
    if (!serviceKey) return;
    const service = parseQualifiedPluginContributionKey(serviceKey);
    if (!service) return;
    const binding = valueRef.current[serviceKey] ?? valueRef.current[serviceId];
    void presentConnectSheet({
      scope: openRef.current?.scope ?? null, service, intent: 'link', anchor,
      ...(binding?.source === 'connected' && binding.profileId
        ? { account: { service, accountId: binding.profileId } } : {}),
    }).then(result => {
      if (result.kind !== 'dismissed') commit({ ...valueRef.current, [serviceId]: {
        source: 'connected', selection: 'profile', profileId: result.account.accountId,
      } });
    });
  }, [commit]);

  if (!bundledAgentId && !qualifiedAgent) return null;

  const title = typeof props.title === 'string'
    ? props.title
    : typeof props.titleKey === 'string'
      ? tLoose(props.titleKey)
      : t('settingsVoice.realtimeProviders.codex.accountTitle');
  const subtitle = typeof props.subtitle === 'string'
    ? props.subtitle
    : typeof props.subtitleKey === 'string'
      ? tLoose(props.subtitleKey)
      : undefined;
  const agentTestId = bundledAgentId
    ?? (qualifiedAgent ? buildQualifiedPluginContributionKey(qualifiedAgent) : 'unknown');
  const testID = `voice-realtime-connected-services-${agentTestId}`;

  if (supportedServiceIds.length === 0) {
    return <Item
      testID={testID}
      title={title}
      subtitle={subtitle}
      detail={t('common.unavailable')}
      mode="info"
      showChevron={false}
    />;
  }

  return <ConnectedServicesBindingRow
    testID={testID}
    title={title}
    description={subtitle ?? t('settingsVoice.pages.conversations.agentAccountDescription')}
    modalTitle={title}
    modalTestID={`voice-realtime-connected-services-modal-${agentTestId}`}
    supportedServiceIds={supportedServiceIds}
    profileOptionsByServiceId={profileOptionsByServiceId}
    groupOptionsByServiceId={groupOptionsByServiceId}
    bindingsByServiceId={bindingsByServiceId}
    defaultProfileIdByServiceId={defaultProfileIdByServiceId}
    accountGroupsEnabled={accountGroupsEnabled}
    includeNativeAuthOption={props.bindingVersion === 2}
    allowDefaultProfileFallback={false}
    // Native realtime envelopes have no "its own sign-in" answer: nothing stored is none.
    fallbackLabel={props.bindingVersion !== 2 && !parsedBinding ? t('common.none') : undefined}
    onBeforeOpen={() => {
      const lifetime = captureActiveServerAccountScopeLifetime();
      if (!lifetime?.isCurrent()) return false;
      openRef.current = { expectedSettingsVersion: storage.getState().settingsVersion, scope: lifetime.scope };
      return true;
    }}
    setBindingForService={(_serviceId, _binding, next) => commit(next)}
    onOpenSettings={openConnect}
    renderSelectionContent={inventoryInput ? content => <VoiceConnectedServicesSelectionContent content={content}
      inventoryInput={inventoryInput} teamCatalogInput={props.teamCatalogInput} /> : undefined}
  />;
}
