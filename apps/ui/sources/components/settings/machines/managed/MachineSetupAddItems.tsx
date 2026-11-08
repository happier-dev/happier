import * as React from 'react';
import { actionInputOptionValueKey } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import {
  MachineRecipeReferenceV1Schema,
  type MachineRecipeReferenceV1,
} from '@happier-dev/protocol/machines/setup/machineRecipeV1';

import {
  CapabilityAddDetailAction,
  CapabilityAddModalBody,
  openCapabilityAddModalHost,
  type CapabilityAddModalConfig,
} from '@/components/capabilities/add/CapabilityAddModal';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import {
  useSoftwareOptions,
  type StoreSoftwareItem,
} from '@/components/store/catalog/storeSoftware';
import { StoreItemMark } from '@/components/store/catalog/StoreItemMark';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';

import { addMachineSetupSoftware } from './machineSetupItems';

const TEST_ID = 'machine-setup.add';

type Params = Readonly<{
  scope: AccountSettingsScope;
  /** The preset's name, for the dialog's title. */
  name: string;
  setup: MachineSetupV1 | undefined;
  /** Each added item hands the editor its next unsaved setup; nothing is saved here. */
  onChange: (next: MachineSetupV1) => void;
}>;
type Offer = Readonly<{
  option: StoreSoftwareItem;
  ref: MachineRecipeReferenceV1;
}>;

/**
 * Add items (lab `p:add`): the Account's offered Software (`machines.setup.software.available` with no Machine), in
 * the one add-from-a-catalog dialog. Adding edits the open preset's draft; the editor's Save stays the only write.
 */
export function openMachineSetupAddItems(params: Params) {
  return openCapabilityAddModalHost(
    MachineSetupAddItemsModal,
    { params },
    {
      title: t('machinePresets.setup.addItemsTitle', { name: params.name }),
      testID: TEST_ID,
    },
  );
}

const offerKey = (offer: Offer) =>
  actionInputOptionValueKey(offer.option.value);
const mark = (offer: Offer, size: number) => (
  <StoreItemMark
    size={size}
    facts={{
      kind: 'software',
      title: offer.option.label,
      bundledPluginId: offer.ref.pluginId,
      iconToken: offer.option.icon ?? null,
    }}
  />
);

export function MachineSetupAddItemsModal(
  props: CustomModalInjectedProps & Readonly<{ params: Params }>,
) {
  const { params } = props;
  const [query, setQuery] = React.useState('');
  const [demanded, setDemanded] = React.useState(true);
  const [setup, setSetup] = React.useState(params.setup);
  const target = React.useMemo(
    () => ({ scope: params.scope, machine: null }),
    [params.scope],
  );
  // One demanded read per open, shared with the editor's own item names; the options owner never refetches idle.
  const software = useSoftwareOptions(target, { presented: demanded });
  const offers = React.useMemo(
    () =>
      software.state.options.flatMap((option): Offer[] => {
        // Runtimes are the setup's Mise tools (the Machine setup section), not preset items.
        const ref = MachineRecipeReferenceV1Schema.safeParse(option.value);
        return ref.success ? [{ option, ref: ref.data }] : [];
      }),
    [software.state.options],
  );
  const items = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? offers.filter((offer) =>
          `${offer.option.label} ${offer.option.description ?? ''}`
            .toLocaleLowerCase()
            .includes(needle),
        )
      : offers;
  }, [offers, query]);
  const contains = (offer: Offer) =>
    !addMachineSetupSoftware(setup, offer.ref).ok;
  const anatomy = buildCapabilityCollectionAnatomy<Offer>({
    title: (offer) => offer.option.label,
    description: (offer) => offer.option.description ?? null,
    whereSummary: (offer) =>
      contains(offer) ? t('machinePresets.setup.alreadyInPreset') : null,
    mark: (offer) => mark(offer, 26),
    facts: () => ({}),
    accessibilityLabel: (offer) => offer.option.label,
    testID: (offer) =>
      `${TEST_ID}.row.${offer.ref.pluginId}.${offer.ref.recipeId}`,
  });
  const failed = software.state.status === 'failed';
  const config: CapabilityAddModalConfig<Offer> = {
    title: t('machinePresets.setup.addItemsTitle', { name: params.name }),
    testID: TEST_ID,
    onCatalogDemandChange: setDemanded,
    modes: [
      {
        key: 'software',
        kind: 'catalog',
        label: t('machinePresets.setup.itemsGroupSoftware'),
        icon: 'cube',
      },
    ],
    catalog: {
      query,
      onQueryChange: setQuery,
      searchPlaceholder: t('machinePresets.setup.addItemsSearch'),
      items,
      itemKey: offerKey,
      anatomy,
      loading: software.state.status === 'loading',
      empty: (
        <SurfaceStateCard
          kind={failed ? 'error' : 'empty'}
          size="line"
          title={t(
            failed
              ? 'machinePresets.setup.addItemsUnavailable'
              : 'machinePresets.setup.addItemsEmpty',
          )}
          action={
            failed
              ? { label: t('common.retry'), onPress: software.refresh }
              : undefined
          }
          testID={`${TEST_ID}.empty`}
        />
      ),
    },
    renderDetail: (offer) => (
      <>
        <CapabilityDetailHeader
          testID={`${TEST_ID}.detail.header`}
          title={offer.option.label}
          purpose={offer.option.description ?? undefined}
          mark={mark(offer, 30)}
          facts={{}}
        />
        <CapabilityAddDetailAction />
      </>
    ),
    detailFooter: (offer) => {
      const held = contains(offer);
      return {
        primary: {
          label: t('machinePresets.setup.addToThisPreset'),
          ...(held
            ? { disabledReason: t('machinePresets.setup.alreadyInPreset') }
            : {}),
          onPress: async () => {
            const next = addMachineSetupSoftware(setup, offer.ref);
            if (!next.ok) return null;
            setSetup(next.setup);
            params.onChange(next.setup);
            return { itemId: offerKey(offer), then: 'stay' };
          },
        },
      };
    },
  };
  return <CapabilityAddModalBody {...props} config={config} />;
}
