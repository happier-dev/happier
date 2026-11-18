import * as React from 'react';
import type { WorkflowReplayAgentOverrideV1} from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import {
    readRoleEffortFromSessionConfigOptionOverridesV1,
    roleEffortToSessionConfigOptionOverridesV1,
    sessionSelectionToRoleEngineV1,
    type RoleEngineSessionSelectionV1,
} from '@happier-dev/protocol/prompts/roles/roleArtifactV1';
import { RoleEngineField } from '@/components/roles/engine/RoleEngineField';
import { useRoleEnginePresentation } from '@/components/roles/catalog/useRoleEnginePresentation';
import { useRoleRailItems } from '@/components/roles/rail/useRoleRailItems';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { readAuthoredSessionModelRef } from '@/sync/domains/teams/teamCredentialProviderModelSelection';
import { t } from '@/text';

/** The step's engine choice a replay swaps: a Role, or an Agent with its model and effort. */
export type WorkflowRunAgentChoice = Omit<WorkflowReplayAgentOverrideV1, 'sourceKey' | 'blockId'>;

/** Only the explicit engine-group choice is editable; admission owns its resolution. */
export function WorkflowRunAgentOverrideField(props: Readonly<{
    step: string;
    value: WorkflowRunAgentChoice | undefined;
    onChange: (engine: WorkflowRunAgentChoice | undefined) => void;
    disabled: boolean;
    serverId?: string | null;
    machineId?: string | null;
    directory?: string | null;
}>) {
    const presentEngine = useRoleEnginePresentation();
    const roles = useRoleRailItems();
    const literal = props.value?.agentTarget ? props.value : null;
    // The override is already the Session-authoring selection, effort included.
    const selection = React.useMemo<RoleEngineSessionSelectionV1>(() => literal ? {
        agentTarget: literal.agentTarget ?? undefined,
        modelSelection: literal.modelSelection ?? null,
        sessionConfigOptionOverrides: literal.sessionConfigOptionOverrides ?? null,
        teamCredentialBindings: literal.teamCredentialBindings,
    } : {}, [literal]);
    const engine = literal ? sessionSelectionToRoleEngineV1(selection) : undefined;
    const modelId = readAuthoredSessionModelRef(selection)?.modelId;
    const presentation = presentEngine(engine && modelId ? { ...engine, modelId } : engine);
    const roleId = props.value?.roleId ?? null;
    const role = roles.find((item) => item.roleId === roleId);
    return <FieldItem label={t('workflows.start.agentForStep', { step: props.step })}>
        <RoleEngineField selection={selection} label={role?.name ?? presentation.label ?? t('workflows.start.chooseAgent')}
            serverId={props.serverId} machineId={props.machineId} directory={props.directory}
            leading={role?.engineIcon ?? presentation.icon} disabled={props.disabled}
            testID="workflow-run-another-agent-field"
            roleSelection={{ value: roleId, roles, onChange: (id) => {
                if (props.disabled) return;
                props.onChange({ roleId: id });
            } }}
            onChangeSelection={(next) => {
                if (props.disabled || !next.agentTarget) return;
                const effort = readRoleEffortFromSessionConfigOptionOverridesV1(next.sessionConfigOptionOverrides);
                props.onChange({ agentTarget: next.agentTarget,
                    ...(next.modelSelection !== undefined ? { modelSelection: next.modelSelection } : {}),
                    ...(next.teamCredentialBindings !== undefined ? { teamCredentialBindings: next.teamCredentialBindings } : {}),
                    ...(effort ? { sessionConfigOptionOverrides: roleEffortToSessionConfigOptionOverridesV1(effort)! } : {}),
                });
            }} />
    </FieldItem>;
}
