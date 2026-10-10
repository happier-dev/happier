import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type {
  ProviderClaudeHelperModelsV1,
  ProviderConnectionPurposeBindingDefaultsV1,
  ProviderGatewayPlacementV1,
} from '@happier-dev/protocol/providers/connections/v1';
import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import {
  useProjectedConnectedServicesRegistry,
  useProjectedPluginLocalizedTextResolver,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import { ConnectedServiceMark } from '@/components/settings/connectedServices/ConnectedServiceMark';
import { resolveQualifiedConnectedServiceRegistryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { getQualifiedConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { useProfile } from '@/sync/store/hooks';
import { t } from '@/text';

type PurposeDeclaration = NonNullable<
  DaemonProviderConnectionViewV1['managedLocalOption']
>['connectedAccountPurposes'][number];
type HelperRole = keyof ProviderClaudeHelperModelsV1;
type PlacementMode = ProviderGatewayPlacementV1['kind'];

const HELPER_ROLES: readonly HelperRole[] = ['fast', 'default', 'strongest'];
const HELPER_ROLE_TITLE_KEY = {
  fast: 'settingsProvidersCollection.gateway.helperFast',
  default: 'settingsProvidersCollection.gateway.helperDefault',
  strongest: 'settingsProvidersCollection.gateway.helperStrongest',
} as const;
/** The menu id for "no pin": the helper follows the session's model. */
const SAME_AS_SESSION = 'happier:same-as-session';

export type ProviderGatewayMachine = Readonly<{
  machineId: string;
  displayName: string;
  online: boolean;
}>;

/**
 * Whether sessions on the user's other computers can reach the chosen one. Only a real peer
 * observation may say so; until one is projected to the app the row says it has not been checked.
 */
export type ProviderGatewayHubReachability =
  | 'unknown'
  | 'reachable'
  | 'unreachable';

/** The chosen computer as the gateway's page states it; `null` while each session uses its own. */
export function resolveProviderGatewayChosenMachine(
  placement: ProviderGatewayPlacementV1 | undefined,
  machines: readonly ProviderGatewayMachine[],
): Readonly<{
  machineId: string;
  machine: ProviderGatewayMachine | null;
}> | null {
  if (placement?.kind !== 'machine') return null;
  return {
    machineId: placement.machineId,
    machine:
      machines.find((machine) => machine.machineId === placement.machineId) ??
      null,
  };
}

export type ProviderGatewaySectionsProps = Readonly<{
  /** Plugin that authored the localized vendor-slot titles. */
  localizedTextPluginId: string;
  declarations: readonly PurposeDeclaration[];
  /** The saved slot map: one account or pool per vendor. */
  slots: ProviderConnectionPurposeBindingDefaultsV1;
  onChangeSlot: (
    purpose: string,
    target: QualifiedConnectedAccountPurposeBindingTargetV1 | null,
  ) => void;
  onConnectService: (serviceKey: string) => void;
  placement: ProviderGatewayPlacementV1 | undefined;
  machines: readonly ProviderGatewayMachine[];
  reachability: ProviderGatewayHubReachability;
  /** `null` returns the gateway to each session's computer. */
  onChangePlacement: (placement: ProviderGatewayPlacementV1 | null) => void;
  helperModels: ProviderClaudeHelperModelsV1 | undefined;
  models: readonly Readonly<{ id: string; name: string }>[];
  /** `null` clears every pin. */
  onChangeHelperModels: (
    helperModels: ProviderClaudeHelperModelsV1 | null,
  ) => void;
  /** The page cannot write right now (no computer to write through, or another Account's machine). */
  disabled: boolean;
  disabledReason?: string;
  /** "Show in model picker" and the Models link, owned by the page. */
  pickerRows: React.ReactNode;
  /** The Name field, owned by the page. */
  nameRow: React.ReactNode;
}>;

/**
 * A gateway's configuration (lab `rgateway` GW1/GW2): which subscription each vendor draws on, where
 * the gateway runs, how it shows in the model picker, and Claude Code's helper models. Every control
 * saves on change through the connection's one update writer; this component holds no saved state.
 */
export const ProviderGatewaySections = React.memo(
  function ProviderGatewaySections(props: ProviderGatewaySectionsProps) {
    const { theme } = useUnistyles();
    const chosen = resolveProviderGatewayChosenMachine(
      props.placement,
      props.machines,
    );
    // "A chosen computer" is only saved once a computer is picked; until then the choice is the page's.
    const [choosing, setChoosing] = React.useState(false);
    const mode: PlacementMode =
      chosen || choosing ? 'machine' : 'sessionMachine';
    const [computerMenuOpen, setComputerMenuOpen] = React.useState(false);
    const [helperMenuOpen, setHelperMenuOpen] =
      React.useState<HelperRole | null>(null);
    const [knowOpen, setKnowOpen] = React.useState(false);

    const selectMode = (next: PlacementMode) => {
      if (next === mode) return;
      if (next === 'machine') {
        setChoosing(true);
        return;
      }
      setChoosing(false);
      if (chosen) props.onChangePlacement(null);
    };

    const placementTabs = React.useMemo(
      () => [
        {
          id: 'sessionMachine' as const,
          label: t('settingsProvidersCollection.gateway.runsOnSession'),
        },
        {
          id: 'machine' as const,
          label: t('settingsProvidersCollection.gateway.runsOnChosen'),
        },
      ],
      [],
    );
    const computerItems = React.useMemo(
      () =>
        props.machines.map((machine) => ({
          id: machine.machineId,
          testID: `provider-gateway-computer:${machine.machineId}`,
          title: machine.displayName,
          subtitle: machine.online
            ? undefined
            : t('settingsProvidersCollection.gateway.computerOffline'),
          icon: (
            <Icon
              name="desktop"
              size={16}
              color={theme.colors.text.secondary}
            />
          ),
        })),
      [props.machines, theme.colors.text.secondary],
    );
    const computerStatus = !chosen
      ? t('settingsProvidersCollection.gateway.computerChooseDescription')
      : !chosen.machine
        ? t('settingsProvidersCollection.gateway.computerGone')
        : !chosen.machine.online
          ? t('settingsProvidersCollection.gateway.computerOffline')
          : props.reachability === 'reachable'
            ? t('settingsProvidersCollection.gateway.computerOnlineReachable')
            : props.reachability === 'unreachable'
              ? t(
                  'settingsProvidersCollection.gateway.computerOnlineUnreachable',
                )
              : t('settingsProvidersCollection.gateway.computerOnline');
    const computerTrouble = chosen !== null && chosen.machine?.online !== true;

    const helperItems = React.useMemo(
      () => [
        {
          id: SAME_AS_SESSION,
          title: t('settingsProvidersCollection.gateway.helperSameAsSession'),
        },
        ...props.models.map((model) => ({ id: model.id, title: model.name })),
      ],
      [props.models],
    );
    const setHelper = (role: HelperRole, modelId: string) => {
      const next: { -readonly [Role in HelperRole]?: string } = {
        ...props.helperModels,
      };
      if (modelId === SAME_AS_SESSION) delete next[role];
      else next[role] = modelId;
      props.onChangeHelperModels(Object.keys(next).length > 0 ? next : null);
    };

    return (
      <>
        <ItemGroup
          title={t('settingsProvidersCollection.gateway.modelsFromTitle')}
          description={t(
            'settingsProvidersCollection.gateway.modelsFromDescription',
          )}
        >
          {props.declarations.map((declaration) => (
            <GatewaySlotRow
              key={`${buildQualifiedPluginContributionKey(declaration.service)}/${declaration.purpose}`}
              declaration={declaration}
              localizedTextPluginId={props.localizedTextPluginId}
              value={props.slots[declaration.purpose] ?? null}
              disabled={props.disabled}
              disabledReason={props.disabledReason}
              onChange={props.onChangeSlot}
              onConnect={props.onConnectService}
            />
          ))}
        </ItemGroup>

        <ItemGroup
          title={t('settingsProvidersCollection.gateway.runsOnTitle')}
          description={t(
            'settingsProvidersCollection.gateway.runsOnDescription',
          )}
        >
          <SectionContentRow testID="provider-gateway-placement">
            <View style={styles.placement}>
              <SegmentedTabBar<PlacementMode>
                tabs={placementTabs}
                activeTabId={mode}
                onSelectTab={selectMode}
                slidingThumb
                segmentSizing="equal"
                targetSize="platform"
                disabled={props.disabled}
                accessibilityLabel={t(
                  'settingsProvidersCollection.gateway.runsOnTitle',
                )}
                role="radiogroup"
                testIDPrefix="provider-gateway-placement"
              />
              <Text style={styles.consequence}>
                {mode === 'machine'
                  ? t(
                      'settingsProvidersCollection.gateway.runsOnChosenDescription',
                    )
                  : t(
                      'settingsProvidersCollection.gateway.runsOnSessionDescription',
                    )}
              </Text>
            </View>
          </SectionContentRow>
          {mode === 'machine' ? (
            <DropdownMenu
              open={computerMenuOpen}
              onOpenChange={setComputerMenuOpen}
              variant="selectable"
              search={false}
              selectedId={chosen?.machineId ?? null}
              showCategoryTitles={false}
              matchTriggerWidth={true}
              connectToTrigger={true}
              rowKind="item"
              popoverPortalWebTarget="body"
              itemTrigger={{
                title: t('settingsProvidersCollection.gateway.computerTitle'),
                subtitle: computerStatus,
                subtitleFormatter: () => (
                  <Text
                    style={[
                      styles.status,
                      computerTrouble
                        ? { color: theme.colors.state.warning.foreground }
                        : null,
                    ]}
                  >
                    {computerStatus}
                  </Text>
                ),
                placeholder: t(
                  'settingsProvidersCollection.gateway.computerChoose',
                ),
                field: {
                  leading: (
                    <Icon
                      name="desktop"
                      size={16}
                      color={theme.colors.text.secondary}
                    />
                  ),
                  invalid: chosen !== null && chosen.machine === null,
                },
                itemProps: {
                  disabled: props.disabled,
                  testID: 'provider-gateway-computer',
                },
              }}
              items={computerItems}
              onSelect={(machineId) => {
                setComputerMenuOpen(false);
                setChoosing(false);
                if (machineId !== chosen?.machineId)
                  props.onChangePlacement({ kind: 'machine', machineId });
              }}
            />
          ) : null}
        </ItemGroup>

        <ItemGroup
          title={t('settingsProvidersCollection.gateway.modelPickerTitle')}
        >
          {props.pickerRows}
        </ItemGroup>

        <ItemGroup
          title={t('settingsProvidersCollection.gateway.helperTitle')}
          description={t(
            'settingsProvidersCollection.gateway.helperDescription',
          )}
        >
          {HELPER_ROLES.map((role) => {
            const pinned = props.helperModels?.[role] ?? SAME_AS_SESSION;
            return (
              <DropdownMenu
                key={role}
                open={helperMenuOpen === role}
                onOpenChange={(open) => setHelperMenuOpen(open ? role : null)}
                variant="selectable"
                search={helperItems.length > 8}
                selectedId={pinned}
                showCategoryTitles={false}
                matchTriggerWidth={true}
                connectToTrigger={true}
                rowKind="item"
                popoverPortalWebTarget="body"
                itemTrigger={{
                  title: t(HELPER_ROLE_TITLE_KEY[role]),
                  // A pin whose model left the gateway still says which model it names.
                  detailFormatter: (selected) => selected?.title ?? pinned,
                  field: { quietValue: pinned === SAME_AS_SESSION },
                  itemProps: {
                    disabled: props.disabled,
                    testID: `provider-gateway-helper:${role}`,
                  },
                }}
                items={helperItems}
                onSelect={(modelId) => {
                  setHelperMenuOpen(null);
                  if (modelId !== pinned) setHelper(role, modelId);
                }}
              />
            );
          })}
        </ItemGroup>

        <ItemGroup
          title={t('settingsProvidersCollection.gateway.detailsTitle')}
        >
          {props.nameRow}
          <ExpandableItem
            testID="provider-gateway-what-to-know"
            expanded={knowOpen}
            onExpandedChange={setKnowOpen}
            header={(state) => (
              <Item
                testID="provider-gateway-what-to-know:header"
                {...state.headerProps}
                title={t('settingsProvidersCollection.gateway.whatToKnow')}
                detail={t('settingsProviders.compatibility.experimental')}
                rightElement={
                  <Icon
                    name={state.expanded ? 'caret-down' : 'caret-right'}
                    size={14}
                    color={theme.colors.text.secondary}
                  />
                }
                showChevron={false}
              />
            )}
          >
            <Item
              testID="provider-gateway-what-to-know:policy"
              mode="info"
              title={t('settingsProvidersCollection.gateway.whatToKnowTitle')}
              subtitle={t(
                'settingsProvidersCollection.gateway.whatToKnowDescription',
              )}
              subtitleLines={0}
              showChevron={false}
            />
          </ExpandableItem>
        </ItemGroup>
      </>
    );
  },
);

/**
 * One vendor's slot. With no account of that vendor the row is the way to connect one; otherwise it
 * is the shared account-or-pool chooser, which already offers "None" for a vendor left unused.
 */
const GatewaySlotRow = React.memo(function GatewaySlotRow(
  props: Readonly<{
    declaration: PurposeDeclaration;
    localizedTextPluginId: string;
    value: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
    disabled: boolean;
    disabledReason?: string;
    onChange: ProviderGatewaySectionsProps['onChangeSlot'];
    onConnect: ProviderGatewaySectionsProps['onConnectService'];
  }>,
) {
  const { declaration } = props;
  const profile = useProfile();
  const registry = useProjectedConnectedServicesRegistry();
  const localizePluginText = useProjectedPluginLocalizedTextResolver();
  const serviceKey = buildQualifiedPluginContributionKey(declaration.service);
  const title =
    (declaration.title
      ? localizePluginText(props.localizedTextPluginId, declaration.title)
      : '') ||
    resolveQualifiedConnectedServiceRegistryDisplayName(
      registry,
      declaration.service,
      t,
      localizePluginText,
    );
  const hasAccount = (profile.connectedAccountsV4 ?? []).some(
    (account) =>
      buildQualifiedPluginContributionKey(account.ref.service) === serviceKey,
  );
  const mark = (
    <ConnectedServiceMark
      legacyServiceId={
        getQualifiedConnectedServiceRegistryEntry(declaration.service)
          ?.legacyServiceId ?? null
      }
      size="inline"
    />
  );
  const testID = `provider-gateway-slot:${declaration.purpose}`;
  const purpose = declaration.purpose;
  const onChange = props.onChange;
  const change = React.useCallback(
    (target: QualifiedConnectedAccountPurposeBindingTargetV1 | null) => {
      onChange(purpose, target);
    },
    [onChange, purpose],
  );

  if (!hasAccount && props.value === null) {
    return (
      <Item
        testID={testID}
        icon={mark}
        title={title}
        subtitle={t('settingsProvidersCollection.gateway.slotConnect', {
          service: title,
        })}
        subtitleLines={0}
        showChevron={false}
        rightElement={
          <RoundButton
            testID={`${testID}:connect`}
            size="small"
            display="secondary"
            title={t('settingsProvidersCollection.gateway.connect')}
            accessibilityLabel={t(
              'settingsProvidersCollection.gateway.slotConnect',
              { service: title },
            )}
            onPress={() => props.onConnect(serviceKey)}
          />
        }
        rightElementOutsidePressable
      />
    );
  }
  return (
    <ConnectedAccountPurposeTargetChooser
      testID={testID}
      localizedTextPluginId={props.localizedTextPluginId}
      declaration={declaration}
      value={props.value}
      icon={mark}
      description={
        props.value === null
          ? t('settingsProvidersCollection.gateway.slotUnused', {
              service: title,
            })
          : undefined
      }
      disabled={props.disabled}
      disabledReason={props.disabledReason}
      onChange={change}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  placement: {
    gap: 10,
  },
  consequence: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
  status: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
}));
