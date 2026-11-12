import * as React from 'react';
import { actionInputOptionValueKey } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type { MachinePresetItemV1, MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { MachineRecipeReferenceV1Schema, type MachineRecipeReferenceV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { REGISTRY_ITEMS_READ_ACTION_ID_V1 } from '@happier-dev/protocol/registries/registryActionIdsV1';
import { CapabilityAddDetailAction, CapabilityAddModalBody, openCapabilityAddModalHost, type CapabilityAddModalConfig } from '@/components/capabilities/add/CapabilityAddModal';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { useMachineSetupRecipeOptions, useSoftwareOptions, type StoreSoftwareItem } from '@/components/store/catalog/storeSoftware';
import { StoreItemMark } from '@/components/store/catalog/StoreItemMark';
import { readStoreAppTemplateRef, storeAppPresetItem } from '@/components/store/presets/storePresetDoor';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useStoreActionTarget } from '@/components/settings/plugins/model/useStoreMachineScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useRegistryItems } from '@/registries/useRegistryItems';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';
import { addMachineSetupItem, addMachineSetupSoftware, containsMachineSetupItem } from './machineSetupItems';

const TEST_ID = 'machine-setup.add';

type Params = Readonly<{
  scope: AccountSettingsScope;
  name: string;
  setup: MachineSetupV1 | undefined;
  /** Adding changes the unsaved draft; the editor's Save stays the only write. */
  onChange: (next: MachineSetupV1) => void;
}>;
type Offer = Readonly<{ kind: 'setup' | 'software'; option: StoreSoftwareItem; ref: MachineRecipeReferenceV1 }>
  | Readonly<{ kind: 'app'; summary: RegistryCatalogItemSummary }>;

/** The existing preset Add dialog, reading inert Account offerings without a Machine support claim. */
export function openMachineSetupAddItems(params: Params) {
  return openCapabilityAddModalHost(MachineSetupAddItemsModal, { params }, {
    title: t('machinePresets.setup.addItemsTitle', { name: params.name }), testID: TEST_ID,
  });
}

const offerKey = (offer: Offer) => offer.kind === 'app'
  ? `app:${offer.summary.sourceId}/${offer.summary.itemId}` : actionInputOptionValueKey(offer.option.value);
const title = (offer: Offer) => offer.kind === 'app' ? offer.summary.title : offer.option.label;
const description = (offer: Offer) => offer.kind === 'app' ? offer.summary.description : offer.option.description;
const mark = (offer: Offer, size: number) => <StoreItemMark size={size} facts={offer.kind === 'app'
  ? { kind: 'app', title: offer.summary.title, brand: offer.summary.brandMark }
  : { kind: 'software', title: offer.option.label,
    bundledPluginId: offer.ref.pluginId, iconToken: offer.option.icon ?? null }} />;

function offeredItem(offer: Offer): MachinePresetItemV1 | null {
  if (offer.kind !== 'app') return { kind: offer.kind === 'software' ? 'softwareRecipe' : 'setupRecipe',
    selection: { ref: offer.ref, inputs: {} } };
  const { sourceId, itemId, version } = offer.summary;
  return version ? storeAppPresetItem(offer.summary.title, { sourceId, itemId, version }) : null;
}

export function MachineSetupAddItemsModal(props: CustomModalInjectedProps & Readonly<{ params: Params }>) {
  const { params } = props;
  const [query, setQuery] = React.useState('');
  const [mode, setMode] = React.useState('all');
  const [demanded, setDemanded] = React.useState(true);
  const [setup, setSetup] = React.useState(params.setup);
  const target = React.useMemo(() => ({ scope: params.scope, machine: null }), [params.scope]);
  const recipesDemanded = demanded && mode !== 'apps';
  const appsDemanded = demanded && (mode === 'all' || mode === 'apps');
  const recipes = useMachineSetupRecipeOptions(target, { presented: recipesDemanded });
  const software = useSoftwareOptions(target, { presented: recipesDemanded });
  const apps = useRegistryItems({ kind: 'app', query }, appsDemanded, params.scope);
  const execution = useMountedActionExecution(params.scope);
  const externalActionTarget = useStoreActionTarget(undefined, true, params.scope);
  const offers = React.useMemo((): Offer[] => {
    // The two native option projections own membership. Wait for both before classifying a recipe.
    if (!recipesDemanded || recipes.state.status !== 'ready' || software.state.status !== 'ready') return [];
    const softwareKeys = new Set(software.state.options.map(option => actionInputOptionValueKey(option.value)));
    return recipes.state.options.flatMap((option): Offer[] => {
      const ref = MachineRecipeReferenceV1Schema.safeParse(option.value);
      return ref.success ? [{ kind: softwareKeys.has(actionInputOptionValueKey(option.value)) ? 'software' : 'setup', option, ref: ref.data }] : [];
    });
  }, [recipesDemanded, recipes.state, software.state]);
  const items = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...offers.filter(offer => (mode === 'all' || mode === offer.kind)
      && (!needle || `${title(offer)} ${description(offer) ?? ''}`.toLocaleLowerCase().includes(needle))),
      ...(appsDemanded ? apps.items.map((summary): Offer => ({ kind: 'app', summary })) : [])];
  }, [offers, query, mode, appsDemanded, apps.items]);
  const contains = (offer: Offer) => {
    const item = offeredItem(offer);
    return item !== null && containsMachineSetupItem(setup, item);
  };
  const anatomy = buildCapabilityCollectionAnatomy<Offer>({
    title, description: offer => description(offer) ?? null,
    whereSummary: offer => contains(offer) ? t('machinePresets.setup.alreadyInPreset') : null,
    mark: offer => mark(offer, 26), facts: () => ({}), accessibilityLabel: title,
    testID: offer => `${TEST_ID}.row.${offerKey(offer)}`,
  });
  const failed = recipesDemanded && (recipes.state.status === 'failed' || software.state.status === 'failed')
    || appsDemanded && Boolean(apps.error);
  const retry = async () => { await Promise.all([
    ...(recipesDemanded ? [recipes.refresh(), software.refresh()] : []), ...(appsDemanded ? [apps.refresh()] : []),
  ]); };
  const failure = <SurfaceStateCard kind="error" size="line" title={t('machinePresets.setup.addItemsUnavailable')}
    action={{ label: t('common.retry'), onPress: retry }} testID={`${TEST_ID}.unavailable`} />;
  const config: CapabilityAddModalConfig<Offer> = {
    title: t('machinePresets.setup.addItemsTitle', { name: params.name }), testID: TEST_ID,
    onCatalogDemandChange: setDemanded, onModeChange: setMode,
    modes: [
      { key: 'all', kind: 'catalog', label: t('common.all'), icon: 'squares-four' },
      { key: 'setup', kind: 'catalog', label: t('machinePresets.setup.itemsGroupSetup'), icon: 'gear' },
      { key: 'software', kind: 'catalog', label: t('machinePresets.setup.itemsGroupSoftware'), icon: 'cube' },
      { key: 'apps', kind: 'catalog', label: t('machinePresets.setup.itemsGroupApps'), icon: 'rocket-launch' },
    ],
    catalog: {
      query, onQueryChange: setQuery, searchPlaceholder: t('machinePresets.setup.addItemsSearch'), items,
      itemKey: offerKey, anatomy,
      loading: recipesDemanded && (recipes.state.status === 'loading' || software.state.status === 'loading') || appsDemanded && apps.loading,
      ...(appsDemanded && apps.hasNextPage ? { loadMore: { label: t('common.more'), loading: apps.loading, onPress: apps.nextPage } } : {}),
      sourceFailures: appsDemanded ? apps.sourceFailures : [],
      footer: failed && items.length > 0 ? failure : undefined,
      empty: failed ? failure : <SurfaceStateCard kind="empty" size="line" title={t('machinePresets.setup.addItemsEmpty')} testID={`${TEST_ID}.empty`} />,
    },
    renderDetail: offer => <>
      <CapabilityDetailHeader testID={`${TEST_ID}.detail.header`} title={title(offer)} purpose={description(offer) ?? undefined}
        mark={mark(offer, 30)} facts={{}} />
      <CapabilityAddDetailAction />
    </>,
    detailFooter: offer => ({ primary: {
      label: t('machinePresets.setup.addToThisPreset'),
      ...(contains(offer) ? { disabledReason: t('machinePresets.setup.alreadyInPreset') }
        : offer.kind === 'app' && offer.summary.problem?.code === 'needs_review'
          ? { disabledReason: t('capabilities.store.appPage.needsReviewHint') } : {}),
      onPress: async () => {
        let item = offeredItem(offer);
        if (offer.kind === 'app') {
          // One explicit selected read, through the captured Account's existing Action owner; never prefetch each row.
          const value = await execution.executeValue(REGISTRY_ITEMS_READ_ACTION_ID_V1, { kind: 'app',
            sourceId: offer.summary.sourceId, itemId: offer.summary.itemId, version: offer.summary.version }, { externalActionTarget });
          // Registry Action admission already validated this same-process result.
          const read = value as ReturnType<(typeof REGISTRY_ACTION_OUTPUT_SCHEMAS_V1)[typeof REGISTRY_ITEMS_READ_ACTION_ID_V1]['parse']>;
          const templateRef = readStoreAppTemplateRef(read.item);
          if (!templateRef) throw new Error(t('capabilities.store.appPage.needsReviewHint'));
          item = storeAppPresetItem(offer.summary.title, templateRef);
        }
        if (!item) return null;
        const next = offer.kind === 'software' ? addMachineSetupSoftware(setup, offer.ref) : addMachineSetupItem(setup, item);
        if (!next.ok) return null;
        setSetup(next.setup);
        params.onChange(next.setup);
        return { itemId: offerKey(offer), then: 'stay' };
      },
    } }),
  };
  return <CapabilityAddModalBody {...props} config={config} />;
}
