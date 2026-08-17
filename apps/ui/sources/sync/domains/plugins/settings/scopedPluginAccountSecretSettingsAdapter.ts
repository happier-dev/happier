import {
    applyAccountSettingsSavedSecretMutation,
    eraseAccountSettingsPluginSecretBindings,
    resolveAccountSettingsPluginSecret,
} from '@happier-dev/protocol';

import type {
    ScopedPluginSettingsAccountTarget,
    ScopedPluginSettingsAdapter,
    ScopedPluginSettingsField,
    ScopedPluginSettingsReadInput,
    ScopedPluginSettingsReadResult,
    ScopedPluginSettingsWriteInput,
    ScopedPluginSettingsWriteResult,
} from './scopedPluginSettingsAdapter';

export type AccountPluginSecretSettingsSnapshot = Readonly<{
    /** The Account Settings CAS version that protects every binding and SavedSecret. */
    revision: number;
    /** Raw Account Settings are consumed only by the Protocol custody owner. */
    settings: Readonly<Record<string, unknown>>;
}>;

export type AccountPluginSecretSettingsWriteResult =
    | Readonly<{ status: 'applied'; snapshot: AccountPluginSecretSettingsSnapshot }>
    | Readonly<{ status: 'conflict'; snapshot: AccountPluginSecretSettingsSnapshot | null }>
    /** A one-shot write may have applied; this contains the owner's sole safe readback. */
    | Readonly<{ status: 'outcomeUnknown'; snapshot: AccountPluginSecretSettingsSnapshot | null }>
    | Readonly<{ status: 'unavailable' }>;

/**
 * A Settings-owned erase result intentionally exposes no raw Settings,
 * bindings, or SavedSecret identity to a cross-domain coordinator.
 */
export type AccountPluginSecretSettingsEraseResult =
    | Readonly<{ status: 'completed'; changed: boolean }>
    | Readonly<{ status: 'conflict' }>
    | Readonly<{ status: 'unavailable' }>;

/**
 * The Account Settings engine owns envelope crypto, CAS, persistence, and
 * active-account currentness. This narrow boundary supplies its current raw
 * snapshot to the Protocol SavedSecret owner; it never exposes that snapshot
 * to a plugin Settings renderer.
 */
export type AccountPluginSecretSettingsBoundary = Readonly<{
    readSnapshot(input: Readonly<{
        target: ScopedPluginSettingsAccountTarget;
    }>): AccountPluginSecretSettingsSnapshot | null;
    writeOnce(input: Readonly<{
        target: ScopedPluginSettingsAccountTarget;
        expectedRevision: number;
        mutate(settings: Readonly<Record<string, unknown>>): Record<string, unknown>;
    }>): Promise<AccountPluginSecretSettingsWriteResult>;
}>;

/**
 * Remove every Account SavedSecret binding owned by one plugin through the
 * already-captured Settings boundary. The Protocol owner computes the entire
 * next Settings document once; a version conflict is surfaced to the caller
 * rather than recomputed or replayed against a later Account snapshot.
 */
export async function eraseAccountPluginSecretSettingsBindings(params: Readonly<{
    boundary: AccountPluginSecretSettingsBoundary;
    target: ScopedPluginSettingsAccountTarget;
    pluginId: string;
}>): Promise<AccountPluginSecretSettingsEraseResult> {
    const before = params.boundary.readSnapshot({ target: params.target });
    if (!before) return { status: 'unavailable' };
    try {
        const erased = eraseAccountSettingsPluginSecretBindings(before.settings, params.pluginId);
        // Retrying a successfully completed erase is safe: there is no
        // Settings mutation left to submit and no competing writer is started.
        if (erased.removedBindingCount === 0) {
            return { status: 'completed', changed: false };
        }
        const result = await params.boundary.writeOnce({
            target: params.target,
            expectedRevision: before.revision,
            // The Protocol result belongs to this exact CAS baseline. Do not
            // recompute the erase from a later raw document inside the writer.
            mutate: () => ({ ...erased.settings }),
        });
        if (result.status === 'applied') return { status: 'completed', changed: true };
        return result.status === 'conflict'
            ? { status: 'conflict' }
            : { status: 'unavailable' };
    } catch {
        return { status: 'unavailable' };
    }
}

