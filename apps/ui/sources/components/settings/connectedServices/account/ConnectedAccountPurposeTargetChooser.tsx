import * as React from 'react';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';

import type {
  AgentConnectedAccountPurposeTeamResourceDefault,
  PluginContributionIdentityV1,
  PluginLocalizedStringV2,
  QualifiedConnectedAccountPurposeBindingTargetV1,
} from '@happier-dev/protocol';

import {
  SelectionList,
  resolvePopoverSelectionListHeightBehavior,
  type SelectionListStep,
} from '@/components/ui/selectionList';
import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import {
  useProjectedConnectedServicesRegistry,
  useProjectedPluginLocalizedTextResolver,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { getConnectedAccountAuthentication } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { resolveQualifiedConnectedServiceRegistryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { resolveConnectedAccountUiNegotiation } from '@/sync/domains/connectedServices/resolveConnectedAccountUiNegotiation';
import { useServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { useActiveServerAccountScope, useProfile } from '@/sync/store/hooks';
import { selectConnectedMetadataLabels, useConnectedMetadataCatalog } from '@/hooks/server/connectedServices/useConnectedMetadataCatalog';
import type { HomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { getPreferredLanguage, t } from '@/text';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';

import {
  buildConnectedAccountPurposeTargetChoices,
  connectedAccountPurposeTargetChoiceId,
} from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';

const PURPOSE_TARGET_PICKER_MAX_HEIGHT = 520;
const EMPTY_ACCOUNTS = Object.freeze([]);
const EMPTY_GROUPS = Object.freeze([]);
const EMPTY_TEAM_RESOURCES: HomeTeamCredentialModelCatalog['resources'] = Object.freeze([]);

type ConnectedAccountPurposeTargetPickerModalContentProps = Readonly<{
  rootStep: SelectionListStep;
  selectedOptionId: string | null;
  accessibilityLabel: string;
  onSelect: (optionId: string) => void;
  onClose: () => void;
}>;

function ConnectedAccountPurposeTargetPickerModalContent(
  props: ConnectedAccountPurposeTargetPickerModalContentProps,
) {
  return (
    <SelectionList
      testID="connected-account-purpose-target-picker"
      rootStep={props.rootStep}
      selectedOptionId={props.selectedOptionId}
      listAccessibilityLabel={props.accessibilityLabel}
      maxHeight={PURPOSE_TARGET_PICKER_MAX_HEIGHT}
      heightBehavior={resolvePopoverSelectionListHeightBehavior()}
      keyboardHintsEnabled
      onRequestClose={props.onClose}
      onSelect={(optionId) => {
        props.onClose();
        props.onSelect(optionId);
      }}
    />
  );
}

export function ConnectedAccountPurposeTargetChooser(props: Readonly<{
  testID: string;
  /** Plugin that authored the localized purpose title. */
  localizedTextPluginId: string;
  declaration: Readonly<{
    purpose: string;
    service: PluginContributionIdentityV1;
    title?: PluginLocalizedStringV2;
    required?: boolean;
  }>;
  value: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
  /** The purpose's current Team resource default, when that is its selection. */
  teamResourceValue?: AgentConnectedAccountPurposeTeamResourceDefault | null;
  /**
   * One choice: a personal target, or (only with `teamCredentialCatalog`) a
   * Team resource as its canonical Team selection; never both.
   */
  onChange: (
    target: QualifiedConnectedAccountPurposeBindingTargetV1 | null,
    teamResource: AgentConnectedAccountPurposeTeamResourceDefault | null,
  ) => void;
  disabled?: boolean;
  disabledReason?: string;
  /** The identity mark of what this purpose draws on (a service), in the row's leading column. */
  icon?: React.ReactNode;
  /** What the current choice means here, said when the row has no state of its own to report. */
  description?: string;
  onReload?: () => Promise<void> | void;
  /** Provider's current status, presented by the provider status owner. */
  reloadSubtitle?: string;
  /**
   * The viewer's entitled Team catalog for the active Home. Supplied only by a
   * surface whose consumer materializes the purpose inside a Session, where
   * the Home admits the Team binding; other surfaces offer personal targets.
   */
  teamCredentialCatalog?: Pick<
    HomeTeamCredentialModelCatalog,
    'resources' | 'teamNameById' | 'currentResourceKeys'
  >;
}>) {
  const profile = useProfile();
  const { present } = useConnectedAccountIdentityPrivacy();
  const locale = getPreferredLanguage();
  const labelsByKey = useConnectedMetadataCatalog(undefined, selectConnectedMetadataLabels);
  const pathname = usePathname();
  const registry = useProjectedConnectedServicesRegistry();
  const localizePluginText = useProjectedPluginLocalizedTextResolver();
  const serverFeatures = useServerFeaturesRuntimeSnapshot({ enabled: true });
  const accountTransport = resolveConnectedAccountUiNegotiation(serverFeatures);
  const activeAccountScope = useActiveServerAccountScope();
  // A feature bit only proves the transport is understood. The profile owner
  // proves whether the qualified target arrays belong to the current Account;
  // its default empty profile must remain indeterminate until that owner has
  // hydrated (or a cached profile is demonstrably for the active Account).
  const profileHydrated = typeof profile.id === 'string'
    && Boolean(activeAccountScope?.accountId)
    && profile.id.trim() === activeAccountScope?.accountId;
  const effectiveAccountTransport = accountTransport === 'advertised-v4' && !profileHydrated
    ? 'indeterminate'
    : accountTransport;
  const pickerModalIdRef = React.useRef<string | null>(null);
  const [reloading, setReloading] = React.useState(false);
  const accounts = effectiveAccountTransport === 'advertised-v4'
    ? profile.connectedAccountsV4 ?? EMPTY_ACCOUNTS
    : EMPTY_ACCOUNTS;
  const groups = effectiveAccountTransport === 'advertised-v4'
    ? profile.connectedAccountGroupsV4 ?? EMPTY_GROUPS
    : EMPTY_GROUPS;
  const teamCatalog = props.teamCredentialCatalog;
  const teamResources = React.useMemo(() => (
    teamCatalog ? teamCatalog.resources : EMPTY_TEAM_RESOURCES
  ), [teamCatalog]);
  const serviceTitle = React.useMemo(() => {
    return resolveQualifiedConnectedServiceRegistryDisplayName(
      registry,
      props.declaration.service,
      t,
      localizePluginText,
    );
  }, [localizePluginText, locale, props.declaration.service, registry.entries]);
  const choices = React.useMemo(() => buildConnectedAccountPurposeTargetChoices({
    declaration: { ...props.declaration, required: props.declaration.required === true },
    selectedTarget: props.value,
    selectedTeamResource: props.teamResourceValue ?? null,
    accounts,
    groups,
    labelsByKey,
    serviceTitle,
    sourceNegotiation: effectiveAccountTransport,
    presentIdentity: present,
    resolveAuthentication: getConnectedAccountAuthentication,
    teamResources,
    teamResourceCurrentKeys: teamCatalog?.currentResourceKeys,
    ...(teamCatalog ? { teamNameById: teamCatalog.teamNameById } : {}),
  }), [
    accounts,
    groups,
    teamResources,
    teamCatalog,
    effectiveAccountTransport,
    present,
    props.declaration,
    props.value,
    props.teamResourceValue,
    serviceTitle,
    labelsByKey,
    // The registry is the descriptor/currentness owner for authentication.
    registry,
  ]);
  const selectedId = connectedAccountPurposeTargetChoiceId(props.value, props.teamResourceValue ?? null);
  const selected = choices.find((choice) => choice.id === selectedId) ?? null;
  const declaredPurposeTitle = props.declaration.title
    ? localizePluginText(props.localizedTextPluginId, props.declaration.title)
    : '';
  const purposeTitle = declaredPurposeTitle || serviceTitle;
  const unreadSelectionReason = props.value === null && !props.teamResourceValue ? props.disabledReason : null;
  const selectedTargetAccessibilityLabel = !unreadSelectionReason && selected?.selectable
    ? selected.presentation.accessibilityLabel
    : null;
  const unresolvedSourceLabel = effectiveAccountTransport === 'indeterminate'
    ? t('common.loading')
    : effectiveAccountTransport === 'legacy'
      ? t('connectedServices.purposeTargets.legacyUnavailable')
      : null;
  const requiredUnsetLabel = props.value === null && !props.teamResourceValue && props.declaration.required === true
    ? t('connectedServices.purposeTargets.requiredPrompt')
    : null;
  const triggerStatus = props.disabledReason
    ?? unresolvedSourceLabel
    ?? (selectedTargetAccessibilityLabel ? null : requiredUnsetLabel ?? t('common.unavailable'));
  const triggerDetail = unreadSelectionReason
    ?? selected?.presentation.primaryLabel
    ?? unresolvedSourceLabel
    ?? requiredUnsetLabel
    ?? t('common.unavailable');
  const triggerAccessibilityLabel = [
    purposeTitle,
    selectedTargetAccessibilityLabel,
    triggerStatus,
  ].filter((label): label is string => label !== null).join(' · ');

  const rootStep = React.useMemo<SelectionListStep>(() => ({
    id: 'connected-account-purpose-targets',
    inputPlaceholder: t('modelPickerOverlay.searchPlaceholder'),
    emptyStateLabel: t('common.unavailable'),
    sections: [{
      kind: 'static',
      id: 'targets',
      // SelectionList owns search and automatically virtualizes this section
      // above its shared threshold; the chooser does not keep a second limit.
      options: choices.map((choice) => ({
        id: choice.id,
        testID: `${props.testID}:choice:${choice.id}`,
        label: choice.presentation.primaryLabel,
        ...(choice.presentation.secondaryLabel ? { subtitle: choice.presentation.secondaryLabel } : {}),
        accessibilityLabel: choice.presentation.accessibilityLabel,
        disabled: !choice.selectable,
      })),
    }],
  }), [choices, locale, props.testID]);
  const closePicker = React.useCallback(() => {
    if (!pickerModalIdRef.current) return;
    Modal.hide(pickerModalIdRef.current);
    pickerModalIdRef.current = null;
  }, []);
  const openPicker = React.useCallback(() => {
    if (props.disabled) return;
    closePicker();
    pickerModalIdRef.current = Modal.show({
      component: ConnectedAccountPurposeTargetPickerModalContent,
      props: {
        rootStep,
        selectedOptionId: selected?.selectable ? selected.id : null,
        accessibilityLabel: purposeTitle,
        onSelect: (id) => {
          const choice = choices.find((candidate) => candidate.id === id);
          if (choice?.selectable) props.onChange(choice.target, choice.teamResource);
        },
      },
      chrome: {
        kind: 'card',
        title: purposeTitle,
        testID: `${props.testID}:modal`,
        scrollHost: 'body',
        bodyScroll: 'none',
      },
      closeOnBackdrop: true,
    });
  }, [choices, closePicker, props.disabled, props.onChange, props.testID, purposeTitle, rootStep, selected]);

  // This screen can stay mounted behind another Settings route while its picker
  // remains portaled. Route ownership and unmount both close it.
  React.useEffect(() => {
    closePicker();
    return closePicker;
  }, [closePicker, pathname]);

  const reload = React.useCallback(async () => {
    if (!props.onReload || reloading) return;
    setReloading(true);
    try {
      await props.onReload();
    } finally {
      setReloading(false);
    }
  }, [props.onReload, reloading]);

  return <>
    <Item
      testID={props.testID}
      icon={props.icon}
      title={purposeTitle}
      subtitle={triggerStatus ?? props.description}
      subtitleLines={props.description ? 0 : undefined}
      detail={triggerDetail}
      accessibilityLabel={triggerAccessibilityLabel}
      showChevron
      disabled={props.disabled}
      onPress={props.disabled ? undefined : openPicker}
    />
    {props.onReload ? (
      <Item
        testID={`${props.testID}:reload`}
        title={t('common.refresh')}
        subtitle={props.reloadSubtitle}
        loading={reloading}
        disabled={reloading}
        onPress={() => void reload()}
      />
    ) : null}
  </>;
}
