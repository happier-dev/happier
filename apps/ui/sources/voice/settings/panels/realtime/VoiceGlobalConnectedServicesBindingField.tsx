import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { ConnectedAccountServiceKeySchema, ConnectedServiceBindingsV1Schema, ConnectedServiceBindingsV2Schema, ConnectedServiceIdSchema, type ConnectedServiceBindingsV1, type ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import { PluginContributionIdentityV1Schema, buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

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
import { storage, useSetting } from '@/sync/domains/state/storage';
import { useProfile } from '@/sync/store/hooks';
import { selectConnectedMetadataLabels, useConnectedMetadataCatalog } from '@/hooks/server/connectedServices/useConnectedMetadataCatalog';
import { t, tLoose } from '@/text';
import { buildQualifiedConnectedAccountGroupOptionsByServiceId, buildQualifiedConnectedAccountProfileOptionsByServiceId } from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';

const PICKER_MAX_HEIGHT = 520;

type PickerProps = Readonly<{
  onClose: () => void;
  initialBindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
  supportedServiceIds: ReadonlyArray<string>;
  profileOptionsByServiceId: Parameters<typeof NewSessionConnectedServicesSelectionContent>[0]['profileOptionsByServiceId'];
  groupOptionsByServiceId: Parameters<typeof NewSessionConnectedServicesSelectionContent>[0]['groupOptionsByServiceId'];
  defaultProfileIdByServiceId: Readonly<Record<string, string | undefined>>;
  accountGroupsEnabled: boolean;
  bindingVersion?: 1 | 2;
  onBindingChange: (bindings: ConnectedServiceBindingsV1 | ConnectedServiceBindingsV2 | null) => void;
  onOpenSettings: (serviceId: string) => void;
}>;

function VoiceGlobalConnectedServicesPicker(props: PickerProps) {
  const [bindingsByServiceId, setBindingsByServiceId] = React.useState(props.initialBindingsByServiceId);
  // Persisting the Voice setting is an external effect, so it cannot live inside a
  // functional state updater: React may evaluate or replay an updater more than once
  // and a single selection would then be written more than once. This ref mirrors the
  // rendered selection so the event callback derives the next value exactly once —
  // including for two selections batched before the next render — while the state
  // update itself stays a pure value assignment.
  const bindingsRef = React.useRef(bindingsByServiceId);
  bindingsRef.current = bindingsByServiceId;
  const setBindingForService = React.useCallback((serviceId: string, binding: ConnectedServicesServiceBinding) => {
    const next = { ...bindingsRef.current, [serviceId]: binding };
    bindingsRef.current = next;
    setBindingsByServiceId(next);
    const sessionBindings = buildConnectedServicesBindingsPayload({
      supportedConnectedServiceIds: props.supportedServiceIds,
      connectedServiceProfileOptionsByServiceId: props.profileOptionsByServiceId,
      connectedServiceAccountGroupOptionsByServiceId: props.groupOptionsByServiceId,
      connectedServicesBindingsByServiceId: next,
      defaultProfileByServiceId: { ...props.defaultProfileIdByServiceId },
      accountGroupsFeatureEnabled: props.accountGroupsEnabled,
    });
    props.onBindingChange(props.bindingVersion === 2 ? sessionBindings : sessionBindings === null
      ? null
      : ConnectedServiceBindingsV1Schema.parse({
        v: 1,
        bindingsByServiceId: sessionBindings.bindingsByServiceId,
      }));
  }, [props]);

  return <NewSessionConnectedServicesSelectionContent
    supportedServiceIds={props.supportedServiceIds}
    profileOptionsByServiceId={props.profileOptionsByServiceId}
    groupOptionsByServiceId={props.groupOptionsByServiceId}
    bindingsByServiceId={bindingsByServiceId}
    setBindingForService={setBindingForService}
    defaultProfileIdByServiceId={props.defaultProfileIdByServiceId}
    includeNativeAuthOption={props.bindingVersion === 2}
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
  /** Local Voice uses current Session bindings; native realtime envelopes retain V1. */
  bindingVersion?: 1 | 2;
  onChange: (value: unknown, expectedSettingsVersion: number | null) => void;
}>) {
  const profile = useProfile();
  const { present } = useConnectedAccountIdentityPrivacy();
  const connectedServicesDefaultProfileByServiceId = useSetting('connectedServicesDefaultProfileByServiceId');
  const labelsByKey = useConnectedMetadataCatalog(undefined, selectConnectedMetadataLabels);
  const router = useRouter();
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
  const bindingsByServiceId = parsedBinding?.bindingsByServiceId ?? {};
  const defaultProfileIdByServiceId = connectedServicesDefaultProfileByServiceId ?? {};
  const label = React.useMemo(() => resolveConnectedServicesAuthLabel({
    supportedServiceIds,
    bindingsByServiceId,
    profileOptionsByServiceId,
    accountGroupOptionsByServiceId: groupOptionsByServiceId,
    accountGroupsEnabled,
    defaultProfileIdByServiceId,
    resolveServiceTitle: (serviceId) => resolveConnectedServiceDisplayName(serviceId, t),
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
    detail={parsedBinding ? label : props.bindingVersion === 2
      ? props.value === undefined ? t('common.default') : t('connectedServices.authModal.nativeAuthTitle')
      : t('common.none')}
    showChevron
    onPress={() => {
      const expectedSettingsVersion = storage.getState().settingsVersion;
      Modal.show({
        component: VoiceGlobalConnectedServicesPicker,
        props: {
          initialBindingsByServiceId: bindingsByServiceId,
          supportedServiceIds,
          profileOptionsByServiceId,
          groupOptionsByServiceId,
          defaultProfileIdByServiceId,
          accountGroupsEnabled,
          bindingVersion: props.bindingVersion,
          onBindingChange: (value: ConnectedServiceBindingsV1 | ConnectedServiceBindingsV2 | null) => props.onChange(value, expectedSettingsVersion),
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
