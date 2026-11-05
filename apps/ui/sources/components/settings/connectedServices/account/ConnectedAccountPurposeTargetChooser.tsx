import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';

import type {
  AgentConnectedAccountPurposeTeamResourceDefault,
  PluginContributionIdentityV1,
  PluginLocalizedStringV2,
  QualifiedConnectedAccountPurposeBindingTargetV1,
} from '@happier-dev/protocol';

import {
  SELECTION_LIST_MODAL_CARD_SCROLL,
  SELECTION_LIST_MODAL_MAX_HEIGHT,
  SelectionList,
  resolveSelectionListModalHeightBehavior,
  type SelectionListStep,
} from '@/components/ui/selectionList';
import { Item } from '@/components/ui/lists/Item';
import { useListPresentation } from '@/components/ui/lists/listPresentation';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { Icon } from '@/components/ui/icons/Icon';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { Modal } from '@/modal';
import {
  useAppShellPluginUiProjection,
  useProjectedConnectedServicesRegistry,
  useProjectedPluginLocalizedTextResolver,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { getConnectedAccountAuthentication, type ConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
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

const EMPTY_ACCOUNTS = Object.freeze([]);
const EMPTY_GROUPS = Object.freeze([]);
const EMPTY_TEAM_RESOURCES: HomeTeamCredentialModelCatalog['resources'] = Object.freeze([]);

/**
 * Re-reading the targets is a recovery for "my account is not in this list", so it lives where that
 * list is read: one quiet line under the choices, never a row on the page.
 */
type PurposeTargetPickerRefresh = Readonly<{
  /** The owner's current status (for example the Provider's), said next to the action. */
  status?: string;
  refreshing: boolean;
  onRefresh: () => void;
}>;

type ConnectedAccountPurposeTargetPickerModalContentProps = Readonly<{
  rootStep: SelectionListStep;
  selectedOptionId: string | null;
  accessibilityLabel: string;
  onSelect: (optionId: string) => void;
  refresh: PurposeTargetPickerRefresh | null;
  testID: string;
  onClose: () => void;
}>;

function ConnectedAccountPurposeTargetPickerModalContent(
  props: ConnectedAccountPurposeTargetPickerModalContentProps,
) {
  return (
    <>
      <SelectionList
        testID="connected-account-purpose-target-picker"
        rootStep={props.rootStep}
        selectedOptionId={props.selectedOptionId}
        listAccessibilityLabel={props.accessibilityLabel}
        maxHeight={SELECTION_LIST_MODAL_MAX_HEIGHT}
        heightBehavior={resolveSelectionListModalHeightBehavior()}
        keyboardHintsEnabled
        onRequestClose={props.onClose}
        onSelect={(optionId) => {
          props.onClose();
          props.onSelect(optionId);
        }}
      />
      {props.refresh ? (
        <View style={styles.refresh}>
          <Text style={styles.refreshStatus} numberOfLines={2}>{props.refresh.status ?? ''}</Text>
          <RoundButton
            testID={`${props.testID}:reload`}
            size="small"
            display="inverted"
            title={t('common.refresh')}
            loading={props.refresh.refreshing}
            disabled={props.refresh.refreshing}
            onPress={props.refresh.onRefresh}
          />
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  refresh: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  refreshStatus: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    flex: 1,
    minWidth: 0,
    color: theme.colors.text.secondary,
  },
}));

export function ConnectedAccountPurposeTargetChooser(props: Readonly<{
  testID: string;
  registry?: ConnectedServiceRegistrySnapshot;
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
  /**
   * What an optional purpose with no target means on this surface (an Agent's own sign-in, an
   * unused gateway slot). Defaults to "Not set"; never a dash.
   */
  noneLabel?: string;
  /** Re-read the owner's targets, together with the followed descriptors. Offered once, inside the picker sheet, not as a page row. */
  onReload?: () => Promise<void> | void;
  /** The owner's current status (for example the Provider's), shown next to Refresh in the sheet. */
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
  accountsOnly?: boolean;

}>) {
  const profile = useProfile();
  const { present } = useConnectedAccountIdentityPrivacy();
  const locale = getPreferredLanguage();
  const labelsByKey = useConnectedMetadataCatalog(undefined, selectConnectedMetadataLabels);
  const pathname = usePathname();
  const focusedRegistry = useProjectedConnectedServicesRegistry();
  const registry = props.registry ?? focusedRegistry;
  // Refresh also re-reads the descriptors of the registry this chooser follows; an explicit
  // registry is another scope's snapshot and is never reloaded as a substitute.
  const { reloadConnectedAccountProjection } = useAppShellPluginUiProjection();
  const reloadDescriptors = props.registry ? undefined : reloadConnectedAccountProjection;
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
  const reloadingRef = React.useRef(false);
  const accounts = effectiveAccountTransport === 'advertised-v4'
    ? profile.connectedAccountsV4 ?? EMPTY_ACCOUNTS
    : EMPTY_ACCOUNTS;
  const groups = effectiveAccountTransport === 'advertised-v4' && !props.accountsOnly
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
    ...(props.noneLabel ? { noneLabel: props.noneLabel } : {}),
    accounts,
    groups,
    labelsByKey,
    serviceTitle,
    sourceNegotiation: effectiveAccountTransport,
    descriptorsLoading: registry.status === 'loading',
    presentIdentity: present,
    resolveAuthentication: service => getConnectedAccountAuthentication(service, registry),
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
    props.noneLabel,
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
    ? (props.accountsOnly ? t('connectedServices.purposeTargets.requiredAccountPrompt') : t('connectedServices.purposeTargets.requiredPrompt'))
    : null;
  const triggerStatus = props.disabledReason
    ?? unresolvedSourceLabel
    ?? selected?.presentation.unavailableReason
    ?? (selectedTargetAccessibilityLabel ? null : requiredUnsetLabel ?? t('common.unavailable'));
  const triggerDetail = unreadSelectionReason
    ?? selected?.presentation.primaryLabel
    ?? unresolvedSourceLabel
    ?? requiredUnsetLabel
    ?? t('common.unavailable');
  const triggerAccessibilityLabel = [
    purposeTitle,
    selected?.presentation.unavailableReason ? selected.presentation.accessibilityLabel : selectedTargetAccessibilityLabel,
    selected?.presentation.unavailableReason ? null : triggerStatus,
  ].filter((label): label is string => label !== null).join(' · ');

  const rootStep = React.useMemo<SelectionListStep>(() => ({
    id: 'connected-account-purpose-targets',
    // It chooses accounts and pools, not models.
    inputPlaceholder: t('common.search'),
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
  const onReload = props.onReload;
  // Refresh is offered when there is something to re-read: the owner's reload or the followed descriptors.
  const canReload = Boolean(onReload || reloadDescriptors);
  const reload = React.useCallback(async () => {
    if (!canReload || reloadingRef.current) return;
    reloadingRef.current = true;
    setReloading(true);
    try {
      reloadDescriptors?.();
      await onReload?.();
    } finally {
      reloadingRef.current = false;
      setReloading(false);
    }
  }, [canReload, onReload, reloadDescriptors]);
  // Consumers pass inline handlers; the open sheet updates only when what it shows changes.
  const onChangeRef = React.useRef(props.onChange);
  onChangeRef.current = props.onChange;
  // The open sheet reads the same choices as the row: a reload (or any upstream change) refreshes it
  // in place instead of leaving a stale list on screen.
  const pickerProps = React.useMemo((): Omit<ConnectedAccountPurposeTargetPickerModalContentProps, 'onClose'> => ({
    rootStep,
    selectedOptionId: selected?.selectable ? selected.id : null,
    accessibilityLabel: purposeTitle,
    testID: props.testID,
    refresh: canReload
      ? {
          ...(props.reloadSubtitle ? { status: props.reloadSubtitle } : {}),
          refreshing: reloading,
          onRefresh: () => void reload(),
        }
      : null,
    onSelect: (id) => {
      // The sheet closed itself before selecting; it no longer takes updates.
      pickerModalIdRef.current = null;
      const choice = choices.find((candidate) => candidate.id === id);
      if (choice?.selectable) onChangeRef.current(choice.target, choice.teamResource);
    },
  }), [canReload, choices, props.reloadSubtitle, props.testID, purposeTitle, reload, reloading, rootStep, selected]);
  React.useEffect(() => {
    if (pickerModalIdRef.current) Modal.update(pickerModalIdRef.current, pickerProps);
  }, [pickerProps]);
  const openPicker = React.useCallback(() => {
    if (props.disabled) return;
    closePicker();
    pickerModalIdRef.current = Modal.show({
      component: ConnectedAccountPurposeTargetPickerModalContent,
      props: pickerProps,
      chrome: {
        kind: 'card',
        title: purposeTitle,
        testID: `${props.testID}:modal`,
        ...SELECTION_LIST_MODAL_CARD_SCROLL,
      },
      closeOnBackdrop: true,
      onRequestClose: () => { pickerModalIdRef.current = null; },
    });
  }, [closePicker, pickerProps, props.disabled, props.testID, purposeTitle]);

  // This screen can stay mounted behind another Settings route while its picker
  // remains portaled. Route ownership and unmount both close it.
  React.useEffect(() => {
    closePicker();
    return closePicker;
  }, [closePicker, pathname]);

  // On a configuration page a choice from a list is the shared bordered field select (the same one
  // DropdownMenu draws), holding the value and a pool's mark; grouped surfaces keep the value row.
  const { theme } = useUnistyles();
  const pageField = useListPresentation() === 'page';
  // Only a saved target that no longer exists is a wrong value; a target the user can repair (add or
  // reconnect an account) keeps the ordinary field and says what fixes it in the warning line below.
  const fieldColors = React.useMemo(
    () => (pageField ? resolveFieldBoxColors(theme, selected?.presentation.unavailableReasonCode === 'targetMissing' ? 'invalid' : 'idle') : undefined),
    [pageField, selected?.presentation.unavailableReasonCode, theme],
  );
  const subtitle = triggerStatus ?? selected?.presentation.summaryLabel ?? props.description;
  // What repairs a saved target that cannot serve (D14) reads as needing the user.
  const subtitleNeedsYou = Boolean(selected?.presentation.unavailableReason) && subtitle === triggerStatus;
  return (
    <Item
      testID={props.testID}
      icon={props.icon}
      title={purposeTitle}
      subtitle={subtitle}
      subtitleLines={props.description || subtitleNeedsYou ? 0 : undefined}
      subtitleStyle={subtitleNeedsYou ? { color: theme.colors.state.warning.foreground } : undefined}
      detail={fieldColors ? undefined : triggerDetail}
      rightElement={fieldColors ? renderDropdownItemTriggerRightElement({
        detail: triggerDetail,
        open: false,
        detailColor: theme.colors.text.secondary,
        chevronColor: theme.colors.text.secondary,
        field: fieldColors,
        fieldSpan: 'column',
        leading: selected?.kind === 'group'
          ? <Icon name="stack" size={14} color={theme.colors.text.secondary} />
          : undefined,
      }) : undefined}
      accessoryLayout={fieldColors ? 'adaptive' : undefined}
      fieldAccessory={fieldColors ? true : undefined}
      accessibilityLabel={triggerAccessibilityLabel}
      showChevron={!fieldColors}
      disabled={props.disabled}
      onPress={props.disabled ? undefined : openPicker}
    />
  );
}
