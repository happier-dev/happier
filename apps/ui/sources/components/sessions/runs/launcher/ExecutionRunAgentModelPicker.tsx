import { getAgentModelConfig } from '@happier-dev/agents';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { projectAgentConnectedAccountPurposeDefaultsToSessionBindings } from '@happier-dev/protocol/account/settings/connected-services';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import type { ConnectSheetAccountRequest } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { useFirstConnection } from '@/components/projects/deployments/useFirstConnection';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { PersonalSessionModelRef } from '@happier-dev/protocol/providers/selection/v2';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';
import { ExactModelChoicePicker } from '@/components/sessions/modelPicker/useExactModelChoice';
import type { SessionModelPickerProps } from '@/components/sessions/modelPicker/SessionModelPicker';
import type { ReviewEngineListItem } from '@happier-dev/protocol/reviews/reviewEngines';
import { SessionAuthoringConnectedServicesField } from '@/components/sessions/authoring/controls/SessionAuthoringConnectedServicesField';
import { t } from '@/text';
import type { ExecutionRunLauncherBackendChoice } from './resolveExecutionRunLauncherBackendChoices';
import { useExecutionRunTeamCredentialModel } from './useExecutionRunTeamCredentialModel';
import { applyExecutionRunChildSelection, clearExecutionRunChildSelection } from './executionRunChildChoice';

/** Mount the exact Agent's Team demand only while its model detail is open. */
type AgentModelPickerProps = Readonly<{
    choice: ExecutionRunLauncherBackendChoice;
    sessionId: string | null;
    serverId: string | null;
    machineId: string | null;
    actionInput: Record<string, unknown>;
    selected: PersonalSessionModelRef | null;
    providerProtocols?: SessionModelPickerProps['providerProtocols'];
    connectedAccountPurposes?: NonNullable<ReviewEngineListItem['runnerAgents']>[number]['connectedAccountPurposes'];
    inheritedTeamCredentialModel: TeamCredentialProviderModelSelectionV1 | null;
    selectBackend: (targetKey: string) => void;
    setActionInput: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
}>;

export function ExecutionRunAgentModelPicker(props: AgentModelPickerProps) {
    const catalog = props.choice.agentCatalogEntry;
    const purposes = props.connectedAccountPurposes;
    const choice = React.useMemo(() => catalog && purposes !== undefined
        ? { ...props.choice, agentCatalogEntry: { ...catalog, connectedAccounts: catalog.connectedAccounts.filter(
            declaration => purposes.includes(declaration.purpose),
        ) } } : props.choice, [catalog, props.choice, purposes]);
    return getAgentModelConfig(props.choice.agentId)?.supportsSelection === false
        ? <ExecutionRunAccountPurposePicker {...props} choice={choice} /> : <ExecutionRunAgentModelPickerContent {...props} choice={choice} />;
}

/** Account-only engines consume their Agent declaration, with no model catalog demand. */
function ExecutionRunAccountPurposePicker(props: AgentModelPickerProps) {
    const catalog = props.choice.agentCatalogEntry;
    const parsed = ConnectedServiceBindingsV2Schema.safeParse(props.actionInput.connectedServices);
    if (!catalog?.identity) return null;
    const consumer = catalog.identity;
    const serverIdentityId = props.serverId ? getServerProfileById(props.serverId)?.serverIdentityId : null;
    const initialMachineTarget = serverIdentityId && props.machineId ? { serverIdentityId, machineId: props.machineId } : null;
    return <>{catalog.connectedAccounts.map(declaration => <ExecutionRunAccountPurposeField key={declaration.purpose}
        declaration={declaration} consumer={consumer} agentTitle={props.choice.title} initialMachineTarget={initialMachineTarget}
        bindings={parsed.success ? parsed.data : undefined} setActionInput={props.setActionInput} />)}</>;
}

