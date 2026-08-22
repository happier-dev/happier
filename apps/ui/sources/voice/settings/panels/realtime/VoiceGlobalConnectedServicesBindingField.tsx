import * as React from 'react';
import { useRouter } from 'expo-router';

import {
  ConnectedServiceBindingsV1Schema,
  ConnectedServiceIdSchema,
  PluginContributionIdentityV1Schema,
  buildQualifiedPluginContributionKey,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import {
  isBundledAgentId,
  resolveBundledAgentIdFromContributionIdentity,
} from '@/agents/catalog/catalog';
import { resolveConnectedServiceDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { resolveConnectedServicesAuthLabel } from '@/components/settings/connectedServices/model/resolveConnectedServicesAuthLabel';
import { NewSessionConnectedServicesSelectionContent } from '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent';
import {
  buildConnectedServiceAccountGroupOptionsByServiceId,
  buildConnectedServiceProfileOptionsByServiceId,
  buildConnectedServicesBindingsPayload,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { Item } from '@/components/ui/lists/Item';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { useProfile, useSettings } from '@/sync/store/hooks';
import { t, tLoose } from '@/text';

const PICKER_MAX_HEIGHT = 520;

type PickerProps = Readonly<{
  onClose: () => void;
  initialBindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
  supportedServiceIds: ReadonlyArray<ConnectedServiceId>;
  profileOptionsByServiceId: Parameters<typeof NewSessionConnectedServicesSelectionContent>[0]['profileOptionsByServiceId'];
  groupOptionsByServiceId: Parameters<typeof NewSessionConnectedServicesSelectionContent>[0]['groupOptionsByServiceId'];
  defaultProfileIdByServiceId: Readonly<Record<string, string | undefined>>;
  accountGroupsEnabled: boolean;
  onBindingChange: (bindings: ConnectedServiceBindingsV1 | null) => void;
  onOpenSettings: (serviceId: string) => void;
}>;

function VoiceGlobalConnectedServicesPicker(props: PickerProps) {
  const [bindingsByServiceId, setBindingsByServiceId] = React.useState(props.initialBindingsByServiceId);
  const setBindingForService = React.useCallback((serviceId: string, binding: ConnectedServicesServiceBinding) => {
    setBindingsByServiceId((current) => {
      const next = { ...current, [serviceId]: binding };
      props.onBindingChange(buildConnectedServicesBindingsPayload({
        supportedConnectedServiceIds: props.supportedServiceIds,
        connectedServiceProfileOptionsByServiceId: props.profileOptionsByServiceId,
        connectedServiceAccountGroupOptionsByServiceId: props.groupOptionsByServiceId,
        connectedServicesBindingsByServiceId: next,
        defaultProfileByServiceId: { ...props.defaultProfileIdByServiceId },
        accountGroupsFeatureEnabled: props.accountGroupsEnabled,
      }));
      return next;
    });
  }, [props]);

  return <NewSessionConnectedServicesSelectionContent
    supportedServiceIds={props.supportedServiceIds}
    profileOptionsByServiceId={props.profileOptionsByServiceId}
    groupOptionsByServiceId={props.groupOptionsByServiceId}
    bindingsByServiceId={bindingsByServiceId}
    setBindingForService={setBindingForService}
    defaultProfileIdByServiceId={props.defaultProfileIdByServiceId}
    includeNativeAuthOption={false}
    allowDefaultProfileFallback={false}
    onOpenSettings={props.onOpenSettings}
    requestClose={props.onClose}
    maxHeight={PICKER_MAX_HEIGHT}
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
  onChange: (value: unknown) => void;
}>) {
  const profile = useProfile();
  const settings = useSettings();
  const router = useRouter();
  const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
  const bundledAgentId = isBundledAgentId(props.agentId)
    ? props.agentId
    : resolveBundledAgentIdFromContributionIdentity(props.agentId);
  const qualifiedAgent = React.useMemo(() => {
    const parsed = PluginContributionIdentityV1Schema.safeParse(props.agentId);
    return parsed.success ? parsed.data : null;
  }, [props.agentId]);
  const declaredServiceIds = React.useMemo(
    () => Array.isArray(props.serviceIds)
      ? new Set(props.serviceIds.flatMap((serviceId) => {
        const parsed = ConnectedServiceIdSchema.safeParse(serviceId);
        return parsed.success ? [parsed.data] : [];
      }))
      : new Set<ConnectedServiceId>(),
    [props.serviceIds],
  );
  const supportedServiceIds = React.useMemo(
    () => [...declaredServiceIds],
    [declaredServiceIds],
  );
  const profileOptionsByServiceId = React.useMemo(
    () => buildConnectedServiceProfileOptionsByServiceId({
      accountProfileConnectedServicesV2: profile.connectedServicesV2 ?? [],
      // Voice declarations own eligibility; this projection keeps canonical profile health only.
      agentCore: null,
      supportedConnectedServiceIds: supportedServiceIds,
      labelsByKey: settings.connectedServicesProfileLabelByKey ?? {},
    }),
    [
      profile.connectedServicesV2,
      settings.connectedServicesProfileLabelByKey,
      supportedServiceIds,
    ],
  );
  const groupOptionsByServiceId = React.useMemo(
    () => buildConnectedServiceAccountGroupOptionsByServiceId({
      accountGroupsFeatureEnabled: accountGroupsEnabled,
      accountProfileConnectedServicesV2: profile.connectedServicesV2 ?? [],
      supportedConnectedServiceIds: supportedServiceIds,
    }),
    [accountGroupsEnabled, profile.connectedServicesV2, supportedServiceIds],
  );
  const parsedBinding = React.useMemo(() => {
    const parsed = ConnectedServiceBindingsV1Schema.safeParse(props.value);
    return parsed.success ? parsed.data : null;
  }, [props.value]);
  const bindingsByServiceId = parsedBinding?.bindingsByServiceId ?? {};
  const defaultProfileIdByServiceId = settings.connectedServicesDefaultProfileByServiceId ?? {};
  const label = React.useMemo(() => resolveConnectedServicesAuthLabel({
    supportedServiceIds,
    bindingsByServiceId,
    profileOptionsByServiceId,
    accountGroupOptionsByServiceId: groupOptionsByServiceId,
    accountGroupsEnabled,
    defaultProfileIdByServiceId,
    resolveServiceTitle: (serviceId) => resolveConnectedServiceDisplayName(serviceId as ConnectedServiceId, t),
    nativeLabel: t('connectedServices.authChip.nativeLabel'),
    formatConnectedCountLabel: (count) => t('connectedServices.authChip.connectedCountLabel', { count }),
  }).label, [
    accountGroupsEnabled,
    bindingsByServiceId,
    defaultProfileIdByServiceId,
    groupOptionsByServiceId,
    profileOptionsByServiceId,
    supportedServiceIds,
  ]);

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

  return <Item
    testID={testID}
    title={title}
    subtitle={subtitle}
    detail={parsedBinding ? label : t('common.none')}
    showChevron
    onPress={() => {
      Modal.show({
        component: VoiceGlobalConnectedServicesPicker,
        props: {
          initialBindingsByServiceId: bindingsByServiceId,
          supportedServiceIds,
          profileOptionsByServiceId,
          groupOptionsByServiceId,
          defaultProfileIdByServiceId,
          accountGroupsEnabled,
          onBindingChange: props.onChange,
          onOpenSettings: (serviceId) => router.push({
            pathname: '/(app)/settings/connected-services/[serviceId]',
            params: { serviceId },
          } as never),
        },
        chrome: {
          kind: 'card',
          title,
          testID: `voice-realtime-connected-services-modal-${agentTestId}`,
          scrollHost: 'body',
          bodyScroll: 'none',
        },
        closeOnBackdrop: true,
      });
    }}
  />;
}
