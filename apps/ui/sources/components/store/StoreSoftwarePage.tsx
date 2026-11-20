import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { actionInputOptionValueKey, isSameActionInputOptionValue } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { MachineSetupToolchainSoftwareChoiceV1Schema } from '@happier-dev/protocol/plugins/contributions/projectNativeAdapters';
import { MachineRecipeReferenceV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';

import { useOpenStoreListing, useStoreListingSelection } from './StoreListing';
import type { StoreSoftwareListingReference } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import {
  CapabilityAddDetailAction,
  CapabilityListingDetail,
  type CapabilityListingConfig,
} from '@/components/capabilities/add/CapabilityAddModal';
import { CapabilityListingSections } from '@/components/capabilities/add/CapabilityListingSections';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import { pluginSourceKindLabel } from '@/components/settings/plugins/model/pluginMarketplaceModel';
import { useStoreDirectoryState } from '@/components/settings/plugins/model/usePluginsOpenItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { BareSectionContent } from '@/components/ui/lists/BareSectionContent';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { StoreItemMark } from './catalog/StoreItemMark';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { resolvePluginProjectedActionPresentation } from '@/sync/domains/plugins/ui/actionPresentation';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { t } from '@/text';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

import type {
  StoreSoftwareItem,
  StoreSoftwareTarget,
} from './catalog/storeSoftware';
import {
  Directory,
  StoreKindFrame,
  type DirectoryGroup,
  type DirectoryRow,
} from './StoreKindPage';
import { StoreSoftwareKind, type StoreKindList } from './StoreKindScreen';
import {
  StoreSoftwareEntry,
  type StoreSoftwareEntryState,
} from './StoreSoftwareEntry';
import {
  omitBlankSoftwareInputs,
  readSoftwareInputFields,
  SoftwareInputFields,
  type SoftwareInputDraft,
} from './StoreSoftwareInputs';
import { showStoreSoftwareReview } from './StoreSoftwareReview';
import { StoreAddToPresetButton, StorePresetEditorHandoff, type StorePresetChoice } from './presets/StoreAddToPreset';
import { StorePresetsShelf } from './presets/StorePresetsShelf';
import type { StorePresetDoorItem } from './presets/storePresetDoor';
import { describeMachineSetupPlanFailure } from '@/components/settings/machines/managed/MachineSetupPlanReview';
import {
  SoftwareMachineMark,
  SoftwareMachineSelect,
  foldOfflineSoftwareTargets,
  type SoftwareMachineTarget,
  SoftwareTargetsDraftProvider,
  softwareMachineFacts,
  softwareMachineName,
  softwareMachineUnavailableReason,
  useSoftwareMachines,
  useSoftwareTargetsDraft,
  type SoftwareMachines,
} from './StoreSoftwareTargets';

/** The catalog row's mark box draws a bare mark at this size (S10 catalogRow), as every kind page does. */
const ROW_MARK_PX = 26;

const isToolchain = (item: StoreSoftwareItem) =>
  MachineSetupToolchainSoftwareChoiceV1Schema.safeParse(item.value).success;

/**
 * A software option's one mark, through the Store mark owner: the declaring bundled plugin's brand when it ships
 * one, else the descriptor's declared icon, else the Software glyph. Search and this page draw the same option.
 */
export function SoftwareMark(
  props: Readonly<{ item: StoreSoftwareItem; pixelSize: number }>,
): React.ReactNode {
  const { item } = props;
  const value = item.value;
  const bundledPluginId = value && typeof value === 'object' && 'pluginId' in value && typeof value.pluginId === 'string'
    ? value.pluginId : null;
  return <StoreItemMark facts={{ kind: 'software', title: item.label, bundledPluginId, iconToken: item.icon ?? null }} size={props.pixelSize} />;
}

/**
 * Store → Software (lab `w:kind`): what this Account's plugins offer, as Runtimes and Programs. Browsing needs no
 * Machine and reads none; which Machines support an item is checked in a listing's Install on… review.
 */
export function StoreSoftwarePage(
  props: Readonly<{ presented: boolean }>,
): React.ReactNode {
  const directory = useStoreDirectoryState();
  const query = directory.state?.query ?? '';
  const scope = useAccountSettingsScope();
  const input = React.useMemo(
    () => ({ query: query.trim(), softwareTarget: { scope, machine: null } }),
    [query, scope],
  );
  const demand = React.useMemo(
    () => ({ presented: props.presented }),
    [props.presented],
  );
  const openListing = useOpenStoreListing();
  const selected = useStoreListingSelection();
  const openItem = React.useCallback(
    (item: StoreSoftwareItem) => {
      const value = MachineSetupToolchainSoftwareChoiceV1Schema.safeParse(item.value);
      const recipe = MachineRecipeReferenceV1Schema.safeParse(item.value);
      const choice = value.success ? value.data : recipe.success ? recipe.data : null;
      if (!choice) return;
      openListing({ type: 'software', value: choice });
    },
    [openListing],
  );
  return (
    <SoftwareTargetsDraftProvider>
    <StoreSoftwareKind input={input} demand={demand}>
      {(list) => (
        <StoreKindFrame
          kind="software"
          query={query}
          onQueryChange={directory.setQuery}
          presented={props.presented}
        >
          <SoftwareDirectory
            list={list}
            query={input.query}
            open={openItem}
            selectedKey={selected?.type === 'software' ? actionInputOptionValueKey(selected.value) : null}
            onClear={() => directory.setQuery('')}
          />
          {/* The Account's presets hold software for any Machine. */}
          <StorePresetsShelf presented={props.presented} query={input.query} />
        </StoreKindFrame>
      )}
    </StoreSoftwareKind>
    </SoftwareTargetsDraftProvider>
  );
}

function SoftwareDirectory(
  props: Readonly<{
    list: StoreKindList<'software'>;
    query: string;
    open: (item: StoreSoftwareItem) => void;
    selectedKey: string | null;
    onClear: () => void;
  }>,
): React.ReactNode {
  const { items } = props.list;
  const { open } = props;
  const rows = React.useMemo(
    () =>
      items.map((item): DirectoryRow => ({
        key: actionInputOptionValueKey(item.value),
        title: item.label,
        description: item.description?.trim() || null,
        group: isToolchain(item) ? 'runtimes' : 'programs',
        open: () => open(item),
        mark: <SoftwareMark item={item} pixelSize={ROW_MARK_PX} />,
      })),
    [items, open],
  );
  const groups = React.useMemo(
    (): readonly DirectoryGroup[] =>
      [
        {
          key: 'runtimes',
          title: t('capabilities.store.softwarePage.runtimesTitle'),
          description: t('capabilities.store.softwarePage.runtimesDescription'),
        },
        {
          key: 'programs',
          title: t('capabilities.store.softwarePage.programsTitle'),
          description: t('capabilities.store.softwarePage.programsDescription'),
        },
      ].filter((group) => rows.some((row) => row.group === group.key)),
    [rows],
  );
  // A catalog that cannot be read says so once, where its rows would be; it never reads as "nothing offered".
  const error = props.list.error;
  if (error && rows.length === 0) {
    return <SoftwareUnavailable error={error} onRetry={props.list.refresh} />;
  }
  if (!props.list.loading && rows.length === 0 && !props.query) {
    return (
      <SurfaceStateCard
        testID="store.kind.software.empty"
        kind="empty"
        size="line"
        title={t('capabilities.store.softwarePage.catalogEmpty')}
      />
    );
  }
  return (
    <Directory
      kind="software"
      rows={rows}
      groups={groups}
      list={{ loading: props.list.loading, hasNextPage: false }}
      query={props.query}
      sourceTitle={null}
      selectedKey={props.selectedKey}
      addLabel={t('capabilities.store.softwarePage.installOn')}
      onClear={props.onClear}
    />
  );
}

/** The native Software failure reads identically in kind and mixed-kind directories. */
export function SoftwareUnavailable(props: Readonly<{ error: string; machine?: string; onRetry: () => void }>) {
  const { error } = props;
  const unavailable = error === 'offline' || error === 'unknown' || error === 'missing_option_dependency';
  const machine = props.machine ?? t('storeInstalled.machineFallback');
  const failed = props.machine ? t('capabilities.store.softwarePage.failed', { machine }) : t('capabilities.store.softwarePage.catalogFailed');
  const title = error === 'missing_option_dependency' ? t('capabilities.store.softwarePage.noMachineTitle')
    : error === 'offline' ? t('capabilities.store.softwarePage.offline', { machine })
    : error === 'unknown' ? t('capabilities.store.softwarePage.unknown', { machine })
    : failed;
  return <SurfaceStateCard testID="store.kind.software.state" kind={unavailable ? 'unavailable' : 'error'}
    size="line" title={title} {...(unavailable ? {} : {
      action: { label: t('capabilities.store.retry'), onPress: props.onRetry }, diagnosticCode: error,
    })} />;
}

/** A routed native choice reuses the same exact-read/listing owner in page and pane. */
export function StoreSoftwareRouteListing(props: Readonly<{
  reference: StoreSoftwareListingReference; pushed: boolean; onClose: () => void;
}>) {
  const machines = useSoftwareMachines();
  const scope = useAccountSettingsScope();
  // Exact selected details are read from a Machine that can answer; with none, the listing still shows what it is.
  const target = props.reference.target ?? machines.targets.find((entry) => entry.machine.online !== false)?.target
    ?? { scope, machine: null };
  return <SoftwareListing target={target} initialInputs={props.reference.inputs}
    item={{ value: props.reference.value, label: t('capabilities.store.kinds.software.title') }}
    machines={machines} pushed={props.pushed} onClose={props.onClose} />;
}

/** One Software listing (lab `w:pick`): who it is, what it sets up, where it goes, then one review. */
export function SoftwareListing(
  props: Readonly<{
    target: StoreSoftwareTarget;
    item: StoreSoftwareItem;
    machines: SoftwareMachines;
    pushed: boolean;
    onClose: () => void;
    /** The recipe's inputs to start from, as a stopped Setup run proposed them. */
    initialInputs?: SoftwareInputDraft;
  }>,
): React.ReactNode {
  const focused = useIsFocused();
  const visible = useLayoutPresentationActive();
  const demand = React.useMemo(() => ({ presented: focused && visible }), [focused, visible]);
  return (
    <StoreSoftwareEntry
      target={props.target}
      selection={props.item}
      demand={demand}
    >
      {(state) => <SoftwareListingBody {...props} item={state.options.find(option =>
        isSameActionInputOptionValue(option.value, props.item.value)) ?? props.item} state={state} />}
    </StoreSoftwareEntry>
  );
}

function SoftwareListingBody(
  props: Readonly<{
    target: StoreSoftwareTarget;
    item: StoreSoftwareItem;
    machines: SoftwareMachines;
    pushed: boolean;
    onClose: () => void;
    state: StoreSoftwareEntryState;
    initialInputs?: SoftwareInputDraft;
  }>,
): React.ReactNode {
  const { theme } = useUnistyles();
  const { state, item } = props;
  const toolchain = isToolchain(item);
  const [config, setConfig] = React.useState('');
  // A recipe's schema and presentation hints ask for its inputs; what is typed is the draft.
  const [draft, setDraft] = React.useState<SoftwareInputDraft>(() => props.initialInputs ?? {});
  // No Machine is chosen for the person: each one they turn on joins the one review. The Store page holds the
  // choice, so closing this listing and opening it again keeps it.
  const { chosen, setChosen } = useSoftwareTargetsDraft();
  const [showOffline, setShowOffline] = React.useState(false);
  // A Machine the person toggled here keeps its row while the listing is open, so turning off an offline one
  // never pulls it out from under them into the fold.
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(() => new Set());
  const ready = state.status === 'ready';
  // The owner's own validation says whether this recipe asks for values the listing cannot collect.
  const needsInputs = ready && !toolchain && props.target.machine !== null && !state.configure({}).ok;
  // The recipe's field titles are the declaring plugin's localized text, read by the one Action-presentation resolver.
  const localize = usePluginLocalizedTextResolver({ projection: null });
  const hints = React.useMemo(() => {
    const declared = state.machineRecipeDetails?.[0];
    const inputHints = declared && normalizePluginActionInputHintsV2(declared.definition.inputHints, declared.definition.inputSchema);
    return declared && inputHints
      ? (resolvePluginProjectedActionPresentation({
          pluginId: declared.pluginId,
          presentation: {
            title: declared.definition.title,
            inputHints,
          },
          projection: null,
          localize,
        }).inputHints ?? undefined)
      : undefined;
  }, [state.machineRecipeDetails, localize]);
  const form = React.useMemo(
    () => readSoftwareInputFields(hints, draft),
    [hints, draft],
  );
  const hasForm = ready && !toolchain && form.fields.length > 0;
  // Needs values the listing has no field for: the recipe declares none to ask for.
  const unaskable = needsInputs && !hasForm;
  const packageInputs = omitBlankSoftwareInputs(draft) ?? {};
  const packageChecked =
    hasForm && form.missing === null ? state.configure(packageInputs) : null;
  const unsupported = item.disabled === true;
  // A reachability/roster refresh cannot change the exact set the person chose.
  const selectedTargets = [...chosen.values()];
  const disabledReason = unsupported
    ? t('capabilities.store.softwarePage.unsupported')
    : state.status === 'failed'
      ? t('capabilities.store.softwarePage.readFailed')
      : !ready
        ? t('common.loading')
        : unaskable
          ? t('capabilities.store.softwarePage.needsPackagesTitle')
          : hasForm && form.missing !== null
            ? t('capabilities.store.softwarePage.needsField', {
                field: form.missing,
              })
            : packageChecked && !packageChecked.ok
              ? t('capabilities.store.softwarePage.invalidPackage')
              : selectedTargets.length === 0
                ? t('capabilities.store.softwarePage.chooseMachines')
                : toolchain && !config.trim()
                  ? t('capabilities.store.softwarePage.configLabel')
                  : undefined;
  const review = async () => {
    const request = {
      inputs: toolchain ? config : packageInputs,
      targets: selectedTargets,
    };
    const prepared = await state.prepare(request);
    if (!prepared.ok) {
      const nameOf = (machineId: string) => {
        const machine = props.machines.targets.find((entry) => entry.machine.machineId === machineId)?.machine;
        return machine ? softwareMachineName(machine) : t('storeInstalled.machineFallback');
      };
      throw new Error(describeMachineSetupPlanFailure(prepared, nameOf));
    }
    showStoreSoftwareReview({
      name: item.label,
      prepared,
      machines: props.machines,
      apply: state.apply,
      prepareOn: (selectedMachineId) => state.prepare({ ...request, selectedMachineId }),
      scope: props.target.scope!,
    });
    return null;
  };
  // A recipe joins a preset as itself with the values typed here; a runtime's Mise configuration is not a preset item.
  const presetItem = React.useMemo((): StorePresetDoorItem | null => {
    const recipe = toolchain ? null : MachineRecipeReferenceV1Schema.safeParse(item.value);
    return recipe?.success
      ? { kind: 'softwareRecipe', selection: { ref: recipe.data, inputs: omitBlankSoftwareInputs(draft) ?? {} } } : null;
  }, [item.value, toolchain, draft]);
  const [presetHandoff, setPresetHandoff] = React.useState<StorePresetChoice | null>(null);
  const returnFromPreset = React.useCallback(() => setPresetHandoff(null), []);
  const key = actionInputOptionValueKey(item.value);
  const config_: CapabilityListingConfig<StoreSoftwareItem> = {
    testID: 'store.software.listing',
    catalog: { itemKey: () => key },
    detailFooter: () => ({
      primary: {
        label: t('capabilities.store.appPage.review'),
        onPress: review,
        ...(disabledReason ? { disabledReason } : {}),
      },
      ...(presetItem ? { secondary: (
        <StoreAddToPresetButton
          testID="store.software.listing.addToPreset"
          serverId={props.target.scope?.serverId ?? null}
          item={presetItem}
          name={item.label}
          onChoose={setPresetHandoff}
        />
      ) } : selectedTargets.length === 0 && props.machines.targets.length > 0 ? { secondary: (
        <SoftwareMachineSelect
          testID="store.software.listing.chooseMachine"
          machines={props.machines}
          selectedId={null}
          placeholder={t('capabilities.store.softwarePage.chooseMachine')}
          onSelect={entry => setChosen(previous => new Map(previous).set(entry.machine.machineId, entry.target))}
        />
      ) } : {}),
      provenance: (
        <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
          {/* A disabled Review always says what it waits for, where the note stands beside it. */}
          {disabledReason ?? t('capabilities.store.softwarePage.installNote')}
        </Text>
      ),
    }),
    renderDetail: () => (
      <View>
        <ItemGroup surface="none" header="none">
          <BareSectionContent>
            <View style={styles.head}>
              {/* The same detail header as every other Store listing: mark, name, purpose, then its facts. */}
              <CapabilityDetailHeader
                testID="store.software.listing.header"
                mark={<SoftwareMark item={item} pixelSize={30} />}
                title={item.label}
                {...(item.description ? { purpose: item.description } : {})}
                facts={{ extra: [t('capabilities.store.kindWord.software')] }}
              />
              {unsupported ? (
                <Text
                  variant="meta"
                  style={{ color: theme.colors.status.actionRequired }}
                >
                  {t('capabilities.store.softwarePage.unsupported')}
                </Text>
              ) : null}
              <CapabilityAddDetailAction />
            </View>
          </BareSectionContent>
        </ItemGroup>
        {toolchain ? (
          <ItemGroup
            title={t('capabilities.store.softwarePage.configureTitle')}
            description={t(
              'capabilities.store.softwarePage.configureRuntimeDescription',
            )}
          >
            <SectionContentRow>
              <FieldTextInput
                testID="store.software.listing.config"
                value={config}
                onChangeText={setConfig}
                accessibilityLabel={t(
                  'capabilities.store.softwarePage.configLabel',
                )}
                placeholder={'[tools]\nnode = "22"'}
                multiline
                monospace
                autoCapitalize="none"
              />
            </SectionContentRow>
          </ItemGroup>
        ) : hasForm ? (
          <ItemGroup title={t('capabilities.store.softwarePage.packageTitle')}>
            <SectionContentRow>
              <SoftwareInputFields
                testID="store.software.listing.input"
                fields={form.fields}
                draft={draft}
                onPatch={(patch) =>
                  setDraft((previous) => ({ ...previous, ...patch }))
                }
              />
            </SectionContentRow>
          </ItemGroup>
        ) : unaskable ? (
          <ItemGroup
            title={t('capabilities.store.softwarePage.needsPackagesTitle')}
          >
            <SectionContentRow>
              <Text
                variant="body"
                style={{ color: theme.colors.text.secondary }}
              >
                {t('capabilities.store.softwarePage.needsPackagesBody')}
              </Text>
            </SectionContentRow>
          </ItemGroup>
        ) : !ready && state.status !== 'failed' ? (
          <ItemGroup
            title={t('capabilities.store.softwarePage.configureTitle')}
          >
            <SkeletonRows rows={1} />
          </ItemGroup>
        ) : null}
        <ItemGroup
          title={t('capabilities.store.softwarePage.targetsTitle')}
          description={t('capabilities.store.softwarePage.targetsDescription')}
        >
          {props.machines.targets.length === 0 ? (
            <SurfaceStateCard
              testID="store.software.listing.noMachine"
              kind="empty"
              size="line"
              title={t('capabilities.store.softwarePage.noMachineTitle')}
            />
          ) : null}
          {(() => {
            const fold = foldOfflineSoftwareTargets(props.machines.targets, {
              has: (machineId: string) => chosen.has(machineId) || touched.has(machineId),
            });
            const row = (entry: SoftwareMachineTarget) => {
              const reason = softwareMachineUnavailableReason(entry.machine);
              const reachable = reason === null && !unsupported && !unaskable;
              const on = chosen.has(entry.machine.machineId);
              return (
                <Item
                  key={entry.machine.machineId}
                  testID={`store.software.listing.target.${entry.machine.machineId}`}
                  title={softwareMachineName(entry.machine)}
                  subtitle={softwareMachineFacts(entry.machine)}
                  icon={<SoftwareMachineMark entry={entry} />}
                  rightElement={
                    <Switch
                      value={on}
                      disabled={!reachable && !on}
                      accessibilityLabel={softwareMachineName(entry.machine)}
                      onValueChange={(value) => {
                        setTouched((previous) => previous.has(entry.machine.machineId)
                          ? previous : new Set(previous).add(entry.machine.machineId));
                        setChosen((previous) => {
                          const next = new Map(previous);
                          if (value) next.set(entry.machine.machineId, entry.target);
                          else next.delete(entry.machine.machineId);
                          return next;
                        });
                      }}
                    />
                  }
                />
              );
            };
            return (
              <>
                {fold.shown.map(row)}
                {/* Offline Machines fold behind one line that says why once (as the Machines index folds them). */}
                {fold.offline.length === 0 ? null : (
                  <SurfaceStateCard
                    testID="store.software.listing.offline"
                    kind="empty"
                    size="line"
                    title={t('allMachines.offlineHidden', { count: fold.offline.length })}
                    reason={t('capabilities.store.softwarePage.offlineTargetsNote')}
                    action={{
                      testID: 'store.software.listing.offline-action',
                      label: showOffline ? t('allMachines.hideOffline') : t('allMachines.showOffline'),
                      onPress: () => setShowOffline((value) => !value),
                    }}
                  />
                )}
                {showOffline ? fold.offline.map(row) : null}
              </>
            );
          })()}
        </ItemGroup>
        <CapabilityListingSections
          testID="store.software.listing"
          facts={{
            version: item.version ?? null,
            versionNote: item.version
              ? t('capabilities.store.softwarePage.pluginVersionNote')
              : null,
            sourceTitle: item.source
              ? pluginSourceKindLabel(item.source.kind)
              : null,
          }}
        />
      </View>
    ),
  };
  if (presetHandoff && presetItem) {
    return <StorePresetEditorHandoff choice={presetHandoff} item={presetItem} onReturn={returnFromPreset} />;
  }
  return (
    <CapabilityListingDetail
      config={config_}
      item={item}
      onClose={props.onClose}
      pushed={props.pushed}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  head: { gap: theme.space.s8 },
}));