function ExecutionRunAccountPurposeField(props: Readonly<{
    declaration: React.ComponentProps<typeof ConnectedAccountPurposeTargetChooser>['declaration'];
    consumer: NonNullable<NonNullable<ExecutionRunLauncherBackendChoice['agentCatalogEntry']>['identity']>;
    agentTitle: string;
    initialMachineTarget: ConnectSheetAccountRequest['initialMachineTarget'];
    bindings: SessionModelPickerProps['connectedServices'];
    setActionInput: AgentModelPickerProps['setActionInput'];
}>) {
    const { declaration, consumer } = props;
    const binding = props.bindings?.bindingsByServiceId[buildQualifiedPluginContributionKey(declaration.service)];
    const value = binding?.source === 'connected'
        ? binding.selection === 'group' ? { kind: 'group' as const, service: declaration.service, groupId: binding.groupId }
            : { kind: 'account' as const, account: { service: declaration.service, accountId: binding.profileId } }
        : null;
    const select: React.ComponentProps<typeof ConnectedAccountPurposeTargetChooser>['onChange'] = (target, teamResource) =>
        props.setActionInput(previous => ({
            ...clearExecutionRunChildSelection(previous),
            connectedServices: projectAgentConnectedAccountPurposeDefaultsToSessionBindings([{
                purpose: { consumer, purpose: declaration.purpose }, service: declaration.service, target, teamResource,
            }]),
        }));
    const connection = useFirstConnection(null, declaration.service, account => select({ kind: 'account', account }, null), props.initialMachineTarget);
    const testID = `execution-run-account:${declaration.purpose}`;
    const ownSignIn = t('connectedServices.purposeTargets.ownSignIn', { agent: props.agentTitle });
    if (connection.pending) return <SurfaceStateCard testID={`${testID}:pending`} size="line" kind="loading" title={t('common.loading')} />;
    if (connection.unavailable) return <SurfaceStateCard testID={`${testID}:unavailable`} size="line" kind="unavailable"
        title={t('settings.connectedAccounts')} reason={t('errors.connectedAccountsUnavailable')}
        action={{ label: t('common.retry'), onPress: connection.retry }} />;
    if (value === null && connection.missing) return <SurfaceStateCard testID={`${testID}:missing`} size="line" kind="unavailable"
        title={ownSignIn} reason={t('connectedServices.authModal.nativeAuthSubtitle')}
        action={{ label: t('settings.connectAccount'), onPress: connection.connect, testID: `${testID}:connect` }} />;
    return <ConnectedAccountPurposeTargetChooser testID={testID} declaration={declaration}
        localizedTextPluginId={consumer.pluginId} accountsOnly value={value}
        noneLabel={ownSignIn} onChange={select}
        addAccount={{ label: t('settings.connectAccount'), onPress: connection.connect }} />;
}

function ExecutionRunAgentModelPickerContent(props: AgentModelPickerProps) {
    const { theme } = useUnistyles();
    const setSelection = React.useCallback<React.Dispatch<React.SetStateAction<Record<string, unknown>>>>(update => {
        props.selectBackend(props.choice.targetKey);
        props.setActionInput(update);
    }, [props.choice.targetKey, props.selectBackend, props.setActionInput]);
    const team = useExecutionRunTeamCredentialModel({ ...props, selectedBackendChoice: props.choice,
        inheritedSelection: props.inheritedTeamCredentialModel,
        // Browsing another Agent does not normalize or commit the draft.
        hasBackendChoices: false, setActionInput: setSelection });
    const connectedServices = React.useMemo(() => {
        if (props.actionInput.connectedServices == null) return props.actionInput.connectedServices;
        const parsed = ConnectedServiceBindingsV2Schema.safeParse(props.actionInput.connectedServices);
        return parsed.success ? parsed.data : undefined;
    }, [props.actionInput.connectedServices]);
    const catalog = props.choice.agentCatalogEntry;
    const anchorRef = React.useRef(null);
    const chipRenderContext = React.useMemo(() => ({ chipStyle: () => null, iconColor: theme.colors.text.secondary, showLabel: true,
        textStyle: null, countTextStyle: null, chipAnchorRef: anchorRef, popoverAnchorRef: anchorRef }), [theme.colors.text.secondary]);
    const selectAccount = React.useCallback((value: SessionModelPickerProps['connectedServices']) => {
        setSelection(previous => ({ ...clearExecutionRunChildSelection(previous), connectedServices: value }));
    }, [setSelection]);
    return <>
    {catalog?.connectedAccounts.length ? <SessionAuthoringConnectedServicesField agentId={props.choice.agentId} agentIdentity={catalog.identity}
        connectedAccounts={catalog.connectedAccounts} context={{ serverId: props.serverId }} value={connectedServices}
        onChange={selectAccount} chipRenderContext={chipRenderContext} trigger="select" testID="execution-run-native-account" /> : null}
    <ExactModelChoicePicker
        agentTargetKey={buildBackendTargetKeyV2(props.choice.backendTarget)}
        agentId={props.choice.agentId}
        machineId={props.machineId}
        serverId={props.serverId}
        selected={props.selected}
        includeProviderConnectedAccounts
        connectedServices={connectedServices}
        providerProtocols={props.providerProtocols}
        teamModelChoice={team.pickerProps}
        title={t('agentInput.model.title')}
        fallbackLabel={t('runPage.menu.selectionChoose')}
        onSelect={(ref, binding) => setSelection(previous => ref
            ? applyExecutionRunChildSelection(previous, ref, binding) : clearExecutionRunChildSelection(previous))}
    /></>;
}
