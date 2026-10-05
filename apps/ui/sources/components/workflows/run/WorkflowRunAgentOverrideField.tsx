import * as React from 'react';
import type { WorkflowEngineSelectionV1, RoleEngineV1 } from '@happier-dev/protocol';
import { buildBackendTargetKeyV2, parseBackendTargetKeyV2 } from '@happier-dev/protocol';
import { RoleEngineField } from '@/components/roles/engine/RoleEngineField';
import { useRoleEnginePresentation } from '@/components/roles/catalog/useRoleEnginePresentation';
import { useRoleRailItems } from '@/components/roles/rail/useRoleRailItems';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { t } from '@/text';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

/** Only the explicit engine-group choice is editable; admission owns its resolution. */
export function WorkflowRunAgentOverrideField(props: Readonly<{
    step: string;
    value: WorkflowEngineSelectionV1 | undefined;
    onChange: (engine: WorkflowEngineSelectionV1 | undefined) => void;
    disabled: boolean;
}>) {
    const presentEngine = useRoleEnginePresentation();
    const roles = useRoleRailItems();
    const [targetUnavailable, setTargetUnavailable] = React.useState(false);
    const engine: RoleEngineV1 | undefined = props.value && 'agentTarget' in props.value ? {
        agentTargetKey: buildBackendTargetKeyV2(props.value.agentTarget),
        ...(props.value.modelSelection?.ref.modelId ? { modelId: props.value.modelSelection.ref.modelId } : {}),
        ...(props.value.effort ? { effort: props.value.effort } : {}),
    } : undefined;
    const presentation = presentEngine(engine);
    const roleId = props.value && 'role' in props.value ? props.value.role : null;
    const role = roles.find((item) => item.roleId === roleId);
    return <FieldItem label={t('workflows.start.agentForStep', { step: props.step })}
        supportingText={targetUnavailable ? t('roles.settings.engineUnavailable') : undefined}>
        <RoleEngineField engine={engine} label={role?.name ?? presentation.label ?? t('workflows.start.chooseAgent')}
            leading={role?.engineIcon ?? presentation.icon} disabled={props.disabled}
            testID="workflow-run-another-agent-field"
            roleSelection={{ value: roleId, roles, onChange: (id) => {
                if (props.disabled) return;
                setTargetUnavailable(false);
                props.onChange({ role: id });
            } }}
            onChange={(next) => {
                if (props.disabled) return;
                const agentTargetKey = resolveBackendTargetKeyV2(next.agentTargetKey);
                const target = parseBackendTargetKeyV2(agentTargetKey);
                if (target.kind !== 'agent') {
                    setTargetUnavailable(true);
                    props.onChange(undefined);
                    return;
                }
                setTargetUnavailable(false);
                props.onChange({ agentTarget: target,
                    ...(next.modelId ? { modelSelection: { v: 1, updatedAt: 0,
                        ref: { agentTargetKey, providerConnectionId: null, modelId: next.modelId } } } : {}),
                    ...(next.effort ? { effort: next.effort } : {}),
                });
            }} />
    </FieldItem>;
}
