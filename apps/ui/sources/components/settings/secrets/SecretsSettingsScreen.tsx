import * as React from 'react';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useFocusEffect } from '@/components/appShell/workspace/destinationRoute';
import { parseSavedSecretCatalogReferenceV1, type SavedSecretCatalogCorruptEntryV1, type SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import { SavedSecretAccessEditor } from '@/components/secrets/SavedSecretAccessEditor';
import { SavedSecretCreateEditor } from '@/components/secrets/SavedSecretCreateEditor';
import { SecretsSettingsPage } from '@/components/settings/secrets/SecretsSettingsPage';
import { reviewManagedResourceRemoval } from '@/components/settings/machines/managed/reviewManagedResourceRemoval';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { Modal } from '@/modal';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useSettingsVersion } from '@/sync/store/hooks';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import {
    deleteSavedSecretResource,
    repairCustodiedSavedSecretResourceEnvelopesBestEffort,
    updateSavedSecretResource,
    type SavedSecretResourceDeleteResult,
} from '@/sync/ops/settings/savedSecretResourceOperations';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';

/**
 * Settings → Secrets: owns the catalog, the shared-secret mutations and their approval continuation,
 * and renders them as one page ({@link SecretsSettingsPage}).
 */
export const SecretsSettingsScreen = React.memo(function SecretsSettingsScreen() {
    const router = useRouter();
    const navigation = useNavigation();
    const catalog = useSavedSecretCatalog();
    const scope = useAccountSettingsScope();
    const settingsVersion = useSettingsVersion();
    const scopeKey = scope ? `${scope.serverId}:${scope.accountId}` : null;
    const currentScopeKey = React.useRef(scopeKey);
    currentScopeKey.current = scopeKey;
    // The secret whose recipients are being chosen. Nothing is written while it
    // is set: promotion is irreversible, so it carries the chosen grants and
    // happens once, on save.
    const [sharingPersonal, setSharingPersonal] = React.useState<SavedSecret | null>(null);
    const [creating, setCreating] = React.useState(false);
    const [accessDirty, setAccessDirty] = React.useState(false);
    const [createDirty, setCreateDirty] = React.useState(false);
    const [sharedMutationPending, setSharedMutationPending] = React.useState(false);
    const [accessSelection, setAccessSelection] = React.useState<Readonly<{ scopeKey: string; ref: string }> | null>(null);
    const clearEditors = React.useCallback(() => {
        setSharingPersonal(null);
        setAccessSelection(null);
        setCreating(false);
        setAccessDirty(false);
        setCreateDirty(false);
    }, []);
    useUnsavedDraftNavigationGuard({
        navigation,
        isDirty: accessDirty || createDirty,
        onDiscard: clearEditors,
        tag: 'SecretsSettingsScreen.beforeRemove',
    });
    const selectEditor = (select: () => void) => {
        void runGuardedNavigation(() => {
            clearEditors();
            select();
        });
    };
    const accessEntry = accessSelection === null || accessSelection.scopeKey !== scopeKey
        ? null
        : catalog.sharedEntries.find((entry) => entry.ref === accessSelection.ref) ?? null;
    const approval = useActionApprovalContinuation({
        scopeKey: scopeKey ?? 'unbound:saved-secrets',
        serverId: scope?.serverId ?? '',
        onExecuted: () => { void catalog.reload().catch(() => undefined); },
    });
    const approvalId = approval.approvalId;
    // A conversion is offered only in a direction that can succeed. Into
    // Plain, the Home's storage policy must admit Plain content (plan 10.08
    // §10.5 "subject to Home policy"); into E2EE, this Account must hold the
    // content key that seals the owner's envelope.
    const plaintextStorageEnabled = useFeatureEnabled('encryption.plaintextStorage', {
        scopeKind: 'spawn',
        serverId: scope?.serverId,
    });
    const accountHoldsContentKey = getSyncSingleton().encryption !== null;

    React.useEffect(() => {
        clearEditors();
        setSharedMutationPending(false);
    }, [clearEditors, scopeKey]);

    // Recipients this Account custodies can be waiting on an envelope no
    // mutation is coming to write: they became E2EE-ready, or rotated their
    // content key, after the last grant change. Opening Saved Secrets is the
    // moment the custodian is present to close that, so prepare what is owed
    // here. Nothing is mutated and nothing is shown: the sweep either has
    // work and does it, or asks the census once and stops.
    useFocusEffect(React.useCallback(() => {
        const encryption = getSyncSingleton().encryption;
        if (!scope || !encryption || !catalog.sharedEnabled) return;
        void repairCustodiedSavedSecretResourceEnvelopesBestEffort({
            scope,
            decryptDataKeyEnvelope: (encryptedDataKey) => encryption.decryptEncryptionKey(encryptedDataKey, scope),
        }).catch(() => undefined);
    }, [catalog.sharedEnabled, scope]));

    const updateResource = React.useCallback(async (
        entry: SavedSecretCatalogEntryV1,
        update: Readonly<{ nextName?: string; nextValue?: string; toMode?: 'plain' | 'e2ee' }>,
    ) => {
        const parsed = parseSavedSecretCatalogReferenceV1(entry.ref);
        const encryption = getSyncSingleton().encryption;
        if (!scope || parsed?.kind !== 'shared_resource' || entry.revision === null) return;
        if (sharedMutationPending || approval.approvalPending) return;
        const requestedScopeKey = scopeKey;
        setSharedMutationPending(true);
        try {
        const finish = async () => {
            if (currentScopeKey.current !== requestedScopeKey) return;
            setSharedMutationPending(false);
            await catalog.reload();
        };
        const result = await updateSavedSecretResource({
            scope,
            resourceId: parsed.id,
            expectedRevision: entry.revision,
            ...update,
            decryptDataKeyEnvelope: (value) => encryption
                ? encryption.decryptEncryptionKey(value, scope)
                : Promise.resolve(null),
            onApprovalSucceeded: finish,
            onApprovalFailed: () => {
                if (currentScopeKey.current !== requestedScopeKey) return;
                setSharedMutationPending(false);
                Modal.alert(t('common.error'), t('secrets.catalog.operationFailed'));
            },
        });
        if (currentScopeKey.current !== requestedScopeKey) return;
        setSharedMutationPending(false);
        if (!result.ok) {
            if (result.reason === 'outcome_unknown') await catalog.reload().catch(() => {});
            Modal.alert(t('common.error'), result.reason === 'outcome_unknown'
                ? t('secrets.catalog.outcomeUnknown')
                : t('secrets.catalog.operationFailed'));
            return;
        }
        await catalog.reload();
        return true;
        } catch (cause) {
            if (currentScopeKey.current !== requestedScopeKey) return;
            if (isTeamActionApprovalPendingError(cause)) {
                approval.requestApproval(cause.registration);
                return true;
            }
            setSharedMutationPending(false);
            Modal.alert(t('common.error'), t('secrets.catalog.operationFailed'));
        }
    }, [approval, catalog, scope, scopeKey, sharedMutationPending]);

    const renameShared = React.useCallback(async (entry: SavedSecretCatalogEntryV1, nextName: string) => {
        const normalized = nextName.trim();
        if (!normalized) return;
        if (normalized === entry.name) return true;
        return updateResource(entry, { nextName: normalized });
    }, [updateResource]);

    const rotateShared = React.useCallback(async (entry: SavedSecretCatalogEntryV1, nextValue: string) => {
        if (nextValue.length === 0) return;
        return updateResource(entry, { nextValue });
    }, [updateResource]);

    // Changing where a shared secret is kept is an explicit owner intent on the
    // same resource, carried by the one update flow rather than by a second
    // write path. Handing an end-to-end encrypted value to the Home lowers its
    // trust level, so that direction is confirmed first; raising protection is
    // not a disclosure and asks nothing.
    const convertSharedMode = React.useCallback(async (
        entry: SavedSecretCatalogEntryV1,
        toMode: 'plain' | 'e2ee',
    ) => {
        if (entry.encryptionMode === null || entry.encryptionMode === toMode) return;
        if (toMode === 'plain') {
            const confirmed = await Modal.confirm(
                t('secrets.catalog.convertToPlainTitle'),
                t('secrets.catalog.convertToPlainBody'),
                {
                    cancelText: t('common.cancel'),
                    confirmText: t('secrets.catalog.convertToPlainConfirm'),
                },
            );
            if (!confirmed) return;
        }
        await updateResource(entry, { toMode });
    }, [updateResource]);

    // One presentation for the owner reference census's refusal, so the ordinary
    // delete and the corrupt-resource repair name the same bindings.
    const alertDeleteRefusal = React.useCallback((
        result: Exclude<SavedSecretResourceDeleteResult, Readonly<{ ok: true }>>,
    ) => {
        if (result.reason === 'in_use') {
            Modal.alert(t('secrets.catalog.inUseTitle'), t('secrets.catalog.inUseBody', {
                places: result.references.map((reference) => reference.path).join('\n'),
            }));
            return;
        }
        Modal.alert(t('common.error'), result.reason === 'outcome_unknown'
            ? t('secrets.catalog.outcomeUnknown')
            : t('secrets.catalog.operationFailed'));
    }, []);

    const removeSharedResource = React.useCallback(async (resourceId: string, expectedRevision: number, name: string) => {
        if (!scope) return;
        // Deleting runs the owner reference census, which reads the owner's own
        // current Account Settings; without a known version it cannot run.
        if (settingsVersion === null) return;
        if (sharedMutationPending || approval.approvalPending) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || !areServerAccountScopesEqual(lifetime.scope, scope) || !lifetime.isCurrent()) return;
        const requestedScopeKey = scopeKey;
        const isCurrent = () => lifetime.isCurrent() && currentScopeKey.current === requestedScopeKey;
        const confirmed = await Modal.confirm(
            t('secrets.prompts.deleteTitle'),
            t('secrets.prompts.deleteConfirm', { name }),
            { cancelText: t('common.cancel'), confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed || !isCurrent()) return;
        setSharedMutationPending(true);
        const handleFailure = (cause: unknown) => {
            if (!isCurrent()) return;
            if (isTeamActionApprovalPendingError(cause)) {
                approval.requestApproval(cause.registration);
                return;
            }
            setSharedMutationPending(false);
            Modal.alert(t('common.error'), t('secrets.catalog.operationFailed'));
        };
        try {
            const operation = {
                scope, resourceId, expectedRevision,
                expectedSettingsVersion: settingsVersion, confirmedByPresentUser: true,
                onApprovalSucceeded: async () => {
                    if (!isCurrent()) return;
                    setSharedMutationPending(false);
                    await catalog.reload();
                },
                onApprovalFailed: (_code: string, result: Exclude<SavedSecretResourceDeleteResult, Readonly<{ ok: true }>>) => {
                    void settleResult(result);
                },
            } as const;
            // Immediate replies and Inbox-executed refusals carry the same
            // owner-decoded result, and retain the original operation operands.
            const settleResult = async (initialResult: SavedSecretResourceDeleteResult) => {
                try {
                    let result = initialResult;
                    while (!result.ok && result.reason === 'managed_resources_review_required') {
                        if (!isCurrent()) return;
                        const dispositions = await reviewManagedResourceRemoval(result.resources);
                        if (!isCurrent()) return;
                        if (!dispositions) {
                            setSharedMutationPending(false);
                            return;
                        }
                        result = await deleteSavedSecretResource({ ...operation, managedResourceDispositions: dispositions });
                    }
                    if (!isCurrent()) return;
                    setSharedMutationPending(false);
                    if (!result.ok) {
                        if (result.reason === 'outcome_unknown') await catalog.reload().catch(() => {});
                        alertDeleteRefusal(result);
                    } else await catalog.reload();
                } catch (cause) {
                    handleFailure(cause);
                }
            };
            await settleResult(await deleteSavedSecretResource(operation));
        } catch (cause) {
            handleFailure(cause);
        }
    }, [alertDeleteRefusal, approval, catalog, scope, scopeKey, settingsVersion, sharedMutationPending]);

    const removeShared = React.useCallback(async (entry: SavedSecretCatalogEntryV1) => {
        const parsed = parseSavedSecretCatalogReferenceV1(entry.ref);
        if (parsed?.kind !== 'shared_resource' || entry.revision === null) return;
        await removeSharedResource(parsed.id, entry.revision, entry.name ?? t('secrets.catalog.unavailableName'));
    }, [removeSharedResource]);

    const removeCorruptShared = React.useCallback(async (
        entry: Extract<SavedSecretCatalogCorruptEntryV1, { relationship: 'owner' }>,
    ) => {
        await removeSharedResource(entry.repair.resourceId, entry.repair.expectedRevision, t('secrets.catalog.unavailableName'));
    }, [removeSharedResource]);

    const openApproval = approvalId && scope ? () => router.push(
        `/inbox/approvals/${encodeURIComponent(approvalId)}?serverId=${encodeURIComponent(scope.serverId)}`,
    ) : undefined;

    // The one secret whose recipients are being chosen, keyed by its row. Sharing a still-personal
    // secret and managing a shared one's access are the same editor with a different target.
    const accessEditor = (() => {
        if (!catalog.sharedEnabled || !scope) return null;
        if (settingsVersion !== null && sharingPersonal) {
            return {
                key: sharingPersonal.id,
                element: (
                    <SavedSecretAccessEditor
                        key={`${scope.serverId}:${scope.accountId}:personal:${sharingPersonal.id}`}
                        target={{ kind: 'personal', secret: sharingPersonal, expectedSettingsVersion: settingsVersion }}
                        scope={scope}
                        onClose={clearEditors}
                        onDirtyChange={setAccessDirty}
                        onSaved={catalog.reload}
                        approvalPending={approval.approvalPending}
                        approvalId={approvalId}
                        requestApproval={approval.requestApproval}
                        onOpenApproval={openApproval}
                    />
                ),
            };
        }
        if (accessEntry) {
            return {
                key: accessEntry.ref,
                element: (
                    <SavedSecretAccessEditor
                        key={`${scope.serverId}:${scope.accountId}:${accessEntry.ref}`}
                        target={{ kind: 'shared', entry: accessEntry }}
                        scope={scope}
                        onClose={clearEditors}
                        onDirtyChange={setAccessDirty}
                        onSaved={catalog.reload}
                        onMakeHomeManaged={plaintextStorageEnabled && accessEntry.capabilities.rotate
                            ? () => { void convertSharedMode(accessEntry, 'plain'); }
                            : undefined}
                        approvalPending={approval.approvalPending}
                        approvalId={approvalId}
                        requestApproval={approval.requestApproval}
                        onOpenApproval={openApproval}
                    />
                ),
            };
        }
        return null;
    })();

    const createEditor = creating ? (
        <SavedSecretCreateEditor
            scope={scope}
            onCreatePersonal={catalog.personalMutations.create}
            sharedAvailable={catalog.sharedEnabled}
            approvalPending={approval.approvalPending}
            approvalId={approvalId}
            requestApproval={approval.requestApproval}
            onOpenApproval={openApproval}
            onCancel={clearEditors}
            onDirtyChange={setCreateDirty}
            onCreated={async (ref, storage) => {
                clearEditors();
                if (storage === 'personal' || !scope) return;
                await catalog.reload();
                // A new shared secret opens on who can use it, as sharing is why it was created.
                setAccessSelection({ scopeKey: `${scope.serverId}:${scope.accountId}`, ref });
            }}
        />
    ) : null;

    return (
        <SecretsSettingsPage
            key={scopeKey}
            onBeginEdit={clearEditors}
            personalSecrets={catalog.personalSecrets}
            sharedEntries={catalog.sharedEntries}
            corruptEntries={catalog.corruptEntries}
            resolveSharedReference={catalog.resolveReference}
            sharedCatalogStale={catalog.status === 'error' || (catalog.status === 'ready' && catalog.stale)}
            onRetrySharedCatalog={catalog.sharedEnabled || catalog.collisionMigrationStatus === 'failed'
                ? () => { void catalog.reload().catch(() => {}); }
                : undefined}
            onRenamePersonal={catalog.personalMutations.rename}
            onRotatePersonal={catalog.personalMutations.rotate}
            onDeletePersonal={catalog.personalMutations.delete}
            onSharePersonal={catalog.sharedEnabled && scope && settingsVersion !== null
                ? (secret) => selectEditor(() => setSharingPersonal(secret)) : undefined}
            sharedMutationsDisabled={sharedMutationPending || approval.approvalPending}
            approvalId={catalog.sharedEnabled ? approvalId : null}
            onOpenApproval={catalog.sharedEnabled ? openApproval : undefined}
            onRenameShared={catalog.sharedEnabled ? renameShared : undefined}
            onRotateShared={catalog.sharedEnabled ? rotateShared : undefined}
            onMakeSharedHomeManaged={catalog.sharedEnabled && plaintextStorageEnabled
                ? (entry) => { void convertSharedMode(entry, 'plain'); }
                : undefined}
            onEncryptShared={catalog.sharedEnabled && accountHoldsContentKey
                ? (entry) => { void convertSharedMode(entry, 'e2ee'); }
                : undefined}
            onManageAccessShared={catalog.sharedEnabled && scopeKey
                ? (entry) => selectEditor(() => setAccessSelection({ scopeKey, ref: entry.ref })) : undefined}
            onDeleteShared={catalog.sharedEnabled ? (entry) => { void removeShared(entry); } : undefined}
            onDeleteCorruptShared={catalog.sharedEnabled ? (entry) => { void removeCorruptShared(entry); } : undefined}
            onAdd={() => selectEditor(() => setCreating(true))}
            onCancelAdd={() => { void runGuardedNavigation(clearEditors); }}
            createEditor={createEditor}
            accessEditor={accessEditor}
        />
    );
});
