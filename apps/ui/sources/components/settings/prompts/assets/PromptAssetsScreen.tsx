import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { type PromptAssetDiscoveryItemV1, type PromptAssetScopeV1, type PromptAssetTypeDescriptorV1 } from '@happier-dev/protocol';

import { ContextBar } from '@/components/settings/contextBar/ContextBar';
import { layout } from '@/components/ui/layout/layout';
import { useContextBarSelection } from '@/components/settings/contextBar/useContextBarSelection';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { useAllMachines, useArtifacts, useSettingMutable } from '@/sync/domains/state/storage';
import { machinePromptAssetsDelete, machinePromptAssetsDiscover, machinePromptAssetsDownload, machinePromptAssetsListTypes } from '@/sync/ops/machinePromptAssets';
import { removePromptExternalLink } from '@/sync/ops/promptLibrary/promptDocs';
import { importPromptAssetToLibrary } from '@/sync/ops/promptLibrary/importPromptAssetToLibrary';
import { usePrimaryMachineFromActiveSelection } from '@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection';
import { t } from '@/text';
import { buildPromptAssetExportHref } from '@/components/settings/prompts/shared/buildPromptAssetExportHref';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    content: {
        paddingVertical: 12,
        maxWidth: layout.maxWidth,
        width: '100%',
        alignSelf: 'center',
    },
}));

function describeMachine(
    machineId: string,
    machines: ReadonlyArray<{ id: string; metadata?: { displayName?: string | null; host?: string | null; homeDir?: string | null } | null }>,
): string {
    const machine = machines.find((entry) => entry.id === machineId) ?? null;
    return machine?.metadata?.displayName || machine?.metadata?.host || machineId;
}

