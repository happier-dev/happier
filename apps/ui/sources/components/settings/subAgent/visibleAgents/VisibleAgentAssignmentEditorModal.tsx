import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
    buildBackendTargetKey,
    SESSION_PERMISSION_INTENT_INPUTS,
    VisibleAgentsTeamTemplateEntryV1Schema,
    type BackendTargetRefV1,
    type ExecutionRunRole,
    type VisibleAgentsTeamTemplateEntryV1,
} from '@happier-dev/protocol';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';

export type VisibleAgentRoleChoice = Readonly<{ id: ExecutionRunRole; label: string }>;
export type VisibleAgentBackendChoice = Readonly<{ target: BackendTargetRefV1; label: string }>;

export type VisibleAgentAssignmentEditorValue = Readonly<{
    role?: ExecutionRunRole;
    backendTarget?: BackendTargetRefV1;
    modelId?: string;
    permissionMode?: NonNullable<VisibleAgentsTeamTemplateEntryV1['permissionMode']>;
}>;

const UNSET = '__unset__';
const PERMISSION_CHOICES = SESSION_PERMISSION_INTENT_INPUTS.map((input) => ({
    input,
    value: VisibleAgentsTeamTemplateEntryV1Schema.parse({ role: 'worker', permissionMode: input }).permissionMode!,
}));

export function VisibleAgentAssignmentEditorModal(props: Readonly<{
    title: string;
    initial: VisibleAgentAssignmentEditorValue;
    roles: ReadonlyArray<VisibleAgentRoleChoice>;
    backends: ReadonlyArray<VisibleAgentBackendChoice>;
    showPermissionMode?: boolean;
    roleRequired?: boolean;
    onResolve: (value: VisibleAgentAssignmentEditorValue | null) => void;
}> & CustomModalInjectedProps) {
    const { theme } = useUnistyles();
    const [role, setRole] = React.useState<ExecutionRunRole | undefined>(props.initial.role);
    const [backendKey, setBackendKey] = React.useState(
        props.initial.backendTarget ? buildBackendTargetKey(props.initial.backendTarget) : UNSET,
    );
    const [modelId, setModelId] = React.useState(props.initial.modelId ?? '');
    const [permissionMode, setPermissionMode] = React.useState<NonNullable<VisibleAgentsTeamTemplateEntryV1['permissionMode']> | undefined>(props.initial.permissionMode);
    const [openMenu, setOpenMenu] = React.useState<'role' | 'backend' | 'permission' | null>(null);
    const selectedBackend = props.backends.find((entry) => buildBackendTargetKey(entry.target) === backendKey)?.target;
    const canSave = !props.roleRequired || Boolean(role);

    const closeWith = React.useCallback((value: VisibleAgentAssignmentEditorValue | null) => {
        props.onResolve(value);
        props.onClose();
    }, [props]);
    const footer = React.useMemo(() => (
        <View style={{ paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', justifyContent: 'flex-end', gap: 10 }}>
            <RoundButton size="normal" display="inverted" title={t('common.cancel')} onPress={() => closeWith(null)} />
            <RoundButton
                size="normal"
                title={t('common.save')}
                disabled={!canSave}
                onPress={() => closeWith({
                    ...(role ? { role } : {}),
                    ...(selectedBackend ? { backendTarget: selectedBackend } : {}),
                    ...(modelId.trim() ? { modelId: modelId.trim() } : {}),
                    ...(props.showPermissionMode && permissionMode ? { permissionMode } : {}),
                })}
            />
        </View>
    ), [canSave, closeWith, modelId, permissionMode, props.showPermissionMode, role, selectedBackend]);
    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title: props.title,
        testID: 'visible-agent-assignment-editor-modal',
        layout: 'fill' as const,
        dimensions: { width: 640, maxHeightRatio: 0.92, size: 'lg' as const },
        footer,
    }), [footer, props.title]));

    const roleItems = React.useMemo<ReadonlyArray<DropdownMenuItem>>(() => [
        ...(!props.roleRequired ? [{ id: UNSET, title: t('visibleAgents.editor.unset') }] : []),
        ...props.roles.map((entry) => ({ id: entry.id, title: entry.label })),
    ], [props.roleRequired, props.roles]);
    const backendItems = React.useMemo<ReadonlyArray<DropdownMenuItem>>(() => [
        { id: UNSET, title: t('visibleAgents.editor.unset') },
        ...props.backends.map((entry) => ({ id: buildBackendTargetKey(entry.target), title: entry.label })),
    ], [props.backends]);
    const permissionItems = React.useMemo<ReadonlyArray<DropdownMenuItem>>(() => [
        { id: UNSET, title: t('visibleAgents.editor.inheritLeadPermission') },
        ...PERMISSION_CHOICES.map((choice) => ({ id: choice.value, title: choice.input })),
    ], []);

    return (
        <ScrollView
            style={{ flex: 1 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            {...(Platform.OS === 'ios' ? { automaticallyAdjustKeyboardInsets: true } : {})}
            contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 14, paddingBottom: 18, gap: 12 }}
        >
            <ItemGroup>
                <DropdownMenu
                    open={openMenu === 'role'}
                    onOpenChange={(open) => setOpenMenu(open ? 'role' : null)}
                    items={roleItems}
                    selectedId={role ?? UNSET}
                    onSelect={(id) => setRole(id === UNSET ? undefined : id as ExecutionRunRole)}
                    rowKind="item"
                    itemTrigger={{ title: t('visibleAgents.editor.role') }}
                />
                <DropdownMenu
                    open={openMenu === 'backend'}
                    onOpenChange={(open) => setOpenMenu(open ? 'backend' : null)}
                    items={backendItems}
                    selectedId={backendKey}
                    onSelect={setBackendKey}
                    rowKind="item"
                    itemTrigger={{ title: t('visibleAgents.editor.backend') }}
                />
                {props.showPermissionMode ? (
                    <DropdownMenu
                        open={openMenu === 'permission'}
                        onOpenChange={(open) => setOpenMenu(open ? 'permission' : null)}
                        items={permissionItems}
                        selectedId={permissionMode ?? UNSET}
                        onSelect={(id) => setPermissionMode(id === UNSET
                            ? undefined
                            : PERMISSION_CHOICES.find((choice) => choice.value === id)?.value)}
                        rowKind="item"
                        itemTrigger={{ title: t('visibleAgents.editor.permission') }}
                    />
                ) : null}
            </ItemGroup>
            <Text style={{ fontSize: 13, fontWeight: '600', color: theme.colors.text.secondary }}>
                {t('visibleAgents.editor.model')}
            </Text>
            <TextInput
                testID="visible-agent-model-id"
                accessibilityLabel={t('visibleAgents.editor.model')}
                value={modelId}
                onChangeText={setModelId}
                placeholder={t('visibleAgents.editor.modelPlaceholder')}
                placeholderTextColor={theme.colors.input.placeholder}
                style={[{
                    borderWidth: 1,
                    borderColor: theme.colors.border.default,
                    borderRadius: 10,
                    paddingHorizontal: 12,
                    paddingVertical: Platform.select({ web: 10, ios: 8, default: 10 }),
                    color: theme.colors.text.primary,
                    backgroundColor: theme.colors.input.background,
                }, Typography.default()]}
            />
        </ScrollView>
    );
}