export type AccountPluginSecretSettingsAdapterOptions = Readonly<{
    createId(): string;
    now(): number;
}>;

function unavailable(reason: 'transport' | 'scope-mismatch' | 'target-mismatch') {
    return { status: 'unavailable' as const, reason };
}

function isAccountSecretInput(input: ScopedPluginSettingsReadInput): input is ScopedPluginSettingsReadInput & Readonly<{
    scope: Readonly<{ kind: 'account' }>;
    target: ScopedPluginSettingsAccountTarget;
}> {
    return input.scope.kind === 'account'
        && input.target.kind === 'account'
        && input.target.serverIdentityId.trim().length > 0
        && input.fields.every((field) => field.redacted);
}

function secretName(pluginId: string, fieldId: string): string {
    const name = `Plugin ${pluginId} secret ${fieldId}`;
    return name.length <= 100 ? name : name.slice(0, 100);
}

function projectSecretSnapshot(input: ScopedPluginSettingsReadInput, snapshot: AccountPluginSecretSettingsSnapshot): ScopedPluginSettingsReadResult {
    if (!isAccountSecretInput(input)) return unavailable('scope-mismatch');
    const secretStates: Record<string, 'configured' | 'missing'> = {};
    try {
        for (const field of input.fields) {
            secretStates[field.key] = resolveAccountSettingsPluginSecret(snapshot.settings, {
                pluginId: input.pluginId,
                localId: field.key,
            }) ? 'configured' : 'missing';
        }
    } catch {
        return unavailable('transport');
    }
    return {
        status: 'ready',
        snapshot: {
            scope: { kind: 'account' },
            target: input.target,
            revision: { kind: 'account-secret', value: snapshot.revision },
            // A token never crosses this presentation boundary. Consumers only
            // receive per-field configured/missing facts below.
            values: {},
            secretStates,
        },
    };
}

/**
 * A rejected one-shot SavedSecret mutation may safely expose the current
 * redacted snapshot, but it must remain observably distinct from success.
 */
function projectSecretConflict(
    input: ScopedPluginSettingsReadInput,
    snapshot: AccountPluginSecretSettingsSnapshot,
): ScopedPluginSettingsWriteResult {
    const projected = projectSecretSnapshot(input, snapshot);
    if (projected.status !== 'ready') return projected;
    return { status: 'conflict', snapshot: projected.snapshot };
}

function fieldIsDeclaredSecret(fieldId: string, fields: readonly ScopedPluginSettingsField[]): boolean {
    return fields.some((field) => field.redacted && field.key === fieldId);
}

function isSupportedAccountSecretMutation(input: ScopedPluginSettingsWriteInput): boolean {
    const mutation = input.mutation;
    if (mutation.kind === 'set' || mutation.kind === 'delete' || mutation.kind === 'unbind') return true;
    return mutation.kind === 'bind' && mutation.savedSecretId.trim().length > 0;
}

/**
 * Build the Account-only Settings adapter for fields declared as secrets.
 * It delegates binding integrity and replacement/removal cleanup to the one
 * Protocol SavedSecret mutation owner. It intentionally shares no writer or
 * reader with the Account plugin-settings record adapter.
 */
