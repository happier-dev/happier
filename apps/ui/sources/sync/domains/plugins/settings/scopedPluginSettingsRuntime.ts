import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { eraseAccountSettingsPluginSecretBindings } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { PluginAccountSettingsMutationResponseV1Schema, PluginAccountSettingsReadResponseV1Schema, PluginAccountSettingsStorageUnavailableV1Schema, PluginAccountSettingsValuesV1Schema } from '@happier-dev/protocol/plugins/settings/accountSettingsV1';

import { getRandomBytes } from '@/platform/cryptoRandom';
import { randomUUID } from '@/platform/randomUUID';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    areServerProfileIdentifiersEquivalent,
    getServerProfileLegacyServerIds,
    resolveServerProfileForPortableIdentity,
} from '@/sync/domains/server/serverProfiles';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
import { serverFetch, type ExpectedActiveServerFetchBasis } from '@/sync/http/client';
import {
    machinePluginSecretDelete,
    machinePluginSecretSet,
    machinePluginSecretStatus,
    machinePluginSettingsGet,
    machinePluginSettingsSet,
    watchMachinePluginSettingsChanges,
} from '@/sync/ops/machineContributionRegistryProjection';
import { sync } from '@/sync/sync';

import {
    createAccountScopedPluginSettingsTransport,
    createScopedPluginSettingsAdapter,
    withoutScopedPluginSettingsWriteSnapshot,
    type ScopedPluginSettingsAccountRecordBoundary,
    type ScopedPluginSettingsAccountRecordRead,
    type ScopedPluginSettingsAccountRecordWriteResult,
    type ScopedPluginSettingsAccountTarget,
    type ScopedPluginSettingsAdapter,
    type ScopedPluginSettingsReadInput,
    type ScopedPluginSettingsReadResult,
    type ScopedPluginSettingsWriteInput,
    type ScopedPluginSettingsWriteResult,
    type ScopedPluginSettingsWatch,
    type ScopedPluginSettingsWatchInput,
} from './scopedPluginSettingsAdapter';
import {
    createAccountPluginSecretSettingsAdapter,
    eraseAccountPluginSecretSettingsBindings,
    type AccountPluginSecretSettingsBoundary,
    type AccountPluginSecretSettingsEraseResult,
    type AccountPluginSecretSettingsSnapshot,
    type AccountPluginSecretSettingsWriteResult,
} from './scopedPluginAccountSecretSettingsAdapter';
import { watchActiveScopedPluginSettingsChanges } from './scopedPluginSettingsChangeWatch';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

type ActiveAccountRequestContext = Readonly<{
    target: ScopedPluginSettingsAccountTarget;
    lifetime: ActiveServerAccountScopeLifetime;
    expectedActiveServer: ExpectedActiveServerFetchBasis;
    token: string;
    encryption: NonNullable<typeof sync.encryption> | null;
}>;

function encodePluginId(pluginId: string): string {
    return encodeURIComponent(pluginId);
}

/**
 * Maps an already-selected device-local profile id to its portable identity.
 * It does not select a profile, invent an identity, or permit an unknown
 * routing id to become Account state.
 */
export function resolveScopedPluginSettingsServerIdentity(
    serverId: string | null | undefined,
): string | null {
    return resolvePortableServerIdentityForRoutingId(serverId);
}

/**
 * The Account route can only serve the currently authenticated Account. A
 * portable target may identify another configured server, but it never causes
 * the UI to route an authenticated request there behind the user's back.
 */
function captureActiveAccountRequestContext(
    target: ScopedPluginSettingsAccountTarget,
): ActiveAccountRequestContext | null {
    const lifetime = captureActiveServerAccountScopeLifetime();
    const snapshot = getActiveServerSnapshot();
    const resolved = resolveServerProfileForPortableIdentity(target.serverIdentityId);
    const credentials = sync.getCredentials();
    if (
        !lifetime
        || resolved.kind !== 'resolved'
        || !areServerProfileIdentifiersEquivalent(resolved.profile.id, snapshot.serverId)
        || !credentials?.token
    ) {
        return null;
    }
    return {
        target,
        lifetime,
        expectedActiveServer: { serverId: snapshot.serverId, generation: snapshot.generation },
        token: credentials.token,
        encryption: sync.encryption,
    };
}

