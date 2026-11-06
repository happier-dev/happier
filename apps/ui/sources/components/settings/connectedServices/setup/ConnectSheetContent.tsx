import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierBodyEdgeContext } from '@happier-dev/plugin-ui/presentation';

import {
  RoundButton,
  RoundButtonSizeScope,
} from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { presentConnectedAccountNames } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { t } from '@/text';

import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';

import { ConnectedServiceMark } from '../ConnectedServiceMark';
import { ConnectedAccountActionApprovalNotice } from '../ConnectedAccountActionApprovalNotice';
import { ConnectedAccountPurposeTargetChooser } from '../account/ConnectedAccountPurposeTargetChooser';
import { resolveConnectedAccountCredentialStatusLabel } from '../account/connectedAccountCredentialStatusLabel';
import {
  ConnectedServiceSetupPanel,
  presentConnectedServiceSetupHeading,
} from './ConnectedServiceSetupPanel';
import type {
  ConnectSheetAccountRequest,
  ConnectSheetKeyRequest,
  ConnectSheetContentProps,
} from './ConnectedServiceSetupModal';
import { useConnectAccountSheetModel } from './useConnectAccountSheetModel';
import { useConnectSheetHeading } from './useConnectSheetHeading';

import { ConnectKeySheetBody } from './ConnectKeySheetBody';

import { isConnectSheetKeyRequest } from './connectSheetOpening';

import { useConnectKeySheetModel } from './useConnectKeySheetModel';

type SheetMode = 'new' | 'saved';

/** New | Saved, shown only when there is something saved to pick. */
function SheetModeSwitch(
  props: Readonly<{
    mode: SheetMode;
    newLabel: string;
    savedLabel: string;
    onChange: (mode: SheetMode) => void;
  }>,
) {
  const tabs = React.useMemo(
    () => [
      { id: 'new' as const, label: props.newLabel },
      { id: 'saved' as const, label: props.savedLabel },
    ],
    [props.newLabel, props.savedLabel],
  );
  return (
    <SegmentedTabBar
      role="radiogroup"
      labelSize="field"
      segmentSizing="equal"
      accessibilityLabel={t('connectedServicesSetup.keyHowToAdd')}
      tabs={tabs}
      activeTabId={props.mode}
      onSelectTab={props.onChange}
      testIDPrefix="connect-sheet:mode"
    />
  );
}

function ConnectKeySheetLeaf(
  props: ConnectSheetContentProps &
    Readonly<{ request: ConnectSheetKeyRequest }>,
) {
  const { theme } = useUnistyles();
  const model = useConnectKeySheetModel(props.request);
  const suggestedName = props.request.service.suggestedName;
  // A key asked for by something (a provider, a field) is "Add a key"; Credentials' own "+" is a new secret.
  const requested = Boolean(
    props.request.bindingTarget ||
      props.request.current !== undefined ||
      props.request.service.keyKind,
  );
  useConnectSheetHeading(props, {
    title:
      suggestedName ??
      (requested
        ? t('connectedServicesSetup.keyTitle')
        : t('connectedServicesCollection.newSecret')),
    subtitle: '',
    leading: <Icon name="key" size={18} color={theme.colors.text.secondary} />,
    leadingKey: 'key',
    bodyScroll: 'none',
  });
  return (
    <View style={[styles.frame, styles.bounded]}>
      <ConnectKeySheetBody
        catalog={model.catalog}
        linkableEntries={model.linkableEntries}
        initialMode={model.initialMode}
        preselected={model.preselected}
        loading={model.loading}
        scope={props.request.scope ?? null}
        currentRef={props.request.current ?? null}
        sameTargetRefs={model.sameTargetRefs}
        suggestedName={suggestedName}
        submitLabel={requested ? t('connectedServicesSettings.keySave') : undefined}
        onResult={props.onResult}
        onCancel={() => props.onResult({ kind: 'dismissed' })}
      />
    </View>
  );
}

