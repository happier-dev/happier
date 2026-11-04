import * as React from 'react';
import { View } from 'react-native';
import { resolveRoleSelectionV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { resolveRoleRunsAsKindV1 } from '@happier-dev/protocol/prompts/roles/roleArtifactV1';
import { describeRoleRunsAs } from '@/components/roles/catalog/rolePresentation';
import type { RoleOverrideV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';
import { walkWorkflowBlocks, type WorkflowDefinitionEditOpV1 } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { useRoleCatalog } from '@/components/roles/catalog/useRoleCatalog';
import { roleDisplayName } from '@/sync/domains/roles/roleCatalog';
import { useRoleEnginePresentation } from '@/components/roles/catalog/useRoleEnginePresentation';
import { RoleEngineField } from '@/components/roles/engine/RoleEngineField';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';

/** Definition-local role pins. No Settings write or per-run override is made here:
 * every edit is a draft change recorded by the editor's existing history owner. */
export function WorkflowRolesEditor(props: Readonly<{
    draft: WorkflowEditorDraft;
    onEdit: (ops: readonly WorkflowDefinitionEditOpV1[]) => void;
    prefix: string;
    editable?: boolean;
}>) {
    const catalog = useRoleCatalog();
    const presentEngine = useRoleEnginePresentation();
    const [adding, setAdding] = React.useState(false);
    const roles = props.draft.roles ?? [];
    const editable = props.editable !== false;
    const roleIds = [...new Set([
        ...roles.map((role) => role.roleId),
        ...walkWorkflowBlocks(props.draft.blocks).flatMap((block) => {
            if (block.kind !== 'step') return [];
            const engine = block.execution?.engine ?? props.draft.defaults.engine;
            return engine && 'role' in engine ? [engine.role] : [];
        }),
    ])];
    const addInline = () => {
        let ordinal = 1;
        while (roleIds.includes(`workflow_role_${ordinal}`) || catalog.entries.some((entry) => entry.roleId === `workflow_role_${ordinal}`)) ordinal += 1;
        props.onEdit([{ kind: 'upsert_role', role: { roleId: `workflow_role_${ordinal}`, name: t('roles.settings.newRoleName'),
            instructions: '', runsAs: { kind: 'session' } } }]);
    };
    return <View>
        {catalog.status === 'failed' ? <View>
            <Text accessibilityRole="alert">{t('roles.settings.loadFailed')}</Text>
            <RoundButton size="small" title={t('common.retry')} onPress={catalog.refresh} />
        </View> : null}
        {roleIds.map((roleId) => {
            const pin = roles.find((role) => role.roleId === roleId);
            const entry = catalog.entries.find((candidate) => candidate.roleId === roleId);
            const effective = resolveRoleSelectionV1({ roleId, settingsRoles: entry ? { [roleId]: entry.role } : {},
                settingsOverrides: entry?.override ? { [roleId]: entry.override } : {}, workflowRoles: roles });
            const change = (patch: Partial<Omit<RoleOverrideV1, 'roleId'>>) => {
                const next = { ...pin, roleId, ...patch };
                props.onEdit([{ kind: 'upsert_role', role: next }]);
            };
            const prefix = `${props.prefix}-role-${roleId}`;
            const inline = pin && 'name' in pin ? pin : null;
            const engine = effective.ok ? presentEngine(effective.selection.engine) : null;
            return <View key={roleId}>
                {inline ? <>
                    <FieldItem label={t('roles.settings.nameTitle')}>
                        <FieldTextInput value={inline.name} accessibilityLabel={t('roles.settings.nameTitle')}
                            testID={`${prefix}-name`} editable={editable} onChangeText={(name) => { if (editable) props.onEdit([{ kind: 'upsert_role', role: { ...inline, name } }]); }} />
                    </FieldItem>
                    <FieldItem label={t('roles.settings.instructionsTitle')}>
                        <FieldTextInput value={inline.instructions} multiline accessibilityLabel={t('roles.settings.instructionsTitle')}
                            testID={`${prefix}-instructions`} editable={editable} onChangeText={(instructions) => { if (editable) props.onEdit([{ kind: 'upsert_role', role: { ...inline, instructions } }]); }} />
                    </FieldItem>
                </> : null}
                {effective.ok ? <>
                    <FieldItem label={roleDisplayName(effective.selection)}>
                        <RoleEngineField engine={effective.selection.engine} label={engine?.label ?? null} leading={engine?.icon}
                            disabled={!editable} onChange={(value) => { if (editable) change({ engine: value }); }} testID={`${prefix}-engine`} />
                    </FieldItem>
                    <SegmentedChoiceItem title={t('roles.settings.runsAsTitle')}
                        disabled={!editable}
                        value={effective.selection.runsAs.kind} options={[
                            { id: 'session', label: describeRoleRunsAs('session') },
                            { id: 'background_run', label: describeRoleRunsAs('background_run') },
                        ]} testIDPrefix={`${prefix}-target`}
                        onChange={(kind) => change({ runsAs: resolveRoleRunsAsKindV1(kind, effective.selection.runsAs) })} />
                </> : <Text accessibilityRole="alert">{`${inline?.name ?? roleId} · ${t(catalog.status === 'loading' ? 'common.loading' : 'roles.settings.engineUnavailable')}`}</Text>}
                {pin && editable ? <RoundButton size="small" display="inverted" title={t(inline ? 'common.remove' : 'roles.session.reset')}
                    testID={`${prefix}-reset`} onPress={() => props.onEdit([{ kind: 'remove_role', roleId }])} /> : null}
            </View>;
        })}
        {!editable ? null : <DropdownMenu testID={`${props.prefix}-add-role`} open={adding} onOpenChange={setAdding} search
            trigger={({ toggle }) => <RoundButton size="small" display="inverted" title={t('roles.session.addRoleConfirm')}
                testID={`${props.prefix}-add-role-trigger`} onPress={toggle} />}
            items={[
                ...catalog.entries.filter((entry) => !roles.some((role) => role.roleId === entry.roleId))
                    .map((entry) => ({ id: `catalog:${entry.roleId}`, title: roleDisplayName({ roleId: entry.roleId, name: entry.role.name }) })),
                { id: 'new-inline-role', title: t('roles.settings.newRole'), testID: `${props.prefix}-add-role-inline` },
            ]}
            onSelect={(choiceId) => {
                setAdding(false);
                if (choiceId === 'new-inline-role') addInline();
                else {
                    const entry = catalog.entries.find((candidate) => `catalog:${candidate.roleId}` === choiceId);
                    if (entry) props.onEdit([{ kind: 'upsert_role', role: { roleId: entry.roleId } }]);
                }
            }} />}
    </View>;
}
