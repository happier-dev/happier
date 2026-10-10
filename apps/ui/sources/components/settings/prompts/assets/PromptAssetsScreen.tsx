import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import {
    type PromptAssetDiscoveryItemV1,
    type PromptAssetScopeV1,
    type PromptAssetTypeDescriptorV1,
} from '@happier-dev/protocol';

import { ContextBar } from '@/components/settings/contextBar/ContextBar';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { useContextBarSelection } from '@/components/settings/contextBar/useContextBarSelection';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { useArtifacts } from '@/sync/domains/state/storage';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiPromptLibraryArtifactStore } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { requireUpdatedPromptLibraryMutation, writePromptLibraryRecordAndPublishInContext } from '@/sync/api/account/apiPromptLibraryCatalog';
import { machinePromptAssetsDelete, machinePromptAssetsDiscover, machinePromptAssetsDownload, machinePromptAssetsListTypes } from '@/sync/ops/machinePromptAssets';
import { removePromptExternalLink } from '@/sync/ops/promptLibrary/promptDocs';
import { importPromptAssetToLibrary } from '@/sync/ops/promptLibrary/importPromptAssetToLibrary';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { useMachineAdministrationExecutionTargetBinding } from '@/sync/domains/machines/administration/useExecutionTargetBinding';
import { t } from '@/text';
import { buildPromptAssetExportHref } from '@/components/settings/prompts/shared/buildPromptAssetExportHref';
import { promptCollectionItemHref } from '@/components/settings/prompts/collection/promptCollectionModel';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { isPromptExternalLinkForMachine } from '@happier-dev/protocol/prompts/library/promptExternalLinksV1';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';

/**
 * `/settings/prompts/assets`: prompts and skills already on the machine in the header chip (in a
 * project or the user's folders), found by each tool's asset type. Importing one brings it into the
 * library and keeps it linked; linked ones open in the library.
 */
