import * as React from 'react';
import { resolveSelectionListModalHeightBehavior, SELECTION_LIST_MODAL_CARD_SCROLL, SELECTION_LIST_MODAL_MAX_HEIGHT } from '@/components/ui/selectionList/selectionListModalPresentation';
import type { PopoverAnchor } from '@/components/ui/popover';

import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';

import type { ConnectedServicesSelectionOptionAvailability } from '@/components/sessions/new/components/buildNewSessionConnectedServicesSelectionListModel';
import {
  NewSessionConnectedServicesSelectionContent,
  type NewSessionConnectedServicesSelectionContentProps,
} from '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent';
import { useActionSettingsNarrowLayout } from '@/components/settings/actions/useActionSettingsNarrowLayout';
import { useProjectedConnectedServicesRegistry } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';

import {
  resolveConnectedServiceDisplayName,
  resolveQualifiedConnectedServiceRegistryDisplayName,
} from './model/resolveConnectedServiceDisplayName';
import {
  resolveConnectedServicesAuthLabel,
  resolveConnectedServicesAuthWarningTranslationKey,
  type ConnectedServicesAuthWarningCode,
} from './model/resolveConnectedServicesAuthLabel';


type SelectionContentProps = NewSessionConnectedServicesSelectionContentProps;

export type ConnectedServicesBindingRowProps = Readonly<{
  testID: string;
  title: string;
  /** What the row is for; on a phone the current answer takes its place. */
  description: string;
  modalTitle: string;
  modalTestID: string;
  supportedServiceIds: SelectionContentProps['supportedServiceIds'];
  profileOptionsByServiceId: SelectionContentProps['profileOptionsByServiceId'];
  groupOptionsByServiceId: SelectionContentProps['groupOptionsByServiceId'];
  bindingsByServiceId: Readonly<
    Record<string, ConnectedServicesServiceBinding | undefined>
  >;
  defaultProfileIdByServiceId: Readonly<Record<string, string | undefined>>;
  accountGroupsEnabled: boolean;
  /** `next` is every binding the card now shows, this pick included. */
  setBindingForService: (
    serviceId: string,
    binding: ConnectedServicesServiceBinding,
    next: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>,
  ) => void;
  /** Opens the service's own setup; the card closes first. */
  onOpenSettings: (serviceId: string, anchor?: PopoverAnchor) => void;
  includeNativeAuthOption?: boolean;
  allowDefaultProfileFallback?: boolean;
  teamCredentialResources?: SelectionContentProps['teamCredentialResources'];
  teamCredentialResourceStatusByKey?: SelectionContentProps['teamCredentialResourceStatusByKey'];
  teamNameById?: SelectionContentProps['teamNameById'];
  onRecoverTeamCredentialResource?: SelectionContentProps['onRecoverTeamCredentialResource'];
  /** Said instead of the answer while no service is connected: bindings not readable yet, or none stored where "none" is the answer. */
  fallbackLabel?: string;
  disabled?: boolean;
  /** Runs as the card opens; returning false keeps it closed. */
  onBeforeOpen?: () => boolean;
  /** Inventory owners mount their live detail subscriptions inside the open card. */
  renderSelectionContent?: (props: SelectionContentProps) => React.ReactNode;
}>;

export function resolveConnectedServicesBindingWarningLabel(
  warningCode: ConnectedServicesAuthWarningCode | undefined,
): string | undefined {
  const key = resolveConnectedServicesAuthWarningTranslationKey(warningCode);
  return key ? t(key) : undefined;
}

/**
 * The connected-services binding row and its card: one answer for "which sign-in does this use",
 * shared by Agent defaults and Voice. Callers own what a selection persists to.
 */
