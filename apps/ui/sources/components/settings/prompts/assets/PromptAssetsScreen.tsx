import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    type MachineAdministrationTargetV1,
    type PromptAssetDiscoveryItemV1,
    type PromptAssetScopeV1,
    type PromptAssetTypeDescriptorV1,
} from '@happier-dev/protocol';

import { ContextBar } from '@/components/settings/contextBar/ContextBar';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { useContextBarSelection } from '@/components/settings/contextBar/useContextBarSelection';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { useArtifacts, useSettingMutable } from '@/sync/domains/state/storage';
import { machinePromptAssetsDelete, machinePromptAssetsDiscover, machinePromptAssetsDownload, machinePromptAssetsListTypes } from '@/sync/ops/machinePromptAssets';
import { removePromptExternalLink } from '@/sync/ops/promptLibrary/promptDocs';
import { importPromptAssetToLibrary } from '@/sync/ops/promptLibrary/importPromptAssetToLibrary';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { machineAdministrationTargetsEqual } from '@/sync/domains/machines/administration/targetSelection';
import {
    useMachineAdministrationTargetSelection,
    type FreshMachineAdministrationExecutionTargetV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import { isMachineAdministrationExecutionTargetCurrent } from '@/sync/domains/machines/administration/operationCurrentness';
import { t } from '@/text';
import { buildPromptAssetExportHref } from '@/components/settings/prompts/shared/buildPromptAssetExportHref';
import { Icon } from '@/components/ui/icons/Icon';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    content: {
        paddingVertical: 12,
        width: '100%',
        alignSelf: 'center',
    },
}));