function isCurrent(context: ActiveAccountRequestContext): boolean {
    const snapshot = getActiveServerSnapshot();
    const credentials = sync.getCredentials();
    if (
        !context.lifetime.isCurrent()
        || snapshot.serverId !== context.expectedActiveServer.serverId
        || snapshot.generation !== context.expectedActiveServer.generation
        || credentials?.token !== context.token
    ) {
        return false;
    }
    const resolved = resolveServerProfileForPortableIdentity(context.target.serverIdentityId);
    return resolved.kind === 'resolved'
        && areServerProfileIdentifiersEquivalent(resolved.profile.id, snapshot.serverId);
}

function isExactAccountTarget(
    left: ScopedPluginSettingsAccountTarget,
    right: ScopedPluginSettingsAccountTarget,
): boolean {
    return left.serverIdentityId === right.serverIdentityId;
}

/**
 * Reads the current in-memory winner only after the active Account lifetime,
 * selected portable identity, and persisted Account scope still agree. Raw
 * Settings stay below the Protocol SavedSecret boundary that consumes them.
 */
function readAccountPluginSecretSettingsSnapshot(
    context: ActiveAccountRequestContext,
): AccountPluginSecretSettingsSnapshot | null {
    if (!isCurrent(context)) return null;
    const state = storage.getState();
    const settingsVersion = state.settingsVersion;
    if (
        !areAccountSettingsScopesEqual(state.settingsScope, context.lifetime.scope)
        || typeof settingsVersion !== 'number'
        || !Number.isInteger(settingsVersion)
        || settingsVersion < 0
    ) {
        return null;
    }
    return {
        revision: settingsVersion,
        // The Protocol SavedSecret owner gets the exact Account Settings raw
        // baseline; this module never projects it to a Settings renderer.
        settings: { ...state.settings },
    };
}

function createAccountPluginSecretSettingsBoundary(
    context: ActiveAccountRequestContext,
    signal?: AbortSignal,
): AccountPluginSecretSettingsBoundary {
    return Object.freeze({
        readSnapshot({ target }) {
            return !signal?.aborted && isExactAccountTarget(target, context.target)
                ? readAccountPluginSecretSettingsSnapshot(context)
                : null;
        },
        async writeOnce(input): Promise<AccountPluginSecretSettingsWriteResult> {
            if (signal?.aborted || !isExactAccountTarget(input.target, context.target) || !isCurrent(context)) {
                return { status: 'unavailable' };
            }
            const controller = new AbortController();
            const abort = () => controller.abort();
            const retirement = context.lifetime.onRetire(abort);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            try {
                if (controller.signal.aborted || !isCurrent(context)) return { status: 'unavailable' };
                const result = await sync.mutateAccountSettingsOnce({
                    signal: controller.signal,
                    expectedSettingsScope: context.lifetime.scope,
                    expectedSettingsVersion: input.expectedRevision,
                    mutate(raw) {
                        if (controller.signal.aborted || !isCurrent(context)) {
                            throw new Error('Account Settings scope changed while mutating a plugin secret');
                        }
                        return { settings: input.mutate(raw), value: null };
                    },
                });
                const snapshot = controller.signal.aborted ? null : readAccountPluginSecretSettingsSnapshot(context);
                if (result.status === 'conflict') {
                    return { status: 'conflict', snapshot };
                }
                if (result.status === 'outcomeUnknown') {
                    const safeSnapshot = result.safeSnapshotVersion === undefined
                        ? null
                        : snapshot?.revision === result.safeSnapshotVersion
                            ? snapshot
                            : null;
                    return { status: 'outcomeUnknown', snapshot: safeSnapshot };
                }
                return {
                    status: 'applied',
                    revision: result.settingsVersion,
                    snapshot: snapshot?.revision === result.settingsVersion ? snapshot : null,
                };
            } catch {
                return { status: 'unavailable' };
            } finally {
                signal?.removeEventListener('abort', abort);
                retirement.dispose();
            }
        },
    });
}

/**
 * The single Settings/SavedSecret arm for a user-initiated plugin erase.
 * Callers provide only an already-selected Account target and plugin id; this
 * owner captures the live Account lifetime, performs at most one whole-
 * Settings CAS, and never exposes raw Settings or SavedSecret identifiers.
 */
