import { createHash, randomUUID } from 'node:crypto';

import {
    AccountSettingsSavedSecretMutationError,
    applyAccountSettingsSavedSecretMutation,
    decryptSecretValueWithKeysV1,
    resolveAccountSettingsPluginSecret,
    type AccountSettingsPluginSecretResolution,
    type PluginAccountSecretBindingTarget,
} from '@happier-dev/protocol';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

import {
    getActiveAccountSettingsSnapshot,
    getActiveAccountSettingsSnapshotLifetimeToken,
    type ActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { readStoredCredentials } from '@/persistence';
import { refreshAccountSettingsForMinimumVersion } from '@/settings/accountSettings/refreshAccountSettingsForMinimumVersion';
import type { AccountSettingsMutationResult } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';

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
    resolution: AccountSettingsPluginSecretResolution | null,
): string {
    const hash = createHash('sha256');
    hash.update(snapshot.scopeKey ?? 'unscoped');
    hash.update('\0');
    hash.update(String(snapshot.settingsVersion));
    hash.update('\0');
    hash.update(resolution?.binding.savedSecretId ?? 'missing');
    hash.update('\0');
    hash.update(String(resolution?.secret.updatedAt ?? 0));
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
    const owner: AccountSettingsMutationOwner = params.owner ?? Object.freeze({
        readSnapshot: getActiveAccountSettingsSnapshot,
        readLifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken,
        async updateOnce(input): Promise<AccountSettingsMutationResult> {
            return await updateActivePluginAccountSettingsOnce({
                expectedVersion: input.expectedVersion,
                mutate: input.mutate,
                deps: { assertCurrent: input.assertCurrent },
            });
        },
        async rereadAfterAmbiguousWrite(input: Readonly<{
            expectedLifetimeToken?: number;
            expectedScopeKey?: string;
        }> = {}): Promise<AccountSecretSnapshot | null> {
            const credentials = await readStoredCredentials();
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

    function resolveSavedSecret(
        snapshot: AccountSecretSnapshot,
        target: PluginAccountSecretBindingTarget,
    ): AccountSettingsPluginSecretResolution | null {
        try {
            return resolveAccountSettingsPluginSecret(snapshot.settings, target);
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
        resolution: AccountSettingsPluginSecretResolution | null;
        revision: string;
    }> {
        const resolution = resolveSavedSecret(snapshot, target);
        return Object.freeze({
            resolution,
            revision: revisionFor(snapshot, resolution),
        });
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
                    state: current.resolution ? 'configured' as const : 'missing' as const,
                    revision: current.revision,
                });
            },
            async get() {
                const snapshot = requireBoundAccountSnapshot();
                const current = state(snapshot, target);
                if (!current.resolution) return null;
                assertSnapshotCurrent(snapshot);
                const value = decryptSecretValueWithKeysV1(
                    current.resolution.secret.encryptedValue,
                    snapshot.settingsSecretsReadKeys,
                );
                requireBoundAccountSnapshot();
                if (value === null) {
                    throw custodyError(
                        'plugin_secret_custody_unavailable',
                        'Account plugin secret material is unavailable',
                    );
                }
                return Object.freeze({ value, revision: current.revision });
            },
            async set(input) {
                input.assertCurrent?.();
                const snapshot = requireBoundAccountSnapshot();
                const current = state(snapshot, target);
                assertExpectedRevision(current, input.expectedRevision);
                const existing = current.resolution;
                const now = nowMs();
                const savedSecretId = createId();
                const after = await update(
                    snapshot,
                    (settings) => ({
                        ...applyAccountSettingsSavedSecretMutation(settings, {
                            kind: 'replacePluginSecret',
                            target,
                            expectedSecretId: existing?.binding.savedSecretId ?? null,
                            expectedSecretUpdatedAt: existing?.secret.updatedAt ?? null,
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
                        const resolved = resolveSavedSecret(reread, target);
                        if (!resolved || resolved.secret.id !== savedSecretId) return false;
                        return decryptSecretValueWithKeysV1(
                            resolved.secret.encryptedValue,
                            reread.settingsSecretsReadKeys,
                        ) === input.value;
                    },
                );
                const next = state(after, target);
                if (!next.resolution) {
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
                const existing = current.resolution;
                if (!existing) return Object.freeze({ revision: current.revision });
                const after = await update(
                    snapshot,
                    (settings) => ({
                        ...applyAccountSettingsSavedSecretMutation(settings, {
                            kind: 'removePluginSecret',
                            target,
                            expectedSecretId: existing.binding.savedSecretId,
                            expectedSecretUpdatedAt: existing.secret.updatedAt,
                        }).settings,
                    }),
                    () => {
                        input.assertCurrent?.();
                        requireBoundAccountSnapshot();
                    },
                    (reread) => resolveSavedSecret(reread, target) === null,
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
        const existing = current.resolution;
        const after = await update(
            snapshot,
            (settings) => ({
                ...applyAccountSettingsSavedSecretMutation(settings, {
                    kind: 'bindPluginSecret',
                    target,
                    expectedSecretId: existing?.binding.savedSecretId ?? null,
                    expectedSecretUpdatedAt: existing?.secret.updatedAt ?? null,
                    secretId: input.savedSecretId,
                }).settings,
            }),
            assertCurrent,
            (reread) => {
                const resolved = resolveSavedSecret(reread, target);
                return resolved?.binding.savedSecretId === input.savedSecretId
                    && resolved.binding.createdForBinding === false;
            },
        );
        const next = state(after, target);
        if (
            next.resolution?.binding.savedSecretId !== input.savedSecretId
            || next.resolution.binding.createdForBinding !== false
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
        const existing = current.resolution;
        if (!existing) return Object.freeze({ revision: current.revision });
        const after = await update(
            snapshot,
            (settings) => ({
                ...applyAccountSettingsSavedSecretMutation(settings, {
                    kind: 'unbindPluginSecret',
                    target,
                    expectedSecretId: existing.binding.savedSecretId,
                    expectedSecretUpdatedAt: existing.secret.updatedAt,
                }).settings,
            }),
            assertCurrent,
            (reread) => resolveSavedSecret(reread, target) === null,
        );
        return Object.freeze({ revision: state(after, target).revision });
    }

    return Object.freeze({ resolve, bindExisting, unbind });
}