export function createAccountPluginSecretSettingsAdapter(
    boundary: AccountPluginSecretSettingsBoundary,
    options: AccountPluginSecretSettingsAdapterOptions,
): ScopedPluginSettingsAdapter {
    async function read(input: ScopedPluginSettingsReadInput): Promise<ScopedPluginSettingsReadResult> {
        if (!isAccountSecretInput(input)) return unavailable('scope-mismatch');
        const snapshot = boundary.readSnapshot({ target: input.target });
        return snapshot ? projectSecretSnapshot(input, snapshot) : unavailable('transport');
    }

    return Object.freeze({
        read,
        async write(input: ScopedPluginSettingsWriteInput): Promise<ScopedPluginSettingsWriteResult> {
            if (!isAccountSecretInput(input)) return unavailable('scope-mismatch');
            if (input.expectedRevision.kind !== 'account-secret') return unavailable('target-mismatch');
            if (!fieldIsDeclaredSecret(input.fieldId, input.fields)) return unavailable('scope-mismatch');
            if (!isSupportedAccountSecretMutation(input)) return unavailable('scope-mismatch');
            const requestedSecretValue = input.mutation.kind === 'set'
                ? input.mutation.value
                : null;
            if (input.mutation.kind === 'set' && typeof requestedSecretValue !== 'string') {
                return unavailable('scope-mismatch');
            }

            const before = boundary.readSnapshot({ target: input.target });
            if (!before) return unavailable('transport');
            if (before.revision !== input.expectedRevision.value) {
                return projectSecretConflict(input, before);
            }

            // A one-shot Account Settings mutation is never replayed after a
            // conflict. Allocate replacement metadata once before it crosses
            // that CAS boundary so the admitted mutation is stable as well.
            const replacement = typeof requestedSecretValue === 'string'
                ? {
                    id: options.createId(),
                    value: requestedSecretValue,
                    at: options.now(),
                }
                : null;

            try {
                const existing = resolveAccountSettingsPluginSecret(before.settings, {
                    pluginId: input.pluginId,
                    localId: input.fieldId,
                });
                if ((input.mutation.kind === 'delete' || input.mutation.kind === 'unbind') && !existing) {
                    return projectSecretSnapshot(input, before);
                }
                const result = await boundary.writeOnce({
                    target: input.target,
                    expectedRevision: before.revision,
                    mutate: (settings) => {
                        const resolved = resolveAccountSettingsPluginSecret(settings, {
                            pluginId: input.pluginId,
                            localId: input.fieldId,
                        });
                        const target = { pluginId: input.pluginId, localId: input.fieldId };
                        const mutation = replacement !== null
                            ? {
                                kind: 'replacePluginSecret' as const,
                                target,
                                expectedSecretId: resolved?.binding.savedSecretId ?? null,
                                expectedSecretUpdatedAt: resolved?.secret.updatedAt ?? null,
                                secret: {
                                    id: replacement.id,
                                    name: secretName(input.pluginId, input.fieldId),
                                    kind: 'other' as const,
                                    // The Account Settings CAS owner seals this
                                    // strict SecretString with Account material.
                                    encryptedValue: { _isSecretValue: true as const, value: replacement.value },
                                    createdAt: replacement.at,
                                    updatedAt: replacement.at,
                                },
                            }
                            : input.mutation.kind === 'bind'
                                ? {
                                    kind: 'bindPluginSecret' as const,
                                    target,
                                    expectedSecretId: resolved?.binding.savedSecretId ?? null,
                                    expectedSecretUpdatedAt: resolved?.secret.updatedAt ?? null,
                                    secretId: input.mutation.savedSecretId,
                                }
                                : input.mutation.kind === 'unbind'
                                    ? {
                                        kind: 'unbindPluginSecret' as const,
                                        target,
                                        expectedSecretId: resolved!.binding.savedSecretId,
                                        expectedSecretUpdatedAt: resolved!.secret.updatedAt,
                                    }
                                    : {
                                        kind: 'removePluginSecret' as const,
                                        target,
                                        expectedSecretId: resolved!.binding.savedSecretId,
                                        expectedSecretUpdatedAt: resolved!.secret.updatedAt,
                                    };
                        return applyAccountSettingsSavedSecretMutation(settings, mutation).settings;
                    },
                });
                if (result.status === 'unavailable') return unavailable('transport');
                if (result.status === 'conflict') {
                    return result.snapshot
                        ? projectSecretConflict(input, result.snapshot)
                        : unavailable('transport');
                }
                if (result.status === 'outcomeUnknown') {
                    if (!result.snapshot) return { status: 'outcomeUnknown' };
                    const projected = projectSecretSnapshot(input, result.snapshot);
                    return projected.status === 'ready'
                        ? { status: 'outcomeUnknown', snapshot: projected.snapshot }
                        : { status: 'outcomeUnknown' };
                }
                return projectSecretSnapshot(input, result.snapshot);
            } catch {
                return unavailable('transport');
            }
        },
    });
}
