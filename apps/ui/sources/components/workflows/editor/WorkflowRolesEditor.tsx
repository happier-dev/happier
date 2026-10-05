import * as React from 'react';
import { View } from 'react-native';
import { resolveRoleSelectionV1, type RoleOverrideV1, type WorkflowRoleV1 } from '@happier-dev/protocol';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { useRoleCatalog } from '@/components/roles/catalog/useRoleCatalog';
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
    onChange: (next: WorkflowEditorDraft) => void;
    prefix: string;
}>) {
    const catalog = useRoleCatalog();
    const presentEngine = useRoleEnginePresentation();
    const [adding, setAdding] = React.useState(false);
    const roles = props.draft.roles ?? [];
    const roleIds = [...new Set([
        ...roles.map((role) => role.roleId),
        ...walkWorkflowBlocks(props.draft.blocks).flatMap((block) => {
            if (block.kind !== 'step') return [];
            const engine = block.execution?.engine ?? props.draft.defaults.engine;
            return engine && 'role' in engine ? [engine.role] : [];
        }),
    ])];
    const update = (next: WorkflowRoleV1[]) => props.onChange({ ...props.draft, roles: next });
    const addInline = () => {
        let ordinal = 1;
        while (roleIds.includes(`workflow_role_${ordinal}`) || catalog.entries.some((entry) => entry.roleId === `workflow_role_${ordinal}`)) ordinal += 1;
        update([...roles, { roleId: `workflow_role_${ordinal}`, name: t('roles.settings.newRoleName'),
            instructions: '', runsAs: { kind: 'session' } }]);
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
                update(pin ? roles.map((role) => role.roleId === roleId ? next : role) : [...roles, next]);
            };
            const prefix = `${props.prefix}-role-${roleId}`;
            const inline = pin && 'name' in pin ? pin : null;
            const engine = effective.ok ? presentEngine(effective.selection.engine) : null;
            return <View key={roleId}>
                {inline ? <>
                    <FieldItem label={t('roles.settings.nameTitle')}>
                        <FieldTextInput value={inline.name} accessibilityLabel={t('roles.settings.nameTitle')}
                            testID={`${prefix}-name`} onChangeText={(name) => update(roles.map((role) => role.roleId === roleId ? { ...inline, name } : role))} />
                    </FieldItem>
                    <FieldItem label={t('roles.settings.instructionsTitle')}>
                        <FieldTextInput value={inline.instructions} multiline accessibilityLabel={t('roles.settings.instructionsTitle')}
                            testID={`${prefix}-instructions`} onChangeText={(instructions) => update(roles.map((role) => role.roleId === roleId ? { ...inline, instructions } : role))} />
                    </FieldItem>
                </> : null}
                {effective.ok ? <>
                    <FieldItem label={effective.selection.name}>
                        <RoleEngineField engine={effective.selection.engine} label={engine?.label ?? null} leading={engine?.icon}
                            onChange={(value) => change({ engine: value })} testID={`${prefix}-engine`} />
                    </FieldItem>
                    <SegmentedChoiceItem title={t('roles.settings.runsAsTitle')}
                        value={effective.selection.runsAs.kind} options={[
                            { id: 'session', label: t('workflows.page.sections.aSession') },
                            { id: 'background_run', label: t('workflows.page.sections.aBackgroundRun') },
                        ]} testIDPrefix={`${prefix}-target`}
                        onChange={(kind) => change({ runsAs: kind === 'session' ? { kind: 'session' }
                            : { kind: 'background_run', intent: effective.selection.runsAs.kind === 'background_run' ? effective.selection.runsAs.intent : 'delegate' } })} />
                </> : <Text accessibilityRole="alert">{`${inline?.name ?? roleId} · ${t(catalog.status === 'loading' ? 'common.loading' : 'roles.settings.engineUnavailable')}`}</Text>}
                {pin ? <RoundButton size="small" display="inverted" title={t(inline ? 'common.remove' : 'roles.session.reset')}
                    testID={`${prefix}-reset`} onPress={() => update(roles.filter((role) => role.roleId !== roleId))} /> : null}
            </View>;
        })}
        <DropdownMenu testID={`${props.prefix}-add-role`} open={adding} onOpenChange={setAdding} search
            trigger={({ toggle }) => <RoundButton size="small" display="inverted" title={t('roles.session.addRoleConfirm')}
                testID={`${props.prefix}-add-role-trigger`} onPress={toggle} />}
            items={[
                ...catalog.entries.filter((entry) => !roles.some((role) => role.roleId === entry.roleId))
                    .map((entry) => ({ id: `catalog:${entry.roleId}`, title: entry.role.name })),
                { id: 'new-inline-role', title: t('roles.settings.newRole'), testID: `${props.prefix}-add-role-inline` },
            ]}
            onSelect={(choiceId) => {
                setAdding(false);
                if (choiceId === 'new-inline-role') addInline();
                else {
                    const entry = catalog.entries.find((candidate) => `catalog:${candidate.roleId}` === choiceId);
                    if (entry) update([...roles, { roleId: entry.roleId }]);
                }
            }} />
    </View>;
}