export async function eraseCurrentAccountPluginSecretBindings(input: Readonly<{
    pluginId: string;
    target: ScopedPluginSettingsAccountTarget;
    signal?: AbortSignal;
    accountContext?: Pick<LazyActionAccountContext, 'serverIdentityId' | 'accountLifetime' | 'assertCurrent' | 'mutateRawSettings'>;
}>): Promise<AccountPluginSecretSettingsEraseResult> {
    const account = input.accountContext;
    if (account) {
        if (input.signal?.aborted || !account.accountLifetime.isCurrent()
            || account.serverIdentityId !== input.target.serverIdentityId) return { status: 'unavailable' };
        try {
            account.assertCurrent();
            let changed = false;
            const result = await account.mutateRawSettings(raw => {
                input.signal?.throwIfAborted();
                account.assertCurrent();
                const erased = eraseAccountSettingsPluginSecretBindings(raw, input.pluginId);
                changed = erased.removedBindingCount > 0;
                return { ...erased.settings };
            }, { rebaseOnConflict: false, observeOutcome: true });
            if (result.status === 'conflict') return { status: 'conflict' };
            if (result.status === 'outcomeUnknown') return { status: 'outcomeUnknown' };
            return { status: 'completed', changed };
        } catch {
            return { status: 'unavailable' };
        }
    }
    const context = captureActiveAccountRequestContext(input.target);
    if (!context) return { status: 'unavailable' };
    return eraseAccountPluginSecretSettingsBindings({
        boundary: createAccountPluginSecretSettingsBoundary(context, input.signal),
        target: input.target,
        pluginId: input.pluginId,
    });
}

const unavailableAccountPluginSecretBoundary: AccountPluginSecretSettingsBoundary = Object.freeze({
    readSnapshot: () => null,
    async writeOnce(): Promise<AccountPluginSecretSettingsWriteResult> {
        return { status: 'unavailable' };
    },
});

const unavailableScopedPluginSettingsWatch: ScopedPluginSettingsWatch = Object.freeze({
    dispose(): void {},
});

const accountPluginSecretSettingsAdapterOptions = Object.freeze({
    createId: () => `plugin_secret_${randomUUID()}`,
    now: () => Date.now(),
});

function createRuntimeAccountPluginSecretSettingsAdapter(
    input: ScopedPluginSettingsReadInput | ScopedPluginSettingsWriteInput,
): ScopedPluginSettingsAdapter {
    const context = input.target.kind === 'account'
        ? captureActiveAccountRequestContext(input.target)
        : null;
    return createAccountPluginSecretSettingsAdapter(
        context
            ? createAccountPluginSecretSettingsBoundary(context)
            : unavailableAccountPluginSecretBoundary,
        accountPluginSecretSettingsAdapterOptions,
    );
}

/**
 * Canonical Account-secret reader/writer for declaration-backed plugin
 * Settings. It projects only configured/missing state and delegates binding,
 * CAS, encryption, and persistence to the incumbent Account Settings owners.
 */
export const scopedPluginAccountSecretSettingsAdapter: ScopedPluginSettingsAdapter = Object.freeze({
    read(input: ScopedPluginSettingsReadInput): Promise<ScopedPluginSettingsReadResult> {
        return createRuntimeAccountPluginSecretSettingsAdapter(input).read(input);
    },
    write(input: ScopedPluginSettingsWriteInput): Promise<ScopedPluginSettingsWriteResult> {
        return createRuntimeAccountPluginSecretSettingsAdapter(input).write(input);
    },
    watch(input: ScopedPluginSettingsWatchInput): ScopedPluginSettingsWatch {
        if (input.scope.kind !== 'account' || input.target.kind !== 'account') {
            return unavailableScopedPluginSettingsWatch;
        }
        const context = captureActiveAccountRequestContext(input.target);
        if (!context || typeof storage.subscribe !== 'function') {
            return unavailableScopedPluginSettingsWatch;
        }
        let disposed = false;
        let observedVersion = storage.getState().settingsVersion;
        let unsubscribe: (() => void) | null = null;
        let retirement: Readonly<{ dispose(): void }> | null = null;
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            unsubscribe?.();
            unsubscribe = null;
            retirement?.dispose();
            retirement = null;
        };
        retirement = context.lifetime.onRetire(dispose);
        try {
            unsubscribe = storage.subscribe((next) => {
                if (disposed || !isCurrent(context)) return;
                const nextVersion = next.settingsVersion;
                if (nextVersion === observedVersion) return;
                observedVersion = nextVersion;
                if (
                    !areAccountSettingsScopesEqual(next.settingsScope, context.lifetime.scope)
                    || typeof nextVersion !== 'number'
                    || !Number.isInteger(nextVersion)
                    || nextVersion < 0
                ) {
                    return;
                }
                try {
                    input.onInvalidated();
                } catch {
                    // A record subscriber cannot corrupt the canonical Account
                    // Settings store or its captured active lifetime.
                }
            });
        } catch {
            dispose();
            return unavailableScopedPluginSettingsWatch;
        }
        return Object.freeze({ dispose });
    },
});

