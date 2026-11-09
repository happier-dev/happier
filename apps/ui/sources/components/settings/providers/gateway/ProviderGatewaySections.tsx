import type { ProviderGatewayFamilyDeclaration, ProviderGatewayFamilyFacts } from '@/providers/connection/gatewayConfiguration';
import * as React from 'react';
import { RowArrivalReveal, SettingAnchor } from '@/components/settings/shell/SettingRow';
import { PROVIDER_GATEWAY_SETTINGS } from '../providersSettings';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type {
  ProviderRoleModelsV1,
  ProviderConnectionPurposeBindingDefaultsV1,
  ProviderGatewayPlacementV1,
} from '@happier-dev/protocol/providers/connections/v1';
import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';
import type { ProviderModelDescriptorV1 } from '@happier-dev/protocol/models/descriptor';
import type { ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { presentProviderError } from '@/providers/connection/errorPresentation';
import type { AgentProviderRequirementsV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import {
  useProjectedConnectedServicesRegistry,
  useProjectedPluginLocalizedTextResolver,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import { ConnectedServiceMark, formatAgentNames } from '@/components/settings/connectedServices/ConnectedServiceMark';
import { resolveQualifiedConnectedServiceRegistryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type { PopoverAnchor } from '@/components/ui/popover/_types';
import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
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

type PurposeDeclaration = ProviderGatewayFamilyDeclaration;
type HelperRole = keyof ProviderRoleModelsV1;
type PlacementMode = ProviderGatewayPlacementV1['kind'];

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
export type ProviderGatewayHubReachability = NonNullable<DaemonProviderConnectionViewV1['runtime']['gateway']>['reachability'];

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
  onConnectService: (serviceKey: string, anchor?: PopoverAnchor) => void;
  placement: ProviderGatewayPlacementV1 | undefined;
  machines: readonly ProviderGatewayMachine[];
  reachability: ProviderGatewayHubReachability;
  /** `null` returns the gateway to each session's computer. */
  onChangePlacement: (placement: ProviderGatewayPlacementV1 | null) => void;
  helperModels: ProviderRoleModelsV1 | undefined;
  modelRoles: NonNullable<AgentProviderRequirementsV1['modelRoles']>;
  /** Null until the catalog has answered; an empty array is an observed empty catalog. */
  models: readonly ProviderModelDescriptorV1[] | null;
  modelsLoading?: boolean;
  onHelperMenuOpenChange?: (open: boolean) => void;
  modelsError?: ProviderErrorV1 | null;
  /** `null` clears every pin. */
  onChangeHelperModels: (
    helperModels: ProviderRoleModelsV1 | null,
  ) => void;
  /** The captured Account catalog is not writable or the selected target belongs to another Account. */
  disabled: boolean;
  disabledReason?: string;
  /** "Show in model picker" and the Models link, owned by the page; a draft has none and shows no section. */
  pickerRows: React.ReactNode;
  /** The Name field, owned by the page. */
  nameRow: React.ReactNode;
  /** A saved gateway's Used by section, owned by the page; a draft has none. */
  usedBy?: React.ReactNode;
  /** What each family (by purpose) can serve here, from the gateway's family rows (seam 04-A/B). */
  familyFacts?: Readonly<Record<string, ProviderGatewayFamilyFacts>>;
}>;

export type { ProviderGatewayFamilyFacts } from '@/providers/connection/gatewayConfiguration';

const NO_FAMILY_FACTS: Readonly<Record<string, ProviderGatewayFamilyFacts>> = Object.freeze({});
const NO_PURPOSES: ReadonlySet<string> = new Set();

function selectConnectedServiceKeys(profile: Readonly<{ connectedAccountsV4?: readonly Readonly<{ ref: Readonly<{ service: Parameters<typeof buildQualifiedPluginContributionKey>[0] }> }>[] | null }>): string {
  return Array.from(new Set((profile.connectedAccountsV4 ?? []).map((account) => buildQualifiedPluginContributionKey(account.ref.service)))).sort().join('\n');
}

/**
 * Which families show as slots and which fold into "Add more" (lab `muse-accounts` C1): a family with an
 * account, or with a saved slot, is a slot; the rest fold. With nothing connected yet every family shows,
 * each with its Connect.
 */
export function partitionProviderGatewayFamilies<Declaration extends Readonly<{ purpose: string; service: Parameters<typeof buildQualifiedPluginContributionKey>[0] }>>(
  declarations: readonly Declaration[],
  slots: Readonly<Record<string, unknown>>,
  connectedServiceKeys: ReadonlySet<string>,
): Readonly<{ shown: readonly Declaration[]; folded: readonly Declaration[] }> {
  const shown: Declaration[] = [];
  const folded: Declaration[] = [];
  for (const declaration of declarations) {
    const connected = connectedServiceKeys.has(buildQualifiedPluginContributionKey(declaration.service))
      || (slots[declaration.purpose] ?? null) !== null;
    (connected ? shown : folded).push(declaration);
  }
  return shown.length === 0 ? { shown: folded, folded: [] } : { shown, folded };
}

/**
 * A gateway's configuration (lab `rgateway` GW1/GW2): which subscription each vendor draws on, where
 * the gateway runs, how it shows in the model picker, and Claude Code's helper models. Every control
 * delegates to the caller's authoring buffer or the connection's one update writer; this component holds no saved state.
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
    const connectedServiceKeyList = useProfile(selectConnectedServiceKeys, ['connectedAccountsV4']);
    const connectedServiceKeys = React.useMemo(
      () => new Set(connectedServiceKeyList ? connectedServiceKeyList.split('\n') : []),
      [connectedServiceKeyList],
    );
    const families = React.useMemo(
      () => partitionProviderGatewayFamilies(props.declarations, props.slots, connectedServiceKeys),
      [connectedServiceKeys, props.declarations, props.slots],
    );
    const familyFacts = props.familyFacts ?? NO_FAMILY_FACTS;
    // A family connected from Add more moves into the slots and takes the reveal pulse once.
    const foldedKey = families.folded.map((declaration) => declaration.purpose).join('\n');
    const previousFoldedRef = React.useRef<ReadonlySet<string> | null>(null);
    const [arrived, setArrived] = React.useState<ReadonlySet<string>>(NO_PURPOSES);
    React.useEffect(() => {
      const previous = previousFoldedRef.current;
      previousFoldedRef.current = new Set(foldedKey ? foldedKey.split('\n') : []);
      if (!previous) return;
      const moved = families.shown.filter((declaration) => previous.has(declaration.purpose));
      if (moved.length > 0) setArrived(new Set(moved.map((declaration) => declaration.purpose)));
      // `families.shown` changes with `foldedKey`; the key alone decides an arrival.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [foldedKey]);

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

    const helperCatalogPending = props.models === null && props.modelsLoading === true;
    const helperCatalogStatus = props.modelsError
      ? t(presentProviderError(props.modelsError).descriptionKey)
      : helperCatalogPending ? t('common.loading')
        : props.models === null ? t('common.unavailable') : undefined;
    const sessionHelperItem = React.useMemo(() => ({ id: SAME_AS_SESSION,
      title: t('settingsProvidersCollection.gateway.helperSameAsSession') }), []);
    const helperItems = React.useMemo(() => helperMenuOpen === null ? [sessionHelperItem] : [
      sessionHelperItem,
      ...(props.models ?? []).map(model => ({ id: model.id, title: model.name })),
    ], [helperMenuOpen, props.models, sessionHelperItem]);
    const setHelper = (role: HelperRole, modelId: string) => {
      const next: ProviderRoleModelsV1 = {
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
          <SettingAnchor setting={PROVIDER_GATEWAY_SETTINGS.settings.slots}><>{families.shown.map((declaration) => (
            <RowArrivalReveal
              key={`${buildQualifiedPluginContributionKey(declaration.service)}/${declaration.purpose}`}
              active={arrived.has(declaration.purpose)}
              testID={`provider-gateway-slot:${declaration.purpose}:arrived`}
            >
              <GatewaySlotRow
                declaration={declaration}
                localizedTextPluginId={props.localizedTextPluginId}
                value={props.slots[declaration.purpose] ?? null}
                hasAccount={connectedServiceKeys.has(buildQualifiedPluginContributionKey(declaration.service))}
                facts={familyFacts[declaration.purpose]}
                disabled={props.disabled}
                disabledReason={props.disabledReason}
                onChange={props.onChangeSlot}
                onConnect={props.onConnectService}
              />
            </RowArrivalReveal>
          ))}
          {families.folded.length > 0 ? (
            <GatewayAddMoreRow
              declarations={families.folded}
              localizedTextPluginId={props.localizedTextPluginId}
              familyFacts={familyFacts}
              disabled={props.disabled}
              disabledReason={props.disabledReason}
              onChange={props.onChangeSlot}
              onConnect={props.onConnectService}
            />
          ) : null}</></SettingAnchor>
        </ItemGroup>

        <ItemGroup
          title={t('settingsProvidersCollection.gateway.runsOnTitle')}
          description={t(
            'settingsProvidersCollection.gateway.runsOnDescription',
          )}
        >
          <SettingAnchor setting={PROVIDER_GATEWAY_SETTINGS.settings.placement}><SectionContentRow testID="provider-gateway-placement">
            <View style={styles.placement}>
              <SegmentedTabBar<PlacementMode>
                tabs={placementTabs}
                activeTabId={mode}
                onSelectTab={selectMode}
                segmentSizing="equal"
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
          </SectionContentRow></SettingAnchor>
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

        {props.usedBy ?? null}

        {props.pickerRows ? (
          <ItemGroup
            title={t('settingsProvidersCollection.gateway.modelPickerTitle')}
          >
            {props.pickerRows}
          </ItemGroup>
        ) : null}

        <ItemGroup
          title={t('settingsProvidersCollection.gateway.helperTitle')}
          description={t(
            'settingsProvidersCollection.gateway.helperDescription',
          )}
        >
          <SettingAnchor setting={PROVIDER_GATEWAY_SETTINGS.settings.helpers}><>{props.modelRoles.map(({ id: role, title }) => {
            const pinned = props.helperModels?.[role] ?? SAME_AS_SESSION;
            const selectedModel = helperMenuOpen !== role && pinned !== SAME_AS_SESSION
              ? props.models?.find(model => model.id === pinned) : undefined;
            const items = selectedModel
              ? [sessionHelperItem, { id: selectedModel.id, title: selectedModel.name }]
              : helperMenuOpen === role ? helperItems : [sessionHelperItem];
            return (
              <DropdownMenu
                key={role}
                open={helperMenuOpen === role}
                onOpenChange={(open) => { setHelperMenuOpen(open ? role : null); props.onHelperMenuOpenChange?.(open); }}
                variant="selectable"
                search={helperItems.length > 8}
                selectedId={pinned}
                showCategoryTitles={false}
                matchTriggerWidth={true}
                connectToTrigger={true}
                rowKind="item"
                popoverPortalWebTarget="body"
                emptyLabel={helperCatalogStatus}
                itemTrigger={{
                  title,
                  subtitle: helperCatalogStatus,
                  // A pin whose model left the gateway still says which model it names.
                  detailFormatter: (selected) => selected?.title ?? pinned,
                  field: { quietValue: pinned === SAME_AS_SESSION },
                  itemProps: {
                    disabled: props.disabled || helperCatalogPending,
                    loading: helperCatalogPending,
                    testID: `provider-gateway-helper:${role}`,
                  },
                }}
                items={items}
                onSelect={(modelId) => {
                  setHelperMenuOpen(null);
                  props.onHelperMenuOpenChange?.(false);
                  if (modelId !== pinned) setHelper(role, modelId);
                }}
              />
            );
          })}</></SettingAnchor>
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
    hasAccount: boolean;
    facts?: ProviderGatewayFamilyFacts;
    disabled: boolean;
    disabledReason?: string;
    onChange: ProviderGatewaySectionsProps['onChangeSlot'];
    onConnect: ProviderGatewaySectionsProps['onConnectService'];
  }>,
) {
  const { declaration } = props;
  const registry = useProjectedConnectedServicesRegistry();
  const localizePluginText = useProjectedPluginLocalizedTextResolver();
  const serviceKey = buildQualifiedPluginContributionKey(declaration.service);
  // The row names the service (lab GW1 "ChatGPT", "Claude"); the section already says each one
  // takes an account or a pool, so the declaration's "… account or pool" title would say it twice.
  const title = resolveQualifiedConnectedServiceRegistryDisplayName(
    registry,
    declaration.service,
    t,
    localizePluginText,
  );
  const hasAccount = props.hasAccount;
  const restriction = props.facts?.restriction;
  const mark = <GatewayFamilyMark service={declaration.service} />;
  // Same name on the chooser row and its popover: the service, not the purpose title.
  const serviceDeclaration = React.useMemo(
    () => {
      if ('status' in declaration) {
        if (declaration.status === 'unavailable') return null;
        const { status: _status, ...purpose } = declaration;
        return { ...purpose, title: undefined };
      }
      return { ...declaration, title: undefined };
    },
    [declaration],
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

  if (!serviceDeclaration || (!hasAccount && props.value === null)) {
    return (
      <Item
        testID={testID}
        icon={mark}
        title={title}
        // What it needs (or why its account can't serve here), then what a restricted family serves.
        subtitle={[
          props.facts?.unavailableReason ?? t('settingsProvidersCollection.gateway.slotConnect', { service: title }),
          restriction?.summary ?? null,
        ].filter(Boolean).join(' · ')}
        subtitleLines={0}
        showChevron={false}
        rightElement={
          <RoundButton
            testID={`${testID}:connect`}
            size="small"
            disabled={props.disabled || serviceDeclaration === null}
            display="secondary"
            title={t('settingsProvidersCollection.gateway.connect')}
            accessibilityLabel={t(
              'settingsProvidersCollection.gateway.slotConnect',
              { service: title },
            )}
            onPress={(event) => props.onConnect(serviceKey, resolvePressTriggerAnchor(event))}
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
      declaration={serviceDeclaration}
      value={props.value}
      icon={mark}
      description={
        props.value === null
          ? t('settingsProvidersCollection.gateway.slotUnused', {
              service: title,
            })
          : undefined
      }
      restriction={restriction}
      disabled={props.disabled}
      disabledReason={props.disabledReason}
      onChange={change}
    />
  );
});

/** A family's mark: its built-in mark, or the brand its plugin declares. */
const GatewayFamilyMark = React.memo(function GatewayFamilyMark(props: Readonly<{ service: PurposeDeclaration['service'] }>) {
  return (
    <ConnectedServiceMark
      legacyServiceId={getQualifiedConnectedServiceRegistryEntry(props.service)?.legacyServiceId ?? null}
      pluginId={props.service.pluginId}
      size="inline"
    />
  );
});

/**
 * The families with no account, folded into one row (lab `muse-accounts` C1): their marks and names,
 * opening in place onto each family's Connect. Closed, its rows are not mounted, so it reads nothing.
 */
const GatewayAddMoreRow = React.memo(function GatewayAddMoreRow(
  props: Readonly<{
    declarations: readonly PurposeDeclaration[];
    localizedTextPluginId: string;
    familyFacts: Readonly<Record<string, ProviderGatewayFamilyFacts>>;
    disabled: boolean;
    disabledReason?: string;
    onChange: ProviderGatewaySectionsProps['onChangeSlot'];
    onConnect: ProviderGatewaySectionsProps['onConnectService'];
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const registry = useProjectedConnectedServicesRegistry();
  const localizePluginText = useProjectedPluginLocalizedTextResolver();
  const names = formatAgentNames(props.declarations.map((declaration) =>
    resolveQualifiedConnectedServiceRegistryDisplayName(registry, declaration.service, t, localizePluginText)));
  return (
    <ExpandableItem
      testID="provider-gateway-add-more"
      expanded={open}
      onExpandedChange={setOpen}
      header={(state) => (
        <Item
          testID="provider-gateway-add-more:header"
          {...state.headerProps}
          icon={<Icon name="plus" size={17} color={theme.colors.text.secondary} />}
          title={t('settingsProvidersCollection.gateway.addMoreFamilies')}
          subtitle={names}
          subtitleLeading={(
            <View style={styles.marks}>
              {props.declarations.map((declaration) => (
                <GatewayFamilyMark key={`${buildQualifiedPluginContributionKey(declaration.service)}/${declaration.purpose}`} service={declaration.service} />
              ))}
            </View>
          )}
        />
      )}
    >
      {props.declarations.map((declaration) => (
        <GatewaySlotRow
          key={`${buildQualifiedPluginContributionKey(declaration.service)}/${declaration.purpose}`}
          declaration={declaration}
          localizedTextPluginId={props.localizedTextPluginId}
          value={null}
          hasAccount={false}
          facts={props.familyFacts[declaration.purpose]}
          disabled={props.disabled}
          disabledReason={props.disabledReason}
          onChange={props.onChange}
          onConnect={props.onConnect}
        />
      ))}
    </ExpandableItem>
  );
});

const styles = StyleSheet.create((theme) => ({
  placement: {
    gap: theme.space.s10,
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
  marks: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
  },
}));
