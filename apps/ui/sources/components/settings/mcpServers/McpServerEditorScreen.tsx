import * as React from 'react';
import { useLocalSearchParams, useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';

import {
    McpServerCatalogEntryV1Schema,
    type McpServerCatalogEntryV1,
} from '@happier-dev/protocol/mcp/servers/settingsV1';

import { McpServerDetailPage } from '@/components/settings/mcpServers/detail/McpServerDetailPage';
import type { McpConfigurationSaveState } from '@/components/settings/mcpServers/McpServerConfigurationSection';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { t } from '@/text';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';

import { MCP_COLLECTION_ROUTE, mcpServerRoute } from './collection/mcpServerCollectionModel';
import { useMcpServersSettings } from './useMcpServersSettings';
import { McpServerCatalogOperationError, requireUpdatedMcpServerCatalogMutation } from '@/sync/api/account/apiMcpServerCatalog';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { McpServerDraftScreen } from './add/McpServerDraftScreen';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { getMcpServerCatalogSnapshot } from '@/sync/store/settings/mcpServerCatalogSnapshot';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

/** Reapply only edited fields; lists remain one ordered value. Timestamps are not an edit conflict. */
function rebaseServerDraft(base: McpServerCatalogEntryV1, draft: McpServerCatalogEntryV1, current: McpServerCatalogEntryV1) {
    let conflict = false;
    function field<T>(before: T, edited: T, published: T): T {
        if (sameStrictJsonValue(before, edited)) return published;
        if (sameStrictJsonValue(before, published) || sameStrictJsonValue(edited, published)) return edited;
        if (before && edited && published && typeof before === 'object' && typeof edited === 'object'
            && typeof published === 'object' && !Array.isArray(before) && !Array.isArray(edited) && !Array.isArray(published)) {
            const previous = before as Record<string, unknown>;
            const local = edited as Record<string, unknown>;
            const latest = published as Record<string, unknown>;
            // Object.fromEntries preserves data keys such as __proto__ in env/header maps.
            return Object.fromEntries([...new Set([...Object.keys(previous), ...Object.keys(local), ...Object.keys(latest)])]
                .flatMap(key => {
                    const value = field(previous[key], local[key], latest[key]);
                    return value === undefined ? [] : [[key, value]];
                })) as T;
        }
        conflict = true;
        return edited;
    }
    const server = field(base, { ...draft, updatedAt: base.updatedAt }, current);
    return { server: { ...server, updatedAt: Math.max(draft.updatedAt, current.updatedAt) }, conflict };
}

function isCatalogConflict(error: unknown): boolean {
    return error instanceof McpServerCatalogOperationError
        && ['conflict', 'settings-conflict', 'mcp_catalog_conflict'].includes(error.code);
}

function sameServerFields(left: McpServerCatalogEntryV1, right: McpServerCatalogEntryV1): boolean {
    return sameStrictJsonValue({ ...left, updatedAt: 0 }, { ...right, updatedAt: 0 });
}

type NavigationLike = Readonly<{
    setOptions?: (options: Readonly<Record<string, unknown>>) => void;
    dispatch?: (action: unknown) => void;
}>;

export const McpServerEditorScreen = React.memo(function McpServerEditorScreen() {
    const { serverId: serverIdParam } = useLocalSearchParams<{ serverId?: string }>();
    const serverId = typeof serverIdParam === 'string' && serverIdParam.trim() ? serverIdParam.trim() : null;
    return serverId ? <McpServerSavedEditorScreen serverId={serverId} /> : <McpServerDraftScreen />;
});

const McpServerSavedEditorScreen = React.memo(function McpServerSavedEditorScreen({ serverId }: Readonly<{ serverId: string }>) {
    const router = useRouter();
    const navigation = useNavigation();
    const nav = navigation as NavigationLike;
    const ignoreBeforeRemoveRef = React.useRef(false);
    const isDirtyRef = React.useRef(false);

    const { settings: normalizedSettings, writable: writableMcpSettings, mutate: mutateMcpCatalog, snapshot, scope, reload, approval: catalogApproval } = useMcpServersSettings();
    const liveScopeRef = React.useRef(scope);
    liveScopeRef.current = scope;
    const draftBaseRef = React.useRef<Readonly<{ scope: AccountSettingsScope; revision: number; server: McpServerCatalogEntryV1 | null }> | null>(null);
    const submittedServerRef = React.useRef<McpServerCatalogEntryV1 | null>(null);
    const [configurationConflict, setConfigurationConflict] = React.useState<Readonly<{
        phase: 'detected' | 'reviewing'; currentServer: McpServerCatalogEntryV1 | null;
    }> | null>(null);
    const savedSecretCatalog = useSavedSecretCatalog({ scope: draftBaseRef.current?.scope ?? scope });
    const secrets = React.useMemo(() => [...savedSecretCatalog.materializedSecrets], [savedSecretCatalog.materializedSecrets]);
    const { resolveReference } = savedSecretCatalog;
    const secretAvailability = React.useMemo(() => ({ resolveReference }), [resolveReference]);
    const approvalScope = draftBaseRef.current?.scope ?? scope;
    const approval = catalogApproval;
    const settingsLoaded = snapshot.status === 'ready';

    const existingServer: McpServerCatalogEntryV1 | null = React.useMemo(() => {
        if (!serverId) return null;
        return normalizedSettings.servers.find((server) => server.id === serverId) ?? null;
    }, [normalizedSettings, serverId]);

    const [draftServer, setDraftServer] = React.useState<McpServerCatalogEntryV1>(() => existingServer ?? {
        id: serverId, name: '', transport: 'stdio', stdio: { command: '', args: [] }, env: {}, createdAt: 0, updatedAt: 0,
    });
    const [isDirty, setIsDirty] = React.useState(false);
    const dirtyFields = React.useRef({ server: false });
    const liveDraftRef = React.useRef({ server: draftServer });
    liveDraftRef.current = { server: draftServer };
    const changeDraftServer = React.useCallback((updater: (current: McpServerCatalogEntryV1) => McpServerCatalogEntryV1) => {
        const next = updater(liveDraftRef.current.server);
        liveDraftRef.current = { server: next };
        const base = draftBaseRef.current?.server;
        const dirty = !base || !sameServerFields(next, base);
        dirtyFields.current = { server: dirty };
        setIsDirty(dirty);
        setDraftServer(next);
    }, []);
    React.useEffect(() => {
        if (!scope || snapshot.status !== 'ready' || snapshot.authority !== 'active' || snapshot.stale || snapshot.revision === 'absent') return;
        if (draftBaseRef.current && !areAccountSettingsScopesEqual(draftBaseRef.current.scope, scope)) return;
        const base = draftBaseRef.current;
        if (base && snapshot.revision < base.revision) return;
        if (isDirty && base) {
            if (snapshot.revision === base.revision) return;
            if (base.server && existingServer) {
                const submitted = submittedServerRef.current;
                const acknowledged = submitted && sameServerFields(submitted, existingServer);
                const rebased = rebaseServerDraft(acknowledged ? submitted : base.server, draftServer, existingServer);
                if (!rebased.conflict) {
                    draftBaseRef.current = { scope, revision: snapshot.revision, server: existingServer };
                    const dirty = !sameServerFields(rebased.server, existingServer);
                    dirtyFields.current = { server: dirty };
                    setIsDirty(dirty);
                    liveDraftRef.current = { server: rebased.server };
                    setDraftServer(current => sameStrictJsonValue(current, rebased.server) ? current : rebased.server);
                    setConfigurationConflict(null);
                    return;
                }
            }
            setConfigurationConflict(current => current?.phase === 'detected' && current.currentServer === existingServer
                ? current : { phase: 'detected', currentServer: existingServer });
            return;
        }
        draftBaseRef.current = { scope, revision: snapshot.revision, server: existingServer };
        setConfigurationConflict(null);
        if (existingServer) {
            dirtyFields.current = { server: false };
            liveDraftRef.current = { server: existingServer };
            setDraftServer(existingServer);
            setIsDirty(false);
        }
    }, [draftServer, existingServer, isDirty, scope, serverId, snapshot.status, snapshot.authority, snapshot.stale, snapshot.revision]);

    const detectCatalogConflict = React.useCallback(() => {
        setConfigurationConflict({ phase: 'detected', currentServer: existingServer });
    }, [existingServer]);

    const reviewConfigurationConflict = React.useCallback(async () => {
        const base = draftBaseRef.current;
        if (!base || !areAccountSettingsScopesEqual(base.scope, liveScopeRef.current)) return;
        await reload();
        if (!areAccountSettingsScopesEqual(base.scope, liveScopeRef.current)) return;
        const current = getMcpServerCatalogSnapshot(base.scope);
        if (current.status !== 'ready' || current.authority !== 'active' || current.stale) return;
        // A catalog with no revision left holds no server: the open one was removed elsewhere.
        const server = current.value?.servers.find(item => item.id === serverId) ?? null;
        // Review keeps both versions available to the presentation owner and preserves local edits.
        if (server && base.server && current.revision !== 'absent') {
            const next = rebaseServerDraft(base.server, liveDraftRef.current.server, server).server;
            liveDraftRef.current = { server: next };
            setDraftServer(next);
            draftBaseRef.current = { scope: base.scope, revision: current.revision, server };
        } else if (!server && current.revision !== 'absent') {
            // Reviewed: the removal is acknowledged, so the publication that reported it stops re-detecting.
            draftBaseRef.current = { ...base, revision: current.revision };
        }
        setConfigurationConflict({ phase: 'reviewing', currentServer: server });
    }, [reload, serverId]);

    React.useEffect(() => {
        isDirtyRef.current = isDirty;
    }, [isDirty]);

    React.useEffect(() => {
        // Match profile edit behavior: disable iOS gesture navigation while the draft is dirty.
        const setOptions = nav.setOptions;
        if (typeof setOptions !== 'function') return;
        setOptions({ gestureEnabled: !isDirty });
    }, [isDirty, nav.setOptions]);

    React.useEffect(() => {
        const setOptions = nav.setOptions;
        if (typeof setOptions !== 'function') return;
        return () => {
            setOptions({ gestureEnabled: true });
        };
    }, [nav.setOptions]);

    const saveDisabled = React.useMemo(() => {
        if (!writableMcpSettings) return true;
        if (draftBaseRef.current && !areAccountSettingsScopesEqual(draftBaseRef.current.scope, scope)) return true;
        return !McpServerCatalogEntryV1Schema.safeParse(draftServer).success;
    }, [draftServer, scope, writableMcpSettings]);

    const closeToMcpServersSettings = React.useCallback(() => {
        // `router.replace` expects the public route (group segments like `/(app)` are not valid here on web).
        router.replace(MCP_COLLECTION_ROUTE);
    }, [router]);

    const commitDraft = React.useCallback(async (): Promise<boolean> => {
        if (configurationConflict && (configurationConflict.phase === 'detected' || !configurationConflict.currentServer)) return false;
        const submittedFields = { ...dirtyFields.current };
        if (!writableMcpSettings) {
            Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
            return false;
        }
        // An observed catalog rebase may run earlier in this same commit's effect flush.
        const submittedDraft = liveDraftRef.current.server;
        const parsedServer = McpServerCatalogEntryV1Schema.safeParse(submittedDraft);
        if (!parsedServer.success) {
            Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
            return false;
        }
        try {
            const base = draftBaseRef.current;
            if (!base || !areAccountSettingsScopesEqual(base.scope, liveScopeRef.current)) throw new McpServerCatalogOperationError('scope-retired');
            if (submittedFields.server) {
                submittedServerRef.current = parsedServer.data;
                const receipt = await mutateMcpCatalog('mcp.servers.update', { entry: parsedServer.data, expectedRevision: base.revision });
                requireUpdatedMcpServerCatalogMutation(receipt);
                if (receipt.revision >= (draftBaseRef.current?.revision ?? base.revision)) {
                    draftBaseRef.current = { scope: base.scope, revision: receipt.revision, server: parsedServer.data };
                }
            }
            if (!areAccountSettingsScopesEqual(base.scope, liveScopeRef.current)) return false;
            const acknowledged = draftBaseRef.current?.server ?? submittedDraft;
            if (!sameServerFields(liveDraftRef.current.server, acknowledged)) return false;
            dirtyFields.current = { server: false };
            setConfigurationConflict(null);
            setIsDirty(false);
            return true;
        } catch (error) {
            if (isCatalogConflict(error)) {
                detectCatalogConflict();
                return false;
            }
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.unknownError'));
            return false;
        } finally {
            if (submittedServerRef.current === parsedServer.data) submittedServerRef.current = null;
        }
    }, [configurationConflict, detectCatalogConflict, mutateMcpCatalog, writableMcpSettings]);

    // A saved server's Configuration saves on blur (T5): a committed value asks for a save, which runs
    // once the draft holding that value has rendered. Invalid drafts stay with their inline error.
    const [configurationCommits, setConfigurationCommits] = React.useState(0);
    const [configurationSaveState, setConfigurationSaveState] = React.useState<McpConfigurationSaveState>('idle');
    const requestConfigurationCommit = React.useCallback(() => setConfigurationCommits((count) => count + 1), []);
    React.useEffect(() => {
        if (configurationCommits === 0 || !serverId || !dirtyFields.current.server || saveDisabled) return;
        setConfigurationSaveState('saving');
        // A refused save says why in its alert and keeps the edit; the line only confirms a save.
        void commitDraft().then((saved) => setConfigurationSaveState(saved ? 'saved' : 'idle'));
        // Only a new commit request saves; draft changes alone wait for the next blur.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [configurationCommits]);

    const discardDraft = React.useCallback(() => {
        const next = existingServer ?? liveDraftRef.current.server;
        liveDraftRef.current = { server: next };
        setDraftServer(next);
        setConfigurationConflict(null);
        dirtyFields.current = { server: false };
        setIsDirty(false);
    }, [existingServer]);

    // Review's two answers: keep the open version (saved over the reviewed current one) or take what is
    // saved now. A server removed elsewhere has nothing to take, so the open edit is dropped and the page closes.
    const keepMyConfiguration = React.useCallback(() => { void commitDraft(); }, [commitDraft]);
    const useCurrentConfiguration = React.useCallback(() => {
        if (configurationConflict?.currentServer) {
            discardDraft();
            return;
        }
        ignoreBeforeRemoveRef.current = true;
        closeToMcpServersSettings();
    }, [closeToMcpServersSettings, configurationConflict, discardDraft]);

    const handleDeleteOrCancel = React.useCallback(async () => {
        if (!writableMcpSettings) {
            Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
            return;
        }
        if (configurationConflict && (configurationConflict.phase === 'detected' || !configurationConflict.currentServer)) return;

        try {
            const base = draftBaseRef.current;
            if (!base || !areAccountSettingsScopesEqual(base.scope, liveScopeRef.current)) throw new McpServerCatalogOperationError('scope-retired');
            const receipt = await mutateMcpCatalog('mcp.servers.delete', {
                serverId, removeBindings: true, expectedRevision: base.revision });
            requireUpdatedMcpServerCatalogMutation(receipt);
            if (!areAccountSettingsScopesEqual(base.scope, liveScopeRef.current)) return;
            ignoreBeforeRemoveRef.current = true;
            closeToMcpServersSettings();
        } catch (error) {
            if (error instanceof McpServerCatalogOperationError && (isActionApprovalDeclinedErrorCode(error.code)
                || error.code === 'action_account_scope_changed')) return;
            if (isCatalogConflict(error)) {
                detectCatalogConflict();
                return;
            }
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.unknownError'));
        }
    }, [closeToMcpServersSettings, configurationConflict, detectCatalogConflict, serverId, mutateMcpCatalog, writableMcpSettings]);

    // Duplicate is the person's own direct Action: a new server with the default reach and no sign-in,
    // opened as soon as the catalog acknowledges it.
    const handleDuplicate = React.useCallback(async () => {
        if (!serverId || !existingServer || !writableMcpSettings) {
            Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
            return;
        }
        try {
            const base = draftBaseRef.current;
            if (!base || !areAccountSettingsScopesEqual(base.scope, liveScopeRef.current)) throw new McpServerCatalogOperationError('scope-retired');
            const receipt = await mutateMcpCatalog('mcp.servers.duplicate', { serverId });
            if (!areAccountSettingsScopesEqual(base.scope, liveScopeRef.current)) return;
            router.push(mcpServerRoute(receipt.serverId) as never);
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.unknownError'));
        }
    }, [existingServer, mutateMcpCatalog, router, serverId, writableMcpSettings]);

    const requestUnsavedChangesDecision = React.useCallback(async () => {
        return await promptUnsavedChangesAlert(
            (title, message, buttons) => Modal.alert(title, message, buttons),
            {
                title: t('common.discardChanges'),
                message: t('common.unsavedChangesWarning'),
                discardText: t('common.discard'),
                saveText: t('common.save'),
                keepEditingText: t('common.keepEditing'),
            },
        );
    }, []);

    const continueNavigation = React.useCallback((action: unknown) => {
        if (action && typeof nav.dispatch === 'function') {
            nav.dispatch(action);
            return;
        }
        closeToMcpServersSettings();
    }, [closeToMcpServersSettings, nav.dispatch]);

    useUnsavedChangesBeforeRemoveGuard({
        ignoreRef: ignoreBeforeRemoveRef,
        isDirty,
        isDirtyRef,
        requestDecision: requestUnsavedChangesDecision,
        onDiscard: discardDraft,
        onSave: commitDraft,
        onContinue: continueNavigation,
        tag: 'McpServerEditorScreen.beforeRemove',
    });


    // A deleted saved server loses authority, but its open unsaved editor remains available for review/copy.
    const displayedServer = existingServer ?? (isDirty ? draftBaseRef.current?.server ?? null : null);
    if (serverId && !displayedServer) {
        if (!settingsLoaded) return null;
        return (
            <ItemList>
                <PageHeader
                    testID="mcp.server.editor.header"
                    alwaysShowTitle
                    title={serverId}
                    description={t('settings.mcpServersServerNotFound')}
                />
            </ItemList>
        );
    }

    if (serverId && displayedServer) {
        return (
            <McpServerDetailPage
                server={displayedServer}
                brandMark={snapshot.brandMarks?.[serverId]}
                draftServer={draftServer}
                configurationBaseServer={draftBaseRef.current?.server}
                catalogRevision={draftBaseRef.current?.revision ?? null}
                secrets={secrets}
                secretAvailability={secretAvailability}
                scope={draftBaseRef.current?.scope ?? scope}
                onCommitConfiguration={requestConfigurationCommit}
                configurationSaveState={configurationSaveState}
                configurationConflict={configurationConflict ? {
                    ...configurationConflict,
                    onReview: reviewConfigurationConflict,
                    onKeepMine: keepMyConfiguration,
                    onUseCurrent: useCurrentConfiguration,
                } : null}
                onRemove={() => { void handleDeleteOrCancel(); }}
                onDuplicate={handleDuplicate}
                approvalNotice={approval.approvalId && approvalScope ? (
                    <ItemGroup>
                        <ActionApprovalPendingNotice testID="mcp.server.editor.approval"
                            message={t('secrets.catalog.approvalPending')}
                            onOpenApproval={() => router.pushRetainingCurrent(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(approvalScope.serverId)}`)} />
                    </ItemGroup>
                ) : null}
                onChangeServer={changeDraftServer}
            />
        );
    }

    return null;
});
