import { PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1, PLUGIN_COLLECTION_GET_HTTP_PATH_V1, PLUGIN_COLLECTION_FORGET_HTTP_PATH_V1, PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1, PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1, PluginCollectionContractReadRequestV1Schema, PluginCollectionContractReadResultV1Schema, PluginCollectionGetRequestV1Schema, PluginCollectionGetResultV1Schema, PluginCollectionForgetRequestV1Schema, PluginCollectionForgetResultV1Schema, PluginCollectionMutationErrorV1Schema, PluginCollectionMutationResultV1Schema, PluginCollectionQueryRequestV1Schema, PluginCollectionQueryResultV1Schema, PluginCollectionReadErrorV1Schema, resolveEffectivePluginCollectionLimitsV1, resolvePluginCollectionIdentityTagV1, type NormalizedPluginAccountCollectionContractV1, type PluginCollectionIndexScalarValueV1, type PluginCollectionMutationConflictV1, type PluginCollectionRelationRestrictionContinuationV1, type PluginCollectionEffectiveLimitsV1, type PluginCollectionMutationOperationV1, type PluginCollectionMutationRequestMeasurementV1, type PluginCollectionMutationResultEntryV1, type PluginCollectionProjectionV1, type PluginCollectionQueryRangeV1, type PluginCollectionQuotaDimensionV1, type PluginCollectionRowV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { PLUGIN_COLLECTION_LIMITS_V1 } from '@happier-dev/protocol/plugins/data/collectionLimitsV1';
import { PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { PluginCollectionRowIdV1Schema } from '@happier-dev/protocol/plugins/data/collectionUiQueryWireV1';
import { compilePluginJsonSchema, createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createAccountScopedCryptoMaterialSnapshotV1, type AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { decodePluginCollectionLogicalRowV1, encodePluginCollectionLogicalValueV1, preparePluginCollectionLogicalMutationRequestV1, type PluginCollectionLogicalMutationRequestOutcomeV1 } from '@happier-dev/protocol/plugins/data/collectionLogicalCodecV1';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import type { PluginCollectionContractRefV1 } from '@happier-dev/protocol/plugins/data/collectionContractRefV1';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { mergeAbortSignals } from '@happier-dev/plugin-sdk/async';
import type {
    PluginAccountCollectionDefinition,
    PluginAccountCollectionValue,
} from '@happier-dev/plugin-sdk/collections';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isDataKeyAuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { fetchAccountEncryptionIdentity, invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { readAccountEncryptionObservationBinding } from '@/sync/http/accountEncryptionObservationBinding';
import { getCachedServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    resolveAccountStoredContentCompatibilityHeaders,
    withAccountStoredContentCompatibilityRequestDeclaration,
    type AccountStoredContentCompatibilityUnavailableReason,
} from '@/sync/http/accountStoredContentCompatibility';
import { captureServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';

import { readHomeDomainConfirmedRollbackV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';

import { watchActivePluginCollectionChanges } from './pluginCollectionChangeWatch';

export type ActivePluginCollectionUnavailableReasonV1 =
    | AccountStoredContentCompatibilityUnavailableReason
    | 'no-active-account-scope'
    | 'account-scope-changed'
    | 'server-generation-changed'
    | 'operation-cancelled'
    | 'account-currentness-unavailable'
    | 'account-encryption-material-unavailable'
    | 'account-content-mismatch'
    | 'collection-unavailable'
    | 'writer-contract-unavailable'
    | 'response-invalid'
    | 'mutation-outcome-unknown'
    /**
     * The runtime's `JSON.stringify` refused this request body. Protocol admits
     * strict JSON iteratively and carries no depth quota, so an admitted value
     * can still exceed what this realm's engine will serialize — and this client
     * spans the widest engine range in the product: Hermes natively, JSC in the
     * macOS/iOS webview, V8 on Windows and Chrome, SpiderMonkey on Firefox.
     * Hermes refuses past 511 nesting levels, an order of magnitude below every
     * browser engine, so this is reachable rather than theoretical; the measured
     * spread is recorded with the Protocol strict-JSON owner. A body this runtime
     * cannot serialize can never be written: it is a permanent defect in the
     * value, never a transport outage a caller should retry.
     */
    | 'request-not-serializable'
    | 'transport-unavailable';

export type ActivePluginCollectionUnavailableV1 = Readonly<{
    status: 'unavailable';
    reason: ActivePluginCollectionUnavailableReasonV1;
}>;

export type ActivePluginCollectionRejectedV1 = Readonly<{
    status: 'rejected';
    code: string;
    relationRestriction?: Readonly<{
        dependentCount: number;
        continuation: PluginCollectionRelationRestrictionContinuationV1;
    }>;
    /**
     * Which limit the server actually enforced and its effective maximum. A
     * caller that sized its batch through `limits`/`measureBatch` reacts to this
     * by repacking against the named dimension instead of retrying blind.
     */
    quotaIncompatibility?: Readonly<{
        dimension: PluginCollectionQuotaDimensionV1;
        effectiveMaximum: number;
    }>;
}>;

export type ActivePluginCollectionLogicalRowV1<
    TValue extends PluginAccountCollectionValue<PluginAccountCollectionDefinition> = PluginAccountCollectionValue<PluginAccountCollectionDefinition>,
> = Readonly<{
    rowId: string;
    revision: number;
    value: TValue;
}>;

export type ActivePluginCollectionGetOutcomeV1<
    TValue extends PluginAccountCollectionValue<PluginAccountCollectionDefinition> = PluginAccountCollectionValue<PluginAccountCollectionDefinition>,
> =
    | Readonly<{
        status: 'ready';
        row: ActivePluginCollectionLogicalRowV1<TValue> | null;
        /** Collection-owned absence currentness from the exact server snapshot. */
        absenceEpoch: number;
    }>
    | ActivePluginCollectionUnavailableV1
    | ActivePluginCollectionRejectedV1;

export type ActivePluginCollectionQueryOutcomeV1<
    TValue extends PluginAccountCollectionValue<PluginAccountCollectionDefinition> = PluginAccountCollectionValue<PluginAccountCollectionDefinition>,
> =
    | Readonly<{
        status: 'ready';
        rows: readonly ActivePluginCollectionLogicalRowV1<TValue>[];
        nextCursor?: string;
        changeCursor: number;
    }>
    | ActivePluginCollectionUnavailableV1
    | ActivePluginCollectionRejectedV1;

export type ActivePluginCollectionMutationOutcomeV1 =
    | Readonly<{
        status: 'updated';
        results: readonly PluginCollectionMutationResultEntryV1[];
        changeCursor: number;
    }>
    | Readonly<{
        status: 'conflict';
        conflicts: readonly PluginCollectionMutationConflictV1[];
    }>
    | ActivePluginCollectionUnavailableV1
    | ActivePluginCollectionRejectedV1;

export type ActivePluginCollectionForgetOutcomeV1 =
    | Readonly<{ status: 'forgotten' }>
    | Readonly<{ status: 'conflict' }>
    | ActivePluginCollectionUnavailableV1
    | ActivePluginCollectionRejectedV1;

export type ActivePluginCollectionQueryInputV1 = Readonly<{
    indexId: string;
    prefix?: readonly PluginCollectionIndexScalarValueV1[];
    range?: PluginCollectionQueryRangeV1;
    order: 'asc' | 'desc';
    cursor?: string;
    limit?: number;
}>;

export type ActivePluginCollectionMutationInputV1<
    TValue extends PluginAccountCollectionValue<PluginAccountCollectionDefinition> = PluginAccountCollectionValue<PluginAccountCollectionDefinition>,
> =
    | Readonly<{
        kind: 'put';
        expectedRevision: number | 'absent';
        value: TValue;
    }>
    | Readonly<{
        kind: 'delete';
        rowId: string;
        expectedRevision: number;
    }>
    | Readonly<{
        kind: 'assert';
        rowId: string;
        expectedRevision: number;
    }>;

export type ActivePluginCollectionOperationOptionsV1 = Readonly<{
    signal?: AbortSignal;
}>;

export type ActivePluginCollectionWatchOutcomeV1 =
    | Readonly<{ status: 'watching'; dispose(): void }>
    | ActivePluginCollectionUnavailableV1;

export type ActivePluginCollectionIdentityTagOutcomeV1 =
    | Readonly<{ status: 'ready'; tag: string }>
    | ActivePluginCollectionUnavailableV1
    | ActivePluginCollectionRejectedV1;

export type ActivePluginCollectionLimitsOutcomeV1 =
    | Readonly<{ status: 'ready'; limits: PluginCollectionEffectiveLimitsV1 }>
    | ActivePluginCollectionUnavailableV1;

export type ActivePluginCollectionMeasurementOutcomeV1 =
    | Readonly<{ status: 'ready'; measurement: PluginCollectionMutationRequestMeasurementV1 }>
    | ActivePluginCollectionUnavailableV1
    | ActivePluginCollectionRejectedV1;

export type ActivePluginCollectionClientForContractRefOutcomeV1<
    TValue extends PluginAccountCollectionValue<PluginAccountCollectionDefinition> = PluginAccountCollectionValue<PluginAccountCollectionDefinition>,
> =
    | Readonly<{
        status: 'ready';
        access: 'readOnly' | 'writable';
        contract: NormalizedPluginAccountCollectionContractV1;
        client: ActivePluginCollectionClientV1<TValue>;
    }>
    | ActivePluginCollectionUnavailableV1
    | ActivePluginCollectionRejectedV1;

export type ActivePluginCollectionClientV1<
    TValue extends PluginAccountCollectionValue<PluginAccountCollectionDefinition> = PluginAccountCollectionValue<PluginAccountCollectionDefinition>,
> = Readonly<{
    /**
     * Derive this collection's Account-mode-aware identity value for one field
     * the admitted contract declares as a mode-derived identity. The contract,
     * not the caller, decides which fields have a derivation domain, and the
     * mode and Account material come from the same prepared operation every
     * other call uses.
     */
    identityTag(
        request: Readonly<{ field: string; components: readonly string[] }>,
        options?: ActivePluginCollectionOperationOptionsV1,
    ): Promise<ActivePluginCollectionIdentityTagOutcomeV1>;
    get(
        rowId: string,
        options?: ActivePluginCollectionOperationOptionsV1,
    ): Promise<ActivePluginCollectionGetOutcomeV1<TValue>>;
    query(
        input: ActivePluginCollectionQueryInputV1,
        options?: ActivePluginCollectionOperationOptionsV1,
    ): Promise<ActivePluginCollectionQueryOutcomeV1<TValue>>;
    mutate(
        operations: readonly ActivePluginCollectionMutationInputV1<TValue>[],
        options?: ActivePluginCollectionOperationOptionsV1,
    ): Promise<ActivePluginCollectionMutationOutcomeV1>;
    forget(
        rowId: string,
        expectedRevision: number,
        options?: ActivePluginCollectionOperationOptionsV1,
    ): Promise<ActivePluginCollectionForgetOutcomeV1>;
    /**
     * The limits in force for this bound collection: the connected deployment's
     * published policy narrowed by the collection's admitted quota. Reading them
     * costs no request, because only the already-cached server capability and
     * the resolved contract decide the answer.
     */
    limits(
        options?: ActivePluginCollectionOperationOptionsV1,
    ): Promise<ActivePluginCollectionLimitsOutcomeV1>;
    /**
     * Measure what these mutations would cost on the wire, through the same
     * seal-and-serialize path `mutate` uses, so a caller sizing multi-batch work
     * never re-models the private envelope, the projection, or the request
     * shell. More operations may be measured than one atomic batch can carry.
     */
    measureBatch(
        operations: readonly ActivePluginCollectionMutationInputV1<TValue>[],
        options?: ActivePluginCollectionOperationOptionsV1,
    ): Promise<ActivePluginCollectionMeasurementOutcomeV1>;
    /** Register before the initial query; the wakeup carries no row content. */
    watch(onInvalidated: () => void): ActivePluginCollectionWatchOutcomeV1;
}>;

/** Shared direct-UI Data operation foundation; only sibling Data owners import it. */
export type PreparedCollectionOperation = Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    serverSnapshot: ReturnType<typeof getActiveServerSnapshot>;
    authority: Awaited<ReturnType<typeof captureServerRequestAuthorityForServerAccountScope>>;
    encryptionMode: 'plain' | 'e2ee';
    material: AccountScopedCryptoMaterial | null;
    headers: Headers;
    signal: AbortSignal;
    /** Caller/invocation cancellation, distinct from Account retirement. */
    callerSignal?: AbortSignal;
    release(): Promise<void>;
}>;

export type PreparedCollectionOperationOutcome =
    | Readonly<{ status: 'ready'; operation: PreparedCollectionOperation }>
    | ActivePluginCollectionUnavailableV1;

type CollectionHttpObservation = Readonly<{ ok: boolean; httpStatus: number; body: unknown }>;
const collectionHttpReads = createScopedResolutionSingleFlight<CollectionHttpObservation>();

/** Raw Collection reads only; each borrower retains its admission, mode and content opening. */
export async function readPluginCollectionHttpResponse(input: Readonly<{
    authority: PreparedCollectionOperation['authority'];
    path: string;
    init: Readonly<{ method: 'GET' | 'POST'; headers: HeadersInit; body?: string; signal?: AbortSignal }>;
    encryptionMode?: 'plain' | 'e2ee';
    fresh?: boolean;
}>): Promise<CollectionHttpObservation> {
    const consume = async (response: Response): Promise<CollectionHttpObservation> => ({
        ok: response.ok, httpStatus: response.status, body: await response.json().catch(() => null),
    });
    const transport = input.authority.readTransport;
    const requestInit = (signal = input.init.signal) => withAccountStoredContentCompatibilityRequestDeclaration(
        { ...input.init, signal }, PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION);
    if (!transport) return await consume(await input.authority.request(input.path, requestInit(), { recoveryRead: 'unbounded' }));
    const transportKey = transport.key;
    const headers = [...new Headers(input.init.headers)].sort(([left], [right]) => left.localeCompare(right));
    const body: unknown = input.init.body === undefined ? null : JSON.parse(input.init.body);
    const key = createCanonicalJsonSigningInput([transportKey, input.path, input.init.method,
        body, headers, input.encryptionMode ?? null]);
    return await collectionHttpReads.run(key, signal => transport.read(input.path, requestInit(signal), undefined, consume),
        { scope: transport.scope ?? transportKey, signal: input.init.signal, fresh: input.fresh });
}

function unavailable(reason: ActivePluginCollectionUnavailableReasonV1): ActivePluginCollectionUnavailableV1 {
    return { status: 'unavailable', reason };
}

function rejected(
    code: string,
    detail?: Readonly<{
        relationRestriction?: ActivePluginCollectionRejectedV1['relationRestriction'];
        quotaIncompatibility?: ActivePluginCollectionRejectedV1['quotaIncompatibility'];
    }>,
): ActivePluginCollectionRejectedV1 {
    return {
        status: 'rejected',
        code,
        ...(detail?.relationRestriction ? { relationRestriction: detail.relationRestriction } : {}),
        ...(detail?.quotaIncompatibility ? { quotaIncompatibility: detail.quotaIncompatibility } : {}),
    };
}

function isScopeAndServerCurrent(
    lifetime: ActiveServerAccountScopeLifetime,
    serverSnapshot: ReturnType<typeof getActiveServerSnapshot>,
): ActivePluginCollectionUnavailableReasonV1 | null {
    if (!lifetime.isCurrent()) return 'account-scope-changed';
    const current = getActiveServerSnapshot();
    if (current.serverId !== serverSnapshot.serverId || current.generation !== serverSnapshot.generation) {
        return 'server-generation-changed';
    }
    return null;
}

export function getPreparedCollectionOperationCurrentness(
    operation: PreparedCollectionOperation,
): ActivePluginCollectionUnavailableReasonV1 | null {
    return operation.callerSignal?.aborted ? 'operation-cancelled'
        : isScopeAndServerCurrent(operation.lifetime, operation.serverSnapshot);
}

function resolveCurrentAccountMaterial(input: Readonly<{
    mode: 'plain' | 'e2ee';
    contentKeyFingerprint: string | null;
    credentials?: AuthCredentials;
}>): AccountScopedCryptoMaterial | null {
    if (input.mode === 'plain') return null;
    if (!input.credentials || !input.contentKeyFingerprint) return null;
    try {
        const material = resolveAccountScopedCryptoMaterialFromCredentials(input.credentials);
        const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
            accountEncryptionMode: 'e2ee',
            material,
            ...(isDataKeyAuthCredentials(input.credentials)
                ? {
                    dataKeyPublicKey: decodeBase64(
                        input.credentials.encryption.publicKey,
                        'base64',
                    ),
                }
                : {}),
        });
        return convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            snapshot.contentPublicKeyFingerprint,
        ) === input.contentKeyFingerprint
            ? material
            : null;
    } catch {
        return null;
    }
}

export async function prepareCollectionOperation(
    options: ActivePluginCollectionOperationOptionsV1 | undefined,
    accountLifetime?: ActiveServerAccountScopeLifetime,
    invocationSignal?: AbortSignal,
    freshPlainIdentity = false,
): Promise<PreparedCollectionOperationOutcome> {
    if (options?.signal?.aborted || invocationSignal?.aborted) return unavailable('operation-cancelled');
    const lifetime = accountLifetime ?? captureActiveServerAccountScopeLifetime();
    if (!lifetime) return unavailable('no-active-account-scope');
    if (!lifetime.isCurrent()) return unavailable('account-scope-changed');
    const serverSnapshot = getActiveServerSnapshot();
    if (serverSnapshot.serverId !== lifetime.scope.serverId) return unavailable('server-generation-changed');
    const compatibility = resolveAccountStoredContentCompatibilityHeaders(
        { 'Content-Type': 'application/json' },
        {
            serverUrl: serverSnapshot.serverUrl,
            declaration: PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
        },
    );
    if (compatibility.status === 'unavailable') return compatibility;

    const callerCancellation = mergeAbortSignals([options?.signal, invocationSignal]);
    const callerSignal = callerCancellation.signal;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const retirement = lifetime.onRetire(abort);
    callerSignal?.addEventListener('abort', abort, { once: true });
    let authority: Awaited<ReturnType<typeof captureServerRequestAuthorityForServerAccountScope>> | null = null;
    const release = async (): Promise<void> => {
        await authority?.release?.();
        callerSignal?.removeEventListener('abort', abort);
        callerCancellation.dispose();
        retirement.dispose();
    };
    if (callerSignal?.aborted) {
        await release();
        return unavailable('operation-cancelled');
    }
    try {
        authority = await captureServerRequestAuthorityForServerAccountScope({
            scope: lifetime.scope,
            activeRequest: (path, init, options) => apiSocket.request(path, init, options),
        });
        const capturedAuthority = authority;
        const currentnessAfterAuthority = isScopeAndServerCurrent(lifetime, serverSnapshot);
        if (currentnessAfterAuthority) {
            await release();
            return unavailable(currentnessAfterAuthority);
        }
        if (controller.signal.aborted) {
            await release();
            return unavailable(callerSignal?.aborted ? 'operation-cancelled' : 'account-scope-changed');
        }

        const credentials = capturedAuthority.context.credentials ?? { token: capturedAuthority.context.token };
        const currentness = await fetchAccountEncryptionIdentity(credentials, {
            request: capturedAuthority.request,
            signal: controller.signal,
            // A tag can outlive a delayed Plain→E2EE push and later become
            // server-visible identity. Never mint its unkeyed digest from a
            // stale Plain observation. E2EE→Plain is already custody-pinned.
            usage: freshPlainIdentity
                && readAccountEncryptionObservationBinding(capturedAuthority.request, credentials)?.peek()?.mode === 'plain'
                ? 'fresh-authority' : 'identity',
        });
        const currentnessAfterRead = isScopeAndServerCurrent(lifetime, serverSnapshot);
        if (currentnessAfterRead) {
            await release();
            return unavailable(currentnessAfterRead);
        }
        if (controller.signal.aborted) {
            await release();
            return unavailable(callerSignal?.aborted ? 'operation-cancelled' : 'account-scope-changed');
        }
        const material = resolveCurrentAccountMaterial({
            mode: currentness.mode,
            contentKeyFingerprint: currentness.contentKeyFingerprint,
            credentials: capturedAuthority.context.credentials,
        });
        if (currentness.mode === 'e2ee' && !material) {
            await release();
            return unavailable('account-encryption-material-unavailable');
        }
        return {
            status: 'ready',
            operation: {
                lifetime,
                serverSnapshot,
                authority: capturedAuthority,
                encryptionMode: currentness.mode,
                material,
                headers: compatibility.headers,
                signal: controller.signal,
                callerSignal,
                release,
            },
        };
    } catch {
        await release();
        return unavailable(controller.signal.aborted
            ? (callerSignal?.aborted ? 'operation-cancelled' : 'account-scope-changed')
            : 'account-currentness-unavailable');
    }
}

export async function requestCollectionOperation(input: Readonly<{
    operation: PreparedCollectionOperation;
    path: string;
    /** Omit together with a `GET` method for a read-only Account Data route. */
    body?: unknown;
    method?: 'GET' | 'POST';
    kind?: 'read' | 'mutation';
    /** Exact mutation/absence witnesses cannot borrow an earlier ordinary observation. */
    fresh?: boolean;
    options?: ActivePluginCollectionOperationOptionsV1;
}>): Promise<
    | Readonly<{ status: 'response'; ok: boolean; httpStatus: number; body: unknown }>
    | ActivePluginCollectionUnavailableV1
> {
    const method = input.method ?? 'POST';
    // Serialize before the request so the host serializer's refusal is reported
    // as the permanent value defect it is, instead of being swallowed by the
    // transport catch below. The daemon host classifies the same refusal as an
    // invalid value, and the two realms must not disagree about one input.
    let serializedBody: string | undefined;
    if (method !== 'GET') {
        try {
            serializedBody = JSON.stringify(input.body);
        } catch {
            return unavailable('request-not-serializable');
        }
    }
    const beforeRequest = getPreparedCollectionOperationCurrentness(input.operation);
    if (beforeRequest) return unavailable(beforeRequest);
    const credentials = input.operation.authority.context.credentials ?? { token: input.operation.authority.context.token };
    const observation = readAccountEncryptionObservationBinding(input.operation.authority.request, credentials);
    const observedIdentity = observation?.peek();
    // The prepared operation signal only carries the cancellation known when the
    // operation was prepared. A per-request signal — a transaction's composed
    // participant cancellation, for example — reaches the transport only if it
    // is composed here, at the one place the physical request is issued.
    const cancellation = mergeAbortSignals([input.operation.signal, input.options?.signal]);
    const mutationTransport = input.operation.authority.readTransport;
    const mutationReadScope = mutationTransport ? mutationTransport.scope ?? mutationTransport.key : undefined;
    let mutationIssued = false;
    try {
        if (cancellation.signal.aborted) {
            return unavailable(input.options?.signal?.aborted || input.operation.callerSignal?.aborted ? 'operation-cancelled' : 'account-scope-changed');
        }
        const init = withAccountStoredContentCompatibilityRequestDeclaration({
                method,
                headers: input.operation.headers,
                ...(method === 'GET' ? {} : { body: serializedBody }),
                signal: cancellation.signal,
            }, PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION);
        const response = input.kind === 'read'
            ? await readPluginCollectionHttpResponse({ authority: input.operation.authority, path: input.path,
                init: { method, headers: new Headers(init.headers), ...(serializedBody === undefined ? {} : { body: serializedBody }),
                    signal: cancellation.signal }, encryptionMode: input.operation.encryptionMode, fresh: input.fresh })
            : await (async (): Promise<CollectionHttpObservation> => {
                const result = await input.operation.authority.request(input.path, init,
                    input.kind === 'mutation' ? { onIssued: () => { mutationIssued = true; } } : undefined);
                return { ok: result.ok, httpStatus: result.status, body: await result.json().catch(() => null) };
            })();
        const body = response.body;
        if (input.kind !== 'mutation' && cancellation.signal.aborted) {
            return unavailable(input.options?.signal?.aborted || input.operation.callerSignal?.aborted
                ? 'operation-cancelled'
                : 'account-scope-changed');
        }
        const currentnessAfterBody = isScopeAndServerCurrent(
            input.operation.lifetime,
            input.operation.serverSnapshot,
        );
        if (input.kind !== 'mutation' && currentnessAfterBody) return unavailable(currentnessAfterBody);
        const refusal = !response.ok ? PluginCollectionReadErrorV1Schema.safeParse(body) : null;
        if (refusal?.success && refusal.data.error === 'collection_content_mode_mismatch'
            && observedIdentity && observation?.peek() === observedIdentity) {
            // The server refused this admitted identity. Withdraw it once, without
            // replacing a newer push or fetching until another reader needs it.
            invalidateAccountEncryptionModeCache({ serverId: input.operation.authority.scope.serverId });
        }
        return { status: 'response', ok: response.ok, httpStatus: response.httpStatus, body };
    } catch {
        // An interrupted mutation stays outcome-unknown: cancelling the request
        // cannot establish that the server did not apply it.
        if (input.kind === 'mutation') return unavailable('mutation-outcome-unknown');
        return unavailable(input.options?.signal?.aborted || input.operation.callerSignal?.aborted
            ? 'operation-cancelled'
            : input.operation.lifetime.isCurrent()
                ? 'transport-unavailable'
                : 'account-scope-changed');
    } finally {
        if (mutationIssued && mutationReadScope !== undefined) {
            // A receipt or unknown outcome may have changed rows. Later demand
            // must not borrow a read begun before that mutation attempt.
            collectionHttpReads.invalidate(mutationReadScope);
        }
        cancellation.dispose();
    }
}

export type EncodedPluginCollectionLogicalValueV1 = Readonly<{
    rowId: string;
    content: Extract<PluginCollectionMutationOperationV1, { kind: 'put' }>['content'];
    projection: PluginCollectionProjectionV1;
}>;

/**
 * The sole direct-UI logical-value encoder. Candidate preparation uses this
 * exact codec so its non-authoritative target rows cannot drift from ordinary
 * Account Collection writes.
 */
export function encodePluginCollectionLogicalValue<TValue extends PluginAccountCollectionValue<PluginAccountCollectionDefinition>>(input: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
    validate: ReturnType<typeof compilePluginJsonSchema>;
    value: TValue;
    encryptionMode: 'plain' | 'e2ee';
    material: AccountScopedCryptoMaterial | null;
}>): EncodedPluginCollectionLogicalValueV1 | null {
    const encoded = encodePluginCollectionLogicalValueV1({
        contract: input.contract,
        isValidLogicalValue: (value) => isValidPluginJsonSchemaValue(input.validate, value),
        value: input.value,
        encryptionMode: input.encryptionMode,
        material: input.material,
        randomBytes: getRandomBytes,
    });
    return encoded.status === 'encoded'
        ? {
            rowId: encoded.rowId,
            content: encoded.content,
            projection: encoded.projection,
        }
        : null;
}

/** Shared direct-UI logical-row decoder for ordinary and candidate-bound reads. */
export function mergeLogicalRow<TValue extends PluginAccountCollectionValue<PluginAccountCollectionDefinition>>(input: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
    storedReadSchema: ReturnType<typeof createPluginJsonSchemaZodValueAdapter>;
    row: PluginCollectionRowV1;
    encryptionMode: 'plain' | 'e2ee';
    material: AccountScopedCryptoMaterial | null;
}>): ActivePluginCollectionLogicalRowV1<TValue> | null {
    const decoded = decodePluginCollectionLogicalRowV1<TValue>({
        contract: input.contract,
        parseStoredLogicalValue: (value) => {
            const parsed = input.storedReadSchema.safeParse(value);
            if (!parsed.success || parsed.data === null || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) return null;
            // The canonical stored-read adapter already validates the projected logical object.
            return parsed.data as TValue;
        },
        row: input.row,
        encryptionMode: input.encryptionMode,
        material: input.material,
    });
    return decoded.status === 'decoded'
        ? Object.freeze({
            rowId: decoded.rowId,
            revision: decoded.revision,
            value: decoded.value,
        })
        : null;
}

