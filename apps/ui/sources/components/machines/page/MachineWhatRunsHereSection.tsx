import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { AllDeploymentsGroups } from '@/components/projects/deployments/AllDeploymentsScreen';
import { useDeploymentInventory } from '@/components/projects/deployments/useDeploymentProject';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';

import { machinePageHref } from './machinePageHref';

/**
 * Machine → Overview → What runs here (pfc-redesign mOv, dMachine): the Environments this Machine runs, with the one
 * environment row, read only while the Overview is on screen. Present only once there is something in it, like the
 * Overview's other work sections; Services opens the Machine's own Services tab.
 */
export function MachineWhatRunsHereSection(
  props: Readonly<{
    serverId: string;
    machineId: string;
    lifetime: ServerAccountScopeLifetime | null;
  }>,
) {
  const router = useRouter();
  const layoutPresented = useLayoutPresentationActive();
  const focused = useOptionalScreenIsFocused() !== false;
  const presented = layoutPresented && focused;
  const demand = React.useMemo(
    () => ({ mounted: true, visible: presented, focused: presented }),
    [presented],
  );
  const query = React.useMemo(
    () => ({ machineId: props.machineId }),
    [props.machineId],
  );
  const read = useDeploymentInventory(props.lifetime, demand, query);
  const items = read.snapshot.value?.items;
  const openServices = React.useCallback(() => {
    router.push(
      machinePageHref({
        door: 'rail',
        target: { serverId: props.serverId, machineId: props.machineId },
        tab: { id: 'services' },
      }) as never,
    );
  }, [props.machineId, props.serverId, router]);
  if (!items || items.length === 0) return null;
  return (
    <>
      <ItemGroup
        testID="machine.whatRunsHere"
        title={t('machineWhatRunsHere.title')}
        description={t('machineWhatRunsHere.description', {
          count: items.length,
        })}
        action={
          <SectionActionButton
            testID="machine.whatRunsHere.services"
            title={t('machineServices.tab')}
            destination
            onPress={openServices}
          />
        }
        surface="none"
      >
        {null}
      </ItemGroup>
      <AllDeploymentsGroups
        items={items}
        serverId={props.serverId}
        lifetime={props.lifetime}
        hereMachine
      />
    </>
  );
}
