import * as React from 'react';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { machinePresetCollectionHref } from '@/components/settings/machines/collection/machineCollectionModel';
import {
  ManagedPresetMark,
  MANAGED_PROVISIONER_MARK_SIZE,
} from '@/components/settings/machines/managed/useManagedProvisionerPresentation';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';

import { describeStorePreset } from './StoreAddToPreset';
import { useStorePresets } from './useStorePresets';

const NO_SERVERS: readonly string[] = [];

/**
 * Store → Software's Presets shelf (lab `w/kind`, S40-U3b): the Account's own presets, each saying what it sets up.
 * A preset opens in the one P20 preset page; the "+" starts a new one there. The collection is read once the page
 * has been presented, and its held answer stays on screen while the page is hidden or refreshing.
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
  const state = serverId ? presets.statesByServerId[serverId] : undefined;
  const query = props.query.trim().toLocaleLowerCase();
  const rows = React.useMemo(
    () =>
      presets.rows
        .filter(
          (row) =>
            !query || row.preset.name.toLocaleLowerCase().includes(query),
        )
        .sort((a, b) => a.preset.name.localeCompare(b.preset.name)),
    [presets.rows, query],
  );
  if (!serverId) return null;
  // A search that matched no preset leaves the shelf out rather than saying "no presets" under matching software.
  if (query && rows.length === 0) return null;
  const awaiting = !state || (state.loading && state.value == null);
  const denied =
    state?.error === 'permission_denied' || state?.error === 'signed_out';
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
  return (
    <ItemGroup
      testID="store.software.presets"
      // Bare rows, as the Runtimes and Programs above them: one directory rhythm, not a sheet among bare sections.
      surface="none"
      title={t('capabilities.store.softwarePage.presetsTitle')}
      description={t('capabilities.store.softwarePage.presetsDescription')}
      action={add}
    >
      {state?.error ? (
        <SurfaceStateCard
          testID="store.software.presets.state"
          size="line"
          kind={denied ? 'denied' : 'unavailable'}
          title={
            denied
              ? t('machinePresets.accessLost')
              : t('capabilities.store.softwarePage.presetsFailed')
          }
          diagnosticCode={state.error}
          action={{ label: t('common.retry'), onPress: presets.refresh }}
        />
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
      ) : (
        rows.map((row) => (
          <Item
            key={`${row.serverId}:${row.preset.id}`}
            testID={`store.software.preset.${row.preset.id}`}
            rowRole="catalogRow"
            title={row.preset.name}
            subtitle={describeStorePreset(row.preset) || undefined}
            icon={
              <HappierCollectionListMark rowRole="catalogRow">
                <ManagedPresetMark
                  serverId={row.serverId}
                  preset={row.preset}
                  size={MANAGED_PROVISIONER_MARK_SIZE.row}
                />
              </HappierCollectionListMark>
            }
            showChevron
            onPress={() =>
              router.push(
                machinePresetCollectionHref({
                  serverId: row.serverId,
                  presetId: row.preset.id,
                }) as never,
              )
            }
          />
        ))
      )}
    </ItemGroup>
  );
}