function isLogicalCollectionValue<TValue extends PluginAccountCollectionValue<PluginAccountCollectionDefinition>>(
    validate: ReturnType<typeof compilePluginJsonSchema>,
    value: unknown,
): value is TValue {
    return isValidPluginJsonSchemaValue(validate, value);
}

function mapReadError(value: unknown): ActivePluginCollectionUnavailableV1 | ActivePluginCollectionRejectedV1 {
    const parsed = PluginCollectionReadErrorV1Schema.safeParse(value);
    if (!parsed.success) return unavailable('response-invalid');
    switch (parsed.data.error) {
        case 'collection_unavailable':
            return unavailable('collection-unavailable');
        case 'collection_content_mode_mismatch':
        case 'collection_index_not_ready':
        case 'collection_contract_inconsistent':
        case 'collection_query_invalid':
        case 'collection_cursor_invalid':
        case 'collection_update_required':
            return rejected(parsed.data.error);
    }
    return unavailable('response-invalid');
}

function mapMutationError(value: unknown, httpStatus: number): ActivePluginCollectionUnavailableV1 | ActivePluginCollectionRejectedV1 {
    const rollback = readHomeDomainConfirmedRollbackV1(httpStatus, value);
    if (rollback) return rejected(rollback.code);
    const parsed = PluginCollectionMutationErrorV1Schema.safeParse(value);
    if (!parsed.success) return unavailable('mutation-outcome-unknown');
    if (parsed.data.error === 'collection_relation_restricted') {
        return rejected(parsed.data.error, {
            relationRestriction: {
                dependentCount: parsed.data.dependentCount,
                continuation: parsed.data.continuation,
            },
        });
    }
    if (parsed.data.error === 'collection_quota_incompatible') {
        return rejected(parsed.data.error, {
            quotaIncompatibility: {
                dimension: parsed.data.dimension,
                effectiveMaximum: parsed.data.effectiveMaximum,
            },
        });
    }
    switch (parsed.data.error) {
        case 'collection_unavailable':
        case 'collection_index_not_ready':
        case 'collection_relation_unavailable':
        case 'collection_contract_inconsistent':
            return unavailable('collection-unavailable');
        case 'collection_writer_contract_unavailable':
            return unavailable('writer-contract-unavailable');
        case 'collection_content_mode_mismatch':
            return unavailable('account-content-mismatch');
        case 'collection_mutation_invalid':
        case 'collection_quota_exceeded':
        // The row identity spent every revision its persisted column can hold.
        // That is a refused write, not an unavailable Collection.
        case 'collection_revision_exhausted':
            return rejected(parsed.data.error);
    }
    return unavailable('response-invalid');
}

