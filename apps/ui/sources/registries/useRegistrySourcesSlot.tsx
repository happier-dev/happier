import * as React from 'react';
import type { RegistryKindV1 } from '@happier-dev/protocol/registries';

import type { CapabilityAddModalConfig } from '@/components/capabilities/add/CapabilityAddModal';
import { t } from '@/text';

import {
  RegistrySourceSelect,
  type RegistrySourceSelection,
} from './RegistrySourceSelect';
import {
  RegistrySourcesViewWithSources,
  type RegistrySourcesViewItemFromSource,
} from './RegistrySourcesView';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { useRegistrySources } from './useRegistrySources';

export type RegistrySourcesSlot = Readonly<{
  sources: NonNullable<CapabilityAddModalConfig<unknown>['sources']>;
  selection: RegistrySourceSelection;
  /** What `useRegistryItems` reads for the selection: every source, or the one chosen. */
  sourceIds: readonly string[] | undefined;
  setSelection: (next: RegistrySourceSelection) => void;
}>;

/**
 * The one glue between P4's registry components and P5's Add-modal `sources` slot (P4 I-7): it owns the selection,
 * renders the select in the tools row and the Registries view one level in. A registry added from the view becomes
 * the selection and the modal returns to the catalog on it. Skills, MCP servers and Agents all call this.
 */
export function useRegistrySourcesSlot(
  kind: RegistryKindV1,
  opts?: Readonly<{
    itemsFromSource?: (
      sourceId: string,
    ) => readonly RegistrySourcesViewItemFromSource[];
    initialSelection?: RegistrySourceSelection;
    /** Deliberate selection, distinct from withdrawal of a removed source. */
    onSelectionChange?: (next: RegistrySourceSelection) => void;
    testID?: string;
  }>,
): RegistrySourcesSlot {
  const registry = useRegistrySources(kind);
  return useRegistrySourcesSlotWithSources(kind, registry, opts);
}

/** Share the opener's source read without mounting another descriptor acquisition. */
export function useRegistrySourcesSlotWithSources(
  kind: RegistryKindV1,
  registry: ReturnType<typeof useRegistrySources>,
  opts?: Parameters<typeof useRegistrySourcesSlot>[1],
): RegistrySourcesSlot {
  const [choice, setChoice] = React.useState(() => ({
    sources: registry.sources,
    selection: opts?.initialSelection ?? 'all',
  }));
  const sourcesChanged = registry.hasValue && choice.sources !== registry.sources;
  const selection = sourcesChanged && choice.selection !== 'all'
    && !registry.sources.some(source => source.id === choice.selection && source.enabled)
    ? 'all' : choice.selection;
  if (sourcesChanged) {
    // Adjust before consumers commit a query. Only a new source list can retire a choice:
    // an acknowledged Add may select its new id before the list refresh reaches this hook.
    setChoice({ sources: registry.sources, selection });
  }
  const onSelectionChange = opts?.onSelectionChange;
  const setSelection = React.useCallback((next: RegistrySourceSelection) => {
    setChoice(previous => previous.selection === next ? previous : { ...previous, selection: next });
    onSelectionChange?.(next);
  }, [onSelectionChange]);
  const itemsFromSource = opts?.itemsFromSource;
  const testID = opts?.testID ?? `registries.${kind}`;
  const sources = React.useMemo<RegistrySourcesSlot['sources']>(
    () => ({
      renderSelect: ({ openRegistries }) => (
        <RegistrySourceSelect
          sources={registry.sources}
          value={selection}
          onChange={setSelection}
          onOpenRegistries={openRegistries}
          testID={`${testID}.select`}
        />
      ),
      // The modal's registries are a configuration body like the details: section descriptions read above their rows.
      renderRegistriesView: ({ intent, back }) => (
        <ListPresentationProvider value="page" pageInsets="contained">
          <RegistrySourcesViewWithSources
            kind={kind}
            registry={registry}
            initialIntent={intent}
            {...(itemsFromSource ? { itemsFromSource } : {})}
            onSourceAdded={(sourceId) => {
              setSelection(sourceId);
              back();
            }}
            onBack={back}
            testID={`${testID}.view`}
          />
        </ListPresentationProvider>
      ),
      registriesHeader: {
        title: t('capabilities.registries.view.title'),
        subtitle: t('capabilities.registries.view.purpose', { kind }),
      },
    }),
    [itemsFromSource, kind, registry.sources, registry.hasValue, registry.loading, registry.error,
      registry.failureStatus, registry.status, registry.refresh, selection, setSelection, testID],
  );
  const sourceIds = React.useMemo(
    () => (selection === 'all' ? undefined : [selection]),
    [selection],
  );
  return React.useMemo(
    () => ({ sources, selection, sourceIds, setSelection }),
    [selection, setSelection, sourceIds, sources],
  );
}
