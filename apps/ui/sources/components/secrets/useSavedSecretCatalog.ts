import * as React from 'react';
import { type SavedSecretCatalogCorruptEntryV1, type SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

import { useSettingsVersion } from '@/sync/store/hooks';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { Modal } from '@/modal';
import { t } from '@/text';
import { awaitActionApprovalResult, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import {
    observeSavedSecretCatalog,
    refreshSavedSecretCatalog,
} from '@/sync/engine/settings/savedSecretCatalogEngine';
import {
    getUsableSavedSecrets,
    getSavedSecretCatalogSnapshot,
    resolveSavedSecretReference,
    subscribeSavedSecretCatalogSnapshots,
    type SavedSecretReferenceResolution,
} from '@/sync/store/settings/savedSecretCatalogSnapshot';
import {
    deleteSavedSecretResource,
    createSavedSecretResource,
    updateSavedSecretResource,
    type SavedSecretResourceDeleteResult,
} from '@/sync/ops/settings/savedSecretResourceOperations';

type SavedSecretCatalogCorruptOwnerEntry = Extract<
    SavedSecretCatalogCorruptEntryV1,
    Readonly<{ relationship: 'owner' }>
>;

export type SavedSecretPrivateCreationApprovalOptions = Readonly<{
    onApprovalPending: (registration: ActionApprovalRegistration) => void;
    signal?: AbortSignal;
}>;

export type SavedSecretCatalogProjection = Readonly<{
    sharedEnabled: boolean;
    personalSecrets: readonly SavedSecret[];
    personalMutationsAvailable: boolean;
    personalMutations: Readonly<{
        create: (input: Readonly<{ name: string; value: string }>, approval?: SavedSecretPrivateCreationApprovalOptions) => Promise<string | null>;
        rename: (secret: SavedSecret, name?: string) => Promise<boolean>;
        rotate: (secret: SavedSecret, value?: string) => Promise<boolean>;
        delete: (secret: SavedSecret) => Promise<boolean>;
    }>;
    collisionMigrationStatus: 'not_required' | 'migrating' | 'failed';
    entries: readonly SavedSecretCatalogEntryV1[];
    sharedEntries: readonly SavedSecretCatalogEntryV1[];
    corruptEntries: readonly SavedSecretCatalogCorruptEntryV1[];
    /**
     * The repair carries the owner reference census's own answer, so a resource
     * the owner's Settings still bind is reported as in use rather than as a
     * nameless failure the person cannot act on.
     */
    deleteCorruptResource: (entry: SavedSecretCatalogCorruptOwnerEntry) => Promise<SavedSecretResourceDeleteResult>;
    materializedSecrets: readonly SavedSecret[];
    usableSecrets: readonly SavedSecret[];
    resolveReference: (ref: string) => SavedSecretReferenceResolution;
    status: 'loading' | 'refreshing' | 'ready' | 'error';
    stale: boolean;
    error: boolean;
    reload: () => Promise<void>;
}>;

/**
 * The UI's one Saved Secret catalog.
 *
 * Private and granted resources come from the qualified Home. Legacy Settings
 * values are handled only by the catalog engine's source importer.
 */
export function useSavedSecretCatalog(options?: Readonly<{
    /** Fail-closed switch for surfaces scoped to Homes without shared credentials. */
    sharedEnabled?: boolean;
    /** Exact Account/Home scope for mounted surfaces that are not on the active Home. */
    scope?: AccountSettingsScope | null;
    /** Legacy caller input; the engine imports Settings material rather than projecting it here. */
    personalSecrets?: readonly SavedSecret[];
}>): SavedSecretCatalogProjection {
    const settingsVersion = useSettingsVersion();
    const activeScope = useAccountSettingsScope();
    const scope = options && Object.prototype.hasOwnProperty.call(options, 'scope')
        ? options.scope ?? null
        : activeScope;
    const scopeIsActive = Boolean(
        scope
        && activeScope
        && scope.serverId === activeScope.serverId
        && scope.accountId === activeScope.accountId,
    );
    const sharedEnabled = Boolean(scope) && options?.sharedEnabled !== false;
    const snapshot = React.useSyncExternalStore(
        sharedEnabled ? subscribeSavedSecretCatalogSnapshots : subscribeNoop,
        () => sharedEnabled ? getSavedSecretCatalogSnapshot(scope) : null,
        () => sharedEnabled ? getSavedSecretCatalogSnapshot(scope) : null,
    );

    React.useEffect(() => {
        if (!scope || !sharedEnabled) return;
        return observeSavedSecretCatalog(scope);
    }, [scope, sharedEnabled]);

    const sharedEntries = snapshot?.data ?? EMPTY_SHARED_ENTRIES;
    const corruptEntries = snapshot?.corruptEntries ?? EMPTY_CORRUPT_ENTRIES;
    const entries = sharedEntries;

    const reload = React.useCallback(async () => {
        if (scope && sharedEnabled) await refreshSavedSecretCatalog(scope);
    }, [scope, sharedEnabled]);

    const deleteCorruptResource = React.useCallback(async (entry: SavedSecretCatalogCorruptOwnerEntry): Promise<SavedSecretResourceDeleteResult> => {
        if (!scope || !scopeIsActive || !sharedEnabled || entry.repair.kind !== 'delete_resource') {
            return { ok: false, reason: 'unavailable' };
        }
        // The owner reference census reads this Account's own current Settings,
        // so an unknown version fails the repair closed rather than deleting a
        // resource other Settings may still reference.
        if (settingsVersion === null) return { ok: false, reason: 'unavailable' };
        const result = await deleteSavedSecretResource({
            scope,
            resourceId: entry.repair.resourceId,
            expectedRevision: entry.repair.expectedRevision,
            expectedSettingsVersion: settingsVersion,
            confirmedByPresentUser: true,
        });
        if (!result.ok && result.reason === 'outcome_unknown') {
            await refreshSavedSecretCatalog(scope).catch(() => undefined);
        }
        return result;
    }, [scope, scopeIsActive, settingsVersion, sharedEnabled]);

    const updateResource = React.useCallback(async (secret: SavedSecret, change: Readonly<{ nextName?: string; nextValue?: string }>): Promise<boolean> => {
        try {
            if (!scope || !scopeIsActive || !sharedEnabled) return false;
            const reference = parseSavedSecretRefV1(secret.id);
            const entry = sharedEntries.find(candidate => candidate.ref === secret.id);
            if (reference.kind !== 'shared_resource' || !entry || entry.relationship !== 'owner'
                || entry.revision === null || entry.materialStatus !== 'ready'
                || (change.nextName !== undefined && !entry.capabilities.rename)
                || (change.nextValue !== undefined && !entry.capabilities.rotate)) return false;
            const context = await captureLazyActionAccountContext(scope.serverId);
            let result: Awaited<ReturnType<typeof updateSavedSecretResource>>;
            try {
                if (context.accountId !== scope.accountId) return false;
                result = await updateSavedSecretResource({
                    scope, resourceId: reference.resourceId, expectedRevision: entry.revision!, ...change,
                    decryptDataKeyEnvelope: async encryptedDataKey => {
                        const { encryption } = await context.resolveAccountEncryption();
                        context.assertCurrent();
                        return encryption ? encryption.decryptEncryptionKey(encryptedDataKey, scope) : null;
                    },
                });
            } finally { context.dispose(); }
            if (result.ok || result.reason === 'outcome_unknown') await refreshSavedSecretCatalog(scope).catch(() => undefined);
            return result.ok;
        } catch (error) {
            Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('errors.operationFailed'),
            );
            return false;
        }
    }, [scope, scopeIsActive, sharedEnabled, sharedEntries]);
    const createPersonal = React.useCallback(async (input: Readonly<{ name: string; value: string }>, approval?: SavedSecretPrivateCreationApprovalOptions) => {
        const name = input.name.trim();
        if (!name || input.value.length === 0) return null;
        if (!scope || !scopeIsActive || !sharedEnabled) return null;
        const execute = async (callbacks?: Readonly<{
            onApprovalSucceeded: (result: Extract<Awaited<ReturnType<typeof createSavedSecretResource>>, { ok: true }>) => void;
            onApprovalFailed: (code: string) => void;
        }>) => createSavedSecretResource({ scope, name, kind: 'apiKey', value: input.value,
            accountGrants: [], teamGrants: [], groupGrants: [], ...callbacks });
        const result = approval
            ? await awaitActionApprovalResult<Extract<Awaited<ReturnType<typeof execute>>, { ok: true }>, Awaited<ReturnType<typeof execute>>>({
                ...(approval.signal ? { signal: approval.signal } : {}),
                execute: async callbacks => {
                    try { return await execute(callbacks); }
                    catch (error) {
                        if (!isTeamActionApprovalPendingError(error)) throw error;
                        approval.onApprovalPending(error.registration);
                        return { approvalPending: true };
                    }
                },
                succeeded: value => value,
                failed: () => ({ ok: false, reason: 'failed' }),
                aborted: () => ({ ok: false, reason: 'changed' }),
            })
            : await execute();
        if (result.ok || result.reason === 'outcome_unknown') await refreshSavedSecretCatalog(scope).catch(() => undefined);
        return result.ok ? result.resourceRef : null;
    }, [scope, scopeIsActive, sharedEnabled]);
    const renamePersonal = React.useCallback(async (secret: SavedSecret, directName?: string) => {
        const name = directName ?? await Modal.prompt(
            t('secrets.prompts.renameTitle'),
            t('secrets.prompts.renameDescription'),
            { defaultValue: secret.name, placeholder: t('secrets.fields.name'), cancelText: t('common.cancel'), confirmText: t('common.rename') },
        );
        if (name === null) return false;
        const normalizedName = name.trim();
        if (!normalizedName) return false;
        return updateResource(secret, { nextName: normalizedName });
    }, [updateResource]);
    const rotatePersonal = React.useCallback(async (secret: SavedSecret, directValue?: string) => {
        const value = directValue ?? await Modal.prompt(
            t('secrets.prompts.replaceValueTitle'),
            t('secrets.prompts.replaceValueDescription'),
            { placeholder: 'sk-...', inputType: 'secure-text', cancelText: t('common.cancel'), confirmText: t('secrets.actions.replace') },
        );
        if (value === null) return false;
        if (value.length === 0) return false;
        return updateResource(secret, { nextValue: value });
    }, [updateResource]);
    const deletePersonal = React.useCallback(async (secret: SavedSecret) => {
        const confirmed = await Modal.confirm(
            t('secrets.prompts.deleteTitle'),
            t('secrets.prompts.deleteConfirm', { name: secret.name }),
            { cancelText: t('common.cancel'), confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed) return false;
        if (!scope || !scopeIsActive || !sharedEnabled || settingsVersion === null) return false;
        const reference = parseSavedSecretRefV1(secret.id);
        const entry = sharedEntries.find(candidate => candidate.ref === secret.id);
        if (reference.kind !== 'shared_resource' || !entry || entry.relationship !== 'owner'
            || entry.revision === null || !entry.capabilities.delete) return false;
        const result = await deleteSavedSecretResource({ scope, resourceId: reference.resourceId,
            expectedRevision: entry.revision, expectedSettingsVersion: settingsVersion, confirmedByPresentUser: true });
        if (!result.ok && result.reason === 'outcome_unknown') await refreshSavedSecretCatalog(scope).catch(() => undefined);
        return result.ok;
    }, [scope, scopeIsActive, settingsVersion, sharedEnabled, sharedEntries]);
    const personalMutations = React.useMemo(() => Object.freeze({
        create: createPersonal,
        rename: renamePersonal,
        rotate: rotatePersonal,
        delete: deletePersonal,
    }), [createPersonal, deletePersonal, renamePersonal, rotatePersonal]);
    const usableSecrets = React.useMemo(
        () => sharedEnabled ? getUsableSavedSecrets(scope, EMPTY_MATERIALIZED_SECRETS) : EMPTY_MATERIALIZED_SECRETS,
        [scope, sharedEnabled, snapshot],
    );
    const resolveReference = React.useCallback(
        (ref: string) => {
            const resolved = resolveSavedSecretReference(scope, EMPTY_MATERIALIZED_SECRETS, ref);
            if (!sharedEnabled && resolved.kind === 'shared_resource') {
                return Object.freeze({
                    ref,
                    kind: 'shared_resource' as const,
                    status: 'temporarily_unavailable' as const,
                    entry: null,
                    secret: null,
                    revision: null,
                    fingerprint: null,
                });
            }
            return resolved;
        },
        [scope, sharedEnabled, snapshot],
    );

    return Object.freeze({
        sharedEnabled,
        personalSecrets: EMPTY_MATERIALIZED_SECRETS,
        personalMutationsAvailable: scopeIsActive && sharedEnabled,
        personalMutations,
        collisionMigrationStatus: 'not_required',
        entries,
        sharedEntries,
        corruptEntries,
        deleteCorruptResource,
        materializedSecrets: snapshot && !snapshot.stale && snapshot.status === 'ready'
            ? snapshot.materializedSecrets
            : EMPTY_MATERIALIZED_SECRETS,
        usableSecrets,
        resolveReference,
        status: sharedEnabled ? (snapshot?.status ?? 'loading') : 'ready',
        stale: sharedEnabled ? (snapshot?.stale ?? true) : false,
        error: sharedEnabled && snapshot?.error !== null && snapshot?.error !== undefined,
        reload,
    });
}

const EMPTY_SHARED_ENTRIES: readonly SavedSecretCatalogEntryV1[] = Object.freeze([]);
const EMPTY_CORRUPT_ENTRIES: readonly SavedSecretCatalogCorruptEntryV1[] = Object.freeze([]);
const EMPTY_MATERIALIZED_SECRETS: readonly SavedSecret[] = Object.freeze([]);
const subscribeNoop = () => () => undefined;