function mapEncodeFailure(
    failure: Extract<PluginCollectionLogicalMutationRequestOutcomeV1, { status: 'failed' }>,
): ActivePluginCollectionRejectedV1 {
    return failure.reason === 'private-payload-too-large'
        ? rejected('collection_quota_incompatible', {
            quotaIncompatibility: {
                dimension: failure.dimension,
                effectiveMaximum: failure.effectiveMaximum,
            },
        })
        : rejected('collection_mutation_invalid');
}

export function contractMatchesRef(
    contract: NormalizedPluginAccountCollectionContractV1,
    ref: PluginCollectionContractRefV1,
): boolean {
    return contract.pluginId === ref.pluginId
        && contract.collectionId === ref.collectionId
        && contract.schemaVersion === ref.schemaVersion
        && contract.contractDigest === ref.contractDigest;
}

/**
 * Resolves one immutable release-admitted contract through the canonical Data
 * route, then returns the existing direct client over that exact contract. It
 * intentionally owns no cached contract, Account lifecycle, or alternate
 * transport: each caller gets the current scoped result or a typed failure.
 */
export async function createActivePluginCollectionClientForContractRef<
    TValue extends PluginAccountCollectionValue<PluginAccountCollectionDefinition> = PluginAccountCollectionValue<PluginAccountCollectionDefinition>,
