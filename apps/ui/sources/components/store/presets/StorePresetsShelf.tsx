import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { readMachineSetupPresetChoices } from '@/components/settings/machines/managed/machineSetupPresetChoices';
import { machinePresetCollectionHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { ManagedPresetMark } from '@/components/settings/machines/managed/useManagedProvisionerPresentation';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { t } from '@/text';

import { Directory, ROW_MARK_PX, type DirectoryRow } from '../StoreKindPage';
import { describeStorePreset } from './StoreAddToPreset';
import { useStorePresets } from './useStorePresets';
import { StorePresetsReadFailure } from './StorePresetsReadFailure';
import { showStoreSoftwarePresetReview } from '../StoreSoftwareReview';

const NO_SERVERS: readonly string[] = [];
const NO_GROUPS: readonly [] = [];
/** Rows reach the directory only once read: it never draws its own loading for them. */
const HELD_LIST = { loading: false, hasNextPage: false } as const;

/**
 * Store → Software's Presets shelf (lab `w/kind`, S40-U3b): saved and bundled presets, each saying what it sets up.
 * Its rows are the same directory rows as Runtimes and Programs above it (one rhythm, one material). A preset opens
 * in the one P20 preset page when saved, or reviews its bundled setup on an enrolled Machine. The "+" starts a new
 * saved preset. The collection is read once the page has been
 * presented, and its held answer stays on screen while the page is hidden or refreshing.
 */
export function StorePresetsShelf(
  props: Readonly<{ presented: boolean; query: string }>,
) {
  const router = useRouter();
  const scope = useAccountSettingsScope();
  const serverId = scope?.serverId ?? null;
  const [demanded, setDemanded] = React.useState(props.presented);
  if (props.presented && !demanded) setDemanded(true);
  const serverIds = React.useMemo(
    () => (demanded && serverId ? [serverId] : NO_SERVERS),
    [demanded, serverId],
  );
  const presets = useStorePresets(serverIds);
  const projection = useAppShellPluginUiDeclarationProjection();
  const localize = usePluginLocalizedTextResolver({ projection });
  const bundled = React.useMemo(() => readMachineSetupPresetChoices([], projection, localize), [projection, localize]);
  const state = serverId ? presets.statesByServerId[serverId] : undefined;
  const query = props.query.trim().toLocaleLowerCase();
  const rows = React.useMemo(
    () =>
      [...presets.rows, ...(serverId ? bundled.map(preset => ({ serverId, preset })) : [])]
        .filter(
          (row) =>
            !query || row.preset.name.toLocaleLowerCase().includes(query),
        )
        .sort((a, b) => a.preset.name.localeCompare(b.preset.name))
        .map((row): DirectoryRow => ({
          key: `preset:${row.serverId}:${row.preset.id}`,
          title: row.preset.name,
          description: ('kind' in row.preset ? row.preset.description : describeStorePreset(row.preset)) || null,
          group: 'presets',
          mark: (
            <ManagedPresetMark
              serverId={row.serverId}
              preset={'kind' in row.preset ? {} : row.preset}
              size={ROW_MARK_PX}
            />
          ),
          // Saved rows open their page; bundled rows use the same native review as Software.
          addable: false,
          open: () => {
            if ('kind' in row.preset) {
              if (scope) showStoreSoftwarePresetReview({ name: row.preset.name, preset: row.preset, scope });
              return;
            }
            router.push(
              machinePresetCollectionHref({
                serverId: row.serverId,
                presetId: row.preset.id,
              }) as never,
            );
          },
        })),
    [presets.rows, bundled, serverId, scope, query, router],
  );
  if (!serverId) return null;
  // A search that matched no preset leaves the shelf out rather than saying "no presets" under matching software.
  if (query && rows.length === 0) return null;
  const awaiting = !state || (state.loading && state.value == null);
  const add =
    !awaiting && !state?.error ? (
      <IconButton
        testID="store.software.presets.new"
        iconName="plus"
        variant="plain"
        accessibilityLabel={t('capabilities.store.softwarePage.presetsNew')}
        onPress={() =>
          router.push(
            `/settings/machines/presets/new?serverId=${encodeURIComponent(serverId)}` as never,
          )
        }
      />
    ) : null;
  // The heading and any one-line state are a bare section; the rows are the same page directory as Runtimes and
  // Programs above, standing on the page frame beside them rather than inset inside the section.
  return (
    <>
      <ItemGroup
        testID="store.software.presets"
        surface="none"
        title={t('capabilities.store.softwarePage.presetsTitle')}
        description={t('capabilities.store.softwarePage.presetsDescription')}
        action={add}
      >
        {state?.error ? (
          <StorePresetsReadFailure testID="store.software.presets.state" error={state.error} onRetry={presets.refresh} />
        ) : rows.length === 0 ? (
          // Loading and empty share one line on the rows' edge, so the section never shifts when the answer arrives.
          <EmptyState
            testID="store.software.presets.empty"
            layout="line"
            title={
              awaiting
                ? t('machinePresets.loading')
                : t('capabilities.store.softwarePage.presetsEmpty')
            }
            lineLoading={awaiting}
          />
        ) : null}
      </ItemGroup>
      {rows.length > 0 ? (
        <Directory
          kind="software"
          label={t('capabilities.store.softwarePage.presetsTitle')}
          rows={rows}
          groups={NO_GROUPS}
          list={HELD_LIST}
          query=""
          sourceTitle={null}
          selectedKey={null}
        />
      ) : null}
    </>
  );
}
