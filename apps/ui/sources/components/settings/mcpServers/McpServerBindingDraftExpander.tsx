import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';

import { McpServerBindingV1Schema, type McpServerBindingTargetV1, type McpServerBindingV1 } from '@happier-dev/protocol';

import { McpBindingTargetFields, describeBindingTarget } from '@/components/settings/mcpServers/McpBindingTargetFields';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { McpWorkspaceRootPickerModal } from './McpWorkspaceRootPickerModal';
import { createDefaultMcpBindingTarget, resolveMcpBindingTargetTypeChange } from './resolveMcpBindingTarget';

function createDraftBinding(serverId: string, machines: readonly Machine[]): McpServerBindingV1 {
    const now = Date.now();
    return {
        id: randomUUID(),
        serverId,
        enabled: true,
        target: createDefaultMcpBindingTarget(machines),
        createdAt: now,
        updatedAt: now,
    };
}

export const McpServerBindingDraftExpander = React.memo(function McpServerBindingDraftExpander(props: Readonly<{
    serverId: string;
    machines: readonly Machine[];
    favoriteDirectories: string[];
    onChangeFavoriteDirectories: (next: string[]) => void;
    onAddBinding: (binding: McpServerBindingV1) => void;
    expandedContainerStyle?: React.ComponentProps<typeof InlineAddExpander>['expandedContainerStyle'];
}>) {
    const { theme } = useUnistyles();
    const [isOpen, setIsOpen] = React.useState(false);
    const [draftBinding, setDraftBinding] = React.useState<McpServerBindingV1>(() => createDraftBinding(props.serverId, props.machines));
    const draftBindingParse = React.useMemo(() => McpServerBindingV1Schema.safeParse(draftBinding), [draftBinding]);

    React.useEffect(() => {
        setDraftBinding((current) => ({ ...current, serverId: props.serverId }));
    }, [props.serverId]);

    const resetDraftBinding = React.useCallback(() => {
        setDraftBinding(createDraftBinding(props.serverId, props.machines));
    }, [props.machines, props.serverId]);

    const updateDraftBinding = React.useCallback((updater: (current: McpServerBindingV1) => McpServerBindingV1) => {
        setDraftBinding((current) => updater(current));
    }, []);

    const setDraftBindingTargetType = React.useCallback((nextType: McpServerBindingTargetV1['t']) => {
        updateDraftBinding((current) => {
            const now = Date.now();
            const nextTarget = resolveMcpBindingTargetTypeChange(current.target, nextType, props.machines);
            if (!nextTarget) {
                Modal.alert(t('common.error'), t('settings.mcpServersNoMachineSelected'));
                return current;
            }

            return {
                ...current,
                target: nextTarget,
                updatedAt: now,
            };
        });
    }, [props.machines, updateDraftBinding]);

    const setDraftBindingMachineId = React.useCallback((machineId: string) => {
        updateDraftBinding((current) => {
            const now = Date.now();
            if (current.target.t === 'allMachines') return current;
            return { ...current, target: { ...current.target, machineId }, updatedAt: now };
        });
    }, [updateDraftBinding]);

    const openDraftWorkspacePicker = React.useCallback(() => {
        const { target } = draftBinding;
        if (target.t !== 'workspace') return;
        const machine = props.machines.find((item) => item.id === target.machineId) ?? null;
        const homeDir = machine?.metadata?.homeDir || '/home';
        Modal.show({
            component: McpWorkspaceRootPickerModal,
            props: {
                machineId: target.machineId,
                machineHomeDir: homeDir,
                machinePlatform: machine?.metadata?.platform ?? null,
                selectedPath: target.workspaceRoot,
                onSelectPath: (workspaceRoot: string) =>
                    updateDraftBinding((current) => {
                        if (current.target.t !== 'workspace') return current;
                        return {
                            ...current,
                            target: { ...current.target, workspaceRoot },
                            updatedAt: Date.now(),
                        };
                    }),
                favoriteDirectories: props.favoriteDirectories,
                onChangeFavoriteDirectories: props.onChangeFavoriteDirectories,
            },
            chrome: {
                kind: 'card',
                title: t('settings.mcpServersPickWorkspaceTitle'),
                dimensions: { size: 'lg' },
            },
            closeOnBackdrop: true,
        });
    }, [
        draftBinding,
        props.favoriteDirectories,
        props.machines,
        props.onChangeFavoriteDirectories,
        updateDraftBinding,
    ]);

    const handleCancel = React.useCallback(() => {
        setIsOpen(false);
        resetDraftBinding();
    }, [resetDraftBinding]);

    const handleSave = React.useCallback(() => {
        if (!draftBindingParse.success) {
            Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
            return;
        }
        props.onAddBinding(draftBindingParse.data);
        setIsOpen(false);
        resetDraftBinding();
    }, [draftBindingParse, props, resetDraftBinding]);

    return (
        <ItemGroup>
            <InlineAddExpander
                isOpen={isOpen}
                onOpenChange={(nextOpen) => {
                    setIsOpen(nextOpen);
                    if (nextOpen) {
                        resetDraftBinding();
                    } else {
                        handleCancel();
                    }
                }}
                title={t('settings.mcpServersAddApplyRule')}
                subtitle={t('settings.mcpServersAddApplyRuleSubtitle')}
                icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.state.success.foreground} />}
                helpText={t('settings.mcpServersAddApplyRuleHelp')}
                onCancel={handleCancel}
                onSave={handleSave}
                saveDisabled={!draftBindingParse.success}
                cancelLabel={t('common.cancel')}
                saveLabel={t('settings.mcpServersAddApplyRuleSave')}
                expandedContainerStyle={props.expandedContainerStyle}
            >
                <Text style={styles.draftBindingSummary}>
                    {describeBindingTarget(draftBinding.target, props.machines)}
                </Text>
                <McpBindingTargetFields
                    target={draftBinding.target}
                    machines={props.machines}
                    onChangeTargetType={setDraftBindingTargetType}
                    onChangeMachineId={setDraftBindingMachineId}
                    onOpenWorkspacePicker={openDraftWorkspacePicker}
                />
            </InlineAddExpander>
        </ItemGroup>
    );
});

const styles = StyleSheet.create((theme) => ({
    draftBindingSummary: {
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
        marginBottom: 12,
    },
}));