>(input: Readonly<{
    ref: PluginCollectionContractRefV1;
    options?: ActivePluginCollectionOperationOptionsV1;
    /** Preserve a facade's sole pre-captured Account lifetime across nested operations. */
    accountLifetime?: ActiveServerAccountScopeLifetime;
    /** The bound facade's current release admission, rechecked before effects. */
    assertAdmitted?: () => void;
    signal?: AbortSignal;
    /** Exact Data reads bypass pending acquisition sharing; Account identity stays admitted. */
    fresh?: boolean;
}>): Promise<ActivePluginCollectionClientForContractRefOutcomeV1<TValue>> {
    const request = PluginCollectionContractReadRequestV1Schema.safeParse({ ref: input.ref });
    if (!request.success) return rejected('collection_query_invalid');
    const prepared = await prepareCollectionOperation(input.options, input.accountLifetime, input.signal);
    if (prepared.status === 'unavailable') return prepared;
    try {
        input.assertAdmitted?.();
        const response = await requestCollectionOperation({
            operation: prepared.operation,
            path: PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1,
            kind: 'read',
            fresh: input.fresh ?? true,
            body: request.data,
            options: input.options,
        });
        if (response.status === 'unavailable') return response;
        if (!response.ok) return mapReadError(response.body);
        const result = PluginCollectionContractReadResultV1Schema.safeParse(response.body);
        if (!result.success || !contractMatchesRef(result.data.contract, request.data.ref)) {
            return unavailable('response-invalid');
        }
        return {
            status: 'ready',
            access: result.data.access,
            contract: result.data.contract,
            client: createActivePluginCollectionClient<TValue>({
                contract: result.data.contract,
                access: result.data.access,
                accountLifetime: input.accountLifetime,
                assertAdmitted: input.assertAdmitted,
                signal: input.signal,
            }),
        };
    } finally {
        await prepared.operation.release();
    }
}

