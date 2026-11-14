import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { PageLoadingRows } from '@/components/ui/layout/PageLoadingRows';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useDeviceType } from '@/utils/platform/responsive';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { DeploymentEnvironmentDraft } from './DeploymentEnvironmentDraft';
import { useDeploymentProjectChoice } from './DeploymentProjectChoice';
import { createDeploymentActions } from './deploymentActions';
import { buildDeploymentEnvironmentHref, type DeploymentNewDefinitionKind } from './deploymentNavigation';

/** The Store/New app door holds a Project choice; the ordinary create Action commits it with the Environment. */
export function DeploymentDefinitionDraftPage(props: Readonly<{ serverId: string | null; definitionKind: DeploymentNewDefinitionKind;
  /** The Machine a "Deploy an app here" door chose (route `deployMachine`); the draft starts on it. */
  initialMachineId?: string | null }>) {
  const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
  return binding ? <DefinitionDraft key={`${binding.scope.serverId}:${binding.scope.accountId}`} lifetime={binding} definitionKind={props.definitionKind}
    initialMachineId={props.initialMachineId ?? null} />
    : <PageLoadingRows testID="project-deployments.definition.loading" header />;
}

function DefinitionDraft(props: Readonly<{ lifetime: ServerAccountScopeLifetime; definitionKind: DeploymentNewDefinitionKind; initialMachineId: string | null }>) {
  const router = useRouter();
  const phone = useDeviceType() === 'phone';
  const projectChoice = useDeploymentProjectChoice({ lifetime: props.lifetime, initiallyNew: true });
  const actions = React.useMemo(() => createDeploymentActions(props.lifetime), [props.lifetime]);
  return <DeploymentEnvironmentDraft lifetime={props.lifetime} sourceId={null} projectChoice={projectChoice}
    definitionKind={props.definitionKind} phone={phone} actions={actions} initialMachineId={props.initialMachineId}
    onDiscard={() => safeRouterBack({ router, fallbackHref: '/projects/new-app' })}
    onApprovalRequested={artifactId => router.pushRetainingCurrent(buildApprovalHref(artifactId, props.lifetime.scope.serverId))}
    onSaved={(environmentId, next) => {
      const projectSourceId = next?.projectSourceId ?? (projectChoice.selection && 'projectSourceId' in projectChoice.selection ? projectChoice.selection.projectSourceId : null);
      if (projectSourceId) router.replace(buildDeploymentEnvironmentHref({ serverId: props.lifetime.scope.serverId, projectSourceId,
        environmentId, ...(next?.tab ? { tab: next.tab } : {}) }) as never);
    }} />;
}