function requestHeaders(context: ActiveAccountRequestContext): Readonly<Record<string, string>> {
    return {
        Authorization: `Bearer ${context.token}`,
        'Content-Type': 'application/json',
    };
}

async function readAccountEncryptionMode(
    context: ActiveAccountRequestContext,
): Promise<'plain' | 'e2ee' | null> {
    if (!isCurrent(context)) return null;
    const response = await serverFetch(
        '/v1/account/encryption',
        { method: 'GET', headers: requestHeaders(context) },
        {
            includeAuth: false,
            retry: 'none',
            expectedActiveServer: context.expectedActiveServer,
        },
    );
    if (!isCurrent(context) || !response.ok) return null;
    const body = await response.json().catch(() => null);
    if (!isCurrent(context)) return null;
    const parsed = AccountEncryptionModeResponseSchema.safeParse(body);
    return parsed.success && (parsed.data.mode === 'plain' || parsed.data.mode === 'e2ee')
        ? parsed.data.mode
        : null;
}

async function readAccountRecord(
    input: Readonly<{ pluginId: string; target: ScopedPluginSettingsAccountTarget }>,
    context: ActiveAccountRequestContext | null,
): Promise<ScopedPluginSettingsAccountRecordRead> {
    if (!context) return { status: 'unavailable' };
    try {
        const mode = await readAccountEncryptionMode(context);
        if (!mode || !isCurrent(context)) return { status: 'unavailable' };
        const response = await serverFetch(
            `/v1/account/plugin-settings/${encodePluginId(input.pluginId)}`,
            { method: 'GET', headers: requestHeaders(context) },
            {
                includeAuth: false,
                retry: 'none',
                expectedActiveServer: context.expectedActiveServer,
            },
        );
        if (!isCurrent(context) || !response.ok) return { status: 'unavailable' };
        const body = await response.json().catch(() => null);
        if (!isCurrent(context)) return { status: 'unavailable' };
        const parsed = PluginAccountSettingsReadResponseV1Schema.safeParse(body);
        if (!parsed.success) return { status: 'unavailable' };
        if (parsed.data.status === 'absent') return { status: 'absent' };
        if (parsed.data.status === 'deleted') return { status: 'deleted', revision: parsed.data.revision };
        if (parsed.data.content.t === 'plain') {
            if (mode !== 'plain') return { status: 'unavailable' };
            const values = PluginAccountSettingsValuesV1Schema.safeParse(parsed.data.content.v);
            return values.success
                ? { status: 'present', revision: parsed.data.revision, values: values.data.values }
                : { status: 'unavailable' };
        }
        if (mode !== 'e2ee' || !context.encryption) return { status: 'unavailable' };
        const opened = openAccountScopedBlobCiphertext({
            kind: 'plugin_declarative_settings',
            material: { type: 'dataKey', machineKey: context.encryption.getContentPrivateKey() },
            ciphertext: parsed.data.content.c,
        });
        const values = opened ? PluginAccountSettingsValuesV1Schema.safeParse(opened.value) : null;
        return values?.success
            ? { status: 'present', revision: parsed.data.revision, values: values.data.values }
            : { status: 'unavailable' };
    } catch {
        return { status: 'unavailable' };
    }
}

