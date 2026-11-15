import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildPluginsHomeRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { inventoryMachineKey } from '@/components/store/inventory/inventoryRows';
import { MANAGED_INVENTORY_PREVIEW_ROWS, ManagedInventoryDirectory } from '@/components/store/inventory/ManagedInventoryDirectory';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { MachineManagedInventorySection } from './MachineManagedInventorySection';

const NO_OPEN = () => {};

/**
 * What's on this Machine (S50 lab `i:machine`): the same inventory composition as Store → Installed,
 * scoped to the routed Machine, under one section header with Open in Installed. The Machine page owns
 * the offline cause; this section only shows what the owners hold for this Machine.
 */
export function MachineInventoryBlock(
  props: Readonly<{
    serverId: string;
    machineId: string;
    scope: ServerAccountScope | null;
    /** The page already says this Machine is offline; the section adds no outage line of its own. */
    offline?: boolean;
  }>,
) {
  const focused = useOptionalScreenIsFocused() !== false;
  const layoutPresented = useLayoutPresentationActive();
  const router = useRouter();
  const serverIdentityId =
    getServerProfileById(props.serverId)?.serverIdentityId ?? null;
  const machine = React.useMemo(
    () =>
      serverIdentityId
        ? { serverIdentityId, machineId: props.machineId }
        : null,
    [serverIdentityId, props.machineId],
  );
  const query = React.useMemo(
    () =>
      machine
        ? {
            scope: props.scope,
            machine,
            projectKey: null,
            presented: focused && layoutPresented,
          }
        : null,
    [machine, props.scope, focused, layoutPresented],
  );
  const openInInstalled = React.useCallback(() => {
    if (!props.scope || !machine) return;
    const href = buildPluginsHomeRoute('app', {
      view: 'installed',
      filters: {
        machine: {
          include: [inventoryMachineKey(props.scope, machine)],
          exclude: [],
        },
      },
    });
    const result = runGuardedNavigation(() => router.push(href as never));
    if (result !== true)
      fireAndForget(result, { tag: 'MachineInventoryBlock.openInInstalled' });
  }, [machine, props.scope, router]);
  if (!query || !props.scope) return null;
  return (
    <MachineManagedInventorySection
      query={query}
      groupBy="kind"
      openKey={null}
      onOpenChange={NO_OPEN}
    >
      {(state) =>
        state.rows.length === 0 &&
        state.attention.length === 0 &&
        (props.offline === true || state.families.every(
          (family) => family.result.coverage === 'available',
        )) ? null : (
          <>
            <ItemGroup
              testID="machine.inventory"
              title={t('storeInstalled.machineTitle')}
              description={t('storeInstalled.machineBody')}
              action={
                <SectionActionButton
                  testID="machine.inventory.openInInstalled"
                  title={t('storeInstalled.openInInstalled')}
                  destination
                  onPress={openInInstalled}
                />
              }
              surface="none"
            >
              {null}
            </ItemGroup>
            <ManagedInventoryDirectory
              state={state}
              input={query}
              groupBy="kind"
              columns={1}
              preview={MANAGED_INVENTORY_PREVIEW_ROWS}
                    nested
              offlineStatedAbove={props.offline === true}
              testIDPrefix="machine.inventory"
            />
          </>
        )
      }
    </MachineManagedInventorySection>
  );
}
