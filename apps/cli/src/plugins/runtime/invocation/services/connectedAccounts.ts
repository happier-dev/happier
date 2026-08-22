import { Buffer } from 'node:buffer';

import {
    ConnectedAccountMaterializationRequestSchema,
    type QualifiedConnectedAccountPurposeV1,
} from '@happier-dev/protocol/connect/connected-account-purposes';
import {
    QualifiedConnectedAccountRefSchema,
} from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type {
    ConnectedServiceCredentialRevisionV1,
} from '@happier-dev/protocol/connect/connected-service-schemas';
import type {
    ConnectedAccountMaterializationRequest,
    ConnectedAccountsService,
    ConnectedAccountBindingSummary as PluginConnectedAccountBindingSummary,
    ConnectedAccountListedAccount as PluginConnectedAccountListedAccount,
    ConnectedAccountListedState as PluginConnectedAccountListedState,
    ConnectedAccountMaterialization as PluginConnectedAccountMaterialization,
    ConnectedAccountMetadataList as PluginConnectedAccountMetadataList,
    ConnectedAccountRef as PluginConnectedAccountRef,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type {
    PluginContributionRef,
} from '@happier-dev/plugin-sdk';
import { isPluginError, PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import type {
    PluginConnectedAccountBindingScope,
    PluginInvocationServicesSeed,
} from './types';
import { PLUGIN_LOG_MAX_SECRET_COMPONENT_BYTES } from './logger';
import { readCredentialRedactionValues } from './credentialRedactionValues';
import type { HostCurrentSessionUiServices } from '@/agent/runtime/state/currentSessionUiTypes';
import type { PermissionRequestOwner } from '@/agent/permissions/permissionRequestOwner';
import { clonePluginPlainData } from '../../plainData';
import {
    normalizeConnectedAccountConfiguredBase,
} from '@/plugins/runtime/connectedAccounts/configuredOrigins';

export type StablePluginConnectedAccountsAuthorizedPurpose = Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    serviceRefs: readonly PluginContributionRef[];
}>;

/**
 * Host-private receipt bridge for an enclosing raw-credential callback. The
 * canonical Connected Account owner remains the sole producer of revisions.
 */
export type ConnectedAccountMaterializationCredentialRevisionBasis = Readonly<{
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null;
    captureCredentialRevision(credentialRevision: ConnectedServiceCredentialRevisionV1): void;
}>;

export type StablePluginConnectedAccountsOwner = Readonly<{
    getBinding(
        input: StablePluginConnectedAccountsAuthorizedPurpose & Readonly<{
            exactPurposeBindingSubjectId?: string;
            sessionId?: string;
            signal: AbortSignal;
        }>,
    ): Promise<PluginConnectedAccountBindingSummary | null>;
    requestSelection(
        input: StablePluginConnectedAccountsAuthorizedPurpose & Readonly<{
            assertGenerationCurrent(): void;
            currentSession?: HostCurrentSessionUiServices;
            permissionOwner?: PermissionRequestOwner;
            reason: string;
            signal: AbortSignal;
        }>,
    ): Promise<PluginConnectedAccountBindingSummary>;
    materialize(
        input: StablePluginConnectedAccountsAuthorizedPurpose & Readonly<{
            exactPurposeBindingSubjectId?: string;
            sessionId?: string;
            expectedAccount?: PluginConnectedAccountRef;
            credentialRevisionBasis?: ConnectedAccountMaterializationCredentialRevisionBasis;
            request: ConnectedAccountMaterializationRequest;
            signal: AbortSignal;
        }>,
    ): Promise<PluginConnectedAccountMaterialization>;
    /**
     * Bounded metadata projection of the purpose's exact current target. The
     * seam clamps `limit` before dispatch; the owner reports its own elision
     * through an explicit complete-or-truncated status.
     */
    listAccounts(
        input: StablePluginConnectedAccountsAuthorizedPurpose & Readonly<{
            exactPurposeBindingSubjectId?: string;
            sessionId?: string;
            limit: number;
            signal: AbortSignal;
        }>,
    ): Promise<PluginConnectedAccountMetadataList>;
    /**
     * Materializes one account admitted by the exact current target. The owner
     * re-verifies target membership and currentness around credential
     * materialization and never mutates the selected binding.
     */
    materializeListedAccount(
        input: StablePluginConnectedAccountsAuthorizedPurpose & Readonly<{
            exactPurposeBindingSubjectId?: string;
            sessionId?: string;
            account: PluginConnectedAccountRef;
            request: ConnectedAccountMaterializationRequest;
            signal: AbortSignal;
        }>,
    ): Promise<PluginConnectedAccountMaterialization>;
    watch(
        input: StablePluginConnectedAccountsAuthorizedPurpose & Readonly<{
            exactPurposeBindingSubjectId?: string;
            sessionId?: string;
            listener(): Promise<void>;
        }>,
    ): Disposable;
}>;

export type StablePluginConnectedAccountsHost = Readonly<{
    bind(
        seed: PluginInvocationServicesSeed,
        scopes: readonly PluginConnectedAccountBindingScope[],
        options?: Readonly<{
            exactPurposeBindingSubjectId?: string;
        }>,
    ): ConnectedAccountsService;
    /** Synchronously disposes every watch owned by this executable registry generation. */
    retire(): void;
}>;

export type StablePluginConnectedAccountsHostOptions = Readonly<{
    registerRawForRedaction(seed: PluginInvocationServicesSeed, value: string): void;
    registerExactForRedaction(seed: PluginInvocationServicesSeed, value: string): void;
}>;

function generationRetired(): PluginError {
    return new PluginError({
        code: 'plugin_final_generation_retired',
        message: 'Plugin generation is no longer current',
    });
}

function undeclaredPurpose(purpose: string): PluginError {
    return new PluginError({
        code: 'plugin_connected_account_purpose_undeclared',
        message: `Connected Accounts purpose '${purpose}' is not authorized for this invocation`,
    });
}

function operationDenied(purpose: string, operation: 'select' | 'use'): PluginError {
    return new PluginError({
        code: 'plugin_host_access_operation_denied',
        message: `Connected Accounts purpose '${purpose}' does not authorize '${operation}'`,
    });
}

function materializationKindDenied(
    purpose: string,
    kind: ConnectedAccountMaterializationRequest['kind'],
): PluginError {
    return new PluginError({
        code: 'plugin_host_access_operation_denied',
        message: `Connected Accounts purpose '${purpose}' does not authorize '${kind}' materialization`,
    });
}

function materializationOutOfScope(): PluginError {
    return new PluginError({
        code: 'plugin_connected_account_binding_out_of_scope',
        message: 'Connected Accounts owner returned materialization outside the request authorization',
    });
}

function listingOutOfScope(): PluginError {
    return new PluginError({
        code: 'plugin_connected_account_binding_out_of_scope',
        message: 'Connected Accounts owner returned a listing outside the request authorization',
    });
}

function assertCurrent(seed: PluginInvocationServicesSeed): void {
    if (seed.signal.aborted || !seed.isGenerationCurrent()) throw generationRetired();
}

function resolveScope(
    scopes: ReadonlyMap<string, PluginConnectedAccountBindingScope>,
    purpose: string,
    operation: 'select' | 'use',
): PluginConnectedAccountBindingScope {
    const scope = scopes.get(purpose);
    if (!scope) throw undeclaredPurpose(purpose);
    if (!scope.operations.includes(operation)) throw operationDenied(purpose, operation);
    return scope;
}

function authorizedPurpose(
    seed: PluginInvocationServicesSeed,
    scope: PluginConnectedAccountBindingScope,
): StablePluginConnectedAccountsAuthorizedPurpose {
    return Object.freeze({
        purpose: Object.freeze({
            consumer: Object.freeze({
                pluginId: seed.plugin.id,
                localId: seed.contribution.id,
            }),
            purpose: scope.purpose,
        }),
        serviceRefs: scope.serviceRefs,
    });
}

function assertAuthorizedSummary(
    scope: PluginConnectedAccountBindingScope,
    summary: PluginConnectedAccountBindingSummary,
): PluginConnectedAccountBindingSummary {
    const serviceAuthorized = scope.serviceRefs.some((service) => (
        service.pluginId === summary.service.pluginId
        && service.localId === summary.service.localId
    ));
    if (summary.purpose !== scope.purpose || !serviceAuthorized) {
        throw new PluginError({
            code: 'plugin_connected_account_binding_out_of_scope',
            message: 'Connected Accounts owner returned a binding outside the invocation authorization',
        });
    }
    return summary;
}

function combineSignals(
    invocationSignal: AbortSignal,
    operationSignal: AbortSignal | undefined,
): Readonly<{ signal: AbortSignal; dispose(): void }> {
    if (!operationSignal || operationSignal === invocationSignal) {
        return Object.freeze({ signal: invocationSignal, dispose() {} });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    invocationSignal.addEventListener('abort', abort, { once: true });
    operationSignal.addEventListener('abort', abort, { once: true });
    if (invocationSignal.aborted || operationSignal.aborted) controller.abort();
    return Object.freeze({
        signal: controller.signal,
        dispose() {
            invocationSignal.removeEventListener('abort', abort);
            operationSignal.removeEventListener('abort', abort);
        },
    });
}

function registerMaterializationForRedaction(
    materialization: PluginConnectedAccountMaterialization,
    seed: PluginInvocationServicesSeed,
    options: StablePluginConnectedAccountsHostOptions | undefined,
): void {
    if (!options) return;
    const registerString = (value: string): void => {
        if (value.length === 0) return;
        options.registerRawForRedaction(seed, value);
        for (const redactionValue of readCredentialRedactionValues({
            authorizationValue: value,
            maximumAuthorizationTokenBytes:
                PLUGIN_LOG_MAX_SECRET_COMPONENT_BYTES,
        })) {
            if (redactionValue === value) continue;
            options.registerRawForRedaction(seed, redactionValue);
        }
    };
    if (materialization.kind === 'httpHeaders') {
        for (const value of Object.values(materialization.headers)) {
            registerString(value);
        }
        return;
    }
    if (materialization.kind === 'environment') {
        for (const value of Object.values(materialization.env)) {
            registerString(value);
        }
        return;
    }
    for (const bytes of Object.values(materialization.files)) {
        if (bytes.byteLength === 0) continue;
        const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        options.registerExactForRedaction(seed, buffer.toString('base64'));
        options.registerExactForRedaction(seed, buffer.toString('base64url'));
        options.registerExactForRedaction(seed, buffer.toString('hex'));
        try {
            registerString(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch {
            // Opaque binary files have no exact UTF-8 string form to redact.
        }
    }
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
    return isUnknownRecord(value)
        && typeof value.addEventListener === 'function'
        && typeof value.removeEventListener === 'function'
        && typeof value.aborted === 'boolean';
}

function snapshotMaterializationRequest(
    request: unknown,
): ConnectedAccountMaterializationRequest {
    let snapshot: unknown;
    try {
        snapshot = clonePluginPlainData(request, {
            path: 'Connected Accounts materialization request',
            invalid: () => materializationOutOfScope(),
        });
    } catch (error) {
        if (isPluginError(error)) throw error;
        throw materializationOutOfScope();
    }
    const parsed = ConnectedAccountMaterializationRequestSchema.safeParse(snapshot);
    if (!parsed.success) throw materializationOutOfScope();
    return parsed.data;
}

function snapshotAccount(
    account: unknown,
    label: string,
): PluginConnectedAccountRef | undefined {
    if (account === undefined) return undefined;
    let snapshot: unknown;
    try {
        snapshot = clonePluginPlainData(account, {
            path: `Connected Accounts ${label}`,
            invalid: () => materializationOutOfScope(),
        });
    } catch (error) {
        if (isPluginError(error)) throw error;
        throw materializationOutOfScope();
    }
    const parsed = QualifiedConnectedAccountRefSchema.safeParse(snapshot);
    if (!parsed.success) throw materializationOutOfScope();
    return Object.freeze({
        service: Object.freeze({ ...parsed.data.service }),
        accountId: parsed.data.accountId,
    });
}

function snapshotMaterializationOptions(
    options: unknown,
): Readonly<{
    signal?: AbortSignal;
    expectedAccount?: PluginConnectedAccountRef;
}> {
    if (
        !isUnknownRecord(options)
        || Object.prototype.hasOwnProperty.call(options, 'account')
    ) {
        throw materializationOutOfScope();
    }
    const hasExpectedAccount = Object.prototype.hasOwnProperty.call(options, 'expectedAccount');
    const expectedAccount = hasExpectedAccount
        ? snapshotAccount(options.expectedAccount, 'expected account')
        : undefined;
    const signal = options.signal;
    if (signal !== undefined && !isAbortSignalLike(signal)) {
        throw materializationOutOfScope();
    }
    return Object.freeze({
        ...(signal ? { signal } : {}),
        ...(expectedAccount ? { expectedAccount } : {}),
    });
}

function snapshotMaterialization(
    request: ConnectedAccountMaterializationRequest,
    materialization: unknown,
): PluginConnectedAccountMaterialization {
    if (!isUnknownRecord(materialization) || materialization.kind !== request.kind) {
        throw materializationOutOfScope();
    }
    if (request.kind === 'httpHeaders') {
        if (!isUnknownRecord(materialization.headers)) throw materializationOutOfScope();
        const requestedNames = new Set(request.headerNames.map((name) => name.toLowerCase()));
        const returnedNames = new Set<string>();
        const headerEntries: Array<readonly [string, string]> = [];
        for (const [name, value] of Object.entries(materialization.headers)) {
            const normalizedName = name.toLowerCase();
            if (
                typeof value !== 'string'
                || !requestedNames.has(normalizedName)
                || returnedNames.has(normalizedName)
            ) {
                throw materializationOutOfScope();
            }
            returnedNames.add(normalizedName);
            headerEntries.push([name, value]);
        }
        return Object.freeze({
            kind: 'httpHeaders',
            headers: Object.freeze(Object.fromEntries(headerEntries)),
        });
    }
    if (request.kind === 'environment') {
        if (!isUnknownRecord(materialization.env)) throw materializationOutOfScope();
        const requestedKeys = new Set(request.keys);
        const environmentEntries: Array<readonly [string, string]> = [];
        for (const [key, value] of Object.entries(materialization.env)) {
            if (typeof value !== 'string' || !requestedKeys.has(key)) {
                throw materializationOutOfScope();
            }
            environmentEntries.push([key, value]);
        }
        return Object.freeze({
            kind: 'environment',
            env: Object.freeze(Object.fromEntries(environmentEntries)),
        });
    }
    if (!isUnknownRecord(materialization.files)) throw materializationOutOfScope();
    const requestedFileIds = new Set(request.fileIds);
    const fileEntries: Array<readonly [string, Uint8Array]> = [];
    for (const [fileId, bytes] of Object.entries(materialization.files)) {
        if (!(bytes instanceof Uint8Array) || !requestedFileIds.has(fileId)) {
            throw materializationOutOfScope();
        }
        fileEntries.push([fileId, new Uint8Array(bytes)]);
    }
    return Object.freeze({
        kind: 'files',
        files: Object.freeze(Object.fromEntries(fileEntries)),
    });
}

/**
 * The bounded metadata listing has no resumable cursor, so its ceiling is the
 * same authorized-inventory bound the interactive selection and Action-form
 * owners already enforce. A caller-supplied limit is clamped into it.
 */
export const CONNECTED_ACCOUNT_METADATA_LIST_MAX_LIMIT = 256;
const CONNECTED_ACCOUNT_LISTED_ORIGIN_MAX = 32;
const CONNECTED_ACCOUNT_LISTED_DISPLAY_NAME_MAX_LENGTH = 512;
const CONNECTED_ACCOUNT_LISTED_STATES = Object.freeze({
    connected: true,
    expired: true,
    reconnectRequired: true,
    unavailable: true,
} satisfies Record<PluginConnectedAccountListedState, true>);

function isListedAccountState(
    value: unknown,
): value is PluginConnectedAccountListedState {
    return typeof value === 'string'
        && Object.hasOwn(CONNECTED_ACCOUNT_LISTED_STATES, value);
}

function clampListLimit(limit: unknown): number {
    if (limit === undefined) return CONNECTED_ACCOUNT_METADATA_LIST_MAX_LIMIT;
    if (
        typeof limit !== 'number'
        || !Number.isSafeInteger(limit)
        || limit < 1
    ) {
        throw listingOutOfScope();
    }
    return Math.min(limit, CONNECTED_ACCOUNT_METADATA_LIST_MAX_LIMIT);
}

function snapshotListRequest(
    request: unknown,
): Readonly<{ purpose: string; limit: number }> {
    if (!isUnknownRecord(request)) throw listingOutOfScope();
    for (const key of Reflect.ownKeys(request)) {
        if (key !== 'purpose' && key !== 'limit') throw listingOutOfScope();
    }
    const purpose = request.purpose;
    if (typeof purpose !== 'string') throw listingOutOfScope();
    return Object.freeze({ purpose, limit: clampListLimit(request.limit) });
}

/**
 * Host-normalized credential-free HTTPS origin. The canonical configured-origin
 * owner already enforces this shape on write; re-checking it here keeps an owner
 * regression from disclosing a credential-bearing or non-canonical URL.
 */
function assertListedOrigin(origin: unknown): string {
    if (typeof origin !== 'string' || origin.length === 0) throw listingOutOfScope();
    let url: URL;
    try {
        url = new URL(origin);
    } catch {
        throw listingOutOfScope();
    }
    if (
        url.protocol !== 'https:'
        || url.username !== ''
        || url.password !== ''
        || url.origin !== origin
    ) {
        throw listingOutOfScope();
    }
    return origin;
}

/**
 * Host-normalized credential-free HTTPS service base. It re-checks the exact
 * shape the canonical configured-endpoint owner produced, delegating the rule
 * itself so no second base normalizer exists.
 */
function assertListedBase(base: unknown): Readonly<{ base: string; origin: string }> {
    if (typeof base !== 'string' || base.length === 0) throw listingOutOfScope();
    let normalized: Readonly<{ base: string; origin: string }>;
    try {
        normalized = normalizeConnectedAccountConfiguredBase(base);
    } catch {
        throw listingOutOfScope();
    }
    if (normalized.base !== base) throw listingOutOfScope();
    return normalized;
}

function snapshotListedAccount(
    scope: PluginConnectedAccountBindingScope,
    listed: unknown,
): PluginConnectedAccountListedAccount {
    if (!isUnknownRecord(listed)) throw listingOutOfScope();
    const account = snapshotAccount(listed.account, 'listed account');
    if (!account) throw listingOutOfScope();
    const serviceAuthorized = scope.serviceRefs.some((service) => (
        service.pluginId === account.service.pluginId
        && service.localId === account.service.localId
    ));
    if (!serviceAuthorized) throw listingOutOfScope();
    const displayName = listed.displayName;
    if (
        typeof displayName !== 'string'
        || displayName.length === 0
        || displayName.length > CONNECTED_ACCOUNT_LISTED_DISPLAY_NAME_MAX_LENGTH
    ) {
        throw listingOutOfScope();
    }
    const state = listed.state;
    if (!isListedAccountState(state)) throw listingOutOfScope();
    const origins = listed.connectedAccountOrigins;
    if (!Array.isArray(origins) || origins.length > CONNECTED_ACCOUNT_LISTED_ORIGIN_MAX) {
        throw listingOutOfScope();
    }
    const uniqueOrigins = new Set<string>();
    for (const origin of origins) {
        const normalized = assertListedOrigin(origin);
        if (uniqueOrigins.has(normalized)) throw listingOutOfScope();
        uniqueOrigins.add(normalized);
    }
    const bases = listed.connectedAccountBases;
    if (!Array.isArray(bases) || bases.length > CONNECTED_ACCOUNT_LISTED_ORIGIN_MAX) {
        throw listingOutOfScope();
    }
    const uniqueBases = new Set<string>();
    for (const base of bases) {
        const normalized = assertListedBase(base);
        if (uniqueBases.has(normalized.base)) throw listingOutOfScope();
        // A base a source would route by must live under an origin HostAccess
        // already admits, so the two facts can never disagree.
        if (!uniqueOrigins.has(normalized.origin)) throw listingOutOfScope();
        uniqueBases.add(normalized.base);
    }
    // Both facts are one projection: an account with an admitted origin always
    // publishes the base a source routes by.
    if ((uniqueOrigins.size === 0) !== (uniqueBases.size === 0)) throw listingOutOfScope();
    return Object.freeze({
        account,
        displayName,
        state,
        connectedAccountOrigins: Object.freeze([...uniqueOrigins]),
        connectedAccountBases: Object.freeze([...uniqueBases]),
    });
}

function snapshotMetadataList(
    scope: PluginConnectedAccountBindingScope,
    limit: number,
    result: unknown,
): PluginConnectedAccountMetadataList {
    if (!isUnknownRecord(result)) throw listingOutOfScope();
    const status = result.status;
    if (status !== 'complete' && status !== 'truncated') throw listingOutOfScope();
    const accounts = result.accounts;
    if (!Array.isArray(accounts) || accounts.length > limit) throw listingOutOfScope();
    const seen = new Set<string>();
    const listed: PluginConnectedAccountListedAccount[] = [];
    for (const entry of accounts) {
        const snapshot = snapshotListedAccount(scope, entry);
        const key = JSON.stringify([
            snapshot.account.service.pluginId,
            snapshot.account.service.localId,
            snapshot.account.accountId,
        ]);
        if (seen.has(key)) throw listingOutOfScope();
        seen.add(key);
        listed.push(snapshot);
    }
    return Object.freeze({
        status,
        accounts: Object.freeze(listed),
    });
}

function snapshotListedMaterializationRequest(
    request: unknown,
): Readonly<{
    purpose: string;
    account: PluginConnectedAccountRef;
    materialization: ConnectedAccountMaterializationRequest;
}> {
    if (!isUnknownRecord(request)) throw materializationOutOfScope();
    for (const key of Reflect.ownKeys(request)) {
        if (key !== 'purpose' && key !== 'account' && key !== 'materialization') {
            throw materializationOutOfScope();
        }
    }
    const purpose = request.purpose;
    if (typeof purpose !== 'string') throw materializationOutOfScope();
    const account = snapshotAccount(request.account, 'listed account');
    if (!account) throw materializationOutOfScope();
    return Object.freeze({
        purpose,
        account,
        materialization: snapshotMaterializationRequest(request.materialization),
    });
}

export function createStablePluginConnectedAccountsHost(
    owner: StablePluginConnectedAccountsOwner,
    hostOptions?: StablePluginConnectedAccountsHostOptions,
): StablePluginConnectedAccountsHost {
    const activeWatchSubscriptions = new Set<Disposable>();
    return Object.freeze({
        retire() {
            for (const subscription of [...activeWatchSubscriptions]) subscription.dispose();
        },
        bind(seed, authorizedScopes, bindOptions): ConnectedAccountsService {
            const scopes = new Map(authorizedScopes.map((scope) => [scope.purpose, scope]));
            const exactPurposeBindingSubjectId =
                bindOptions?.exactPurposeBindingSubjectId?.trim() || null;
            return Object.freeze<ConnectedAccountsService>({
                async getBinding(purpose, options = {}) {
                    assertCurrent(seed);
                    const scope = resolveScope(scopes, purpose, 'use');
                    const signals = combineSignals(seed.signal, options.signal);
                    assertCurrent(seed);
                    try {
                        const summary = await owner.getBinding({
                            ...authorizedPurpose(seed, scope),
                            ...(exactPurposeBindingSubjectId
                                ? { exactPurposeBindingSubjectId }
                                : {}),
                            ...(seed.session ? { sessionId: seed.session.id } : {}),
                            signal: signals.signal,
                        });
                        assertCurrent(seed);
                        return summary === null ? null : assertAuthorizedSummary(scope, summary);
                    } finally {
                        signals.dispose();
                    }
                },
                async requestSelection(input, options = {}) {
                    assertCurrent(seed);
                    const purpose = input.purpose;
                    assertCurrent(seed);
                    if (exactPurposeBindingSubjectId) {
                        throw operationDenied(purpose, 'select');
                    }
                    const scope = resolveScope(scopes, purpose, 'select');
                    const reason = input.reason;
                    assertCurrent(seed);
                    const signals = combineSignals(seed.signal, options.signal);
                    assertCurrent(seed);
                    try {
                        const summary = await owner.requestSelection({
                            ...authorizedPurpose(seed, scope),
                            assertGenerationCurrent: () => assertCurrent(seed),
                            ...(seed.currentSession ? { currentSession: seed.currentSession } : {}),
                            permissionOwner: Object.freeze({
                                kind: 'plugin',
                                pluginId: seed.plugin.id,
                                runtimeId: seed.contribution.qualifiedId,
                            }),
                            reason,
                            signal: signals.signal,
                        });
                        assertCurrent(seed);
                        return assertAuthorizedSummary(scope, summary);
                    } finally {
                        signals.dispose();
                    }
                },
                async materialize(purpose, request, options = {}) {
                    assertCurrent(seed);
                    const requestSnapshot = snapshotMaterializationRequest(request);
                    assertCurrent(seed);
                    const optionSnapshot = snapshotMaterializationOptions(options);
                    assertCurrent(seed);
                    const scope = resolveScope(scopes, purpose, 'use');
                    if (scope.materializationKinds?.includes(requestSnapshot.kind) !== true) {
                        throw materializationKindDenied(purpose, requestSnapshot.kind);
                    }
                    const signals = combineSignals(seed.signal, optionSnapshot.signal);
                    assertCurrent(seed);
                    try {
                        const result = await owner.materialize({
                            ...authorizedPurpose(seed, scope),
                            ...(exactPurposeBindingSubjectId
                                ? { exactPurposeBindingSubjectId }
                                : {}),
                            ...(seed.session ? { sessionId: seed.session.id } : {}),
                            ...(optionSnapshot.expectedAccount
                                ? { expectedAccount: optionSnapshot.expectedAccount }
                                : {}),
                            request: requestSnapshot,
                            signal: signals.signal,
                        });
                        assertCurrent(seed);
                        const snapshot = snapshotMaterialization(requestSnapshot, result);
                        registerMaterializationForRedaction(snapshot, seed, hostOptions);
                        assertCurrent(seed);
                        return snapshot;
                    } finally {
                        signals.dispose();
                    }
                },
                async listAccounts(request, options = {}) {
                    assertCurrent(seed);
                    const requestSnapshot = snapshotListRequest(request);
                    assertCurrent(seed);
                    const scope = resolveScope(scopes, requestSnapshot.purpose, 'use');
                    const signals = combineSignals(seed.signal, options.signal);
                    assertCurrent(seed);
                    try {
                        const result = await owner.listAccounts({
                            ...authorizedPurpose(seed, scope),
                            ...(exactPurposeBindingSubjectId
                                ? { exactPurposeBindingSubjectId }
                                : {}),
                            ...(seed.session ? { sessionId: seed.session.id } : {}),
                            limit: requestSnapshot.limit,
                            signal: signals.signal,
                        });
                        assertCurrent(seed);
                        return snapshotMetadataList(scope, requestSnapshot.limit, result);
                    } finally {
                        signals.dispose();
                    }
                },
                async materializeListedAccount(request, options = {}) {
                    assertCurrent(seed);
                    const requestSnapshot = snapshotListedMaterializationRequest(request);
                    assertCurrent(seed);
                    const scope = resolveScope(scopes, requestSnapshot.purpose, 'use');
                    if (
                        scope.materializationKinds?.includes(
                            requestSnapshot.materialization.kind,
                        ) !== true
                    ) {
                        throw materializationKindDenied(
                            requestSnapshot.purpose,
                            requestSnapshot.materialization.kind,
                        );
                    }
                    const serviceAuthorized = scope.serviceRefs.some((service) => (
                        service.pluginId === requestSnapshot.account.service.pluginId
                        && service.localId === requestSnapshot.account.service.localId
                    ));
                    if (!serviceAuthorized) throw materializationOutOfScope();
                    const signals = combineSignals(seed.signal, options.signal);
                    assertCurrent(seed);
                    try {
                        const result = await owner.materializeListedAccount({
                            ...authorizedPurpose(seed, scope),
                            ...(exactPurposeBindingSubjectId
                                ? { exactPurposeBindingSubjectId }
                                : {}),
                            ...(seed.session ? { sessionId: seed.session.id } : {}),
                            account: requestSnapshot.account,
                            request: requestSnapshot.materialization,
                            signal: signals.signal,
                        });
                        assertCurrent(seed);
                        const snapshot = snapshotMaterialization(
                            requestSnapshot.materialization,
                            result,
                        );
                        registerMaterializationForRedaction(snapshot, seed, hostOptions);
                        assertCurrent(seed);
                        return snapshot;
                    } finally {
                        signals.dispose();
                    }
                },
                watch(purpose, listener) {
                    assertCurrent(seed);
                    const scope = resolveScope(scopes, purpose, 'use');
                    let disposed = false;
                    let registrationComplete = false;
                    let scheduled = false;
                    let initialDeliveryPending = true;
                    let invalidationPending = false;
                    let deliveryWaiters: Array<() => void> = [];
                    let activeDeliveryWaiters: Array<() => void> = [];
                    const resolveDeliveryWaiters = (waiters: readonly (() => void)[]) => {
                        for (const resolve of waiters) resolve();
                    };
                    const startDelivery = () => {
                        if (
                            disposed
                            || !registrationComplete
                            || scheduled
                            || (!initialDeliveryPending && !invalidationPending)
                        ) return;
                        scheduled = true;
                        queueMicrotask(async () => {
                            const isInitialDelivery = initialDeliveryPending;
                            if (isInitialDelivery) {
                                initialDeliveryPending = false;
                            } else {
                                activeDeliveryWaiters = deliveryWaiters;
                                deliveryWaiters = [];
                                invalidationPending = false;
                            }
                            if (disposed) {
                                resolveDeliveryWaiters(activeDeliveryWaiters);
                                activeDeliveryWaiters = [];
                                scheduled = false;
                                return;
                            }
                            if (seed.signal.aborted || !seed.isGenerationCurrent()) {
                                subscription.dispose();
                                resolveDeliveryWaiters(activeDeliveryWaiters);
                                activeDeliveryWaiters = [];
                                scheduled = false;
                                return;
                            }
                            try {
                                const delivery = (listener as (event: Readonly<{ kind: 'resync' }>) => unknown)(
                                    Object.freeze({ kind: 'resync' }),
                                );
                                if (
                                    delivery
                                    && typeof delivery === 'object'
                                    && 'then' in delivery
                                    && typeof delivery.then === 'function'
                                ) {
                                    await delivery;
                                }
                            } catch {
                                // Plugin listener failures cannot break host invalidation delivery.
                            } finally {
                                resolveDeliveryWaiters(activeDeliveryWaiters);
                                activeDeliveryWaiters = [];
                                scheduled = false;
                                startDelivery();
                            }
                        });
                    };
                    const schedule = (): Promise<void> => {
                        if (disposed) return Promise.resolve();
                        invalidationPending = true;
                        const delivered = new Promise<void>((resolve) => {
                            deliveryWaiters.push(resolve);
                        });
                        startDelivery();
                        return delivered;
                    };
                    const ownerSubscription = owner.watch({
                        ...authorizedPurpose(seed, scope),
                        ...(exactPurposeBindingSubjectId
                            ? { exactPurposeBindingSubjectId }
                            : {}),
                        ...(seed.session ? { sessionId: seed.session.id } : {}),
                        listener: schedule,
                    });
                    const abort = () => subscription.dispose();
                    const subscription: Disposable = Object.freeze({
                        dispose() {
                            if (disposed) return;
                            disposed = true;
                            activeWatchSubscriptions.delete(subscription);
                            seed.signal.removeEventListener('abort', abort);
                            resolveDeliveryWaiters(deliveryWaiters);
                            deliveryWaiters = [];
                            resolveDeliveryWaiters(activeDeliveryWaiters);
                            activeDeliveryWaiters = [];
                            ownerSubscription.dispose();
                        },
                    });
                    activeWatchSubscriptions.add(subscription);
                    seed.signal.addEventListener('abort', abort, { once: true });
                    registrationComplete = true;
                    startDelivery();
                    if (seed.signal.aborted || !seed.isGenerationCurrent()) subscription.dispose();
                    return subscription;
                },
            });
        },
    });
}
