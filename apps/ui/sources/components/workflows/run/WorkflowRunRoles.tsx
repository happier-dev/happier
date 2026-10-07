import * as React from 'react';
import { View } from 'react-native';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { resolveRoleSelectionV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import type { RoleOverrideV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowMaterializedLeafV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { useRoleCatalog } from '@/components/roles/catalog/useRoleCatalog';
import { useRoleEnginePresentation } from '@/components/roles/catalog/useRoleEnginePresentation';
import { RoleEngineField } from '@/components/roles/engine/RoleEngineField';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export function workflowUsedRoleIds(definition: WorkflowDefinitionV1): readonly string[] {
    return [...new Set(walkWorkflowBlocks(definition.blocks).flatMap((block) => {
        if (block.kind !== 'step') return [];
        const engine = block.execution?.engine ?? definition.defaults.engine;
        return engine && 'role' in engine ? [engine.role] : [];
    }))];
}

/** Mounted only in the open chip. All editable effective fields come from ORC's resolver. */
export function WorkflowRunRoles(props: Readonly<{
    definition: WorkflowDefinitionV1;
    roleIds: readonly string[];
    overrides: readonly RoleOverrideV1[];
    onChange: (overrides: readonly RoleOverrideV1[]) => void;
    pending: boolean;
    prefix: string;
}>) {
    const catalog = useRoleCatalog();
    const presentEngine = useRoleEnginePresentation();
    if (catalog.status !== 'ready') return <View>
        <Text accessibilityRole={catalog.status === 'failed' ? 'alert' : undefined}>
            {catalog.status === 'failed' ? t('roles.settings.loadFailed') : t('common.loading')}
        </Text>
        {catalog.status === 'failed' ? <RoundButton size="small" title={t('common.retry')} onPress={catalog.refresh} /> : null}
    </View>;
    return <View>{props.roleIds.map((roleId) => {
        const entry = catalog.entries.find((candidate) => candidate.roleId === roleId);
        const layers = { roleId, settingsRoles: entry ? { [roleId]: entry.role } : {},
            settingsOverrides: entry?.override ? { [roleId]: entry.override } : {}, workflowRoles: props.definition.roles };
        const original = resolveRoleSelectionV1(layers);
        const current = resolveRoleSelectionV1({ ...layers, runOverrides: props.overrides });
        if (!original.ok || !current.ok) return <Text key={roleId} accessibilityRole="alert">{t('roles.settings.engineUnavailable')}</Text>;
        const override = props.overrides.find((value) => value.roleId === roleId);
        const engine = presentEngine(current.selection.engine);
        const originalEngine = presentEngine(original.selection.engine);
        const change = (patch: Partial<Omit<RoleOverrideV1, 'roleId'>>) => props.onChange([
            ...props.overrides.filter((value) => value.roleId !== roleId), { ...override, roleId, ...patch },
        ]);
        return <View key={roleId}>
            <FieldItem label={current.selection.name} supportingText={t('workflows.start.rolesUnchanged')}>
                {!pluginJsonValuesEqual(original.selection.engine ?? null, current.selection.engine ?? null)
                    ? <Text>{`${originalEngine.label ?? t('roles.rail.defaultEngine')} → ${engine.label ?? t('roles.rail.defaultEngine')}`}</Text> : null}
                <RoleEngineField engine={current.selection.engine} label={engine.label} leading={engine.icon}
                    disabled={props.pending} onChange={(value) => change({ engine: value })} testID={`${props.prefix}-role-${roleId}-engine`} />
            </FieldItem>
            <SegmentedChoiceItem title={t('workflows.page.sections.eachStepRunsIn')}
                value={current.selection.runsAs.kind} options={[
                    { id: 'session', label: t('workflows.page.sections.aSession') },
                    { id: 'background_run', label: t('workflows.page.sections.aBackgroundRun') },
                ]} disabled={props.pending} testIDPrefix={`${props.prefix}-role-${roleId}-target`}
                onChange={(kind) => change({ runsAs: kind === 'session' ? { kind: 'session' }
                    : { kind: 'background_run', intent: current.selection.runsAs.kind === 'background_run' ? current.selection.runsAs.intent : 'delegate' } })} />
            {override ? <RoundButton size="small" display="inverted" title={t('workflows.start.useYourRole')}
                disabled={props.pending} testID={`${props.prefix}-role-${roleId}-reset`}
                onPress={() => props.onChange(props.overrides.filter((value) => value.roleId !== roleId))} /> : null}
        </View>;
    })}</View>;
}

/** Repeat reads only frozen role facts, never today's mutable Settings or role catalog. */
export function WorkflowAcceptedRunRoles(props: Readonly<{ leaves: readonly WorkflowMaterializedLeafV1[] }>) {
    const presentEngine = useRoleEnginePresentation();
    const roles = [...new Map(props.leaves.flatMap((leaf) => leaf.role
        ? [[JSON.stringify([leaf.sourceKey, leaf.role.roleId]), leaf.role] as const] : [])).entries()];
    return <View>{roles.map(([key, role]) => <FieldItem key={key} label={role.name}>
        <Text>{presentEngine(role.engine).label ?? t('roles.rail.defaultEngine')}</Text>
        <Text>{role.runsAs.kind === 'session' ? t('workflows.page.sections.aSession') : t('workflows.page.sections.aBackgroundRun')}</Text>
    </FieldItem>)}</View>;
}
