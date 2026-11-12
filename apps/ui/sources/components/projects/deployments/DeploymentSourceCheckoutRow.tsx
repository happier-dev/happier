import * as React from 'react';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { selectSourceCheckoutWorkspaceRefs } from '@/sync/domains/workspaces/workspaceRefs';
import {
  useMachineDisplayNamesById,
  useWorkspaceRefs,
} from '@/sync/store/hooks';
import { Item } from '@/components/ui/lists/Item';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { projectSourceRoute } from '@/components/projects/sources/projectSourceNavigation';
import { useOpenProject } from '@/components/projects/useOpenProject';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';

/** The person's most recently opened checkout of this Source on this Home, when they have one. */
export function useOwnSourceCheckout(
  projectSourceId: string,
  serverId: string,
): WorkspaceRefV1 | null {
  const refs = useWorkspaceRefs();
  return React.useMemo(
    () =>
      selectSourceCheckoutWorkspaceRefs(
        Array.isArray(refs) ? refs : [],
        projectSourceId,
        serverId,
      ).reduce<WorkspaceRefV1 | null>(
        (latest, ref) =>
          latest === null ||
          (ref.lastOpenedAtMs ?? 0) > (latest.lastOpenedAtMs ?? 0)
            ? ref
            : latest,
        null,
      ),
    [refs, projectSourceId, serverId],
  );
}

/**
 * Where a deployment page reads its repository from when it was opened without a checkout (the Source's own page):
 * the person's checkout of this Source when they have one, otherwise the Source page, where one is opened.
 */
export function DeploymentSourceCheckoutRow(
  props: Readonly<{
    testID: string;
    projectSourceId: string;
    serverId: string;
    checkout: WorkspaceRefV1 | null;
    /** Why a checkout is needed here, when the person has none yet. */
    needsCheckout?: string;
  }>,
) {
  const router = useRouter();
  const openProject = useOpenProject();
  const machineIds = React.useMemo(
    () => (props.checkout ? [props.checkout.machineId] : []),
    [props.checkout],
  );
  const machineNames = useMachineDisplayNamesById(machineIds);
  const checkout = props.checkout;
  if (!checkout)
    return (
      <Item
        testID={props.testID}
        title={t('projects.deployments.editors.openSourceCheckout')}
        subtitle={props.needsCheckout}
        onPress={() =>
          router.push(projectSourceRoute(props.projectSourceId) as never)
        }
      />
    );
  const machine = machineNames[checkout.machineId];
  return (
    <Item
      testID={props.testID}
      title={t('projects.deployments.editors.openYourCheckout')}
      subtitle={[machine, formatPathRelativeToHome(checkout.rootPath)]
        .filter(Boolean)
        .join(' · ')}
      onPress={() =>
        fireAndForget(
          openProject(checkout.id, { serverId: checkout.serverId }),
          { tag: 'Deployments.openCheckout' },
        )
      }
    />
  );
}
