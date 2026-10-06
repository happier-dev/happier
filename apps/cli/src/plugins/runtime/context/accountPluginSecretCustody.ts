import { createHash, randomUUID } from 'node:crypto';

import { AccountSettingsSavedSecretMutationError, applyAccountSettingsSavedSecretMutation, resolveAccountSettingsPluginSecretBinding, resolveAccountSettingsPluginSecret } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { isSharedSavedSecretReferenceV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { PluginAccountSecretBinding, PluginAccountSecretBindingTarget } from '@happier-dev/protocol';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

import {
    getActiveAccountSettingsSnapshot,
    getActiveAccountSettingsSnapshotLifetimeToken,
    type ActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { readStoredCredentials } from '@/persistence';
import { refreshAccountSettingsForMinimumVersion } from '@/settings/accountSettings/refreshAccountSettingsForMinimumVersion';
import type { AccountSettingsMutationResult } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { refreshSavedSecretCatalogForOperation } from '@/settings/secrets/hydrateSavedSecretCatalog';

import { updateActivePluginAccountSettingsOnce } from './accountSettingsStorage';
import type {
    PluginSecretCustody,
    PluginSecretCustodyResolver,
} from './secrets';

type AccountSecretSnapshot = ActiveAccountSettingsSnapshot;

type AccountSettingsMutationOwner = Readonly<{
    readSnapshot(): AccountSecretSnapshot | null;
    /** Monotonic owner-local token for the active Account incumbent. */
    readLifetimeToken?(): number;
    updateOnce(input: Readonly<{
        expectedVersion: number;
        mutate: (
            settings: Readonly<Record<string, unknown>>,
        ) => Record<string, unknown>,
        assertCurrent(): void;
    }>): Promise<AccountSettingsMutationResult>;
    /**
     * Admits one shared Saved Secret for a new operation against the Home's
     * current authorized catalog (plan 10.08 §5.8, SECRET-05). AccountChange is
     * only a hint, so a hydrated row is not current authorization. An owner
     * without it cannot admit shared material and custody fails closed.
     */
    admitSharedSecretForOperation?(input: Readonly<{ ref: string; expectedScopeKey: string }>): Promise<void>;
    /** Reads the authoritative Account document after a submitted write lost its response. */
    rereadAfterAmbiguousWrite?(input?: Readonly<{
        expectedLifetimeToken?: number;
        expectedScopeKey?: string;
    }>): Promise<AccountSecretSnapshot | null>;
}>;

function custodyError(
    code: string,
    message: string,
    details?: Readonly<Record<string, string>>,
    retryable?: boolean,
): PluginError {
    return new PluginError({
        code,
        message,
        ...(details ? { details } : {}),
        ...(retryable === undefined ? {} : { retryable }),
    });
}

function sameAccount(
    before: AccountSecretSnapshot,
    after: AccountSecretSnapshot | null,
): boolean {
    if (!after) return false;
    if (before.scopeKey && after.scopeKey) return before.scopeKey === after.scopeKey;
    return before === after;
}

function snapshotForSettledMutation(
    before: AccountSecretSnapshot,
    result: Extract<AccountSettingsMutationResult, {
        status: 'applied' | 'satisfied' | 'unchanged';
    }>,
): AccountSecretSnapshot {
    return Object.freeze({
        ...before,
        source: 'network',
        settings: result.settings,
        settingsVersion: result.version,
    });
}

function targetFor(pluginId: string, secretId: string): PluginAccountSecretBindingTarget {
    return Object.freeze({ pluginId, localId: secretId });
}

function revisionFor(
    snapshot: AccountSecretSnapshot,
    binding: PluginAccountSecretBinding | null,
    materialFingerprint: string | null,
    materialStatus: string | null,
): string {
    const hash = createHash('sha256');
    hash.update(snapshot.scopeKey ?? 'unscoped');
    hash.update('\0');
    hash.update(String(snapshot.settingsVersion));
    hash.update('\0');
    hash.update(binding?.savedSecretId ?? 'missing');
    hash.update('\0');
    hash.update(materialFingerprint ?? materialStatus ?? 'missing');
    return `account-secret-r1:${hash.digest('hex')}`;
}

function savedSecretName(pluginId: string, secretId: string): string {
    const value = `Plugin ${pluginId} secret ${secretId}`;
    return value.length <= 100 ? value : value.slice(0, 100);
}

/**
 * Account secret declarations bind to the protocol-owned SavedSecret record
 * for precisely `(pluginId, secretId)`. The SavedSecret mutation owner keeps
 * reference integrity and replacement cleanup atomic with the Account CAS;
 * this adapter never adds a second Account secret store or publishes bytes in
 * settings projections.
 */
export function createAccountPluginSecretCustodyRouter(params: Readonly<{
    owner?: AccountSettingsMutationOwner;
    /** Exact authenticated Account reader selected by the enclosing runtime. */
    readCredentials?: typeof readStoredCredentials;
    /** When supplied, Account-backed custody is available only to this exact Account lifetime. */
    accountScopeKey?: string | null;
    createId?: () => string;
    nowMs?: () => number;
}> = {}): Readonly<{
    resolve: PluginSecretCustodyResolver;
    /**
     * Host-private administration port for selecting an already-existing
     * SavedSecret. It intentionally has no raw secret-value input or result.
     */
    bindExisting(input: Readonly<{
        pluginId: string;
        secretId: string;
        savedSecretId: string;
        expectedRevision?: string;
        assertCurrent?: () => void;
    }>): Promise<Readonly<{ revision: string }>>;
    /** Removes a plugin-to-SavedSecret binding without deleting the SavedSecret. */
    unbind(input: Readonly<{
        pluginId: string;
        secretId: string;
        expectedRevision?: string;
        assertCurrent?: () => void;
    }>): Promise<Readonly<{ revision: string }>>;
}> {
    const readCredentials = params.readCredentials ?? readStoredCredentials;
    const readBoundSnapshot = (): AccountSecretSnapshot | null => {
        if (params.accountScopeKey === null) return null;
        const snapshot = getActiveAccountSettingsSnapshot();
        if (params.accountScopeKey === undefined) return snapshot;
        return snapshot?.scopeKey === params.accountScopeKey
            ? snapshot
            : null;
    };
    const owner: AccountSettingsMutationOwner = params.owner ?? Object.freeze({
        readSnapshot: readBoundSnapshot,
        readLifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken,
        async admitSharedSecretForOperation(input: Readonly<{ ref: string; expectedScopeKey: string }>) {
            await refreshSavedSecretCatalogForOperation({
                expectedScopeKey: input.expectedScopeKey,
                references: [{ ref: input.ref }],
            });
        },
        async updateOnce(input): Promise<AccountSettingsMutationResult> {
            return await updateActivePluginAccountSettingsOnce({
                expectedVersion: input.expectedVersion,
                mutate: input.mutate,
                deps: {
                    assertCurrent: input.assertCurrent,
                    readCredentials,
                },
            });
        },
        async rereadAfterAmbiguousWrite(input: Readonly<{
            expectedLifetimeToken?: number;
            expectedScopeKey?: string;
        }> = {}): Promise<AccountSecretSnapshot | null> {
            const credentials = await readCredentials();
            if (!credentials) return null;
            const stillOwnsPublicationLifetime = () => {
                if (input.expectedLifetimeToken === undefined) return true;
                const active = getActiveAccountSettingsSnapshot();
                return !!active
                    && active.scopeKey === input.expectedScopeKey
                    && getActiveAccountSettingsSnapshotLifetimeToken() === input.expectedLifetimeToken;
            };
            await refreshAccountSettingsForMinimumVersion({
                credentials,
                forceRefresh: true,
                mode: 'blocking',
                shouldCommit: stillOwnsPublicationLifetime,
            });
            return stillOwnsPublicationLifetime()
                ? getActiveAccountSettingsSnapshot()
                : null;
        },
    });
    const createId = params.createId ?? (() => `plugin_secret_${randomUUID()}`);
    const nowMs = params.nowMs ?? (() => Date.now());

    function requireSnapshot(): AccountSecretSnapshot {
        const snapshot = owner.readSnapshot();
        if (!snapshot) {
            throw custodyError(
                'plugin_secret_custody_unavailable',
                'Account plugin secret custody is unavailable',
            );
        }
        return snapshot;
    }

    function assertSnapshotCurrent(snapshot: AccountSecretSnapshot): void {
        if (!sameAccount(snapshot, owner.readSnapshot())) {
            throw custodyError(
                'plugin_secret_custody_unavailable',
                'The active Account changed while resolving a plugin secret',
            );
        }
    }

    function resolveBinding(
        snapshot: AccountSecretSnapshot,
        target: PluginAccountSecretBindingTarget,
    ): PluginAccountSecretBinding | null {
        try {
            return resolveAccountSettingsPluginSecretBinding(snapshot.settings, target);
        } catch {
            throw custodyError(
                'plugin_secret_custody_unavailable',
                'Account plugin secret binding is unavailable',
            );
        }
    }

    function state(
        snapshot: AccountSecretSnapshot,
        target: PluginAccountSecretBindingTarget,
    ): Readonly<{
        binding: PluginAccountSecretBinding | null;
        revision: string;
    }> {
        const binding = resolveBinding(snapshot, target);
        const inspected = binding
            ? createSavedSecretMaterializerFromSnapshotV1(snapshot).inspect(binding.savedSecretId)
            : null;
        return Object.freeze({
            binding,
            revision: revisionFor(
                snapshot,
                binding,
                inspected?.status === 'ready' ? inspected.fingerprint : null,
                inspected?.status ?? null,
            ),
        });
    }

    function personalSecretRevision(
        snapshot: AccountSecretSnapshot,
        binding: PluginAccountSecretBinding | null,
    ): number | null {
        if (!binding || parseSavedSecretRefV1(binding.savedSecretId).kind === 'shared_resource') return null;
        return resolveAccountSettingsPluginSecret(snapshot.settings, targetFor(
            binding.pluginId,
            binding.localId,
        ))?.secret.updatedAt ?? null;
    }

    function assertExpectedRevision(
        current: Readonly<{ revision: string }>,
        expectedRevision?: string,
    ): void {
        if (expectedRevision === undefined || expectedRevision === current.revision) return;
        throw custodyError(
            'plugin_secret_revision_conflict',
            'Plugin secret revision does not match the current Account revision',
            { currentRevision: current.revision },
        );
    }

    async function update(
        snapshot: AccountSecretSnapshot,
        mutate: (settings: Readonly<Record<string, unknown>>) => Record<string, unknown>,
        assertCurrent: () => void,
        matchesPostcondition?: (snapshot: AccountSecretSnapshot) => boolean,
    ): Promise<AccountSecretSnapshot> {
        let lifetimeTokenAtSubmission: number | undefined;
        async function rereadExactPostcondition(): Promise<AccountSecretSnapshot> {
            try {
                const reread = await owner.rereadAfterAmbiguousWrite?.({
                    expectedLifetimeToken: lifetimeTokenAtSubmission,
                    expectedScopeKey: snapshot.scopeKey,
                });
                if (
                    !reread
                    || (
                        lifetimeTokenAtSubmission !== undefined
                        && owner.readLifetimeToken?.() !== lifetimeTokenAtSubmission
                    )
                    || !sameAccount(snapshot, reread)
                    || !matchesPostcondition?.(reread)
                ) {
                    throw custodyError(
                        'plugin_secret_outcome_unknown',
                        'Account plugin secret write outcome is unknown',
                    );
                }
                return reread;
            } catch (error) {
                if (isPluginError(error)) throw error;
                throw custodyError(
                    'plugin_secret_outcome_unknown',
                    'Account plugin secret write outcome is unknown',
                );
            }
        }

        try {
            assertCurrent();
            assertSnapshotCurrent(snapshot);
            lifetimeTokenAtSubmission = owner.readLifetimeToken?.();
            const result = await owner.updateOnce({
                expectedVersion: snapshot.settingsVersion,
                mutate,
                assertCurrent: () => {
                    assertCurrent();
                    assertSnapshotCurrent(snapshot);
                },
            });
            switch (result.status) {
                case 'applied':
                case 'unchanged':
                    return snapshotForSettledMutation(snapshot, result);
                case 'satisfied':
                case 'outcomeUnknown':
                    return await rereadExactPostcondition();
                case 'conflict':
                    throw custodyError(
                        'plugin_secret_revision_conflict',
                        'Plugin secret revision does not match the current Account revision',
                        { currentVersion: String(result.currentVersion) },
                    );
                case 'cancelled':
                    throw custodyError(
                        'plugin_secret_custody_cancelled',
                        'Account plugin secret mutation was cancelled before submission',
                    );
                case 'invalid':
                    throw custodyError(
                        result.reason === 'tooLarge'
                            ? 'plugin_secret_custody_too_large'
                            : 'plugin_secret_custody_invalid',
                        'Account plugin secret mutation is invalid',
                        { reason: result.reason },
                    );
                case 'locked':
                    throw custodyError(
                        'plugin_secret_custody_locked',
                        'Account plugin secret material is locked',
                        { reason: result.reason },
                    );
                case 'unavailable':
                    throw custodyError(
                        'plugin_secret_custody_unavailable',
                        'Account plugin secret mutation is unavailable',
                        undefined,
                        result.retryable,
                    );
            }
        } catch (error) {
            if (isPluginError(error)) throw error;
            if (error instanceof AccountSettingsSavedSecretMutationError) {
                const code = error.code === 'saved_secret_conflict'
                    ? 'plugin_secret_revision_conflict'
                    : 'plugin_secret_custody_unavailable';
                throw custodyError(code, 'Account plugin secret mutation was rejected');
            }
            throw custodyError(
                'plugin_secret_custody_unavailable',
                'Account plugin secret mutation is unavailable',
            );
        }
    }

    const resolve: PluginSecretCustodyResolver = ({ pluginId, declaration }) => {
        const boundAccount: AccountSecretSnapshot | null = owner.readSnapshot();
        if (declaration.custody !== 'account') return null;
        if (!boundAccount) return null;
        const boundAccountSnapshot: AccountSecretSnapshot = boundAccount;
        const boundLifetimeToken = owner.readLifetimeToken?.();
        const target = targetFor(pluginId, declaration.id);

        function requireBoundAccountSnapshot(): AccountSecretSnapshot {
            if (
                boundLifetimeToken !== undefined
                && owner.readLifetimeToken?.() !== boundLifetimeToken
            ) {
                throw custodyError(
                    'plugin_secret_custody_unavailable',
                    'The Account lifetime ended after plugin secret custody was resolved',
                );
            }
            const snapshot = requireSnapshot();
            if (!sameAccount(boundAccountSnapshot, snapshot)) {
                throw custodyError(
                    'plugin_secret_custody_unavailable',
                    'The active Account changed after plugin secret custody was resolved',
                );
            }
            return snapshot;
        }

        const custody: PluginSecretCustody = Object.freeze({
            async status() {
                const snapshot = requireBoundAccountSnapshot();
                const current = state(snapshot, target);
                return Object.freeze({
                    state: current.binding ? 'configured' as const : 'missing' as const,
                    revision: current.revision,
                });
            },
            async get() {
                let snapshot = requireBoundAccountSnapshot();
                let current = state(snapshot, target);
                if (!current.binding) return null;
                const boundSecretId = current.binding.savedSecretId;
                if (isSharedSavedSecretReferenceV1(boundSecretId)) {
                    try {
                        if (!owner.admitSharedSecretForOperation) throw new Error('saved_secret_admission_unavailable');
                        await owner.admitSharedSecretForOperation({ ref: boundSecretId, expectedScopeKey: snapshot.scopeKey ?? '' });
                    } catch {
                        throw custodyError(
                            'plugin_secret_custody_unavailable',
                            'The Home did not admit this shared Saved Secret for a new operation',
                            undefined,
                            true,
                        );
                    }
                    // The admission committed the Home's current catalog into
                    // the Account snapshot; resolve against that, not the
                    // snapshot captured before it.
                    snapshot = requireBoundAccountSnapshot();
                    current = state(snapshot, target);
                    if (current.binding?.savedSecretId !== boundSecretId) {
                        throw custodyError(
                            'plugin_secret_custody_unavailable',
                            'The plugin secret binding changed while it was being admitted',
                        );
                    }
                }
                assertSnapshotCurrent(snapshot);
                const material = createSavedSecretMaterializerFromSnapshotV1(snapshot)
                    .resolve(current.binding.savedSecretId);
                requireBoundAccountSnapshot();
                if (material.status !== 'ready') {
                    throw custodyError(
                        'plugin_secret_custody_unavailable',
                        'Account plugin secret material is unavailable',
                        { materialStatus: material.status },
                        material.status === 'temporarily_unavailable',
                    );
                }
                return Object.freeze({ value: material.value, revision: current.revision });
            },
            async set(input) {
                input.assertCurrent?.();
                const snapshot = requireBoundAccountSnapshot();
                const current = state(snapshot, target);
                assertExpectedRevision(current, input.expectedRevision);
                const existing = current.binding;
                const now = nowMs();
                const savedSecretId = createId();
                const after = await update(
                    snapshot,
                    (settings) => ({
                        ...applyAccountSettingsSavedSecretMutation(settings, {
                            kind: 'replacePluginSecret',
                            target,
                            expectedSecretId: existing?.savedSecretId ?? null,
                            expectedSecretUpdatedAt: personalSecretRevision(snapshot, existing),
                            secret: {
                                id: savedSecretId,
                                name: savedSecretName(pluginId, declaration.id),
                                kind: 'other',
                                encryptedValue: {
                                    _isSecretValue: true,
                                    value: input.value,
                                },
                                createdAt: now,
                                updatedAt: now,
                            },
                        }).settings,
                    }),
                    () => {
                        input.assertCurrent?.();
                        requireBoundAccountSnapshot();
                    },
                    (reread) => {
                        const binding = resolveBinding(reread, target);
                        if (!binding || binding.savedSecretId !== savedSecretId) return false;
                        const resolved = createSavedSecretMaterializerFromSnapshotV1(reread)
                            .resolve(savedSecretId);
                        return resolved.status === 'ready' && resolved.value === input.value;
                    },
                );
                const next = state(after, target);
                if (!next.binding) {
                    throw custodyError(
                        'plugin_secret_custody_unavailable',
                        'Account plugin secret mutation did not produce a binding',
                    );
                }
                return Object.freeze({ revision: next.revision });
            },
            async delete(input) {
                input.assertCurrent?.();
                const snapshot = requireBoundAccountSnapshot();
                const current = state(snapshot, target);
                assertExpectedRevision(current, input.expectedRevision);
                const existing = current.binding;
                if (!existing) return Object.freeze({ revision: current.revision });
                const after = await update(
                    snapshot,
                    (settings) => ({
                        ...applyAccountSettingsSavedSecretMutation(settings, {
                            kind: 'removePluginSecret',
                            target,
                            expectedSecretId: existing.savedSecretId,
                            expectedSecretUpdatedAt: personalSecretRevision(snapshot, existing),
                        }).settings,
                    }),
                    () => {
                        input.assertCurrent?.();
                        requireBoundAccountSnapshot();
                    },
                    (reread) => resolveBinding(reread, target) === null,
                );
                return Object.freeze({ revision: state(after, target).revision });
            },
        });
        return custody;
    };

    async function bindExisting(input: Readonly<{
        pluginId: string;
        secretId: string;
        savedSecretId: string;
        expectedRevision?: string;
        assertCurrent?: () => void;
    }>): Promise<Readonly<{ revision: string }>> {
        const snapshot = requireSnapshot();
        const lifetimeToken = owner.readLifetimeToken?.();
        const target = targetFor(input.pluginId, input.secretId);
        const assertCurrent = (): void => {
            input.assertCurrent?.();
            if (
                lifetimeToken !== undefined
                && owner.readLifetimeToken?.() !== lifetimeToken
            ) {
                throw custodyError(
                    'plugin_secret_custody_unavailable',
                    'The active Account lifetime ended during plugin secret administration',
                );
            }
            assertSnapshotCurrent(snapshot);
        };

        assertCurrent();
        const current = state(snapshot, target);
        assertExpectedRevision(current, input.expectedRevision);
        const selected = createSavedSecretMaterializerFromSnapshotV1(snapshot)
            .inspect(input.savedSecretId);
        if (selected.status !== 'ready') {
            throw custodyError(
                'plugin_secret_custody_unavailable',
                'The selected Account SavedSecret is unavailable',
                { materialStatus: selected.status },
                selected.status === 'temporarily_unavailable',
            );
        }
        const existing = current.binding;
        const after = await update(
            snapshot,
            (settings) => ({
                ...applyAccountSettingsSavedSecretMutation(settings, {
                    kind: 'bindPluginSecret',
                    target,
                    expectedSecretId: existing?.savedSecretId ?? null,
                    expectedSecretUpdatedAt: personalSecretRevision(snapshot, existing),
                    secretId: input.savedSecretId,
                }).settings,
            }),
            assertCurrent,
            (reread) => {
                const binding = resolveBinding(reread, target);
                return binding?.savedSecretId === input.savedSecretId
                    && binding.createdForBinding === false;
            },
        );
        const next = state(after, target);
        if (
            next.binding?.savedSecretId !== input.savedSecretId
            || next.binding.createdForBinding !== false
        ) {
            throw custodyError(
                'plugin_secret_custody_unavailable',
                'Account plugin secret mutation did not produce the selected binding',
            );
        }
        return Object.freeze({ revision: next.revision });
    }

    async function unbind(input: Readonly<{
        pluginId: string;
        secretId: string;
        expectedRevision?: string;
        assertCurrent?: () => void;
    }>): Promise<Readonly<{ revision: string }>> {
        const snapshot = requireSnapshot();
        const lifetimeToken = owner.readLifetimeToken?.();
        const target = targetFor(input.pluginId, input.secretId);
        const assertCurrent = (): void => {
            input.assertCurrent?.();
            if (
                lifetimeToken !== undefined
                && owner.readLifetimeToken?.() !== lifetimeToken
            ) {
                throw custodyError(
                    'plugin_secret_custody_unavailable',
                    'The active Account lifetime ended during plugin secret administration',
                );
            }
            assertSnapshotCurrent(snapshot);
        };

        assertCurrent();
        const current = state(snapshot, target);
        assertExpectedRevision(current, input.expectedRevision);
        const existing = current.binding;
        if (!existing) return Object.freeze({ revision: current.revision });
        const after = await update(
            snapshot,
            (settings) => ({
                ...applyAccountSettingsSavedSecretMutation(settings, {
                    kind: 'unbindPluginSecret',
                    target,
                    expectedSecretId: existing.savedSecretId,
                    expectedSecretUpdatedAt: personalSecretRevision(snapshot, existing),
                }).settings,
            }),
            assertCurrent,
            (reread) => resolveBinding(reread, target) === null,
        );
        return Object.freeze({ revision: state(after, target).revision });
    }

    return Object.freeze({ resolve, bindExisting, unbind });
}
