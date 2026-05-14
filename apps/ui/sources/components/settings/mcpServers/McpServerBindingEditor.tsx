import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { McpServerBindingTargetV1, McpServerBindingV1, McpServerCatalogEntryTransportV1 } from '@happier-dev/protocol';

import { McpWorkspaceRootPickerModal } from './McpWorkspaceRootPickerModal';
import { McpBindingOverridesEditorModal } from './McpBindingOverridesEditorModal';
import { McpBindingTargetFields, describeBindingTarget } from './McpBindingTargetFields';
import { resolveMcpBindingTargetTypeChange } from './resolveMcpBindingTarget';

const stylesheet = StyleSheet.create((theme) => ({
    groupHeader: {
        gap: 2,
    },
    groupHeaderTitle: {
        ...Typography.default('regular'),
        color: theme.colors.text.secondary,
        fontSize: 14,
        lineHeight: 20,
        textTransform: 'uppercase',
        fontWeight: '500',
    },
    groupHeaderSubtitle: {
        ...Typography.default('regular'),
        color: theme.colors.text.secondary,
        fontSize: 14,
        lineHeight: 20,
    },
    groupHeaderSummary: {
        ...Typography.default('regular'),
        color: theme.colors.text.secondary,
        fontSize: 14,
        lineHeight: 20,
        marginTop: 8,
    },
}));

export const McpServerBindingEditor = React.memo(function McpServerBindingEditor(props: Readonly<{
    binding: McpServerBindingV1;
    serverTransport: McpServerCatalogEntryTransportV1;
    secrets: SavedSecret[];
    onChangeSecrets: (next: SavedSecret[]) => void;
    machines: readonly Machine[];
    onChange: (next: McpServerBindingV1) => void;
    onDelete: () => void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [favoriteDirectoriesRaw, setFavoriteDirectoriesRaw] = useSettingMutable('favoriteDirectories');
    const favoriteDirectories = Array.isArray(favoriteDirectoriesRaw) ? favoriteDirectoriesRaw : [];
    const selectedTargetSummary = React.useMemo(
        () => describeBindingTarget(props.binding.target, props.machines),
        [props.binding.target, props.machines],
    );

    const update = React.useCallback((updater: (current: McpServerBindingV1) => McpServerBindingV1) => {
        props.onChange(updater(props.binding));
    }, [props]);

    const setTargetType = React.useCallback((nextType: McpServerBindingTargetV1['t']) => {
        update((current) => {
            const now = Date.now();
            const nextTarget = resolveMcpBindingTargetTypeChange(current.target, nextType, props.machines);
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
                onChangeSecrets: props.onChangeSecrets,
                onSubmit: props.onChange,
            },
            chrome: {
                kind: 'card',
                title: t('settings.mcpServersBindingOverridesTitle'),
                dimensions: { size: 'lg' },
            },
            closeOnBackdrop: true,
        });
    }, [props.binding, props.onChange, props.onChangeSecrets, props.secrets, props.serverTransport]);

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

    return (
        <ItemGroup
            title={(
                <View style={styles.groupHeader}>
                    <Text style={styles.groupHeaderTitle}>
                        {t('settings.mcpServersEditorAppliesTo')}
                    </Text>
                    <Text style={styles.groupHeaderSubtitle}>
                        {t('settings.mcpServersEditorAppliesToSubtitle')}
                    </Text>
                    <Text style={styles.groupHeaderSummary}>
                        {selectedTargetSummary}
                    </Text>
                </View>
            )}
        >
            <Item
                title={t('settings.mcpServersBindingEnabled')}
                subtitle={t('settings.mcpServersBindingEnabledSubtitle')}
                icon={<Ionicons name="toggle-outline" size={29} color={theme.colors.accent.blue} />}
                rightElement={<Switch value={props.binding.enabled} onValueChange={(v) => update((b) => ({ ...b, enabled: v, updatedAt: Date.now() }))} />}
                onPress={() => update((b) => ({ ...b, enabled: !b.enabled, updatedAt: Date.now() }))}
                showChevron={false}
            />

            <McpBindingTargetFields
                target={props.binding.target}
                machines={props.machines}
                onChangeTargetType={setTargetType}
                onChangeMachineId={setMachineId}
                onOpenWorkspacePicker={openWorkspacePicker}
            />

            <Item
                title={t('settings.mcpServersBindingOverridesTitle')}
                subtitle={overridesSummary}
                icon={<Ionicons name="options-outline" size={29} color={theme.colors.accent.purple} />}
                onPress={openOverrides}
            />

            <Item
                title={t('common.delete')}
                subtitle={t('settings.mcpServersBindingDeleteSubtitle')}
                icon={<Ionicons name="trash-outline" size={29} color={theme.colors.state.danger.foreground} />}
                onPress={props.onDelete}
                destructive
            />
        </ItemGroup>
    );
});