export const PromptAssetsScreen = React.memo(function PromptAssetsScreen() {
    const router = useRouter();
    const artifacts = useArtifacts();
    const libraryScope = useAccountSettingsScope();
    const libraryServerIdentityId = libraryScope ? getServerProfileById(libraryScope.serverId)?.serverIdentityId : undefined;
    const { value: promptExternalLinksV1, revision: linksRevision, sourceSettingsVersion: linksSourceSettingsVersion,
        status: linksStatus, stale: linksStale } = usePromptLibraryCatalogValue('external-links');
    const administrationTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.promptAssets,
    );
    const selectedTarget = administrationTargetSelection.selectedTarget;
    const {
        selectionKey,
        resolveExactExecutionTarget,
        isExecutionTargetCurrent,
        isSelectionCurrent,
    } = useMachineAdministrationExecutionTargetBinding(administrationTargetSelection);
    const refreshGenerationRef = React.useRef(0);

    const [scope, setScope] = React.useState<PromptAssetScopeV1>('project');
    const [types, setTypes] = React.useState<PromptAssetTypeDescriptorV1[]>([]);
    const [discoveredByTypeId, setDiscoveredByTypeId] = React.useState<Record<string, PromptAssetDiscoveryItemV1[]>>({});
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
        workspaceBindingKey: selectionKey,
    });

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
            if (generation !== refreshGenerationRef.current || !isSelectionCurrent(requestedSelection)) return;
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
    }, [isExecutionTargetCurrent, isSelectionCurrent, projectDirectory, resolveExactExecutionTarget, scope, selectedTarget, selectionKey]);

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
            if (!selectedTarget || !libraryServerIdentityId || !isPromptExternalLinkForMachine(link, {
                target: selectedTarget, libraryServerIdentityId,
            })) continue;
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
    }, [artifactTitleById, libraryServerIdentityId, promptExternalLinksV1?.links, selectedTarget]);

    const deleteLinkedAsset = React.useCallback(async (linkId: string) => {
        if (!libraryScope || !promptExternalLinksV1 || linksStatus !== 'ready' || linksStale) return;
        const link = (promptExternalLinksV1?.links ?? []).find((entry) => entry.id === linkId) ?? null;
        if (!link) return;
        const requestedSelection = selectionKey;
        const libraryAccount = await captureLazyActionAccountContext(libraryScope.serverId);
        try {
            if (libraryAccount.accountId !== libraryScope.accountId) throw new Error('action_account_scope_changed');
            libraryAccount.assertCurrent();
            if (!libraryAccount.serverIdentityId) throw new Error('content_unavailable');
            const confirmed = await Modal.confirm(
                t('promptLibrary.externalAssetsDeleteConfirmTitle'),
                t('promptLibrary.externalAssetsDeleteConfirmBody'),
                { confirmText: t('common.delete'), destructive: true },
            );
            if (!confirmed) return;
            libraryAccount.assertCurrent();
            const executionTarget = resolveExactExecutionTarget(selectedTarget);
            if (!executionTarget || !isExecutionTargetCurrent(requestedSelection, executionTarget) || !isPromptExternalLinkForMachine(link, {
                target: executionTarget.target, libraryServerIdentityId: libraryAccount.serverIdentityId,
            })) return;

            const directory = link.scope === 'project' ? (link.workspacePath ?? undefined) : undefined;

            const result = await machinePromptAssetsDelete(executionTarget.machine.id, {
                assetTypeId: link.assetTypeId,
                scope: link.scope,
                directory,
                externalRef: link.externalRef,
                previewOnly: false,
                expectedDigest: link.lastExternalDigest ?? null,
            }, { serverId: executionTarget.serverId });
            libraryAccount.assertCurrent();
            if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return;
            if (!result.ok) {
                Modal.alert(t('common.error'), result.error);
                return;
            }

            requireUpdatedPromptLibraryMutation(await writePromptLibraryRecordAndPublishInContext(libraryAccount, {
                record: { key: 'external-links', value: removePromptExternalLink(promptExternalLinksV1, link.id) },
                expectedRevision: linksRevision,
                ...(linksRevision === 'absent' && linksSourceSettingsVersion !== null ? { sourceSettingsVersion: linksSourceSettingsVersion } : {}),
            }));
            libraryAccount.assertCurrent();
            await refreshAssets();
        } finally {
            libraryAccount.dispose();
        }
    }, [isExecutionTargetCurrent, libraryScope, linksRevision, linksSourceSettingsVersion, linksStatus, linksStale, promptExternalLinksV1, refreshAssets, resolveExactExecutionTarget, selectedTarget, selectionKey]);

    const handleImport = React.useCallback(async (item: PromptAssetDiscoveryItemV1) => {
        if (!libraryScope || !promptExternalLinksV1 || linksStatus !== 'ready' || linksStale) return;
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
        const libraryAccount = await captureLazyActionAccountContext(libraryScope.serverId);
        try {
            if (libraryAccount.accountId !== libraryScope.accountId) throw new Error('action_account_scope_changed');
            libraryAccount.assertCurrent();
            if (!libraryAccount.serverIdentityId) throw new Error('content_unavailable');
            if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return;
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
            libraryAccount.assertCurrent();
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
                machineTarget: executionTarget.target,
                libraryServerIdentityId: libraryAccount.serverIdentityId,
                workspacePath: item.scope === 'project'
                    ? (requestDirectory ?? null)
                    : null,
                promptExternalLinks: promptExternalLinksV1,
            }, createUiPromptLibraryArtifactStore(libraryAccount.workflowArtifacts, libraryAccount));
            libraryAccount.assertCurrent();
            if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return;
            requireUpdatedPromptLibraryMutation(await writePromptLibraryRecordAndPublishInContext(libraryAccount, {
                record: { key: 'external-links', value: imported.nextLinks }, expectedRevision: linksRevision,
                ...(linksRevision === 'absent' && linksSourceSettingsVersion !== null ? { sourceSettingsVersion: linksSourceSettingsVersion } : {}),
            }));
            libraryAccount.assertCurrent();
            router.push(
                imported.routeKind === 'doc'
                    ? promptCollectionItemHref('doc', imported.artifactId, { serverId: libraryAccount.serverId })
                    : promptCollectionItemHref('bundle', imported.artifactId, { serverId: libraryAccount.serverId }),
            );
        } finally {
            libraryAccount.dispose();
        }
    }, [isExecutionTargetCurrent, libraryScope, linksRevision, linksSourceSettingsVersion, linksStatus, linksStale, projectDirectory, promptExternalLinksV1, resolveExactExecutionTarget, router, selectedTarget, selectionKey]);

    const executionTarget = resolveExactExecutionTarget(selectedTarget);
    const selectedMachineId = selectedTarget?.machineId ?? null;

    return (
            <ItemList keyboardShouldPersistTaps="handled">
                <SettingsPageHeader
                    description={t('promptLibrary.surface.externalAssetsPageDescription')}
                    actions={(
                        <MachineAdministrationTargetSelector
                            selection={administrationTargetSelection}
                            presentation="chip"
                            testIDPrefix="settings.promptAssets.administration.target"
                        />
                    )}
                />
                <ItemGroup
                    title={t('promptLibrary.surface.whereToLookSection')}
                    description={t('promptLibrary.surface.whereToLookDescription')}
                    action={(
                        <SectionActionButton
                            testID="promptAssets.refresh"
                            title={t('common.refresh')}
                            icon="arrow-clockwise"
                            loading={refreshing}
                            disabled={refreshing || !administrationTargetSelection.canExecute}
                            onPress={runRefresh}
                        />
                    )}
                >
                    <SegmentedChoiceItem
                        title={t('promptLibrary.externalAssetsScope')}
                        options={[
                            { id: 'project', label: t('promptLibrary.externalAssetsProjectScope'), description: t('promptLibrary.externalAssetsProjectScopeSubtitle') },
                            { id: 'user', label: t('promptLibrary.externalAssetsUserScope'), description: t('promptLibrary.externalAssetsUserScopeSubtitle') },
                        ]}
                        value={scope}
                        onChange={(nextScope) => setScope(nextScope as PromptAssetScopeV1)}
                    />
                    {scope === 'project' ? (
                        <ContextBar
                            mode="workspace_only"
                            workspace={{
                                value: projectDirectory,
                                onChange: setProjectDirectory,
                                placeholder: t('promptLibrary.externalAssetsProjectDirectory'),
                                testID: 'promptAssets.directoryInput',
                                browse: {
                                    machineId: executionTarget?.machine.id ?? null,
                                    serverId: executionTarget?.serverId ?? null,
                                    enabled: administrationTargetSelection.canExecute,
                                },
                            }}
                        />
                    ) : null}
                </ItemGroup>

                {!hasLoadedOnce && refreshing ? (
                    <ItemGroup>
                        <Item
                            testID="promptAssets.loading"
                            title={t('common.loading')}
                            subtitle={t('promptLibrary.externalAssetsRefreshSubtitle')}
                            mode="info"
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
                                                    onPress={() => {
                                                        if (linkedArtifact) {
                                                            router.push(promptCollectionItemHref(item.libraryKind === 'bundle' ? 'bundle' : 'doc',
                                                                linkedArtifact.artifactId, { serverId: libraryScope?.serverId }));
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
                                                                    onPress: () => router.push(promptCollectionItemHref(item.libraryKind === 'bundle' ? 'bundle' : 'doc',
                                                                        linkedArtifact.artifactId, { serverId: libraryScope?.serverId })),
                                                                },
                                                                {
                                                                    id: 'manage',
                                                                    title: t('promptLibrary.manageExternalAssets'),
                                                                    icon: 'cloud-arrow-up',
                                                                    onPress: () => router.push(buildPromptAssetExportHref({
                                                                        artifactId: linkedArtifact.artifactId,
                                                                        libraryKind: item.libraryKind,
                                                                        serverId: libraryScope?.serverId,
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
                                                                        void deleteLinkedAsset(linkedLink.id).catch(() => Modal.alert(t('common.error'), t('promptLibrary.saveError')));
                                                                    },
                                                                },
                                                            ] : [
                                                                {
                                                                    id: 'import',
                                                                    title: t('promptLibrary.externalAssetsImportAction'),
                                                                    icon: 'download',
                                                                    onPress: () => { void handleImport(item).catch(() => Modal.alert(t('common.error'), t('promptLibrary.saveError'))); },
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
                                        mode="info"
                                        showChevron={false}
                                    />
                                )}
                            </ItemGroup>
                        );
                    })}
            </ItemList>
    );
});
