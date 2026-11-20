import * as React from 'react';
import { View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { storage } from '@/sync/domains/state/storageStore';
import { getConnectedMetadataCatalog, subscribeConnectedMetadataCatalog } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';

import type {
  AgentConnectedAccountPurposeTeamResourceDefault} from '@happier-dev/protocol/account/settings/connected-services';
import type {
  PluginContributionIdentityV1} from '@happier-dev/protocol/plugins/contribution-identity';
import type {
  PluginLocalizedStringV2} from '@happier-dev/protocol/plugins/contributions/public-types';
import type {
  QualifiedConnectedAccountPurposeBindingTargetV1,
} from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';

import {
  SELECTION_LIST_MODAL_CARD_SCROLL,
  SelectionList,
  resolveSelectionListModalHeightBehavior,
  type SelectionListStep,
    SELECTION_LIST_MODAL_MAX_HEIGHT,
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
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { selectConnectedMetadataLabels, useConnectedMetadataCatalog } from '@/hooks/server/connectedServices/useConnectedMetadataCatalog';
import type { HomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { getPreferredLanguage, t } from '@/text';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';

import {
  buildConnectedAccountPurposeTargetChoices,
  resolveSelectedConnectedAccountPurposeTargetChoice,
  type ConnectedAccountPurposeTargetChoicesInput,
} from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';

const SUMMARY_ACCOUNT_PROFILE_KEYS = ['connectedAccountsV4'] as const;
const SUMMARY_GROUP_PROFILE_KEYS = ['connectedAccountsV4', 'connectedAccountGroupsV4'] as const;
const SUMMARY_NO_PROFILE_KEYS = [] as const;

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

function usePurposeTargetProfile(
  transport: ConnectedAccountPurposeTargetChoicesInput['sourceNegotiation'],
  accountsOnly?: boolean,
  teamResourcesOnly?: boolean,
) {
  const profileKeys = transport !== 'advertised-v4' || teamResourcesOnly
    ? SUMMARY_NO_PROFILE_KEYS : accountsOnly ? SUMMARY_ACCOUNT_PROFILE_KEYS : SUMMARY_GROUP_PROFILE_KEYS;
  return storage(useShallow(state => ({
    accounts: profileKeys.length > 0 ? state.profile.connectedAccountsV4 ?? EMPTY_ACCOUNTS : EMPTY_ACCOUNTS,
    groups: profileKeys === SUMMARY_GROUP_PROFILE_KEYS ? state.profile.connectedAccountGroupsV4 ?? EMPTY_GROUPS : EMPTY_GROUPS,
  })), { profile: profileKeys });
}

type ConnectedAccountPurposeTargetPickerModalContentProps = Readonly<{
  choiceInput: Omit<ConnectedAccountPurposeTargetChoicesInput, 'accounts' | 'groups' | 'labelsByKey'>;
  accountsOnly?: boolean;
  teamResourcesOnly?: boolean;
  restriction?: Readonly<{ summary: string; sentence: string }>;
  accessibilityLabel: string;
  onSelect: (target: QualifiedConnectedAccountPurposeBindingTargetV1 | null, teamResource: AgentConnectedAccountPurposeTeamResourceDefault | null) => void;
  refresh: PurposeTargetPickerRefresh | null;
  testID: string;
  onClose: () => void;
}>;

function ConnectedAccountPurposeTargetPickerModalContent(
  props: ConnectedAccountPurposeTargetPickerModalContentProps,
) {
  const profile = usePurposeTargetProfile(props.choiceInput.sourceNegotiation, props.accountsOnly, props.teamResourcesOnly);
  const labelsByKey = useConnectedMetadataCatalog(undefined, selectConnectedMetadataLabels);
  const locale = getPreferredLanguage();
  const choices = React.useMemo(() => buildConnectedAccountPurposeTargetChoices({
    ...props.choiceInput,
    ...profile,
    labelsByKey,
  }), [props.choiceInput, profile, labelsByKey]);
  const selected = choices.find(choice => choice.current);
  const rootStep = React.useMemo<SelectionListStep>(() => ({
    id: 'connected-account-purpose-targets',
    ...(props.restriction ? { title: props.restriction.sentence } : {}),
    inputPlaceholder: t('common.search'),
    emptyStateLabel: t('common.unavailable'),
    sections: [{
      kind: 'static',
      id: 'targets',
      options: choices.map(choice => ({
        id: choice.id,
        testID: `${props.testID}:choice:${choice.id}`,
        label: choice.presentation.primaryLabel,
        ...(choice.presentation.secondaryLabel ? { subtitle: choice.presentation.secondaryLabel } : {}),
        accessibilityLabel: choice.presentation.accessibilityLabel,
        disabled: !choice.selectable,
      })),
    }],
  }), [choices, locale, props.restriction, props.testID]);
  return (
    <>
      <SelectionList
        testID="connected-account-purpose-target-picker"
        rootStep={rootStep}
        selectedOptionId={selected?.selectable ? selected.id : null}
        listAccessibilityLabel={props.accessibilityLabel}
        maxHeight={SELECTION_LIST_MODAL_MAX_HEIGHT}
        heightBehavior={resolveSelectionListModalHeightBehavior()}
        keyboardHintsEnabled
        onRequestClose={props.onClose}
        onSelect={(optionId) => {
          props.onClose();
          const choice = choices.find(candidate => candidate.id === optionId);
          if (choice?.selectable) props.onSelect(choice.target, choice.teamResource);
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
  /** Injected by `ItemGroup` (or the section composing the rows) and drawn by the row. */
  showDivider?: boolean;
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
  /** Accept the sole eligible choice as the initial value after the inventory settles. */
  onSelectSingleEligible?: (target: QualifiedConnectedAccountPurposeBindingTargetV1 | null,
    teamResource: AgentConnectedAccountPurposeTeamResourceDefault | null) => void;
  disabled?: boolean;
  disabledReason?: string;
  /** The row's label when the surface names what the choice decides ("Sign in with") rather than the purpose. */
  title?: string;
  /** The identity mark of what this purpose draws on (a service), in the row's leading column. */
  icon?: React.ReactNode;
  /** What the current choice means here, said when the row has no state of its own to report. */
  description?: string;
  /**
   * What this purpose can serve here when it is restricted (a gateway family): `summary` ends the row's
   * line 2 ("chat requests only"), `sentence` opens the picker. Words from the declaring owner, never parsed.
   */
  restriction?: Readonly<{ summary: string; sentence: string }>;
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
    'resources' | 'displayNames' | 'teamNameById' | 'resourceStatusByKey'
  >;
  /** The consumer stores one exact account, never a pool: offer accounts only. */
  accountsOnly?: boolean;
  /**
   * The choice is made for other people (a Team's defaults for its members), so the
   * viewer's own accounts and pools are not offered: only Team resources, or none.
   */
  teamResourcesOnly?: boolean;
}>) {
  const profileId = storage(state => state.profile.id, { profile: ['id'] });
  const { present } = useConnectedAccountIdentityPrivacy();
  const locale = getPreferredLanguage();
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
  const activeServer = useActiveServerSnapshot();
  const metadataScope = useActiveServerAccountScope(activeServer.serverId);
  // A feature bit only proves the transport is understood. The profile owner
  // proves whether the qualified target arrays belong to the current Account;
  // its default empty profile must remain indeterminate until that owner has
  // hydrated (or a cached profile is demonstrably for the active Account).
  const profileHydrated = typeof profileId === 'string'
    && Boolean(activeAccountScope?.accountId)
    && profileId.trim() === activeAccountScope?.accountId;
  const effectiveAccountTransport = accountTransport === 'advertised-v4' && !profileHydrated
    ? 'indeterminate'
    : accountTransport;
  const pickerModalIdRef = React.useRef<string | null>(null);
  const [reloading, setReloading] = React.useState(false);
  const reloadingRef = React.useRef(false);
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
  const choiceInput = React.useMemo(() => ({
    declaration: { ...props.declaration, required: props.declaration.required === true },
    selectedTarget: props.value,
    selectedTeamResource: props.teamResourceValue ?? null,
    ...(props.noneLabel ? { noneLabel: props.noneLabel } : {}),
    serviceTitle,
    sourceNegotiation: effectiveAccountTransport,
    descriptorsLoading: registry.status === 'loading',
    presentIdentity: present,
    resolveAuthentication: (service: PluginContributionIdentityV1) => getConnectedAccountAuthentication(service, registry),
    teamResources,
    teamResourceStatusByKey: teamCatalog?.resourceStatusByKey,
    teamResourceDisplayNames: teamCatalog?.displayNames,
    ...(teamCatalog ? { teamNameById: teamCatalog.teamNameById } : {}),
  }), [props.declaration, props.value, props.teamResourceValue, props.noneLabel, serviceTitle, locale,
    effectiveAccountTransport, registry, present, teamResources, teamCatalog]);
  const { onSelectSingleEligible } = props;
  const selectionMade = React.useRef(false);
  const hasSelection = props.value !== null || Boolean(props.teamResourceValue);
  // The same exact-service eligibility drives both paths. An unrelated Machine's
  // descriptor read can be incomplete while this Account's connection is usable.
  const canPreselect = Boolean(onSelectSingleEligible) && !props.disabled && !hasSelection
    && (props.teamResourcesOnly || effectiveAccountTransport !== 'indeterminate');
  const preselectionProfile = usePurposeTargetProfile(canPreselect ? effectiveAccountTransport : undefined,
    props.accountsOnly, props.teamResourcesOnly);
  React.useEffect(() => {
    if (hasSelection) selectionMade.current = true;
    if (selectionMade.current || !canPreselect || !onSelectSingleEligible) return;
    const eligible = buildConnectedAccountPurposeTargetChoices({
      ...choiceInput, ...preselectionProfile, labelsByKey: {},
    }).filter(choice => choice.selectable && choice.kind !== 'none');
    if (eligible.length !== 1) return;
    const choice = eligible[0]!;
    selectionMade.current = true;
    onSelectSingleEligible(choice.target, choice.teamResource);
  }, [canPreselect, choiceInput, hasSelection, onSelectSingleEligible, preselectionProfile]);
  const selectedInventory = !props.teamResourceValue && effectiveAccountTransport === 'advertised-v4'
    ? props.value?.kind ?? null : null;
  const summaryProfileKeys = selectedInventory === 'group' ? SUMMARY_GROUP_PROFILE_KEYS
    : selectedInventory === 'account' ? SUMMARY_ACCOUNT_PROFILE_KEYS : SUMMARY_NO_PROFILE_KEYS;
  const subscribeSummary = React.useCallback((listener: () => void) => {
    const unsubscribeProfile = summaryProfileKeys.length
      ? storage.subscribe(listener, { profile: summaryProfileKeys }) : () => {};
    const unsubscribeLabels = selectedInventory ? subscribeConnectedMetadataCatalog(listener) : () => {};
    return () => { unsubscribeProfile(); unsubscribeLabels(); };
  }, [selectedInventory, summaryProfileKeys]);
  const selectSummary = useShallow((state: ReturnType<typeof storage.getState>) => {
    const choice = resolveSelectedConnectedAccountPurposeTargetChoice({
      ...choiceInput,
      accounts: selectedInventory !== null && !props.teamResourcesOnly
        ? state.profile.connectedAccountsV4 ?? EMPTY_ACCOUNTS : EMPTY_ACCOUNTS,
      groups: selectedInventory === 'group' && !props.accountsOnly && !props.teamResourcesOnly
        ? state.profile.connectedAccountGroupsV4 ?? EMPTY_GROUPS : EMPTY_GROUPS,
      labelsByKey: getConnectedMetadataCatalog(metadataScope).labelsByKey,
    });
    // Flat presentation values give the store owner a stable selected summary even
    // when another account changes; no closed row retains the option inventory.
    return choice ? { ...choice.presentation, id: choice.id, kind: choice.kind, selectable: choice.selectable } : null;
  });
  const readSummary = React.useCallback(() => selectSummary(storage.getState()), [selectSummary]);
  const summary = React.useSyncExternalStore(subscribeSummary, readSummary, readSummary);
  const selected = summary ? { id: summary.id, kind: summary.kind, selectable: summary.selectable, presentation: summary } : null;
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
  // Inventory and label demand live in the mounted sheet; these props keep its
  // current declaration, selected value and owner-provided recovery in sync.
  const pickerProps = React.useMemo((): Omit<ConnectedAccountPurposeTargetPickerModalContentProps, 'onClose'> => ({
    choiceInput,
    accountsOnly: props.accountsOnly,
    teamResourcesOnly: props.teamResourcesOnly,
    restriction: props.restriction,
    accessibilityLabel: purposeTitle,
    testID: props.testID,
    refresh: canReload
      ? {
          ...(props.reloadSubtitle ? { status: props.reloadSubtitle } : {}),
          refreshing: reloading,
          onRefresh: () => void reload(),
        }
      : null,
    onSelect: (target, teamResource) => {
      pickerModalIdRef.current = null;
      selectionMade.current = true;
      onChangeRef.current(target, teamResource);
    },
  }), [canReload, choiceInput, props.accountsOnly, props.teamResourcesOnly, props.restriction, props.reloadSubtitle, props.testID, purposeTitle, reload, reloading]);
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
  const statusSubtitle = triggerStatus ?? selected?.presentation.summaryLabel ?? props.description;
  // The field already says what the row's status says (the unset prompt, a disabled reason); the row does not repeat it.
  const baseSubtitle = fieldColors && statusSubtitle === triggerDetail ? props.description : statusSubtitle;
  const subtitle = props.restriction
    ? [baseSubtitle, props.restriction.summary].filter(Boolean).join(' · ')
    : baseSubtitle;
  // What repairs a saved target that cannot serve (D14) reads as needing the user.
  const subtitleNeedsYou = Boolean(selected?.presentation.unavailableReason) && baseSubtitle === triggerStatus;
  return (
    <Item
      testID={props.testID}
      showDivider={props.showDivider}
      icon={props.icon}
      title={props.title ?? purposeTitle}
      subtitle={subtitle}
      subtitleLines={props.description || subtitleNeedsYou ? 0 : undefined}
      subtitleStyle={subtitleNeedsYou ? { color: theme.colors.state.warning.textForeground } : undefined}
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