export const PromptAssetsScreen = React.memo(function PromptAssetsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const machines = useAllMachines();
    const artifacts = useArtifacts();
    const [promptExternalLinksV1, setPromptExternalLinksV1] = useSettingMutable('promptExternalLinksV1');
    const primaryMachineId = usePrimaryMachineFromActiveSelection();

    const [scope, setScope] = React.useState<PromptAssetScopeV1>('project');
    const [types, setTypes] = React.useState<PromptAssetTypeDescriptorV1[]>([]);
    const [discoveredByTypeId, setDiscoveredByTypeId] = React.useState<Record<string, PromptAssetDiscoveryItemV1[]>>({});
    const [scopeMenuOpen, setScopeMenuOpen] = React.useState(false);
    const [hasLoadedOnce, setHasLoadedOnce] = React.useState(false);
    const defaultMachineId = primaryMachineId;
    const {
        machineId,
        setMachineId,
        workspacePath: projectDirectory,
        setWorkspacePath: setProjectDirectory,
    } = useContextBarSelection({
        selectionKey: 'promptAssets.externalAssets',
        defaultMachineId,
        defaultWorkspacePath: '',
    });

    React.useEffect(() => {
        if (machineId && machines.some((entry) => entry.id === machineId)) return;
        const nextMachineId = defaultMachineId;
        setMachineId(nextMachineId);
        setProjectDirectory('');
    }, [defaultMachineId, machineId, machines, setMachineId, setProjectDirectory]);

    const machineItems = React.useMemo((): DropdownMenuItem[] => {
        return machines.map((machine) => ({
            id: machine.id,
            title: machine.metadata?.displayName || machine.metadata?.host || machine.id,
            subtitle: machine.id,
            icon: <Ionicons name="laptop-outline" size={22} color={theme.colors.text.secondary} />,
        }));
    }, [machines, theme.colors.text.secondary]);

    const scopeItems = React.useMemo((): DropdownMenuItem[] => ([
        {
            id: 'project',
            title: t('promptLibrary.externalAssetsProjectScope'),
            subtitle: t('promptLibrary.externalAssetsProjectScopeSubtitle'),
            icon: <Ionicons name="folder-outline" size={22} color={theme.colors.accent.indigo} />,
        },
        {
            id: 'user',
            title: t('promptLibrary.externalAssetsUserScope'),
            subtitle: t('promptLibrary.externalAssetsUserScopeSubtitle'),
            icon: <Ionicons name="person-outline" size={22} color={theme.colors.accent.blue} />,
        },
    ]), [theme.colors.accent.blue, theme.colors.accent.indigo]);

    const refreshAssets = React.useCallback(async () => {
        if (!machineId) {
            setHasLoadedOnce(true);
            return;
        }

        const listed = await machinePromptAssetsListTypes(machineId, undefined);
        setTypes(listed.types);

        const requestDirectory = scope === 'project' ? projectDirectory.trim() : '';
        const supportedTypes = listed.types.filter((entry) => entry.supportsScope[scope]);
        if (scope === 'project' && requestDirectory.length === 0) {
            setDiscoveredByTypeId(Object.fromEntries(supportedTypes.map((entry) => [entry.id, []] as const)));
            setHasLoadedOnce(true);
            return;
        }
        const discoveredEntries = await Promise.all(
            supportedTypes.map(async (entry) => {
                const response = await machinePromptAssetsDiscover(
                    machineId,
                    {
                        assetTypeId: entry.id,
                        scope,
                        directory: scope === 'project' ? requestDirectory : undefined,
                    },
                    undefined,
                );
                return [entry.id, response.items] as const;
            }),
        );

        setDiscoveredByTypeId(Object.fromEntries(discoveredEntries));
        setHasLoadedOnce(true);
    }, [machineId, projectDirectory, scope]);

    const [refreshing, runRefresh] = useHappyAction(refreshAssets);

    React.useEffect(() => {
        runRefresh();
    }, [runRefresh]);

    const artifactTitleById = React.useMemo(() => {
        const map = new Map<string, string>();
        for (const artifact of artifacts) {
            const title = typeof artifact.header?.title === 'string' ? artifact.header.title : artifact.title;
            if (title) map.set(artifact.id, title);
        }
        return map;
    }, [artifacts]);

    const linkByKey = React.useMemo(() => {
        const map = new Map<string, { artifactId: string; title: string; linkId: string }>();
        for (const link of promptExternalLinksV1?.links ?? []) {
            const key = JSON.stringify([
                link.assetTypeId,
                link.machineId,
                link.scope,
                link.workspacePath ?? null,
                link.externalRef,
            ]);
            const title = artifactTitleById.get(link.artifactId);
            if (!title) continue;
            map.set(key, { artifactId: link.artifactId, title, linkId: link.id });
        }
        return map;
    }, [artifactTitleById, promptExternalLinksV1?.links]);

    const deleteLinkedAsset = React.useCallback(async (linkId: string) => {
        const link = (promptExternalLinksV1?.links ?? []).find((entry) => entry.id === linkId) ?? null;
        if (!link) return;

        const confirmed = await Modal.confirm(
            t('promptLibrary.externalAssetsDeleteConfirmTitle'),
            t('promptLibrary.externalAssetsDeleteConfirmBody'),
            { confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed) return;

        const directory = link.scope === 'project' ? (link.workspacePath ?? undefined) : undefined;

        const result = await machinePromptAssetsDelete(link.machineId, {
            assetTypeId: link.assetTypeId,
            scope: link.scope,
            directory,
            externalRef: link.externalRef,
            previewOnly: false,
            expectedDigest: link.lastExternalDigest ?? null,
        }, undefined);
        if (!result.ok) {
            Modal.alert(t('common.error'), result.error);
            return;
        }

        setPromptExternalLinksV1(removePromptExternalLink(promptExternalLinksV1, link.id));
        await refreshAssets();
    }, [promptExternalLinksV1, refreshAssets, setPromptExternalLinksV1]);

    const handleImport = React.useCallback(async (item: PromptAssetDiscoveryItemV1) => {
        if (!machineId) return;

        const requestDirectory = item.scope === 'project'
            ? projectDirectory.trim()
            : undefined;
        if (item.scope === 'project' && !requestDirectory) {
            Modal.alert(t('common.error'), t('promptLibrary.externalAssetsProjectDirectoryRequired'));
            return;
        }
        const response = await machinePromptAssetsDownload(
            machineId,
            {
                assetTypeId: item.assetTypeId,
                scope: item.scope,
                directory: requestDirectory,
                externalRef: item.externalRef,
            },
            undefined,
        );
        if (!response.ok) {
            Modal.alert(t('common.error'), response.error);
            return;
        }
        if (response.item.libraryKind !== 'doc' && response.item.libraryKind !== 'bundle') {
            Modal.alert(t('common.error'), t('promptLibrary.externalAssetsUnsupportedImport'));
            return;
        }
        if (response.item.libraryKind === 'bundle' && response.item.bundleSchemaId !== 'skills.skill_md_v1') {
            Modal.alert(t('common.error'), t('promptLibrary.externalAssetsUnsupportedImport'));
            return;
        }
        const imported = await importPromptAssetToLibrary({
            item: response.item,
            machineId,
            workspacePath: item.scope === 'project'
                ? (requestDirectory ?? null)
                : null,
            promptExternalLinks: promptExternalLinksV1,
        });
        setPromptExternalLinksV1(imported.nextLinks);
        router.push(
            imported.routeKind === 'doc'
                ? `/settings/prompts/docs/${imported.artifactId}`
                : `/settings/prompts/skills/${imported.artifactId}`,
        );
    }, [machineId, projectDirectory, promptExternalLinksV1, router, setPromptExternalLinksV1]);

    return (
        <View style={styles.container}>
            <ItemList containerStyle={styles.content}>
                <ItemGroup title={t('promptLibrary.externalAssetsContext')}>
                    <ContextBar
                        mode={scope === 'project' ? 'machine_and_workspace' : 'machine_only'}
                        machine={{
                            selectedId: machineId,
                            subtitle: machineId ? describeMachine(machineId, machines) : t('promptLibrary.externalAssetsNoMachine'),
                            items: machineItems,
                            onSelect: (nextMachineId) => {
                                setMachineId(nextMachineId);
                                setProjectDirectory('');
                            },
                        }}
                        workspace={scope === 'project' ? {
                            value: projectDirectory,
                            onChange: setProjectDirectory,
                            placeholder: t('promptLibrary.externalAssetsProjectDirectory'),
                            testID: 'promptAssets.directoryInput',
                            browse: {
                                machineId,
                                enabled: true,
                            },
                        } : undefined}
                    />

                    <DropdownMenu
                        open={scopeMenuOpen}
                        onOpenChange={setScopeMenuOpen}
                        items={scopeItems}
                        selectedId={scope}
                        onSelect={(nextScope) => setScope(nextScope as PromptAssetScopeV1)}
                        itemTrigger={{
                            title: t('promptLibrary.externalAssetsScope'),
                            subtitle: scope === 'project' ? t('promptLibrary.externalAssetsProjectScope') : t('promptLibrary.externalAssetsUserScope'),
                            icon: <Ionicons name="albums-outline" size={29} color={theme.colors.accent.indigo} />,
                        }}
                        rowKind="item"
                        connectToTrigger
                        variant="default"
                    />

                    <Item
                        testID="promptAssets.refresh"
                        title={t('promptLibrary.externalAssetsRefresh')}
                        subtitle={refreshing ? t('common.loading') : t('promptLibrary.externalAssetsRefreshSubtitle')}
                        icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.accent.purple} />}
                        disabled={refreshing || !machineId}
                        onPress={runRefresh}
                        showChevron={false}
                    />
                </ItemGroup>

                {!hasLoadedOnce && refreshing ? (
                    <ItemGroup>
                        <Item
                            testID="promptAssets.loading"
                            title={t('common.loading')}
                            subtitle={t('promptLibrary.externalAssetsRefreshSubtitle')}
                            icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.accent.purple} />}
                            showChevron={false}
                        />
                    </ItemGroup>
                ) : null}

                {types
                    .filter((entry) => entry.supportsScope[scope])
                    .map((entry) => {
                        const items = discoveredByTypeId[entry.id] ?? [];
                        return (
                            <ItemGroup key={entry.id} title={entry.title}>
                                {items.length > 0 ? (
                                    items.map((item, index) => (
                                        (() => {
                                            const directory = item.scope === 'project'
                                                ? (projectDirectory.trim() || null)
                                                : null;
                                            const linkKey = JSON.stringify([
                                                item.assetTypeId,
                                                machineId,
                                                item.scope,
                                                directory,
                                                item.externalRef,
                                            ]);
                                            const linkedArtifact = linkByKey.get(linkKey) ?? null;
                                            const linkedLink = linkedArtifact
                                                ? (promptExternalLinksV1?.links ?? []).find((entry) => entry.id === linkedArtifact.linkId) ?? null
                                                : null;
                                            const subtitle = linkedArtifact
                                                ? `${item.displayPath} · ${t('promptLibrary.externalAssetsLinkedTo', { title: linkedArtifact.title })}`
                                                : item.displayPath;
                                            return (
                                                <Item
                                                    key={`${item.assetTypeId}:${item.displayPath}:${index}`}
                                                    testID={`promptAssets.item.${scope}.${entry.id}.${index}`}
                                                    title={item.title}
                                                    subtitle={subtitle}
                                                    icon={<Ionicons name="sparkles-outline" size={29} color={theme.colors.text.secondary} />}
                                                    onPress={() => {
                                                        if (linkedArtifact) {
                                                            router.push(item.libraryKind === 'bundle'
                                                                ? `/settings/prompts/skills/${linkedArtifact.artifactId}`
                                                                : `/settings/prompts/docs/${linkedArtifact.artifactId}`);
                                                            return;
                                                        }
                                                        void handleImport(item);
                                                    }}
                                                    rightElement={(
                                                        <ItemRowActions
                                                            title={item.title}
                                                            compactActionIds={linkedArtifact ? ['open'] : ['import']}
                                                            actions={linkedArtifact ? [
                                                                {
                                                                    id: 'open',
                                                                    title: t('common.open'),
                                                                    icon: 'open-outline',
                                                                    onPress: () => router.push(item.libraryKind === 'bundle'
                                                                        ? `/settings/prompts/skills/${linkedArtifact.artifactId}`
                                                                        : `/settings/prompts/docs/${linkedArtifact.artifactId}`),
                                                                },
                                                                {
                                                                    id: 'manage',
                                                                    title: t('promptLibrary.manageExternalAssets'),
                                                                    icon: 'cloud-upload-outline',
                                                                    onPress: () => router.push(buildPromptAssetExportHref({
                                                                        artifactId: linkedArtifact.artifactId,
                                                                        libraryKind: item.libraryKind,
                                                                        link: linkedLink,
                                                                    })),
                                                                },
                                                                {
                                                                    id: 'delete',
                                                                    title: t('common.delete'),
                                                                    icon: 'trash-outline',
                                                                    destructive: true,
                                                                    onPress: () => {
                                                                        if (!linkedLink) return;
                                                                        void deleteLinkedAsset(linkedLink.id);
                                                                    },
                                                                },
                                                            ] : [
                                                                {
                                                                    id: 'import',
                                                                    title: t('promptLibrary.externalAssetsImportAction'),
                                                                    icon: 'download-outline',
                                                                    onPress: () => { void handleImport(item); },
                                                                },
                                                            ]}
                                                        />
                                                    )}
                                                />
                                            );
                                        })()
                                    ))
                                ) : (
                                    <Item
                                        testID={`promptAssets.empty.${scope}.${entry.id}`}
                                        title={t('promptLibrary.externalAssetsNoItems')}
                                        subtitle={t('promptLibrary.externalAssetsNoItemsSubtitle')}
                                        icon={<Ionicons name="sparkles-outline" size={29} color={theme.colors.text.secondary} />}
                                        showChevron={false}
                                    />
                                )}
                            </ItemGroup>
                        );
                    })}
            </ItemList>
        </View>
    );
});
