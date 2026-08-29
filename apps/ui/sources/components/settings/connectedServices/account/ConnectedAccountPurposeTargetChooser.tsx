import * as React from 'react';
import { usePathname } from 'expo-router';

import type {
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
import { useProfile, useSettings } from '@/sync/store/hooks';
import { t } from '@/text';

import {
  buildConnectedAccountPurposeTargetChoices,
  connectedAccountPurposeTargetChoiceId,
} from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';

const PURPOSE_TARGET_PICKER_MAX_HEIGHT = 520;
const EMPTY_ACCOUNTS = Object.freeze([]);
const EMPTY_GROUPS = Object.freeze([]);

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
  onChange: (target: QualifiedConnectedAccountPurposeBindingTargetV1 | null) => void;
  onReload?: () => Promise<void> | void;
  /** Provider's current status, presented by the provider status owner. */
  reloadSubtitle?: string;
}>) {
  const profile = useProfile();
  const settings = useSettings();
  const pathname = usePathname();
  const registry = useProjectedConnectedServicesRegistry();
  const localizePluginText = useProjectedPluginLocalizedTextResolver();
  const serverFeatures = useServerFeaturesRuntimeSnapshot({ enabled: true });
  const accountTransport = resolveConnectedAccountUiNegotiation(serverFeatures);
  const pickerModalIdRef = React.useRef<string | null>(null);
  const [reloading, setReloading] = React.useState(false);
  const accounts = accountTransport === 'advertised-v4'
    ? profile.connectedAccountsV4 ?? EMPTY_ACCOUNTS
    : EMPTY_ACCOUNTS;
  const groups = accountTransport === 'advertised-v4'
    ? profile.connectedAccountGroupsV4 ?? EMPTY_GROUPS
    : EMPTY_GROUPS;
  const serviceTitle = React.useMemo(() => {
    return resolveQualifiedConnectedServiceRegistryDisplayName(
      registry,
      props.declaration.service,
      t,
      localizePluginText,
    );
  }, [localizePluginText, props.declaration.service, registry.entries]);
  const choices = React.useMemo(() => buildConnectedAccountPurposeTargetChoices({
    declaration: { ...props.declaration, required: props.declaration.required === true },
    selectedTarget: props.value,
    accounts,
    groups,
    labelsByKey: settings.connectedServicesProfileLabelByKey,
    serviceTitle,
    sourceNegotiation: accountTransport,
    resolveAuthentication: getConnectedAccountAuthentication,
  }), [
    accounts,
    groups,
    accountTransport,
    props.declaration,
    props.value,
    serviceTitle,
    settings.connectedServicesProfileLabelByKey,
    // The registry is the descriptor/currentness owner for authentication.
    registry,
  ]);
  const selectedId = connectedAccountPurposeTargetChoiceId(props.value);
  const selected = choices.find((choice) => choice.id === selectedId) ?? null;
  const declaredPurposeTitle = props.declaration.title
    ? localizePluginText(props.localizedTextPluginId, props.declaration.title)
    : '';
  const purposeTitle = declaredPurposeTitle || serviceTitle;
  const selectedTargetAccessibilityLabel = selected?.selectable
    ? selected.presentation.accessibilityLabel
    : null;
  const unresolvedSourceLabel = accountTransport === 'indeterminate'
    ? t('common.loading')
    : accountTransport === 'legacy'
      ? t('connectedServices.purposeTargets.legacyUnavailable')
      : null;
  const requiredUnsetLabel = props.value === null && props.declaration.required === true
    ? t('connectedServices.purposeTargets.requiredPrompt')
    : null;
  const triggerStatus = unresolvedSourceLabel
    ?? (selectedTargetAccessibilityLabel ? null : requiredUnsetLabel ?? t('common.unavailable'));
  const triggerDetail = selected?.presentation.primaryLabel
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
  }), [choices, props.testID]);
  const closePicker = React.useCallback(() => {
    if (!pickerModalIdRef.current) return;
    Modal.hide(pickerModalIdRef.current);
    pickerModalIdRef.current = null;
  }, []);
  const openPicker = React.useCallback(() => {
    closePicker();
    pickerModalIdRef.current = Modal.show({
      component: ConnectedAccountPurposeTargetPickerModalContent,
      props: {
        rootStep,
        selectedOptionId: selected?.selectable ? selected.id : null,
        accessibilityLabel: purposeTitle,
        onSelect: (id) => {
          const choice = choices.find((candidate) => candidate.id === id);
          if (choice?.selectable) props.onChange(choice.target);
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
  }, [choices, closePicker, props.onChange, props.testID, purposeTitle, rootStep, selected]);

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
      title={purposeTitle}
      subtitle={triggerStatus ?? undefined}
      detail={triggerDetail}
      accessibilityLabel={triggerAccessibilityLabel}
      showChevron
      onPress={openPicker}
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
