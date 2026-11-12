import * as React from 'react';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';

import { SessionModelPicker, type SessionModelPickerProps } from '@/components/sessions/modelPicker/SessionModelPicker';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import { useConfirmExperimentalProviderModel } from '@/providers/hooks/useConfirmExperimentalProviderModel';
import { useProviderSettingsForServer } from '@/providers/hooks/useProviderSettings';
import { hiddenModelVisibilityKeys } from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import { providerDeclarationContext, PROVIDER_DECLARATION_CONTEXT_SECTIONS } from '@/providers/catalog/accountProviderDeclarations';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useTeamCredentialSelectionCoordinator } from '@/components/sessions/teamCredentials/useTeamCredentialSelectionCoordinator';
import { resourceHasAvailableTeamCredentialProviderModel } from '@/components/sessions/teamCredentials/teamCredentialProviderModelCurrentness';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { teamCredentialDetailPath } from '@/components/settings/teams/teamsRoutes';

/** Mounted by the open model field; unopened Voice settings do no catalog work. */
export function VoiceAgentModelPicker(props: Readonly<{
  machineId: string | null;
  serverId: string | null;
  picker: Omit<SessionModelPickerProps, 'providerGroups' | 'providerProjectionAuthoritative' | 'declarationContext'>;
  onSelectTeamCredentialModel: (selection: TeamCredentialProviderModelSelectionV1) => void;
}>) {
  const providersEnabled = useFeatureEnabled('providers');
  const router = useRouter();
  const declarations = useDaemonMergedProjectionInputs({ machineId: props.machineId, serverId: props.serverId,
    enabled: Boolean(props.machineId), sections: PROVIDER_DECLARATION_CONTEXT_SECTIONS });
  const declarationProjection = declarations.phase === 'ready' ? declarations.inputs?.pluginProjectionV2 ?? null : null;
  const catalog = useHomeTeamCredentialModelCatalog({ serverId: props.serverId, machineId: props.machineId,
    declarationProjection, enabled: true, agentTargetKey: props.picker.agentTargetKey });
  const projection = useProviderModelProjection({ serverId: props.serverId, machineId: props.machineId,
    enabled: providersEnabled, agentTargetKey: props.picker.agentTargetKey, mode: 'picker',
    currentSelection: props.picker.selected ?? undefined });
  const providerSettings = useProviderSettingsForServer(props.serverId);
  const hiddenNativeModelKeys = React.useMemo(() => hiddenModelVisibilityKeys(providerSettings,
    { providersFeatureEnabled: providersEnabled }), [providerSettings.modelVisibilityByRef, providersEnabled]);
  const experimentalConfirmation = useConfirmExperimentalProviderModel({ enabled: providersEnabled,
    machineId: props.machineId, serverId: props.serverId, agentTargetKey: props.picker.agentTargetKey,
    refresh: projection.refresh });
  const coordinateSelection = useTeamCredentialSelectionCoordinator(props.serverId);
  const current = React.useRef({ catalog, props });
  current.current = { catalog, props };
  const selectTeamModel = async (selection: TeamCredentialProviderModelSelectionV1) => {
    const resource = catalog.resources.find(resource => resource.teamId === selection.teamId && resource.id === selection.resourceId
      && resourceHasAvailableTeamCredentialProviderModel(resource, selection));
    if (!resource) return;
    const isCurrent = () => current.current.props.serverId === props.serverId
      && current.current.props.machineId === props.machineId
      && current.current.props.picker.agentTargetKey === selection.agentTargetKey
      && current.current.catalog.resourceStatusByKey.get(`${selection.teamId}:${selection.resourceId}`)?.kind === 'current'
      && current.current.catalog.resources.some(resource => resource.teamId === selection.teamId && resource.id === selection.resourceId
        && resourceHasAvailableTeamCredentialProviderModel(resource, selection));
    const outcome = await coordinateSelection({ resource, deliveryMode: selection.deliveryMode, selection, isCurrent });
    if (outcome.kind === 'continue') current.current.props.onSelectTeamCredentialModel(outcome.selection);
  };
  return <SessionModelPicker {...props.picker}
    declarationContext={providerDeclarationContext(props.machineId, declarationProjection)}
    providerGroups={projection.data?.groups ?? []}
    hiddenSources={projection.data?.hiddenSources}
    hiddenNativeModelKeys={hiddenNativeModelKeys}
    experimentalConfirmation={experimentalConfirmation}
    providerProjectionAuthoritative={projection.status === 'success'}
    projectionError={projection.error}
    projectionFailures={projection.refreshFailures}
    projectionApproval={projection.pendingApproval}
    retryProjection={projection.refresh}
    currentSelectionRecovery={projection.data?.currentSelectionRecovery ?? null}
    teamCredentialResources={catalog.resources}
    teamCredentialResourceStatusByKey={catalog.resourceStatusByKey}
    teamNameById={catalog.teamNameById}
    homeNameByTeamId={catalog.homeNameByTeamId}
    onRecoverTeamCredentialResource={resource => {
      if (props.serverId) router.push(teamCredentialDetailPath({ serverId: props.serverId, teamId: resource.teamId }, resource.id));
    }}
    onSelectTeamCredentialModel={selection => { void selectTeamModel(selection); }}
    sourceBrowse={providersEnabled ? { machineId: props.machineId, serverId: props.serverId } : undefined}
  />;
}