export const PromptAssetsScreen = React.memo(function PromptAssetsScreen() {
    // Composed at render time: the module-scope stylesheet evaluates once, so a
    // baked-in `layout.maxWidth` would freeze the user's content-width preference.
    const contentMaxWidthStyle = useLayoutMaxWidthStyle();
    const contentStyle = React.useMemo(() => [styles.content, contentMaxWidthStyle], [contentMaxWidthStyle]);
    const { theme } = useUnistyles();
    const router = useRouter();
    const artifacts = useArtifacts();
    const [promptExternalLinksV1, setPromptExternalLinksV1] = useSettingMutable('promptExternalLinksV1');
    const administrationTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.promptAssets,
    );
    const selectedTarget = administrationTargetSelection.selectedTarget;
    const selectionKey = selectedTarget
        ? `${selectedTarget.serverIdentityId}\0${selectedTarget.machineId}`
        : '';
    const selectionKeyRef = React.useRef(selectionKey);
    selectionKeyRef.current = selectionKey;
    const resolveExecutionTargetRef = React.useRef(administrationTargetSelection.resolveExecutionTarget);
    resolveExecutionTargetRef.current = administrationTargetSelection.resolveExecutionTarget;
    const refreshGenerationRef = React.useRef(0);

    const resolveExactExecutionTarget = React.useCallback((
        expectedTarget: MachineAdministrationTargetV1 | null,
    ): FreshMachineAdministrationExecutionTargetV1 | null => {
        const resolved = resolveExecutionTargetRef.current();
        return expectedTarget !== null
            && resolved !== null
            && machineAdministrationTargetsEqual(expectedTarget, resolved.target)
            ? resolved
            : null;
    }, []);

    const isExecutionTargetCurrent = React.useCallback((
        requestedSelection: string,
        executionTarget: FreshMachineAdministrationExecutionTargetV1,
    ): boolean => {
        return isMachineAdministrationExecutionTargetCurrent({
            expectedTarget: executionTarget,
            resolveCurrentTarget: resolveExecutionTargetRef.current,
            expectedSelectionKey: requestedSelection,
            currentSelectionKey: selectionKeyRef.current,
        });
    }, []);

    const [scope, setScope] = React.useState<PromptAssetScopeV1>('project');
    const [types, setTypes] = React.useState<PromptAssetTypeDescriptorV1[]>([]);
    const [discoveredByTypeId, setDiscoveredByTypeId] = React.useState<Record<string, PromptAssetDiscoveryItemV1[]>>({});
    const [scopeMenuOpen, setScopeMenuOpen] = React.useState(false);
    const [hasLoadedOnce, setHasLoadedOnce] = React.useState(false);
    const {
        workspacePath: projectDirectory,
        setWorkspacePath: setProjectDirectory,
    } = useContextBarSelection({
        selectionKey: 'promptAssets.externalAssets',
        // This legacy context entry now carries only the workspace path. Its
        // machine field is deliberately ignored so it cannot compete with the
        // Administration-owned portable target.
        defaultMachineId: null,
        defaultWorkspacePath: '',
    });
    const previousSelectionKeyRef = React.useRef(selectionKey);

    React.useLayoutEffect(() => {
        const previousSelectionKey = previousSelectionKeyRef.current;
        previousSelectionKeyRef.current = selectionKey;
        if (!previousSelectionKey || previousSelectionKey === selectionKey) return;
        setProjectDirectory('');
    }, [selectionKey, setProjectDirectory]);

    const scopeItems = React.useMemo((): DropdownMenuItem[] => ([
        {
            id: 'project',
            title: t('promptLibrary.externalAssetsProjectScope'),
            subtitle: t('promptLibrary.externalAssetsProjectScopeSubtitle'),
            icon: <Icon name="folder" size={20} color={theme.colors.accent.indigo} />,
        },
        {
            id: 'user',
            title: t('promptLibrary.externalAssetsUserScope'),
            subtitle: t('promptLibrary.externalAssetsUserScopeSubtitle'),
            icon: <Icon name="person" size={20} color={theme.colors.accent.blue} />,
        },
    ]), [theme.colors.accent.blue, theme.colors.accent.indigo]);

    React.useEffect(() => {
        refreshGenerationRef.current += 1;
        setTypes([]);
        setDiscoveredByTypeId({});
        setHasLoadedOnce(false);
    }, [selectionKey]);

    const refreshAssets = React.useCallback(async () => {
        const generation = ++refreshGenerationRef.current;
        const requestedSelection = selectionKey;
        const requestedTarget = selectedTarget;
        const executionTarget = resolveExactExecutionTarget(requestedTarget);
        if (!executionTarget) {
            if (generation !== refreshGenerationRef.current || selectionKeyRef.current !== requestedSelection) return;
            setTypes([]);
            setDiscoveredByTypeId({});
            setHasLoadedOnce(true);
            return;
        }

        const listed = await machinePromptAssetsListTypes(executionTarget.machine.id, {
            serverId: executionTarget.serverId,
        });
        if (
            generation !== refreshGenerationRef.current
            || !isExecutionTargetCurrent(requestedSelection, executionTarget)
        ) return;
        setTypes(listed.types);

        const requestDirectory = scope === 'project' ? projectDirectory.trim() : '';
        const supportedTypes = listed.types.filter((entry) => entry.supportsScope[scope]);
        if (scope === 'project' && requestDirectory.length === 0) {
            if (
                generation !== refreshGenerationRef.current
                || !isExecutionTargetCurrent(requestedSelection, executionTarget)
            ) return;
            setDiscoveredByTypeId(Object.fromEntries(supportedTypes.map((entry) => [entry.id, []] as const)));
            setHasLoadedOnce(true);
            return;
        }
        const discoveredEntries = await Promise.all(
            supportedTypes.map(async (entry) => {
                const currentExecutionTarget = resolveExactExecutionTarget(requestedTarget);
                if (!currentExecutionTarget) return null;
                const response = await machinePromptAssetsDiscover(
                    currentExecutionTarget.machine.id,
                    {
                        assetTypeId: entry.id,
                        scope,
                        directory: scope === 'project' ? requestDirectory : undefined,
                    },
                    { serverId: currentExecutionTarget.serverId },
                );
                if (!isExecutionTargetCurrent(requestedSelection, currentExecutionTarget)) return null;
                return [entry.id, response.items] as const;
            }),
        );

        const resolvedDiscoveredEntries = discoveredEntries.filter((
            entry,
        ): entry is readonly [string, PromptAssetDiscoveryItemV1[]] => entry !== null);
        if (
            resolvedDiscoveredEntries.length !== discoveredEntries.length
            || generation !== refreshGenerationRef.current
            || !isExecutionTargetCurrent(requestedSelection, executionTarget)
        ) return;
        setDiscoveredByTypeId(Object.fromEntries(resolvedDiscoveredEntries));
        setHasLoadedOnce(true);
    }, [isExecutionTargetCurrent, projectDirectory, resolveExactExecutionTarget, scope, selectedTarget, selectionKey]);

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

        const requestedSelection = selectionKey;
        const executionTarget = resolveExactExecutionTarget(selectedTarget);
        if (!executionTarget || executionTarget.machine.id !== link.machineId) return;

        const directory = link.scope === 'project' ? (link.workspacePath ?? undefined) : undefined;

        const result = await machinePromptAssetsDelete(executionTarget.machine.id, {
            assetTypeId: link.assetTypeId,
            scope: link.scope,
            directory,
            externalRef: link.externalRef,
            previewOnly: false,
            expectedDigest: link.lastExternalDigest ?? null,
        }, { serverId: executionTarget.serverId });
        if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return;
        if (!result.ok) {
            Modal.alert(t('common.error'), result.error);
            return;
        }

        setPromptExternalLinksV1(removePromptExternalLink(promptExternalLinksV1, link.id));
        await refreshAssets();
    }, [isExecutionTargetCurrent, promptExternalLinksV1, refreshAssets, resolveExactExecutionTarget, selectedTarget, selectionKey, setPromptExternalLinksV1]);

    const handleImport = React.useCallback(async (item: PromptAssetDiscoveryItemV1) => {
        const requestedSelection = selectionKey;
        const executionTarget = resolveExactExecutionTarget(selectedTarget);
        if (!executionTarget) return;

        const requestDirectory = item.scope === 'project'
            ? projectDirectory.trim()
            : undefined;
        if (item.scope === 'project' && !requestDirectory) {
            Modal.alert(t('common.error'), t('promptLibrary.externalAssetsProjectDirectoryRequired'));
            return;
        }
        const response = await machinePromptAssetsDownload(
            executionTarget.machine.id,
            {
                assetTypeId: item.assetTypeId,
                scope: item.scope,
                directory: requestDirectory,
                externalRef: item.externalRef,
            },
            { serverId: executionTarget.serverId },
        );
        if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return;
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
            machineId: executionTarget.machine.id,
            workspacePath: item.scope === 'project'
                ? (requestDirectory ?? null)
                : null,
            promptExternalLinks: promptExternalLinksV1,
        });
        if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return;
        setPromptExternalLinksV1(imported.nextLinks);
        router.push(
            imported.routeKind === 'doc'
                ? `/settings/prompts/docs/${imported.artifactId}`
                : `/settings/prompts/skills/${imported.artifactId}`,
        );
    }, [isExecutionTargetCurrent, projectDirectory, promptExternalLinksV1, resolveExactExecutionTarget, router, selectedTarget, selectionKey, setPromptExternalLinksV1]);

    const executionTarget = resolveExactExecutionTarget(selectedTarget);
    const selectedMachineId = selectedTarget?.machineId ?? null;

    return (
        <View style={styles.container}>
            <ItemList containerStyle={contentStyle}>
                <MachineAdministrationTargetSelector
                    selection={administrationTargetSelection}
                    testIDPrefix="settings.promptAssets.administration.target"
                />
                <ItemGroup title={t('promptLibrary.externalAssetsContext')}>
                    <ContextBar
                        mode="workspace_only"
                        workspace={scope === 'project' ? {
                            value: projectDirectory,
                            onChange: setProjectDirectory,
                            placeholder: t('promptLibrary.externalAssetsProjectDirectory'),
                            testID: 'promptAssets.directoryInput',
                            browse: {
                                machineId: executionTarget?.machine.id ?? null,
                                serverId: executionTarget?.serverId ?? null,
                                enabled: administrationTargetSelection.canExecute,
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
                            icon: <Icon name="stack" size={29} color={theme.colors.accent.indigo} />,
                        }}
                        rowKind="item"
                        connectToTrigger
                        variant="default"
                    />

                    <Item
                        testID="promptAssets.refresh"
                        title={t('promptLibrary.externalAssetsRefresh')}
                        subtitle={refreshing ? t('common.loading') : t('promptLibrary.externalAssetsRefreshSubtitle')}
                        icon={<Icon name="arrow-clockwise" size={29} color={theme.colors.accent.purple} />}
                        disabled={refreshing || !administrationTargetSelection.canExecute}
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
                            icon={<Icon name="arrow-clockwise" size={29} color={theme.colors.accent.purple} />}
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
                                                selectedMachineId,
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
                                                    icon={<Icon name="sparkle" size={29} color={theme.colors.text.secondary} />}
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
                                                                    icon: 'arrow-square-out',
                                                                    onPress: () => router.push(item.libraryKind === 'bundle'
                                                                        ? `/settings/prompts/skills/${linkedArtifact.artifactId}`
                                                                        : `/settings/prompts/docs/${linkedArtifact.artifactId}`),
                                                                },
                                                                {
                                                                    id: 'manage',
                                                                    title: t('promptLibrary.manageExternalAssets'),
                                                                    icon: 'cloud-arrow-up',
                                                                    onPress: () => router.push(buildPromptAssetExportHref({
                                                                        artifactId: linkedArtifact.artifactId,
                                                                        libraryKind: item.libraryKind,
                                                                        link: linkedLink,
                                                                    })),
                                                                },
                                                                {
                                                                    id: 'delete',
                                                                    title: t('common.delete'),
                                                                    icon: 'trash',
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
                                                                    icon: 'download',
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
                                        icon={<Icon name="sparkle" size={29} color={theme.colors.text.secondary} />}
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