/**
 * Direct UI adapter for one already-admitted collection contract. It has no
 * store, retry loop, persistence, or independent Account lifecycle: callers
 * receive the server's exact CAS result and use the shared AccountChange
 * wakeup to decide when their own desired state needs reconciliation.
 */
export function createActivePluginCollectionClient<
    TValue extends PluginAccountCollectionValue<PluginAccountCollectionDefinition> = PluginAccountCollectionValue<PluginAccountCollectionDefinition>,
>(params: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
    access?: 'readOnly' | 'writable';
    /** A resolved facade retains this existing scope instead of recapturing globally. */
    accountLifetime?: ActiveServerAccountScopeLifetime;
    /** Reuse the caller's Availability authority across asynchronous preparation. */
    assertAdmitted?: () => void;
    signal?: AbortSignal;
}>): ActivePluginCollectionClientV1<TValue> {
    const validate = compilePluginJsonSchema(params.contract.schema);
    const storedReadSchema = createStoredReadSchema(createPluginJsonSchemaZodValueAdapter(params.contract.schema));
    const prepare = async (options?: ActivePluginCollectionOperationOptionsV1, freshPlainIdentity = false) => {
        params.assertAdmitted?.();
        const prepared = await prepareCollectionOperation(options, params.accountLifetime, params.signal, freshPlainIdentity);
        if (prepared.status === 'ready') {
            try {
                params.assertAdmitted?.();
            } catch (error) {
                await prepared.operation.release();
                throw error;
            }
        }
        return prepared;
    };

    const get = async (
        rowId: string,
        options?: ActivePluginCollectionOperationOptionsV1,
        fresh = false,
    ): Promise<ActivePluginCollectionGetOutcomeV1<TValue>> => {
        const request = PluginCollectionGetRequestV1Schema.safeParse({
            pluginId: params.contract.pluginId,
            collectionId: params.contract.collectionId,
            readerContext: {
                pluginId: params.contract.pluginId,
                collectionId: params.contract.collectionId,
                schemaVersion: params.contract.schemaVersion,
                contractDigest: params.contract.contractDigest,
            },
            rowId,
        });
        if (!request.success) return rejected('collection_query_invalid');
        const prepared = await prepare(options);
        if (prepared.status === 'unavailable') return prepared;
        try {
            const response = await requestCollectionOperation({
                operation: prepared.operation,
                path: PLUGIN_COLLECTION_GET_HTTP_PATH_V1,
                kind: 'read',
                fresh,
                body: request.data,
                options,
            });
            if (response.status === 'unavailable') return response;
            if (!response.ok) return mapReadError(response.body);
            const result = PluginCollectionGetResultV1Schema.safeParse(response.body);
            if (!result.success) return unavailable('response-invalid');
            const row = result.data.row === null
                ? null
                : mergeLogicalRow<TValue>({
                    contract: params.contract,
                    storedReadSchema,
                    row: result.data.row,
                    encryptionMode: prepared.operation.encryptionMode,
                    material: prepared.operation.material,
                });
            return result.data.row !== null && !row
                ? unavailable('account-content-mismatch')
                : { status: 'ready', row, absenceEpoch: result.data.absenceEpoch };
        } finally {
            await prepared.operation.release();
        }
    };

    const query = async (
        input: ActivePluginCollectionQueryInputV1,
        options?: ActivePluginCollectionOperationOptionsV1,
    ): Promise<ActivePluginCollectionQueryOutcomeV1<TValue>> => {
        const index = params.contract.indexes.find((candidate) => candidate.id === input.indexId);
        if (!index || (input.prefix?.length ?? 0) > index.fields.length) {
            return rejected('collection_query_invalid');
        }
        const request = PluginCollectionQueryRequestV1Schema.safeParse({
            pluginId: params.contract.pluginId,
            collectionId: params.contract.collectionId,
            readerContext: {
                pluginId: params.contract.pluginId,
                collectionId: params.contract.collectionId,
                schemaVersion: params.contract.schemaVersion,
                contractDigest: params.contract.contractDigest,
            },
            ...input,
        });
        if (!request.success) return rejected('collection_query_invalid');
        const prepared = await prepare(options);
        if (prepared.status === 'unavailable') return prepared;
        try {
            const response = await requestCollectionOperation({
                operation: prepared.operation,
                path: PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1,
                kind: 'read',
                body: request.data,
                options,
            });
            if (response.status === 'unavailable') return response;
            if (!response.ok) return mapReadError(response.body);
            const result = PluginCollectionQueryResultV1Schema.safeParse(response.body);
            if (!result.success) return unavailable('response-invalid');
            const rows: ActivePluginCollectionLogicalRowV1<TValue>[] = [];
            for (const row of result.data.rows) {
                const materialized = mergeLogicalRow<TValue>({
                    contract: params.contract,
                    storedReadSchema,
                    row,
                    encryptionMode: prepared.operation.encryptionMode,
                    material: prepared.operation.material,
                });
                if (!materialized) return unavailable('account-content-mismatch');
                rows.push(materialized);
            }
            return {
                status: 'ready',
                rows,
                ...(result.data.nextCursor ? { nextCursor: result.data.nextCursor } : {}),
                changeCursor: result.data.changeCursor,
            };
        } finally {
            await prepared.operation.release();
        }
    };

    /**
     * The one place this client's logical mutations become a wire request.
     * `mutate` and `measureBatch` share it so a surface that sizes its own
     * batches measures exactly the bytes the mutation will send, private
     * envelope and projection included, rather than modelling the expansion.
     */
    const prepareMutationRequest = (
        operations: readonly ActivePluginCollectionMutationInputV1<TValue>[],
        operation: PreparedCollectionOperation,
        absenceEpoch?: number,
    ) => preparePluginCollectionLogicalMutationRequestV1<TValue>({
        contract: params.contract,
        isValidLogicalValue: (value): value is TValue => isLogicalCollectionValue<TValue>(validate, value),
        operations,
        encryptionMode: operation.encryptionMode,
        material: operation.material,
        randomBytes: getRandomBytes,
        absenceEpoch,
    });

    /**
     * An absent create is witnessed by the Collection-wide epoch, not by a
     * synthetic row revision. Both mutation and measurement must obtain that
     * same incumbent snapshot so their sealed request shapes stay identical.
     */
    const readAbsenceEpochForOperations = async (
        operations: readonly ActivePluginCollectionMutationInputV1<TValue>[],
        options?: ActivePluginCollectionOperationOptionsV1,
    ): Promise<
        | Readonly<{ status: 'ready'; absenceEpoch?: number }>
        | ActivePluginCollectionUnavailableV1
        | ActivePluginCollectionRejectedV1
    > => {
        const absentPut = operations.find((candidate): candidate is Extract<
            ActivePluginCollectionMutationInputV1<TValue>,
            Readonly<{ kind: 'put' }>
        > => candidate.kind === 'put' && candidate.expectedRevision === 'absent');
        if (!absentPut) return { status: 'ready' };
        const rowId = PluginCollectionRowIdV1Schema.safeParse(
            absentPut.value[params.contract.rowIdField],
        );
        if (!rowId.success) return rejected('collection_mutation_invalid');
        const current = await get(rowId.data, options, true);
        if (current.status !== 'ready') return current;
        return { status: 'ready', absenceEpoch: current.absenceEpoch };
    };

    const mutate = async (
        operations: readonly ActivePluginCollectionMutationInputV1<TValue>[],
        options?: ActivePluginCollectionOperationOptionsV1,
    ): Promise<ActivePluginCollectionMutationOutcomeV1> => {
        if (params.access === 'readOnly') return unavailable('writer-contract-unavailable');
        if (
            operations.length < 1
            || operations.length > PLUGIN_COLLECTION_LIMITS_V1.maximumMutationBatchRows
        ) {
            return rejected('collection_mutation_invalid');
        }
        const absence = await readAbsenceEpochForOperations(operations, options);
        if (absence.status !== 'ready') return absence;
        const prepared = await prepare(options);
        if (prepared.status === 'unavailable') return prepared;
        try {
            const sealed = prepareMutationRequest(operations, prepared.operation, absence.absenceEpoch);
            if (sealed.status === 'failed') return mapEncodeFailure(sealed);
            const response = await requestCollectionOperation({
                operation: prepared.operation,
                path: PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1,
                kind: 'mutation',
                body: sealed.request,
                options,
            });
            if (response.status === 'unavailable') return response;
            if (!response.ok) return mapMutationError(response.body, response.httpStatus);
            const result = PluginCollectionMutationResultV1Schema.safeParse(response.body);
            if (!result.success) return unavailable('mutation-outcome-unknown');
            return result.data.status === 'conflict'
                ? { status: 'conflict', conflicts: result.data.conflicts }
                : {
                    status: 'updated',
                    results: result.data.results,
                    changeCursor: result.data.changeCursor,
                };
        } finally {
            await prepared.operation.release();
        }
    };

    /**
     * Retention-only physical reclamation, witnessed solely by the exact row
     * revision the caller already proved unreachable. The server advances
     * Collection absence currentness inside the same transaction, and a direct
     * read cannot see a tombstone — so re-reading before retrying could never
     * resolve a revision conflict, only spin on it. One request, one answer.
     */
    const forget = async (
        rowId: string,
        expectedRevision: number,
        options?: ActivePluginCollectionOperationOptionsV1,
    ): Promise<ActivePluginCollectionForgetOutcomeV1> => {
        if (params.access === 'readOnly') return unavailable('writer-contract-unavailable');
        const body = PluginCollectionForgetRequestV1Schema.safeParse({
            pluginId: params.contract.pluginId,
            collectionId: params.contract.collectionId,
            writerContext: {
                schemaVersion: params.contract.schemaVersion,
                contractDigest: params.contract.contractDigest,
            },
            rowId,
            expectedRevision,
        });
        if (!body.success) return rejected('collection_mutation_invalid');
        const prepared = await prepare(options);
        if (prepared.status === 'unavailable') return prepared;
        try {
            const response = await requestCollectionOperation({
                operation: prepared.operation,
                path: PLUGIN_COLLECTION_FORGET_HTTP_PATH_V1,
                kind: 'mutation',
                body: body.data,
                options,
            });
            if (response.status === 'unavailable') return response;
            if (!response.ok) return mapMutationError(response.body, response.httpStatus);
            const result = PluginCollectionForgetResultV1Schema.safeParse(response.body);
            return result.success ? result.data : unavailable('mutation-outcome-unknown');
        } finally {
            await prepared.operation.release();
        }
    };

    /**
     * The scope facts `limits` needs without a request: this client's captured
     * Account lifetime and the server whose published capability is in force.
     * A stale scope answers with the same typed unavailability every other
     * operation reports rather than a stale ceiling.
     */
    const currentServerScope = (
        options?: ActivePluginCollectionOperationOptionsV1,
    ): Readonly<{ status: 'ready'; serverId: string }> | ActivePluginCollectionUnavailableV1 => {
        if (options?.signal?.aborted) return unavailable('operation-cancelled');
        const lifetime = params.accountLifetime ?? captureActiveServerAccountScopeLifetime();
        if (!lifetime) return unavailable('no-active-account-scope');
        if (!lifetime.isCurrent()) return unavailable('account-scope-changed');
        const serverSnapshot = getActiveServerSnapshot();
        if (serverSnapshot.serverId !== lifetime.scope.serverId) {
            return unavailable('server-generation-changed');
        }
        return { status: 'ready', serverId: serverSnapshot.serverId };
    };

    const identityTag = async (
        request: Readonly<{ field: string; components: readonly string[] }>,
        options?: ActivePluginCollectionOperationOptionsV1,
    ): Promise<ActivePluginCollectionIdentityTagOutcomeV1> => {
        const prepared = await prepare(options, params.contract.identityFields.length > 0);
        if (prepared.status === 'unavailable') return prepared;
        try {
            const resolved = resolvePluginCollectionIdentityTagV1({
                contract: params.contract,
                accountEncryptionMode: prepared.operation.encryptionMode,
                material: prepared.operation.material,
                field: request.field,
                components: request.components,
            });
            if (resolved.status === 'failed') {
                // The daemon host reports an undeclared identity field as an
                // invalid value, and the same plugin code runs in both realms —
                // Triage and channels already branch on this exact code — so a
                // surface must not hand it a second code for one mistake.
                return resolved.reason === 'field-not-declared'
                    ? rejected('plugin_collection_invalid_value')
                    : unavailable('account-encryption-material-unavailable');
            }
            return { status: 'ready', tag: resolved.tag };
        } finally {
            await prepared.operation.release();
        }
    };

    const limits = async (
        options?: ActivePluginCollectionOperationOptionsV1,
    ): Promise<ActivePluginCollectionLimitsOutcomeV1> => {
        const scope = currentServerScope(options);
        if (scope.status === 'unavailable') return scope;
        const featureSnapshot = getCachedServerFeaturesSnapshot({ serverId: scope.serverId });
        return {
            status: 'ready',
            limits: resolveEffectivePluginCollectionLimitsV1({
                deployment: featureSnapshot?.status === 'ready'
                    ? featureSnapshot.features.capabilities.pluginDataCollections
                    : undefined,
                quota: params.contract.quota,
            }),
        };
    };

    const measureBatch = async (
        operations: readonly ActivePluginCollectionMutationInputV1<TValue>[],
        options?: ActivePluginCollectionOperationOptionsV1,
    ): Promise<ActivePluginCollectionMeasurementOutcomeV1> => {
        if (operations.length < 1) return rejected('collection_mutation_invalid');
        const absence = await readAbsenceEpochForOperations(operations, options);
        if (absence.status !== 'ready') return absence;
        const prepared = await prepare(options);
        if (prepared.status === 'unavailable') return prepared;
        try {
            // A caller measures precisely because its candidates do not fit one
            // request, so measurement seals in request-sized windows. Costs are
            // additive and the shell is identical in every window, so the
            // reported decomposition stays exact for any subset.
            const window = PLUGIN_COLLECTION_LIMITS_V1.maximumMutationBatchRows;
            const operationEncodedBytes: number[] = [];
            let overheadEncodedBytes = 0;
            for (let offset = 0; offset < operations.length; offset += window) {
                const sealed = prepareMutationRequest(
                    operations.slice(offset, offset + window),
                    prepared.operation,
                    absence.absenceEpoch,
                );
                if (sealed.status === 'failed') return mapEncodeFailure(sealed);
                overheadEncodedBytes = sealed.measurement.overheadEncodedBytes;
                operationEncodedBytes.push(...sealed.measurement.operationEncodedBytes);
            }
            return {
                status: 'ready',
                measurement: Object.freeze({
                    overheadEncodedBytes,
                    operationEncodedBytes: Object.freeze(operationEncodedBytes),
                }),
            };
        } finally {
            await prepared.operation.release();
        }
    };

    return Object.freeze({
        identityTag,
        get,
        query,
        mutate,
        forget,
        limits,
        measureBatch,
        watch(onInvalidated): ActivePluginCollectionWatchOutcomeV1 {
            const watch = watchActivePluginCollectionChanges({
                pluginId: params.contract.pluginId,
                collectionId: params.contract.collectionId,
                onInvalidated,
                ...(params.accountLifetime ? { accountLifetime: params.accountLifetime } : {}),
            });
            return watch
                ? { status: 'watching', dispose: watch.dispose }
                : unavailable('no-active-account-scope');
        },
    });
}