async function writeAccountRecord(input: Readonly<{
    pluginId: string;
    target: ScopedPluginSettingsAccountTarget;
    expectedRevision: number | 'absent';
    values: Readonly<Record<string, unknown>>;
}>, context: ActiveAccountRequestContext | null): Promise<ScopedPluginSettingsAccountRecordWriteResult> {
    if (!context) return { status: 'unavailable' };
    let issued = false;
    try {
        const values = PluginAccountSettingsValuesV1Schema.safeParse({ v: 1, values: input.values });
        if (!values.success) return { status: 'unavailable' };
        const mode = await readAccountEncryptionMode(context);
        if (!mode || !isCurrent(context)) return { status: 'unavailable' };
        if (mode === 'e2ee' && !context.encryption) return { status: 'unavailable' };
        const content = mode === 'plain'
            ? { t: 'plain' as const, v: values.data }
            : {
                t: 'encrypted' as const,
                c: sealAccountScopedBlobCiphertext({
                    kind: 'plugin_declarative_settings',
                    material: { type: 'dataKey' as const, machineKey: context.encryption!.getContentPrivateKey() },
                    payload: values.data,
                    randomBytes: getRandomBytes,
                }),
            };
        const body = JSON.stringify({ expectedRevision: input.expectedRevision, content });
        if (!isCurrent(context)) return { status: 'unavailable' };
        issued = true;
        const response = await serverFetch(
            `/v1/account/plugin-settings/${encodePluginId(input.pluginId)}`,
            {
                method: 'POST',
                headers: requestHeaders(context),
                body,
            },
            {
                includeAuth: false,
                retry: 'none',
                expectedActiveServer: context.expectedActiveServer,
            },
        );
        if (response.status < 200 || response.status >= 300) {
            if (response.status !== 503) return { status: 'outcomeUnknown' };
            const unavailableBody = await response.json().catch(() => null);
            if (PluginAccountSettingsStorageUnavailableV1Schema.safeParse(unavailableBody).success) {
                // The route's typed storage-unavailable response proves no record
                // mutation was produced, unlike a lost/malformed acknowledgement.
                return { status: 'unavailable' };
            }
            return { status: 'outcomeUnknown' };
        }
        const responseBody = await response.json().catch(() => null);
        const parsed = PluginAccountSettingsMutationResponseV1Schema.safeParse(responseBody);
        if (parsed.success) return parsed.data;
        return { status: 'outcomeUnknown' };
    } catch {
        return issued
            ? { status: 'outcomeUnknown' }
            : { status: 'unavailable' };
    }
}

function createAccountTransport(target: ScopedPluginSettingsAccountTarget) {
    // One logical operation, including migration and settlement readback, must
    // never recapture another Account between its record read and CAS write.
    const context = captureActiveAccountRequestContext(target);
    const boundary: ScopedPluginSettingsAccountRecordBoundary = {
        readRecord: (input) => readAccountRecord(input, context),
        writeRecord: (input) => writeAccountRecord(input, context),
    };
    const transport = createAccountScopedPluginSettingsTransport(boundary, {
        resolveLegacyServerIdentityIds: (selected) => getServerProfileLegacyServerIds(selected.serverIdentityId),
    });
    return {
        async read(input: Parameters<typeof transport.read>[0]): Promise<ScopedPluginSettingsReadResult> {
            const result = await transport.read(input);
            return context && isCurrent(context) ? result : { status: 'unavailable', reason: 'transport' };
        },
        async write(input: Parameters<typeof transport.write>[0]): Promise<ScopedPluginSettingsWriteResult> {
            const result = await transport.write(input);
            return context && isCurrent(context) ? result : withoutScopedPluginSettingsWriteSnapshot(result);
        },
    };
}

/** The single live owner consumed by all host-rendered plugin Settings. */
const runtimeScopedPluginSettingsAdapter = createScopedPluginSettingsAdapter({
    daemonSecretStatus: machinePluginSecretStatus,
    daemonSecretSet: machinePluginSecretSet,
    daemonSecretDelete: machinePluginSecretDelete,
    daemonGet: machinePluginSettingsGet,
    daemonSet: machinePluginSettingsSet,
    accountRead: (input) => createAccountTransport(input.target).read(input),
    accountWrite: (input) => createAccountTransport(input.target).write(input),
});

export const scopedPluginSettingsAdapter: ScopedPluginSettingsAdapter = Object.freeze({
    ...runtimeScopedPluginSettingsAdapter,
    watch(input: ScopedPluginSettingsWatchInput): ScopedPluginSettingsWatch {
        if (input.scope.kind === 'daemon' && input.target.kind === 'daemon') {
            return watchMachinePluginSettingsChanges(input.target.machineId, {
                serverId: input.target.serverId,
                serverIdentityId: input.target.serverIdentityId,
                pluginId: input.pluginId,
                onInvalidated: input.onInvalidated,
            });
        }
        if (input.scope.kind !== 'account' || input.target.kind !== 'account') {
            return unavailableScopedPluginSettingsWatch;
        }
        const context = captureActiveAccountRequestContext(input.target);
        if (!context) return unavailableScopedPluginSettingsWatch;
        return watchActiveScopedPluginSettingsChanges({
            pluginId: input.pluginId,
            target: input.target,
            lifetime: context.lifetime,
            onInvalidated: input.onInvalidated,
        });
    },
});
