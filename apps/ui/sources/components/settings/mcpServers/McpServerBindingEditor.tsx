import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Modal } from '@/modal';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import type { McpServerBindingTargetV1, McpServerBindingV1, McpServerCatalogEntryTransportV1 } from '@happier-dev/protocol';

import { McpWorkspaceRootPickerModal } from './McpWorkspaceRootPickerModal';
import { McpBindingOverridesEditorModal } from './McpBindingOverridesEditorModal';
import { McpBindingTargetFields, describeBindingTarget } from './McpBindingTargetFields';
import { resolveMcpBindingTargetTypeChange } from './resolveMcpBindingTarget';
import { Icon } from '@/components/ui/icons/Icon';

export const McpServerBindingEditor = React.memo(function McpServerBindingEditor(props: Readonly<{
    binding: McpServerBindingV1;
    serverTransport: McpServerCatalogEntryTransportV1;
    secrets: SavedSecret[];
    scope?: AccountSettingsScope | null;
    machines: readonly Machine[];
    onChange: (next: McpServerBindingV1) => void;
    onDelete: () => void;
}>) {
    const styles = stylesheet;
    const [expanded, setExpanded] = React.useState(false);
    const [favoriteDirectoriesRaw, setFavoriteDirectoriesRaw] = useSettingMutable('favoriteDirectories');
    const favoriteDirectories = Array.isArray(favoriteDirectoriesRaw) ? favoriteDirectoriesRaw : [];
    const selectedTargetSummary = React.useMemo(
        () => describeBindingTarget(props.binding.target, props.machines),
        [props.binding.target, props.machines],
    );

    const update = React.useCallback((updater: (current: McpServerBindingV1) => McpServerBindingV1) => {
        props.onChange(updater(props.binding));
    }, [props]);

    const setTargetType = React.useCallback((nextType: McpServerBindingTargetV1['t'], selectedMachineId?: string) => {
        update((current) => {
            const now = Date.now();
            const nextTarget = resolveMcpBindingTargetTypeChange(current.target, nextType, props.machines, selectedMachineId);
            if (!nextTarget) {
                Modal.alert(t('common.error'), t('settings.mcpServersNoMachineSelected'));
                return current;
            }

            return { ...current, target: nextTarget, updatedAt: now };
        });
    }, [props.machines, update]);

    const setMachineId = React.useCallback((machineId: string) => {
        update((current) => {
            const now = Date.now();
            const t0 = current.target;
            if (t0.t === 'machine') return { ...current, target: { ...t0, machineId }, updatedAt: now };
            if (t0.t === 'workspace') return { ...current, target: { ...t0, machineId }, updatedAt: now };
            return current;
        });
    }, [update]);

    const setWorkspaceRoot = React.useCallback((workspaceRoot: string) => {
        update((current) => {
            const now = Date.now();
            const t0 = current.target;
            if (t0.t !== 'workspace') return current;
            return { ...current, target: { ...t0, workspaceRoot }, updatedAt: now };
        });
    }, [update]);

    const openWorkspacePicker = React.useCallback(() => {
        const target = props.binding.target;
        if (target.t !== 'workspace') return;
        const machine = props.machines.find((m) => m.id === target.machineId) ?? null;
        const homeDir = machine?.metadata?.homeDir || '/home';
        Modal.show({
            component: McpWorkspaceRootPickerModal,
            props: {
                machineId: target.machineId,
                machineHomeDir: homeDir,
                machinePlatform: machine?.metadata?.platform ?? null,
                selectedPath: target.workspaceRoot,
                onSelectPath: setWorkspaceRoot,
                favoriteDirectories,
                onChangeFavoriteDirectories: setFavoriteDirectoriesRaw,
            },
            chrome: {
                kind: 'card',
                title: t('settings.mcpServersPickWorkspaceTitle'),
                dimensions: { size: 'lg' },
            },
            closeOnBackdrop: true,
        });
    }, [favoriteDirectories, props.binding.target, props.machines, setFavoriteDirectoriesRaw, setWorkspaceRoot]);

    const openOverrides = React.useCallback(() => {
        Modal.show({
            component: McpBindingOverridesEditorModal,
            props: {
                binding: props.binding,
                serverTransport: props.serverTransport,
                secrets: props.secrets,
                ...(props.scope === undefined ? {} : { scope: props.scope }),
                onSubmit: props.onChange,
            },
            chrome: {
                kind: 'card',
                title: t('settings.mcpServersBindingOverridesTitle'),
                dimensions: { size: 'lg' },
            },
            closeOnBackdrop: true,
        });
    }, [props.binding, props.onChange, props.secrets, props.serverTransport, props.scope]);

    const overridesSummary = React.useMemo(() => {
        const overrides = props.binding.overrides;
        if (!overrides) return t('settings.mcpServersBindingOverridesNone');
        let count = 0;
        if (overrides.envPatch && Object.keys(overrides.envPatch).length > 0) count += Object.keys(overrides.envPatch).length;
        if (overrides.remote?.headersPatch && Object.keys(overrides.remote.headersPatch).length > 0) count += Object.keys(overrides.remote.headersPatch).length;
        if (overrides.stdio?.command !== undefined) count += 1;
        if (overrides.stdio?.args !== undefined) count += 1;
        if (overrides.remote?.url !== undefined) count += 1;
        if (count === 0) return t('settings.mcpServersBindingOverridesNone');
        return t('settings.mcpServersBindingOverridesCount', { count });
    }, [props.binding.overrides]);

    const toggleEnabled = React.useCallback((value: boolean) => {
        update((b) => ({ ...b, enabled: value, updatedAt: Date.now() }));
    }, [update]);

    return (
        <ExpandableItem
            testID={`mcp.server.binding.${props.binding.id}`}
            expanded={expanded}
            onExpandedChange={setExpanded}
            header={({ headerProps }) => (
                <Item
                    {...headerProps}
                    testID={`mcp.server.binding.${props.binding.id}.header`}
                    title={selectedTargetSummary}
                    subtitle={props.binding.enabled ? overridesSummary : t('common.disabled')}
                    titleStyle={props.binding.enabled ? undefined : styles.disabledTitle}
                    rightElementOutsidePressable
                    rightElement={(
                        <Switch
                            accessibilityLabel={t('settings.mcpServersBindingEnabled')}
                            value={props.binding.enabled}
                            onValueChange={toggleEnabled}
                        />
                    )}
                    showChevron={false}
                />
            )}
        >
            <McpBindingTargetFields
                target={props.binding.target}
                machines={props.machines}
                onChangeTargetType={setTargetType}
                onChangeMachineId={setMachineId}
                onOpenWorkspacePicker={openWorkspacePicker}
            />

            <Item
                title={t('settings.mcpServersBindingOverridesTitle')}
                icon={<Icon name="sliders-horizontal" />}
                subtitle={overridesSummary}
                onPress={openOverrides}
            />

            <View style={styles.actions}>
                <RoundButton
                    testID={`mcp.server.binding.${props.binding.id}.delete`}
                    size="small"
                    display="destructive"
                    title={t('common.delete')}
                    accessibilityHint={t('settings.mcpServersBindingDeleteSubtitle')}
                    onPress={props.onDelete}
                />
            </View>
        </ExpandableItem>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        paddingHorizontal: 16,
        paddingTop: 4,
        paddingBottom: 16,
    },
    disabledTitle: {
        color: theme.colors.text.secondary,
    },
}));
