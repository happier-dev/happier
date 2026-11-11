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
import { buildQualifiedConnectedAccountGroupOptionsByServiceId, buildQualifiedConnectedAccountProfileOptionsByServiceId } from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';

const EMPTY_RECORD: Readonly<Record<string, never>> = Object.freeze({});

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
  onChange: (value: unknown, expectedSettingsVersion: number | null) => void;
}>) {
  const profile = useProfile();
  const { present } = useConnectedAccountIdentityPrivacy();
  const connectedServicesDefaultProfileByServiceId = useSetting('connectedServicesDefaultProfileByServiceId');
  const labelsByKey = useConnectedMetadataCatalog(undefined, selectConnectedMetadataLabels);
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
  const profileOptionsByServiceId = React.useMemo(
    () => props.bindingVersion === 2 ? buildQualifiedConnectedAccountProfileOptionsByServiceId({
      accounts: profile.connectedAccountsV4 ?? [], supportedServiceIds, labelsByKey, presentIdentity: present,
    }) : buildConnectedServiceProfileOptionsByServiceId({
      accountProfileConnectedServicesV2: profile.connectedServicesV2 ?? [],
      supportedConnectedServiceIds: legacyServiceIds,
      labelsByKey,
    }),
    [
      profile.connectedServicesV2,
      labelsByKey,
      supportedServiceIds,
      legacyServiceIds,
      props.bindingVersion, profile.connectedAccountsV4, present,
    ],
  );
  const groupOptionsByServiceId = React.useMemo(
    () => props.bindingVersion === 2 ? buildQualifiedConnectedAccountGroupOptionsByServiceId({
      groups: profile.connectedAccountGroupsV4 ?? [], supportedServiceIds, labelsByKey,
    }) : buildConnectedServiceAccountGroupOptionsByServiceId({
      accountGroupsFeatureEnabled: accountGroupsEnabled,
      accountProfileConnectedServicesV2: profile.connectedServicesV2 ?? [],
      supportedConnectedServiceIds: legacyServiceIds,
    }),
    [accountGroupsEnabled, profile.connectedServicesV2, supportedServiceIds, legacyServiceIds, props.bindingVersion, profile.connectedAccountGroupsV4, labelsByKey],
  );
  const parsedBinding = React.useMemo(() => {
    const parsed = (props.bindingVersion === 2 ? ConnectedServiceBindingsV2Schema : ConnectedServiceBindingsV1Schema).safeParse(props.value);
    return parsed.success ? parsed.data : null;
  }, [props.value, props.bindingVersion]);
  const bindingsByServiceId = parsedBinding?.bindingsByServiceId ?? EMPTY_RECORD;
  const defaultProfileIdByServiceId = connectedServicesDefaultProfileByServiceId ?? EMPTY_RECORD;
  // The value the picks build on, and the version and Account scope the card opened under.
  const valueRef = React.useRef(bindingsByServiceId);
  valueRef.current = bindingsByServiceId;
  const openRef = React.useRef<{ expectedSettingsVersion: number | null; scope: AccountSettingsScope | null } | null>(null);
  const commit = React.useCallback((next: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>) => {
    const sessionBindings = buildConnectedServicesBindingsPayload({
      supportedConnectedServiceIds: supportedServiceIds,
      connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
      connectedServiceAccountGroupOptionsByServiceId: groupOptionsByServiceId,
      connectedServicesBindingsByServiceId: next,
      defaultProfileByServiceId: { ...defaultProfileIdByServiceId },
      accountGroupsFeatureEnabled: accountGroupsEnabled,
    });
    props.onChange(props.bindingVersion === 2 ? sessionBindings : sessionBindings === null
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
  />;
}
