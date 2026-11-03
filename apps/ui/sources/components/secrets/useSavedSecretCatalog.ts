import * as React from 'react';
import { type SavedSecretCatalogCorruptEntryV1, type SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

import { getStorage } from '@/sync/domains/state/storageStore';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { Modal } from '@/modal';
import { t } from '@/text';
import { awaitActionApprovalResult, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { runTeamAction, type TeamActionOutcome } from '@/sync/ops/teams/teamActionClient';
import { PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1, PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1,
  type SavedSecretVaultTargetV1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import type { SavedSecretExternalSourceV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import {
    observeSavedSecretCatalog,
    refreshSavedSecretCatalog,
} from '@/sync/engine/settings/savedSecretCatalogEngine';
import {
    getUsableSavedSecrets,
    getMaterializedSavedSecrets,
    getSavedSecretCatalogSnapshot,
    resolveSavedSecretReference,
    subscribeSavedSecretCatalogSnapshots,
    type SavedSecretReferenceResolution,
} from '@/sync/store/settings/savedSecretCatalogSnapshot';
import {
    deleteSavedSecretResource,
    updateSavedSecretResource,
    type SavedSecretCreationResult,
    type SavedSecretResourceDeleteResult,
} from '@/sync/ops/settings/savedSecretResourceOperations';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

type SavedSecretCatalogCorruptOwnerEntry = Extract<
    SavedSecretCatalogCorruptEntryV1,
    Readonly<{ relationship: 'owner' }>
>;
type SavedSecretCreateActionResult = ReturnType<
    (typeof PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1)['secrets.create']['parse']
>;

/** A personal secret holds its value, or links to a field in a declared secret source (never both). */
export type SavedSecretPersonalCreateInput =
  | Readonly<{ name: string; value: string; storeIn?: SavedSecretVaultTargetV1 }>
  | Readonly<{ name: string; source: SavedSecretExternalSourceV1 }>;

type VaultActionId = 'secrets.link' | 'secrets.export';
type VaultInput<T extends VaultActionId> = ReturnType<(typeof PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1)[T]['parse']>;
type VaultOutput<T extends VaultActionId> = ReturnType<(typeof PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1)[T]['parse']>;

export type SavedSecretPrivateCreationApprovalOptions = Readonly<{
    onApprovalPending: (registration: ActionApprovalRegistration) => void;
    /** The person rejected or canceled the approval: a decision, not a failure to present. */
    onApprovalDeclined?: () => void;
    signal?: AbortSignal;
}>;

export type SavedSecretCatalogProjection = Readonly<{
    sharedEnabled: boolean;
    personalSecrets: readonly SavedSecret[];
    personalMutationsAvailable: boolean;
    personalMutations: Readonly<{
        create: (input: SavedSecretPersonalCreateInput, approval?: SavedSecretPrivateCreationApprovalOptions) => Promise<string | null>;
        rename: (secret: SavedSecret, name?: string) => Promise<boolean>;
        rotate: (secret: SavedSecret, value?: string) => Promise<boolean>;
        delete: (secret: SavedSecret) => Promise<boolean>;
    }>;
    collisionMigrationStatus: 'not_required' | 'migrating' | 'failed';
    entries: readonly SavedSecretCatalogEntryV1[];
    sharedEntries: readonly SavedSecretCatalogEntryV1[];
    /** All resources keep their storage/access management metadata, including private resources. */
    updateResource: (input: Omit<Parameters<typeof updateSavedSecretResource>[0], 'scope'>) => ReturnType<typeof updateSavedSecretResource>;
  linkVaultItems: (input: VaultInput<'secrets.link'>, signal?: AbortSignal) => Promise<TeamActionOutcome<VaultOutput<'secrets.link'>>>;
  exportResourcesToVault: (input: VaultInput<'secrets.export'>, signal?: AbortSignal) => Promise<TeamActionOutcome<VaultOutput<'secrets.export'>>>;
    /** Selection rows retain private editing without reclassifying resource-management targets. */
    picker: Readonly<{
        personalSecrets: readonly SavedSecret[];
        sharedEntries: readonly SavedSecretCatalogEntryV1[];
    }>;
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
    /** Sharing visibility; private owner resources do not depend on Teams. */
    sharedEnabled?: boolean;
    /** Exact Account/Home scope for mounted surfaces that are not on the active Home. */
    scope?: AccountSettingsScope | null;
    /** Legacy caller input; the engine imports Settings material rather than projecting it here. */
    personalSecrets?: readonly SavedSecret[];
    /** Reference-only consumers never request or receive decrypted catalog material. */
    includeMaterial?: boolean;
}>): SavedSecretCatalogProjection {
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
    const catalogEnabled = Boolean(scope);
    const includeMaterial = options?.includeMaterial !== false;
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const snapshot = React.useSyncExternalStore(
        catalogEnabled ? subscribeSavedSecretCatalogSnapshots : subscribeNoop,
        () => catalogEnabled ? getSavedSecretCatalogSnapshot(scope) : null,
        () => catalogEnabled ? getSavedSecretCatalogSnapshot(scope) : null,
    );

    React.useEffect(() => {
        if (!serverId || !accountId || !catalogEnabled) return;
        // The loader owns credential/currentness transitions. Equivalent
        // Settings scope objects must not retire its admitted material read.
        return observeSavedSecretCatalog({ serverId, accountId }, { includeMaterial });
    }, [serverId, accountId, catalogEnabled, includeMaterial]);

    const sharedEntries = snapshot?.data ?? EMPTY_SHARED_ENTRIES;
    const corruptEntries = snapshot?.corruptEntries ?? EMPTY_CORRUPT_ENTRIES;
    const entries = sharedEntries;

    const reload = React.useCallback(async () => {
        if (scope && catalogEnabled) await refreshSavedSecretCatalog(scope, { includeMaterial });
    }, [scope, catalogEnabled, includeMaterial]);

    const deleteCorruptResource = React.useCallback(async (entry: SavedSecretCatalogCorruptOwnerEntry): Promise<SavedSecretResourceDeleteResult> => {
        if (!scope || !scopeIsActive || !catalogEnabled || entry.repair.kind !== 'delete_resource') {
            return { ok: false, reason: 'unavailable' };
        }
        // The owner reference census reads this Account's own current Settings,
        // so an unknown version fails the repair closed rather than deleting a
        // resource other Settings may still reference.
        const current = getStorage().getState();
        if (!areServerAccountScopesEqual(current.settingsScope, scope) || current.settingsVersion === null) {
            return { ok: false, reason: 'unavailable' };
        }
        const result = await deleteSavedSecretResource({
            scope,
            resourceId: entry.repair.resourceId,
            expectedRevision: entry.repair.expectedRevision,
            expectedSettingsVersion: current.settingsVersion,
        });
        if (!result.ok && result.reason === 'outcome_unknown') {
            await refreshSavedSecretCatalog(scope).catch(() => undefined);
        }
        return result;
    }, [scope, scopeIsActive, catalogEnabled]);

    const updateResource = React.useCallback(async (secret: SavedSecret, change: Readonly<{ nextName?: string; nextValue?: string }>): Promise<boolean> => {
        try {
            if (!scope || !scopeIsActive || !catalogEnabled) return false;
            const reference = parseSavedSecretRefV1(secret.id);
            const entry = sharedEntries.find(candidate => candidate.ref === secret.id);
            if (reference.kind !== 'shared_resource' || !entry || entry.relationship !== 'owner'
                || entry.revision === null || entry.materialStatus !== 'ready'
                || (change.nextName !== undefined && !entry.capabilities.rename)
                || (change.nextValue !== undefined && !entry.capabilities.rotate)) return false;
            const result = await updatePrivateResource(scope, { resourceId: reference.resourceId, expectedRevision: entry.revision, ...change });
            if (result.kind==='failed' && result.failure.kind==='outcome_unknown') await refreshSavedSecretCatalog(scope).catch(() => undefined);
            return result.kind==='succeeded';
        } catch (error) {
            Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('errors.operationFailed'),
            );
            return false;
        }
    }, [scope, scopeIsActive, catalogEnabled, sharedEntries]);
    const createPersonal = React.useCallback(async (input: SavedSecretPersonalCreateInput, approval?: SavedSecretPrivateCreationApprovalOptions) => {
        const name = input.name.trim();
        if (!name || ('value' in input ? input.value.length === 0 : false)) return null;
        if (!scope || !scopeIsActive || !catalogEnabled) return null;
        const noteDeclinedApproval = (code: string | null | undefined) => {
            if (isActionApprovalDeclinedErrorCode(code)) approval?.onApprovalDeclined?.();
        };
        const execute = async (callbacks?: Readonly<{
            onApprovalSucceeded: (result: Extract<SavedSecretCreationResult, { ok: true }>) => void;
            onApprovalFailed: (code: string) => void;
        }>): Promise<SavedSecretCreationResult> => {
            const result=await runTeamAction<SavedSecretCreateActionResult>({scope,actionId:'secrets.create',input: 'value' in input ? { name, kind: 'apiKey', value: input.value,
            ...(input.storeIn ? { storeIn: input.storeIn } : {}) } : { name, kind: 'apiKey', source: input.source },
                parse:value=>PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.create'].parse(value),
                ...(approval ? { signal: approval.signal, executorOptions: {
                    // The personal Action retains its plaintext input on the live
                    // invocation. Project that wait through the same mounted UI
                    // observer used by deferred resource approvals.
                    onBlockingApprovalPending: ({ artifactId }) => approval.onApprovalPending(artifactId),
                } } : {}),
                ...(callbacks?{onApprovalSucceeded:value=>callbacks.onApprovalSucceeded({ok:true,resourceRef:value.secretRef,revision:1}),onApprovalFailed:callbacks.onApprovalFailed}:{})});
            // A blocking approval settles on this live invocation: a decline arrives here as its failure code.
            if (result.kind==='failed') noteDeclinedApproval(result.failure.code);
            return result.kind==='succeeded'?{ok:true,resourceRef:result.value.secretRef,revision:1}
                :{ok:false,reason:result.failure.kind==='outcome_unknown'?'outcome_unknown':result.failure.kind==='conflict'?'changed':'failed'};
        };
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
                failed: code => {
                    noteDeclinedApproval(code);
                    return { ok: false, reason: 'failed' };
                },
                aborted: () => ({ ok: false, reason: 'changed' }),
            })
            : await execute();
        if (!result.ok && result.reason === 'outcome_unknown') await refreshSavedSecretCatalog(scope).catch(() => undefined);
        return result.ok ? result.resourceRef : null;
    }, [scope, scopeIsActive, catalogEnabled]);
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
        if (!scope || !scopeIsActive || !catalogEnabled) return false;
        const current = getStorage().getState();
        if (!areServerAccountScopesEqual(current.settingsScope, scope) || current.settingsVersion === null) return false;
        const reference = parseSavedSecretRefV1(secret.id);
        const entry = sharedEntries.find(candidate => candidate.ref === secret.id);
        if (reference.kind !== 'shared_resource' || !entry || entry.relationship !== 'owner'
            || entry.revision === null || !entry.capabilities.delete) return false;
        const result = await runTeamAction({scope,actionId:'secrets.delete',input:{secretId:reference.resourceId,expectedUpdatedAt:entry.revision},
            parse:value=>PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.delete'].parse(value)});
        if (result.kind==='failed' && result.failure.kind==='outcome_unknown') await refreshSavedSecretCatalog(scope).catch(() => undefined);
        return result.kind==='succeeded';
    }, [scope, scopeIsActive, catalogEnabled, sharedEntries]);
  const linkVaultItems = React.useCallback(async (input: VaultInput<'secrets.link'>, signal?: AbortSignal) => {
    if (!scope || !scopeIsActive || !catalogEnabled) return { kind: 'failed' as const,
      failure: { kind: 'unreachable' as const, code: 'unavailable', retryable: true } };
    return runTeamAction({ scope, actionId: 'secrets.link', input, signal,
      parse: value => PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.link'].parse(value) });
  }, [scope, scopeIsActive, catalogEnabled]);
  const exportResourcesToVault = React.useCallback(async (input: VaultInput<'secrets.export'>, signal?: AbortSignal) => {
    if (!scope || !scopeIsActive || !catalogEnabled) return { kind: 'failed' as const,
      failure: { kind: 'unreachable' as const, code: 'unavailable', retryable: true } };
    return runTeamAction({ scope, actionId: 'secrets.export', input, signal,
      parse: value => PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.export'].parse(value) });
  }, [scope, scopeIsActive, catalogEnabled]);
    const personalMutations = React.useMemo(() => Object.freeze({
        create: createPersonal,
        rename: renamePersonal,
        rotate: rotatePersonal,
        delete: deletePersonal,
    }), [createPersonal, deletePersonal, renamePersonal, rotatePersonal]);
    const usableSecrets = React.useMemo(() => catalogEnabled && includeMaterial ? getUsableSavedSecrets(scope, EMPTY_MATERIALIZED_SECRETS) : EMPTY_MATERIALIZED_SECRETS,
        [scope, catalogEnabled, includeMaterial, snapshot]);
    const personalSecrets = React.useMemo(() => {
        if (!scopeIsActive) return EMPTY_MATERIALIZED_SECRETS;
        const privateRefs = new Set(entries.filter(entry => entry.relationship === 'owner'
            && entry.audience !== null
            && entry.audience.accounts.length === 0 && entry.audience.teams.length === 0 && entry.audience.groups.length === 0
            && entry.capabilities.rename && entry.capabilities.rotate && entry.capabilities.delete)
            .map(entry => entry.ref));
        return usableSecrets.filter(secret => privateRefs.has(secret.id));
    }, [entries, scopeIsActive, usableSecrets]);
    const displayedSharedEntries = React.useMemo(() => {
        if (personalSecrets.length === 0) return sharedEntries;
        const privateRefs = new Set(personalSecrets.map(secret => secret.id));
        return sharedEntries.filter(entry => !privateRefs.has(entry.ref));
    }, [personalSecrets, sharedEntries]);
    const picker = React.useMemo(() => Object.freeze({ personalSecrets, sharedEntries: displayedSharedEntries }),
        [personalSecrets, displayedSharedEntries]);
    const updateCatalogResource = React.useCallback(async (input: Omit<Parameters<typeof updateSavedSecretResource>[0], 'scope'>) => {
        if (!scope || !scopeIsActive) return { ok: false as const, reason: 'unavailable' as const };
        const secret = personalSecrets.find(secret => {
            const reference = parseSavedSecretRefV1(secret.id);
            return reference.kind === 'shared_resource' && reference.resourceId === input.resourceId;
        });
        // Privacy is decided once by this catalog projection. Storage conversion
        // retains the resource Action, with its separate disclosure and review.
        if (!secret || input.toMode !== undefined) return updateSavedSecretResource({ ...input, scope });
        const result = await updatePrivateResource(scope, input);
        return result.kind === 'succeeded' ? { ok: true as const } : { ok: false as const,
            reason: result.failure.kind === 'outcome_unknown' ? 'outcome_unknown' as const
                : result.failure.kind === 'conflict' ? 'changed' as const : 'failed' as const };
    }, [personalSecrets, scope, scopeIsActive]);
    const resolveReference = React.useCallback(
        (ref: string) => {
            return resolveSavedSecretReference(scope, EMPTY_MATERIALIZED_SECRETS, ref, { includeMaterial });
        },
        [scope, snapshot, includeMaterial],
    );

    return Object.freeze({
        sharedEnabled,
        personalSecrets,
        personalMutationsAvailable: scopeIsActive && catalogEnabled,
        personalMutations,
    linkVaultItems,
    exportResourcesToVault,
        collisionMigrationStatus: 'not_required',
        entries,
        sharedEntries: displayedSharedEntries,
        picker,
        updateResource: updateCatalogResource,
        corruptEntries,
        deleteCorruptResource,
        materializedSecrets: includeMaterial ? getMaterializedSavedSecrets(scope) : EMPTY_MATERIALIZED_SECRETS,
        usableSecrets,
        resolveReference,
        status: catalogEnabled ? (snapshot?.status ?? 'loading') : 'ready',
        stale: catalogEnabled ? (snapshot?.stale ?? true) : false,
        error: catalogEnabled && snapshot?.error !== null && snapshot?.error !== undefined,
        reload,
    });
}

const EMPTY_SHARED_ENTRIES: readonly SavedSecretCatalogEntryV1[] = Object.freeze([]);
const EMPTY_CORRUPT_ENTRIES: readonly SavedSecretCatalogCorruptEntryV1[] = Object.freeze([]);
const EMPTY_MATERIALIZED_SECRETS: readonly SavedSecret[] = Object.freeze([]);
const subscribeNoop = () => () => undefined;

function updatePrivateResource(scope: AccountSettingsScope, input: Pick<Parameters<typeof updateSavedSecretResource>[0],
    'resourceId' | 'expectedRevision' | 'nextName' | 'nextValue'>) {
    return runTeamAction({ scope, actionId: 'secrets.update', input: {
        secretId: input.resourceId, expectedUpdatedAt: input.expectedRevision,
        ...(input.nextName === undefined ? {} : { name: input.nextName }),
        ...(input.nextValue === undefined ? {} : { value: input.nextValue }),
    }, parse: value => PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.update'].parse(value) });
}