function ConnectAccountSheetLeaf(
  props: ConnectSheetContentProps &
    Readonly<{ request: ConnectSheetAccountRequest }>,
) {
  const { theme } = useUnistyles();
  const model = useConnectAccountSheetModel(props.request, props.onResult);
  const target = model.target;
  const selectedEntry =
    target.kind === 'catalog'
      ? null
      : (model.catalog.find(
          (entry) => entry.serviceKey === target.serviceKey,
        ) ?? null);
  const { title, purpose } = presentConnectedServiceSetupHeading({
    selected: selectedEntry,
    targetKind: target.kind,
    scope: 'all',
    chrome: 'sheet',
  });

  // A purpose request (a configurator's account row) chooses through the existing purpose chooser and
  // its reconnect rows, the same composition the setup page leads with; the selection resolves the sheet.
  const { purposeSetup } = model;
  const purposeRequest = props.request.purposeRequest;
  const { present } = useConnectedAccountIdentityPrivacy();
  const purposeChoosers =
    purposeRequest && purposeSetup.declaration
      ? purposeSetup.selectableServices.map((service) => (
          <ConnectedAccountPurposeTargetChooser
            key={`${service.pluginId}/${service.localId}`}
            testID={`connected-account-purpose:${service.pluginId}/${service.localId}`}
            registry={purposeSetup.registry}
            localizedTextPluginId={purposeRequest.purpose.consumer.pluginId}
            declaration={{
              purpose: purposeRequest.purpose.purpose,
              service,
              required: true,
            }}
            value={purposeSetup.selected}
            disabled={purposeSetup.selectionDisabled}
            disabledReason={purposeSetup.selectionDisabledReason}
            onChange={(next) => {
              void purposeSetup.select(next);
            }}
          />
        ))
      : [];
  const purposeReconnectRows = purposeRequest
    ? purposeSetup.reconnectAccounts.map((account) => {
        const identity = present({
          label: account.displayName,
          email: account.providerIdentity?.email,
          accountId: account.ref.accountId,
        });
        const serviceKey = buildQualifiedPluginContributionKey(account.ref.service);
        return (
          <Item
            key={`${serviceKey}:${account.ref.accountId}`}
            testID={`connected-account-purpose-reconnect:${serviceKey}:${account.ref.accountId}`}
            title={t('connectedServices.detail.actions.reconnect')}
            subtitle={identity.label ?? identity.email ?? identity.accountId ?? undefined}
            onPress={() => model.setTarget({ kind: 'reconnect', serviceKey, accountId: account.ref.accountId })}
          />
        );
      })
    : [];

  // A repair names its account and runs its sign-in; adding offers the accounts already here first.
  const repair = target.kind === 'reconnect';
  const canPick =
    !repair &&
    (purposeRequest
      ? purposeChoosers.length + purposeReconnectRows.length > 0
      : target.kind !== 'catalog' && model.savedAccounts.length > 0);
  const [chosenMode, setChosenMode] = React.useState<SheetMode | null>(null);
  const mode: SheetMode = canPick ? (chosenMode ?? model.initialMode) : 'new';
  const [chosenAccountId, setChosenAccountId] = React.useState<string | null>(
    null,
  );
  const selectedAccountId = chosenAccountId ?? model.preselected?.accountId ?? null;

  const serviceTitle =
    selectedEntry?.label ?? t('connectedServices.fallbackName');
  const names = React.useMemo(
    () =>
      presentConnectedAccountNames(
        model.savedAccounts.map((profile) => ({
          key: profile.ref.accountId,
          serviceTitle,
          displayName: profile.displayName ?? null,
          email: profile.providerIdentity?.email ?? null,
          providerAccountId: profile.providerIdentity?.accountId ?? null,
          accountId: profile.ref.accountId,
        })),
      ),
    [model.savedAccounts, serviceTitle],
  );
  const chosen =
    model.savedAccounts.find(
      (profile) => profile.ref.accountId === selectedAccountId,
    ) ?? null;
  const repairAccount =
    target.kind === 'reconnect'
      ? (model.savedAccounts.find(
          (profile) => profile.ref.accountId === target.accountId,
        ) ?? null)
      : null;
  const repairName = repairAccount
    ? names.get(repairAccount.ref.accountId)
    : null;

  // The machine a sign-in runs on: chosen here, so the band can show it beside the title (lab crConnect),
  // and handed to the sign-in below. Read only while the chosen method needs a machine (58c).
  const targetSelection = model.targetSelection;
  const showTargetSelector = mode === 'new' && (model.machineRequired || model.target.kind === 'catalog');
  const machineChip = React.useMemo(() => showTargetSelector ? (
    <MachineAdministrationTargetSelector
      selection={targetSelection}
      resolveCandidateAvailability={model.machineAvailability}
      disabled={Boolean(purposeRequest)}
      presentation="chip"
      testIDPrefix="connected-service-setup-target"
    />
  ) : null, [showTargetSelector, purposeRequest, targetSelection, model.machineAvailability]);

  // A repair names its account once, as the band's quiet second line under "Sign in to … again" (owner 11-01):
  // who it is, never a card of its own.
  const repairLine = repairAccount
    ? [repairName?.primaryLabel ?? serviceTitle, repairName?.identityLabel].filter(Boolean).join(' · ')
    : '';
  useConnectSheetHeading(props, {
    title,
    subtitle: target.kind === 'reconnect' ? repairLine : purpose,
    leading: selectedEntry ? (
      <ConnectedServiceMark
        legacyServiceId={selectedEntry.legacyServiceId}
        size="row"
      />
    ) : (
      <Icon name="plug" size={18} color={theme.colors.text.secondary} />
    ),
    leadingKey: selectedEntry?.serviceKey ?? 'catalog',
    actions: machineChip,
  });

  if (model.unavailableReason) {
    return (
      <View style={styles.frame}>
        <SurfaceStateCard
          testID="connect-sheet:unavailable"
          size="line"
          kind="unavailable"
          title={t(model.unavailableReason === 'purpose_unavailable' ? 'connectedServicesSetup.sheetPurposeUnavailable'
            : model.unavailableReason === 'purpose_requires_selection' ? 'connectedServicesSetup.sheetSelectionRequired'
            : model.unavailableReason === 'profile_account_mismatch' ? 'connectedServicesSetup.sheetProfileUnavailable'
            : 'connectedServicesSetup.sheetUnavailable')}
          diagnosticCode={model.unavailableReason}
        />
      </View>
    );
  }
  return (
    // The sheet draws its own content edge: a state line (a sign-in that could not load) stands on it, its
    // glyph under the band's text edge and its Retry on the sheet's end, like the storage line under it.
    <HappierBodyEdgeContext.Provider value>
    <View style={[styles.frame, styles.body]} testID="connect-sheet:account">
      {/* A host without the sheet's band (an embedding with no chrome) keeps the machine at the body's top. */}
      {props.setChrome ? null : machineChip}
      <ConnectedAccountActionApprovalNotice
        execution={purposeSetup.execution}
        testID="connect-sheet:approval-pending"
      />
      {canPick ? (
        <SheetModeSwitch
          mode={mode}
          newLabel={t('connectedServicesSetup.accountNew')}
          savedLabel={t('connectedServicesSetup.accountSaved')}
          onChange={setChosenMode}
        />
      ) : null}
      {mode === 'new' ? (
        <ConnectedServiceSetupPanel
          testID="connected-service-setup-modal"
          chrome="sheet"
          target={target}
          catalog={model.catalog}
          onTargetChange={model.setTarget}
          onClose={model.close}
          onConnected={(account) => model.onConnected(account)}
          targetSelection={targetSelection}
          initialMachineTarget={props.request.initialMachineTarget}
          onMachineRequirementChange={model.onMachineRequirementChange}
          registry={purposeSetup.registry}
          targetLocked={Boolean(purposeRequest)}
        />
      ) : purposeRequest ? (
        <View style={styles.rows} testID="connect-sheet:purpose">
          {purposeReconnectRows.length > 0 ? (
            <ItemGroup>{purposeReconnectRows}</ItemGroup>
          ) : null}
          {purposeChoosers.length > 0 ? (
            <ItemGroup>{purposeChoosers}</ItemGroup>
          ) : null}
        </View>
      ) : (
        <>
          <View
            accessibilityRole="radiogroup"
            style={styles.rows}
            testID="connect-sheet:saved"
          >
            {model.savedAccounts.map((profile) => {
              const name = names.get(profile.ref.accountId);
              const signedOut = profile.status === 'needs_reauth';
              return (
                <SelectableRow
                  key={profile.ref.accountId}
                  testID={`connect-sheet:saved:${profile.ref.accountId}`}
                  presentation="menu"
                  accessibilityRole="radio"
                  selected={profile.ref.accountId === selectedAccountId}
                  disabled={signedOut}
                  left={
                    <ConnectedServiceMark
                      legacyServiceId={selectedEntry?.legacyServiceId ?? null}
                      size="row"
                    />
                  }
                  title={name?.primaryLabel ?? serviceTitle}
                  subtitle={
                    signedOut
                      ? resolveConnectedAccountCredentialStatusLabel(profile.status, profile.statusReason)
                      : (name?.identityLabel ?? undefined)
                  }
                  onPress={() => setChosenAccountId(profile.ref.accountId)}
                />
              );
            })}
          </View>
          <RoundButtonSizeScope size="normal" presentation="uniform">
            <View style={styles.actions}>
              <RoundButton
                testID="connect-sheet:cancel"
                display="secondary"
                title={t('common.cancel')}
                onPress={model.close}
              />
              <RoundButton
                testID="connect-sheet:use"
                title={
                  chosen
                    ? t('connectedServicesSetup.keyUse', {
                        name:
                          names.get(chosen.ref.accountId)?.primaryLabel ??
                          serviceTitle,
                      })
                    : t('connectedServicesSetup.accountSaved')
                }
                disabled={!chosen || chosen.status === 'needs_reauth'}
                onPress={() => {
                  if (chosen) model.onSelected(chosen.ref);
                }}
              />
            </View>
          </RoundButtonSizeScope>
        </>
      )}
    </View>
    </HappierBodyEdgeContext.Provider>
  );
}

/**
 * The inside of the one Connect sheet (presenter: `presentConnectSheet`). A key request gets New key |
 * Saved key; a service request gets its accounts and its sign-in (the setup panel's flow). The request
 * kind is fixed for the sheet's life, so each kind is its own leaf.
 */
export function ConnectSheetContent(props: ConnectSheetContentProps) {
  const request = props.request;
  if (isConnectSheetKeyRequest(request))
    return <ConnectKeySheetLeaf {...props} request={request} />;
  return <ConnectAccountSheetLeaf {...props} request={request} />;
}

const styles = StyleSheet.create((theme) => ({
  // The card's band and footer own their inset; the body takes the same edge.
  frame: {
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s4,
    paddingBottom: theme.space.s16,
  },
  body: {
    gap: theme.space.s16,
  },
  // The sheet bounds the key body's height; its list scrolls inside, under the pinned mode switch.
  bounded: {
    flexShrink: 1,
    minHeight: 0,
  },
  rows: {
    gap: theme.space.s2,
    marginHorizontal: -theme.space.s8,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: theme.space.s8,
  },
}));
