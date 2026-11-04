import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_PICKS_SOURCE_ID,
  type RegistryKindV1,
  type RegistrySourceDescriptorV1,
} from '@happier-dev/protocol/registries';

import { SelectionList, SelectionListFilterChip } from '@/components/ui/selectionList';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import {
  registryFormatIcon,
  registrySourceKindLabel,
} from './registrySourcePresentation';
import { useRegistrySources } from './useRegistrySources';

export type RegistrySourceSelection = 'all' | string;

/** Happier picks lead, then built-ins, plugin sources and the sources the person added (their own order). */
export function orderRegistrySourcesForSelect(
  sources: readonly RegistrySourceDescriptorV1[],
): readonly RegistrySourceDescriptorV1[] {
  const rank = (source: RegistrySourceDescriptorV1) =>
    source.id === HAPPIER_PICKS_SOURCE_ID
      ? 0
      : source.origin.kind === 'built_in'
        ? 1
        : source.origin.kind === 'plugin'
          ? 2
          : 3;
  return [...sources]
    .filter((source) => source.enabled)
    .sort((a, b) => rank(a) - rank(b));
}

/**
 * The registry chip of every Add modal's tools row (P4 I-7): All registries, then each source that lists this kind with
 * its kind as a quiet fact, then "Add a registry…" and "Manage registries" in their own section.
 */
export function RegistrySourceSelect(
  props: Readonly<{
    kind: RegistryKindV1;
    value: RegistrySourceSelection;
    onChange: (next: RegistrySourceSelection) => void;
    onOpenRegistries: (intent: 'manage' | 'add') => void;
    testID: string;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const { sources } = useRegistrySources(props.kind);
  const mark = React.useCallback(
    (name: Parameters<typeof Icon>[0]['name']) => (
      <Icon
        name={name}
        size={ICON_SIZE.sm}
        color={theme.colors.text.secondary}
      />
    ),
    [theme.colors.text.secondary],
  );
  const options = React.useMemo(
    () => [
      {
        id: 'all',
        label: t('capabilities.registries.select.all'),
        icon: mark('stack'),
      },
      ...orderRegistrySourcesForSelect(sources).map((source) => ({
        id: source.id,
        label: source.title,
        icon: mark(registryFormatIcon(source)),
        subtitle: registrySourceKindLabel(source),
      })),
    ],
    [mark, sources],
  );
  const operations = React.useMemo(
    () => [
      {
        id: REGISTRY_ADD_ID,
        label: t('capabilities.registries.select.addRegistry'),
        icon: mark('plus'),
      },
      {
        id: REGISTRY_MANAGE_ID,
        label: t('capabilities.registries.select.manage'),
        icon: mark('sliders-horizontal'),
      },
    ],
    [mark],
  );
  // A selected source that went away (removed, turned off) reads as All rather than a stale name.
  const value =
    props.value === 'all' || options.some((option) => option.id === props.value)
      ? props.value
      : 'all';
  const selected = options.find((option) => option.id === value) ?? options[0];
  return (
    <SelectionListFilterChip filter={{
      id: 'registry-source',
      testID: props.testID,
      label: t('capabilities.registries.select.label'),
      valueLabel: selected?.label ?? '',
      ...(selected?.icon ? { icon: selected.icon } : {}),
      renderPopoverContent: ({ close, maxHeight }) => (
        <SelectionList
          testID={`${props.testID}.list`}
          listAccessibilityLabel={t('capabilities.registries.select.label')}
          onRequestClose={close}
          maxHeight={maxHeight}
          disableTransitions
          rootStep={{ id: 'registry-sources', sections: [
            { kind: 'static', id: 'sources', options },
            { kind: 'static', id: 'operations', options: operations },
          ] }}
          selectedOptionId={value}
          onSelect={(id) => {
            close();
            // An operation never changes the choice.
            if (id === REGISTRY_ADD_ID) props.onOpenRegistries('add');
            else if (id === REGISTRY_MANAGE_ID) props.onOpenRegistries('manage');
            else props.onChange(id);
          }}
        />
      ),
    }} />
  );
}

const REGISTRY_ADD_ID = 'action:add';
const REGISTRY_MANAGE_ID = 'action:manage';