export function ConnectedServicesBindingRow(
  props: ConnectedServicesBindingRowProps,
) {
  const connectedServicesRegistry = useProjectedConnectedServicesRegistry();
  const narrowLayout = useActionSettingsNarrowLayout();

  const authLabelModel = resolveConnectedServicesAuthLabel({
    supportedServiceIds: props.supportedServiceIds,
    bindingsByServiceId: props.bindingsByServiceId,
    profileOptionsByServiceId: props.profileOptionsByServiceId,
    accountGroupOptionsByServiceId: props.groupOptionsByServiceId,
    accountGroupsEnabled: props.accountGroupsEnabled,
    defaultProfileIdByServiceId: props.defaultProfileIdByServiceId,
    resolveServiceTitle: (serviceId) => {
      const service = parseQualifiedPluginContributionKey(serviceId);
      return service
        ? resolveQualifiedConnectedServiceRegistryDisplayName(
            connectedServicesRegistry,
            service,
            t,
          )
        : resolveConnectedServiceDisplayName(
            serviceId as ConnectedServiceId,
            t,
          );
    },
    // The card calls this answer "Its own sign-in"; the row says the same words.
    nativeLabel: t('connectedServices.authModal.nativeAuthTitle'),
    formatConnectedCountLabel: (count) =>
      t('connectedServices.authChip.connectedCountLabel', { count }),
  });
  // Bindings that cannot be written still name a connected answer they already hold.
  const unavailable =
    props.fallbackLabel !== undefined && authLabelModel.connectedCount === 0;
  const warningLabel = unavailable
    ? undefined
    : resolveConnectedServicesBindingWarningLabel(
        authLabelModel.warningCodes[0],
      );
  const answer = unavailable ? props.fallbackLabel : authLabelModel.label;

  const resolveOptionAvailability = React.useCallback(
    (
      params: Readonly<{
        serviceId: string;
        optionId: string;
        binding: ConnectedServicesServiceBinding;
      }>,
    ): ConnectedServicesSelectionOptionAvailability => {
      const state = authLabelModel.serviceStatesById[params.serviceId];
      // The shared selection builder owns Team resource currentness and recovery; this only
      // says why the native answer is in effect.
      if (
        state?.warningCode &&
        params.optionId ===
          `connected-service:${encodeURIComponent(params.serviceId)}:native`
      ) {
        return {
          subtitle: resolveConnectedServicesBindingWarningLabel(
            state.warningCode,
          ),
        };
      }
      return {};
    },
    [authLabelModel.serviceStatesById],
  );

  const pickerModalIdRef = React.useRef<string | null>(null);
  const closePicker = React.useCallback(() => {
    if (!pickerModalIdRef.current) return;
    Modal.hide(pickerModalIdRef.current);
    pickerModalIdRef.current = null;
  }, []);
  React.useEffect(() => closePicker, [closePicker]);
  React.useEffect(() => {
    if (props.disabled) closePicker();
  }, [closePicker, props.disabled]);

  const openPicker = () => {
    if (props.disabled) return;
    if (props.onBeforeOpen && !props.onBeforeOpen()) return;
    closePicker();
    pickerModalIdRef.current = Modal.show({
      component: ConnectedServicesBindingPickerModalContent,
      props: {
        supportedServiceIds: props.supportedServiceIds,
        profileOptionsByServiceId: props.profileOptionsByServiceId,
        groupOptionsByServiceId: props.groupOptionsByServiceId,
        initialBindingsByServiceId: props.bindingsByServiceId,
        teamCredentialResources: props.teamCredentialResources,
        teamCredentialResourceStatusByKey:
          props.teamCredentialResourceStatusByKey,
        teamNameById: props.teamNameById,
        onRecoverTeamCredentialResource: props.onRecoverTeamCredentialResource,
        setBindingForService: props.setBindingForService,
        defaultProfileIdByServiceId: props.defaultProfileIdByServiceId,
        includeNativeAuthOption: props.includeNativeAuthOption,
        allowDefaultProfileFallback: props.allowDefaultProfileFallback,
        resolveOptionAvailability,
        onOpenSettings: props.onOpenSettings,
        renderSelectionContent: props.renderSelectionContent,
      },
      chrome: {
        kind: 'card',
        title: props.modalTitle,
        testID: props.modalTestID,
        // The modal owner's card scroll: the card keeps to its rows, up to its cap.
        ...SELECTION_LIST_MODAL_CARD_SCROLL,
      },
      closeOnBackdrop: true,
    });
  };

  return (
    <Item
      testID={props.testID}
      title={props.title}
      // A phone has no room beside the title for the answer, so it takes the description's place.
      subtitle={
        narrowLayout
          ? (warningLabel ?? answer)
          : (warningLabel ?? props.description)
      }
      detail={narrowLayout ? undefined : answer}
      disabled={props.disabled}
      showChevron={true}
      onPress={openPicker}
    />
  );
}

type ConnectedServicesBindingPickerModalContentProps = Readonly<{
  onClose: () => void;
  initialBindingsByServiceId: Readonly<
    Record<string, ConnectedServicesServiceBinding | undefined>
  >;
  setBindingForService: ConnectedServicesBindingRowProps['setBindingForService'];
  renderSelectionContent?: ConnectedServicesBindingRowProps['renderSelectionContent'];
}> &
  Omit<
    SelectionContentProps,
    'requestClose' | 'maxHeight' | 'bindingsByServiceId' | 'setBindingForService'
  >;

function ConnectedServicesBindingPickerModalContent(
  props: ConnectedServicesBindingPickerModalContentProps,
) {
  const {
    onClose,
    onOpenSettings,
    initialBindingsByServiceId,
    setBindingForService,
    renderSelectionContent,
    ...contentProps
  } = props;
  // The card shows each pick at once; the caller persists it. Persisting is an effect, so the next
  // value is derived from a ref in the event, never inside a state updater React may replay.
  const [bindingsByServiceId, setBindingsByServiceId] = React.useState(
    initialBindingsByServiceId,
  );
  const bindingsRef = React.useRef(bindingsByServiceId);
  bindingsRef.current = bindingsByServiceId;
  const handleSetBinding = React.useCallback(
    (serviceId: string, binding: ConnectedServicesServiceBinding) => {
      const next = { ...bindingsRef.current, [serviceId]: binding };
      bindingsRef.current = next;
      setBindingsByServiceId(next);
      setBindingForService(serviceId, binding, next);
    },
    [setBindingForService],
  );
  const handleOpenSettings = React.useCallback(
    (serviceId: string, anchor?: PopoverAnchor) => {
      onClose();
      onOpenSettings(serviceId, anchor);
    },
    [onClose, onOpenSettings],
  );

  const selectionProps: SelectionContentProps = {
      ...contentProps,
      bindingsByServiceId,
      setBindingForService: handleSetBinding,
      onOpenSettings: handleOpenSettings,
      requestClose: onClose,
      maxHeight: SELECTION_LIST_MODAL_MAX_HEIGHT,
      heightBehavior: resolveSelectionListModalHeightBehavior(),
  };
  return renderSelectionContent ? renderSelectionContent(selectionProps) : (
    <NewSessionConnectedServicesSelectionContent {...selectionProps} />
  );
}
