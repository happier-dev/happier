import * as React from 'react';
import type { DeploymentEnvironmentDestinationV1 } from '@happier-dev/deployments';
import type { DeploymentFailureRecoveryDestinationV1, DeploymentFailureRecoveryNextActionV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import type { ActionOperationDomainRefV1 } from '@happier-dev/protocol/actions/operations/v1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { PLUGINS_APP_ROUTE } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { buildProjectOpenRoute } from '../activation/projectOpenRoute.mjs';
import { useNavigateToProjectOpen } from '../activation/projectOpenPresentation';
import { projectSourceRoute } from '../sources/projectSourceNavigation';
import type { DeploymentRecoveryTarget } from './deploymentActionOutcome';
import { deploymentEnvironmentRoute } from './deploymentNavigation';
import { useDeploymentAccountController } from './useDeploymentProject';
import { useDeploymentEnvironmentRecord } from './useDeploymentReads';

export type DeploymentRecoveryAddress = Extract<ActionOperationDomainRefV1, {
  kind: 'deployment' | 'deploymentEnvironment' | 'deploymentTargetLink';
}>;

/** Open the reviewed flow selected by the deployment failure owner, from any surface. */
export function useOpenDeploymentRecoveryDestination(input: Readonly<{
  serverId: string;
  sourceId: string | null;
  openEnvironmentTab: (destination: DeploymentEnvironmentDestinationV1) => void;
  openReceipt: (deploymentId: string) => void;
}>) {
  const { serverId, sourceId, openEnvironmentTab, openReceipt } = input;
  const router = useRouter();
  const navigateToProjectOpen = useNavigateToProjectOpen();
  return React.useCallback((destination: DeploymentFailureRecoveryDestinationV1, at?: DeploymentRecoveryTarget) => {
    const machineId = at?.machineId;
    switch (destination) {
      case 'history': case 'variables': case 'domains': case 'permissions': case 'settings':
        openEnvironmentTab({ tab: destination, section: null }); return;
      case 'logs':
        if (at?.deploymentId) { openReceipt(at.deploymentId); return; }
        openEnvironmentTab({ tab: 'overview', section: null }); return;
      case 'review': case 'deploy': case 'reinstall':
        openEnvironmentTab({ tab: 'overview', section: null }); return;
      case 'source':
        if (at?.openProject) navigateToProjectOpen(buildProjectOpenRoute(at.openProject, 'clone'));
        else router.push(projectSourceRoute(sourceId));
        return;
      case 'machineAdminAccess': router.push(machineId ? machinePageHref({ door: 'rail',
        target: { machineId, serverId }, tab: { id: 'security' } }) : SETTINGS_ROUTES.machines); return;
      case 'machines': case 'buildMachineSetup': router.push(machineId ? machinePageHref({ door: 'rail',
        target: { machineId, serverId }, tab: { id: 'setup' } }) : SETTINGS_ROUTES.machines); return;
      case 'registryCredentials': openEnvironmentTab({ tab: 'settings', section: 'registry' }); return;
      case 'connectedAccounts': router.push(SETTINGS_ROUTES.connectedServices); return;
      case 'store': router.push(PLUGINS_APP_ROUTE); return;
    }
  }, [navigateToProjectOpen, openEnvironmentTab, openReceipt, router, serverId, sourceId]);
}

type OperationRecoveryProps = Readonly<{
    action: DeploymentFailureRecoveryNextActionV1;
    address: DeploymentRecoveryAddress;
    onOpened: () => void;
}>;
const PRESENTED = Object.freeze({ mounted: true, visible: true, focused: true });

/** Receipt and target link references carry only the Environment's address. Its owner's exact read supplies the Source. */
function ReadDeploymentRecoveryButton(props: OperationRecoveryProps) {
    const { address } = props;
    const { binding } = useServerCredentialAccountScopeBinding(address.serverId);
    const controller = useDeploymentAccountController(binding, true, PRESENTED);
    const record = useDeploymentEnvironmentRecord(controller, address.environmentId, PRESENTED);
    if (record.snapshot.status === 'unavailable') return null;
    return <ResolvedDeploymentRecoveryButton {...props} projectSourceId={record.snapshot.value?.environment.projectSourceId ?? null} />;
}

function ResolvedDeploymentRecoveryButton(props: OperationRecoveryProps & Readonly<{ projectSourceId: string | null }>) {
    const { address, action, projectSourceId, onOpened } = props;
    const { serverId, environmentId } = address;
    const router = useRouter();
    const openEnvironmentTab = React.useCallback(({ tab, section }: DeploymentEnvironmentDestinationV1) => {
        if (projectSourceId) router.push(deploymentEnvironmentRoute({
            serverId, projectSourceId, environmentId, tab, section: section ?? undefined,
        }));
    }, [environmentId, projectSourceId, router, serverId]);
    const openReceipt = React.useCallback((deploymentId: string) => {
        if (projectSourceId) router.push(deploymentEnvironmentRoute({ serverId, projectSourceId, environmentId, deploymentId }));
    }, [environmentId, projectSourceId, router, serverId]);
    const openRecovery = useOpenDeploymentRecoveryDestination({
        serverId, sourceId: projectSourceId, openEnvironmentTab, openReceipt,
    });
    return <RoundButton
        title={action.label}
        testID="action-operation-recovery-action"
        loading={projectSourceId === null}
        disabled={projectSourceId === null}
        onPress={() => {
            openRecovery(action.destination, {
                machineId: action.machineId,
                openProject: action.openProject,
                deploymentId: address.kind === 'deployment' ? address.deploymentId : undefined,
            });
            onOpened();
        }}
    />;
}

export function DeploymentRecoveryButton(props: OperationRecoveryProps) {
    return props.address.kind === 'deploymentEnvironment'
        ? <ResolvedDeploymentRecoveryButton {...props} projectSourceId={props.address.projectSourceId} />
        : <ReadDeploymentRecoveryButton {...props} />;
}
