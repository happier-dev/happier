import * as React from 'react';
import { randomUUID } from 'expo-crypto';
import { applyAccountSettingsSavedSecretMutation, rekeyPersonalSavedSecret } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { projectSavedSecretCatalogCollisionStateV1, type SavedSecretCatalogCorruptEntryV1, type SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import { useSetting, useSettingsVersion } from '@/sync/store/hooks';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { requireOneShotAccountSettingsMutationApplied } from '@/sync/engine/settings/syncSettings';
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
    type SavedSecretResourceDeleteResult,
} from '@/sync/ops/settings/savedSecretResourceOperations';

type SavedSecretCatalogCorruptOwnerEntry = Extract<
    SavedSecretCatalogCorruptEntryV1,
    Readonly<{ relationship: 'owner' }>
>;

export type SavedSecretCatalogProjection = Readonly<{
    sharedEnabled: boolean;
    personalSecrets: readonly SavedSecret[];
    personalMutationsAvailable: boolean;
    personalMutations: Readonly<{
        create: (input: Readonly<{ name: string; value: string }>) => Promise<string | null>;
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

function personalEntry(secret: SavedSecret): SavedSecretCatalogEntryV1 {
    return Object.freeze({
        ref: secret.id,
        source: 'personal',
        relationship: 'owner',
        name: secret.name,
        kind: secret.kind,
        encryptionMode: null,
        owner: null,
        accessSources: [],
        audience: null,
        ownerAccountId: null,
        revision: null,
        materialStatus: 'ready',
        capabilities: { use: true, rename: true, rotate: true, manageAccess: false, delete: true },
    });
}

/**
 * The UI's one Saved Secret catalog.
 *
 * Personal values remain owned by Account Settings; shared rows are metadata
 * from the qualified Home. Refresh never removes either last-known set, and an
 * unavailable older Home therefore cannot make personal Saved Secrets vanish.
 */
export function useSavedSecretCatalog(options?: Readonly<{
    /** Fail-closed switch for surfaces scoped to Homes without shared credentials. */
    sharedEnabled?: boolean;
    /** Exact Account/Home scope for mounted surfaces that are not on the active Home. */
    scope?: AccountSettingsScope | null;
    /** Exact Account settings projection paired with `scope`, when supplied. */
    personalSecrets?: readonly SavedSecret[];
}>): SavedSecretCatalogProjection {
    const activePersonal = useSetting('secrets');
    const settingsVersion = useSettingsVersion();
    const personal = options?.personalSecrets ?? activePersonal;
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
    const featureEnabled = useFeatureEnabled('teams', {
        scopeKind: 'spawn',
        serverId: scope?.serverId,
    });
    const collisionState = React.useMemo(
        () => projectSavedSecretCatalogCollisionStateV1(personal),
        [personal],
    );
    const firstCollision = collisionState.collisions[0] ?? null;
    const collidingPersonalSecret = firstCollision
        ? personal.find((secret) => secret.id === firstCollision.ref
            && secret.updatedAt === firstCollision.expectedUpdatedAt) ?? null
        : null;
    const requestedSharedEnabled = featureEnabled && options?.sharedEnabled !== false;
    const sharedEnabled = requestedSharedEnabled && collidingPersonalSecret === null;
    const [collisionMigrationState, setCollisionMigrationState] = React.useState<Readonly<{
        key: string;
        status: 'migrating' | 'failed';
    }> | null>(null);
    const [collisionRetry, retryCollisionMigration] = React.useReducer((value: number) => value + 1, 0);
    const collisionAttemptRef = React.useRef<string | null>(null);
    const collisionRef = collidingPersonalSecret?.id ?? null;
    const collisionUpdatedAt = collidingPersonalSecret?.updatedAt ?? null;
    const scopeServerId = scope?.serverId ?? null;
    const scopeAccountId = scope?.accountId ?? null;

    React.useEffect(() => {
        if (!requestedSharedEnabled || !scopeServerId || !scopeAccountId || !scopeIsActive
            || settingsVersion === null || !collisionRef || collisionUpdatedAt === null) return;
        const collisionKey = [
            scopeServerId,
            scopeAccountId,
            settingsVersion,
            collisionRef,
            collisionUpdatedAt,
            collisionRetry,
        ].join(':');
        if (collisionAttemptRef.current === collisionKey) return;
        collisionAttemptRef.current = collisionKey;
        setCollisionMigrationState({ key: collisionKey, status: 'migrating' });
        let active = true;
        const nextPersonalId = randomUUID();
        void getSyncSingleton().mutateAccountSettingsOnce({
            expectedSettingsScope: { serverId: scopeServerId, accountId: scopeAccountId },
            expectedSettingsVersion: settingsVersion,
            mutate: (current) => ({
                settings: rekeyPersonalSavedSecret(current, {
                    secretId: collisionRef,
                    expectedUpdatedAt: collisionUpdatedAt,
                    newSecretId: nextPersonalId,
                }).settings as Record<string, unknown>,
                value: undefined,
            }),
        }).then(requireOneShotAccountSettingsMutationApplied).then(
            () => {
                if (active) setCollisionMigrationState(null);
            },
            () => {
                if (active) setCollisionMigrationState({ key: collisionKey, status: 'failed' });
            },
        );
        return () => { active = false; };
    }, [collisionRef, collisionRetry, collisionUpdatedAt, requestedSharedEnabled,
        scopeAccountId, scopeIsActive, scopeServerId, settingsVersion]);
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
    const entries = React.useMemo(() => Object.freeze([
        ...personal.map(personalEntry),
        ...sharedEntries,
    ]), [personal, sharedEntries]);

    const reload = React.useCallback(async () => {
        if (collidingPersonalSecret) {
            retryCollisionMigration();
            return;
        }
        if (scope && sharedEnabled) await refreshSavedSecretCatalog(scope);
    }, [collidingPersonalSecret, scope, sharedEnabled]);

    const deleteCorruptResource = React.useCallback(async (entry: SavedSecretCatalogCorruptOwnerEntry): Promise<SavedSecretResourceDeleteResult> => {
        if (!scope || !sharedEnabled || entry.repair.kind !== 'delete_resource') {
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
        if (result.ok || result.reason === 'outcome_unknown') {
            await refreshSavedSecretCatalog(scope).catch(() => undefined);
        }
        return result;
    }, [scope, settingsVersion, sharedEnabled]);

    const commitPersonalMutation = React.useCallback(async (
        mutate: (current: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>,
    ): Promise<boolean> => {
        try {
            if (!scope || !scopeIsActive || settingsVersion === null) throw new Error('Account settings version is unavailable');
            requireOneShotAccountSettingsMutationApplied(
                await getSyncSingleton().mutateAccountSettingsOnce({
                    expectedSettingsScope: scope,
                    expectedSettingsVersion: settingsVersion,
                    mutate: (current) => ({ settings: mutate(current) as Record<string, unknown>, value: undefined }),
                }),
            );
            return true;
        } catch (error) {
            Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('errors.operationFailed'),
            );
            return false;
        }
    }, [scope, scopeIsActive, settingsVersion]);
    const createPersonal = React.useCallback(async (input: Readonly<{ name: string; value: string }>) => {
        const name = input.name.trim();
        if (!name || input.value.length === 0) return null;
        const now = Date.now();
        const secret: SavedSecret = {
            id: randomUUID(),
            name,
            kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, value: input.value },
            createdAt: now,
            updatedAt: now,
        };
        const applied = await commitPersonalMutation((current) => (
            applyAccountSettingsSavedSecretMutation(current, { kind: 'add', secret }).settings
        ));
        return applied ? secret.id : null;
    }, [commitPersonalMutation]);
    const renamePersonal = React.useCallback(async (secret: SavedSecret, directName?: string) => {
        const name = directName ?? await Modal.prompt(
            t('secrets.prompts.renameTitle'),
            t('secrets.prompts.renameDescription'),
            { defaultValue: secret.name, placeholder: t('secrets.fields.name'), cancelText: t('common.cancel'), confirmText: t('common.rename') },
        );
        if (name === null) return false;
        const normalizedName = name.trim();
        if (!normalizedName) return false;
        return commitPersonalMutation((current) => applyAccountSettingsSavedSecretMutation(current, {
            kind: 'rename',
            secretId: secret.id,
            expectedUpdatedAt: secret.updatedAt,
            name: normalizedName,
            updatedAt: Date.now(),
        }).settings);
    }, [commitPersonalMutation]);
    const rotatePersonal = React.useCallback(async (secret: SavedSecret, directValue?: string) => {
        const value = directValue ?? await Modal.prompt(
            t('secrets.prompts.replaceValueTitle'),
            t('secrets.prompts.replaceValueDescription'),
            { placeholder: 'sk-...', inputType: 'secure-text', cancelText: t('common.cancel'), confirmText: t('secrets.actions.replace') },
        );
        if (value === null) return false;
        if (value.length === 0) return false;
        return commitPersonalMutation((current) => applyAccountSettingsSavedSecretMutation(current, {
            kind: 'rotateGlobal',
            secretId: secret.id,
            expectedUpdatedAt: secret.updatedAt,
            encryptedValue: { ...secret.encryptedValue, _isSecretValue: true, value },
            updatedAt: Date.now(),
        }).settings);
    }, [commitPersonalMutation]);
    const deletePersonal = React.useCallback(async (secret: SavedSecret) => {
        const confirmed = await Modal.confirm(
            t('secrets.prompts.deleteTitle'),
            t('secrets.prompts.deleteConfirm', { name: secret.name }),
            { cancelText: t('common.cancel'), confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed) return false;
        return commitPersonalMutation((current) => applyAccountSettingsSavedSecretMutation(current, {
            kind: 'delete',
            secretId: secret.id,
            expectedUpdatedAt: secret.updatedAt,
        }).settings);
    }, [commitPersonalMutation]);
    const personalMutations = React.useMemo(() => Object.freeze({
        create: createPersonal,
        rename: renamePersonal,
        rotate: rotatePersonal,
        delete: deletePersonal,
    }), [createPersonal, deletePersonal, renamePersonal, rotatePersonal]);
    const usableSecrets = React.useMemo(
        () => sharedEnabled ? getUsableSavedSecrets(scope, personal) : personal,
        [personal, scope, sharedEnabled, snapshot],
    );
    const resolveReference = React.useCallback(
        (ref: string) => {
            const resolved = resolveSavedSecretReference(scope, personal, ref);
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
        [personal, scope, sharedEnabled, snapshot],
    );
    const collisionMigrationStatus = collidingPersonalSecret
        ? (!scopeIsActive ? 'failed' : collisionMigrationState?.status ?? 'migrating')
        : 'not_required';

    return Object.freeze({
        sharedEnabled,
        personalSecrets: personal,
        personalMutationsAvailable: scopeIsActive && settingsVersion !== null,
        personalMutations,
        collisionMigrationStatus,
        entries,
        sharedEntries,
        corruptEntries,
        deleteCorruptResource,
        materializedSecrets: snapshot && !snapshot.stale && snapshot.status === 'ready'
            ? snapshot.materializedSecrets
            : EMPTY_MATERIALIZED_SECRETS,
        usableSecrets,
        resolveReference,
        status: collisionMigrationStatus === 'failed'
            ? 'error'
            : collisionMigrationStatus === 'migrating'
                ? 'refreshing'
                : sharedEnabled ? (snapshot?.status ?? 'loading') : 'ready',
        stale: collisionMigrationStatus !== 'not_required'
            || (sharedEnabled ? (snapshot?.stale ?? true) : false),
        error: collisionMigrationStatus === 'failed'
            || (sharedEnabled && snapshot?.error !== null && snapshot?.error !== undefined),
        reload,
    });
}

const EMPTY_SHARED_ENTRIES: readonly SavedSecretCatalogEntryV1[] = Object.freeze([]);
const EMPTY_CORRUPT_ENTRIES: readonly SavedSecretCatalogCorruptEntryV1[] = Object.freeze([]);
const EMPTY_MATERIALIZED_SECRETS: readonly SavedSecret[] = Object.freeze([]);
const subscribeNoop = () => () => undefined;
