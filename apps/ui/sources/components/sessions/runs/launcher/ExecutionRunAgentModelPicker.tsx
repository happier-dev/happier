import { getAgentModelConfig } from '@happier-dev/agents';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { projectAgentConnectedAccountPurposeDefaultsToSessionBindings } from '@happier-dev/protocol/account/settings/connected-services';
import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { PersonalSessionModelRef } from '@happier-dev/protocol/providers/selection/v2';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';
import { ExactModelChoicePicker } from '@/components/sessions/modelPicker/useExactModelChoice';
import type { SessionModelPickerProps } from '@/components/sessions/modelPicker/SessionModelPicker';
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
    inheritedTeamCredentialModel: TeamCredentialProviderModelSelectionV1 | null;
    selectBackend: (targetKey: string) => void;
    setActionInput: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
}>;

export function ExecutionRunAgentModelPicker(props: AgentModelPickerProps) {
    return getAgentModelConfig(props.choice.agentId)?.supportsSelection === false
        ? <ExecutionRunAccountPurposePicker {...props} /> : <ExecutionRunAgentModelPickerContent {...props} />;
}

/** Account-only engines consume their Agent declaration, with no model catalog demand. */
function ExecutionRunAccountPurposePicker(props: AgentModelPickerProps) {
    const catalog = props.choice.agentCatalogEntry;
    const parsed = ConnectedServiceBindingsV2Schema.safeParse(props.actionInput.connectedServices);
    if (!catalog?.identity) return null;
    const consumer = catalog.identity;
    return <>{catalog.connectedAccounts.map(declaration => {
        const serviceKey = buildQualifiedPluginContributionKey(declaration.service);
        const binding = parsed.success ? parsed.data?.bindingsByServiceId[serviceKey] : undefined;
        const value = binding?.source === 'connected'
            ? binding.selection === 'group' ? { kind: 'group' as const, service: declaration.service, groupId: binding.groupId }
                : { kind: 'account' as const, account: { service: declaration.service, accountId: binding.profileId } }
            : null;
        return <ConnectedAccountPurposeTargetChooser key={declaration.purpose} declaration={declaration}
            localizedTextPluginId={consumer.pluginId} accountsOnly value={value}
            onChange={(target, teamResource) => props.setActionInput(previous => ({
                ...clearExecutionRunChildSelection(previous),
                connectedServices: projectAgentConnectedAccountPurposeDefaultsToSessionBindings([{
                    purpose: { consumer, purpose: declaration.purpose }, service: declaration.service, target, teamResource,
                }]),
            }))} />;
    })}</>;
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
    {catalog ? <SessionAuthoringConnectedServicesField agentId={props.choice.agentId} agentIdentity={catalog.identity}
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
