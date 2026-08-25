import {
    PLUGIN_UI_HOST_API_COMPATIBLE_RANGE_V1,
    PLUGIN_UI_HOST_API_VERSION_V1,
    PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
    PLUGIN_UI_HOST_METHODS_V1,
    ComposerDecorationResultV1Schema,
    ComposerContentHandleV1Schema,
    ComposerContentInspectWireResultV1Schema,
    ComposerFocusResultV1Schema,
    ComposerReadResultV1Schema,
    ComposerSnapshotV1Schema,
    ComposerTransactionResultV1Schema,
    PluginUiAcquireComposerInputLockRequestV1Schema,
    PluginUiActiveComposerResultV1Schema,
    PluginUiApplyComposerRequestV1Schema,
    PluginUiFocusComposerRequestV1Schema,
    PluginUiInspectComposerContentRequestV1Schema,
    PluginUiJsonObjectV1Schema,
    PluginUiReadComposerRequestV1Schema,
    PluginUiPickComposerMediaRequestV1Schema,
    PluginUiPublishCurrentUiContextRequestV1Schema,
    PluginUiReleaseComposerContentRequestV1Schema,
    PluginUiReplacePageLocationRequestV1Schema,
    PluginUiReplacePageLocationResultV1Schema,
    PluginUiSetComposerDecorationsRequestV1Schema,
    PluginUiWatchComposerRequestV1Schema,
    PluginUiExecuteActionRequestV1Schema,
    PluginUiHostApiSurfaceContextV1Schema,
    PluginUiHostApiRenderContextSnapshotV1Schema,
    PluginUiSelectActionInputRequestV1Schema,
    PluginUiSelectActionInputResultV1Schema,
    PluginUiSelectedActionInputCarrierV1Schema,
    PluginUiHostApiWireEnvelopeV1Schema,
    pluginUiHostApiWireIdentitiesEqual,
    PluginUiResourceSubscriptionEventV1Schema,
    OpenableContentReadResultV1Schema,
    OpenableContentStatResultV1Schema,
    type PluginUiHostApiWireEnvelopeV1,
    type PluginUiHostApiWireIdentityV1,
    type PluginUiHostMethodV1 as ProtocolPluginUiHostMethodV1,
    type PluginUiSelectActionInputResultV1,
    type PluginUiHostApiSurfaceContextV1,
    type PluginUiTargetedContributionOperationV1,
} from '@happier-dev/protocol/plugins/ui/client';

import { PluginError } from '../errors.js';
import type { PluginErrorData } from '../errors.js';
import type { PluginDiagnosticData } from '../diagnostics.js';
import type { JsonValue, PluginReference } from '../identity.js';
import type { Disposable, PluginCancellationOptions } from '../lifecycle.js';
import type {
    PluginUiHostApi,
    PluginUiActionExecutionOptions,
    PluginUiHostApiVersion,
    ComposerDecorationResultV1,
    ComposerContentHandleV1,
    ComposerContentInspectRequestV1,
    ComposerContentInspectResultV1,
    ComposerContentPickMediaRequestV1,
    ComposerFocusResultV1,
    ComposerReadResultV1,
    ComposerSnapshotV1,
    ComposerTransactionResultV1,
    OpenableContentReadRequest,
    OpenableContentReadResult,
    OpenableContentRef,
    OpenableContentStatResult,
    ResourceContent,
    ResourceSubscriptionEvent,
    SurfaceContext,
    SurfaceHostMethod,
} from './hostApi.js';

type MutuallyAssignable<TLeft, TRight> = [TLeft] extends [TRight] ? unknown : never;

/**
 * Internal closure primitive for the author-facing host API surface.
 *
 * The final initial Protocol tuple and public SDK interface must name exactly
 * the same methods. Either side drifting collapses this type to `never`.
 */
export type PluginUiCanonicalHostMethodFor<
    TAuthorMethod extends PropertyKey,
    TProtocolMethod extends PropertyKey,
> =
    & TProtocolMethod
    & MutuallyAssignable<TAuthorMethod, TProtocolMethod>
    & MutuallyAssignable<TProtocolMethod, TAuthorMethod>;

/**
 * UI-D27 closure, type-only and consumed rather than declared.
 *
 * The public SDK interface is closed against the one Protocol tuple. A method
 * added to either side without its counterpart collapses this alias to `never`
 * and stops every `request(...)`/`subscribe(...)` call below from compiling.
 */
type CanonicalHostMethod = PluginUiCanonicalHostMethodFor<
    Exclude<keyof PluginUiHostApi, 'version'>,
    ProtocolPluginUiHostMethodV1
>;

type CanonicalSurfaceContext = PluginUiHostApiSurfaceContextV1
    & MutuallyAssignable<PluginUiHostApiSurfaceContextV1, SurfaceContext>
    & MutuallyAssignable<SurfaceContext, PluginUiHostApiSurfaceContextV1>;

export interface PluginUiHostApiClientTransport {
    send(message: PluginUiHostApiWireEnvelopeV1): void | Promise<void>;
    subscribe(listener: (message: unknown) => void): Disposable;
}

export interface CreatePluginUiHostApiClientFromTransportOptions {
    readonly identity: PluginUiHostApiWireIdentityV1;
    readonly transport: PluginUiHostApiClientTransport;
    readonly apiRange?: string;
    /**
     * Bounds the OPENING HANDSHAKE only. A host that never answers `negotiate`
     * would otherwise leave the client waiting forever with nothing to cancel
     * it, because no caller yet holds a handle to abort.
     *
     * Ordinary operations are deliberately unbounded: `selectActionInput` is
     * held open by a person filling a form, and a wall-clock deadline on it
     * cancels valid work. Their lifetime is owned by the caller's
     * `AbortSignal`, the mount retirement that aborts it, and the terminal
     * disconnect that settles everything in flight.
     */
    readonly negotiationTimeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly createRequestId?: () => string;
    readonly createSubscriptionId?: () => string;
    /**
     * Fired once when the client goes terminally offline — a host
     * `disconnected`, an aborted signal, a failed negotiation or a dead
     * transport. Host-private: it is how `createPluginUiRenderContext` aborts
     * the author's `RenderContext.signal` when the surface is retired (§3.12),
     * and it is not part of the published author surface.
     */
    readonly onDisconnected?: (reason: string) => void;
    /** Host-private projection of the current retained-mount activity fact. */
    readonly onContextActivity?: (activity: Readonly<{ active: boolean }>) => void;
}

export class PluginUiHostApiClientError extends PluginError {
    constructor(
        code: string,
        message?: string,
        retryable = false,
        data: Pick<PluginErrorData, 'details' | 'remediation' | 'diagnostics'> = {},
    ) {
        super({
            code,
            ...(message === undefined ? {} : { message }),
            retryable,
            ...(data.details === undefined ? {} : { details: data.details }),
            ...(data.remediation === undefined ? {} : { remediation: data.remediation }),
            ...(data.diagnostics === undefined ? {} : { diagnostics: data.diagnostics }),
        });
    }
}

type PendingRequest = Readonly<{
    method: CanonicalHostMethod;
    resolve(value: JsonValue | undefined): void;
    reject(error: PluginUiHostApiClientError): void;
    abortCleanup?: () => void;
}>;

type SelectedActionInputCarrier = Readonly<{
    operation: PluginUiTargetedContributionOperationV1;
    result: Extract<PluginUiSelectActionInputResultV1, Readonly<{ kind: 'submitted' }>>;
}>;
/**
 * A subscription's local state (§3.6).
 *
 * `admitted` is flipped synchronously when the host's establishment result
 * settles, so an event the host sends in the same turn as its acknowledgement is
 * not dropped by a microtask boundary. Events that arrive before admission are
 * held in `buffered` and flushed in arrival order — a subscription never
 * silently loses an event, and delivery stays serialized per subscription.
 */
type SubscriptionRecord = {
    readonly method: SubscriptionHostMethod;
    readonly deliver: (value: JsonValue, subscriptionId: string) => void;
    admitted: boolean;
    retired: boolean;
    readonly buffered: JsonValue[];
};
type EstablishedSubscription = Readonly<{
    subscriptionId: string;
    establishment: JsonValue | undefined;
    dispose: () => void;
}>;
type SubscriptionHostMethod = Extract<
    CanonicalHostMethod,
    'watchContext' | 'watchResource' | 'watchComposer' | 'acquireComposerInputLock'
>;

/**
 * Decode a resource subscription event through the canonical Protocol owner
 * rather than a hand-rolled shape check, and require the event to name the
 * subscription the envelope addressed.
 */
function readResourceSubscriptionEvent(value: JsonValue, subscriptionId: string): ResourceSubscriptionEvent {
    const parsed = PluginUiResourceSubscriptionEventV1Schema.safeParse(value);
    if (!parsed.success || parsed.data.subscriptionId !== subscriptionId) {
        throw new PluginUiHostApiClientError('invalid_payload', 'Host returned an invalid resource subscription event.');
    }
    return parsed.data;
}

/**
 * A Resource watch baseline is useful only for the exact subscription the
 * client established. Older hosts omit it, and malformed/mismatched results
 * intentionally leave the caller with the ordinary convergence reread.
 */
function readResourceWatchAdmittedDigest(
    value: JsonValue | undefined,
    subscriptionId: string,
): string | undefined {
    const record = isJsonRecord(value) ? value : undefined;
    const digest = record?.subscriptionId === subscriptionId ? record.digest : undefined;
    return typeof digest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(digest)
        ? digest
        : undefined;
}

let generatedId = 0;
function defaultId(prefix: string): string {
    generatedId += 1;
    return `${prefix}-${Date.now()}-${generatedId}`;
}
function isAdvertisableHostMethod(
    method: ProtocolPluginUiHostMethodV1,
): method is SurfaceHostMethod {
    return (PLUGIN_UI_HOST_METHODS_V1 as readonly string[]).includes(method);
}
function asJsonReference(reference: PluginReference): JsonValue {
    return typeof reference === 'string' ? reference : { pluginId: reference.pluginId, localId: reference.localId };
}
function createExecuteActionRequest(action: PluginReference, input?: JsonValue) {
    const parsed = PluginUiExecuteActionRequestV1Schema.safeParse({
        // Preserve the author-provided runtime shape for the strict Protocol
        // owner. Projecting first would silently drop unknown object fields and
        // create a second, weaker Action grammar at this transport boundary.
        action,
        ...(input === undefined ? {} : { input }),
    });
    if (!parsed.success) {
        throw new PluginUiHostApiClientError('invalid_payload', 'executeAction request is invalid.');
    }
    return parsed.data;
}
function normalizePluginSurfaceDestination(
    reference: PluginReference,
    pluginId: string,
): Readonly<{ pluginId: string; localId: string }> {
    if (typeof reference === 'string') {
        return { pluginId, localId: reference };
    }
    return { pluginId: reference.pluginId, localId: reference.localId };
}
function diagnosticToJson(data: PluginDiagnosticData): JsonValue {
    return {
        code: data.code,
        severity: data.severity,
        ...(data.message === undefined ? {} : { message: data.message }),
        ...(data.details === undefined ? {} : { details: data.details }),
        ...(data.remediation === undefined ? {} : { remediation: data.remediation }),
    };
}
function isJsonRecord(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
    return value !== undefined && value !== null && !Array.isArray(value) && typeof value === 'object';
}
function requireRecord(value: JsonValue | undefined, label: string): Readonly<Record<string, JsonValue>> {
    if (!isJsonRecord(value)) throw new PluginUiHostApiClientError('invalid_payload', `${label} must be an object.`);
    return value;
}
function requireTransportJsonObject(value: unknown, label: string): JsonValue {
    const parsed = PluginUiJsonObjectV1Schema.safeParse(value);
    if (!parsed.success) {
        throw new PluginUiHostApiClientError('invalid_payload', `${label} must be transport-safe JSON.`);
    }
    return parsed.data;
}
function requireExactKeys(record: Readonly<Record<string, JsonValue>>, keys: readonly string[], label: string): void {
    const allowed = new Set(keys);
    if (Object.keys(record).some((key) => !allowed.has(key))) {
        throw new PluginUiHostApiClientError('invalid_payload', `Host returned unknown ${label} fields.`);
    }
}
function readSurface(value: JsonValue): SurfaceContext {
    const parsed = PluginUiHostApiSurfaceContextV1Schema.safeParse(value);
    if (!parsed.success) {
        throw new PluginUiHostApiClientError('invalid_payload', 'Host returned an invalid surface context.');
    }
    const surface: CanonicalSurfaceContext = parsed.data;
    return surface;
}
function readRenderContextSnapshot(value: JsonValue): Readonly<{
    surface: SurfaceContext;
    activity: Readonly<{ active: boolean }>;
}> {
    const parsed = PluginUiHostApiRenderContextSnapshotV1Schema.safeParse(value);
    if (!parsed.success) {
        throw new PluginUiHostApiClientError('invalid_payload', 'Host returned an invalid render context snapshot.');
    }
    return Object.freeze({
        surface: readSurface(parsed.data.surface),
        activity: Object.freeze({ active: parsed.data.activity.active }),
    });
}
function decodeBase64(value: string): Uint8Array {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
        throw new PluginUiHostApiClientError('invalid_payload', 'Host returned malformed resource bytes.');
    }
    try {
        if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(value, 'base64'));
        const decoded = globalThis.atob(value);
        return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    } catch {
        throw new PluginUiHostApiClientError('invalid_payload', 'Host returned malformed resource bytes.');
    }
}

/**
 * The host owns ref admission and request normalization. The client merely
 * preserves the public opaque fields in a JSON-safe envelope; it never turns a
 * handle into a path or supplies an implicit read ceiling.
 */
function openableContentRefToJson(ref: OpenableContentRef): JsonValue {
    return { kind: ref.kind, handle: ref.handle };
}

function readOpenableContentStatResult(value: JsonValue | undefined): OpenableContentStatResult {
    const parsed = OpenableContentStatResultV1Schema.safeParse(value);
    if (!parsed.success) {
        throw new PluginUiHostApiClientError(
            'invalid_payload',
            'Host returned an invalid openable-content stat result.',
        );
    }
    return parsed.data;
}

function readOpenableContentReadResult(value: JsonValue | undefined): OpenableContentReadResult {
    const parsed = OpenableContentReadResultV1Schema.safeParse(value);
    if (!parsed.success) {
        throw new PluginUiHostApiClientError(
            'invalid_payload',
            'Host returned an invalid openable-content read result.',
        );
    }
    return parsed.data;
}

function readActiveComposerResult(value: JsonValue | undefined) {
    const parsed = PluginUiActiveComposerResultV1Schema.safeParse(value);
    if (!parsed.success) {
        throw new PluginUiHostApiClientError(
            'invalid_payload',
            'Host returned an invalid active Composer result.',
        );
    }
    return parsed.data;
}

function readComposerReadResult(value: JsonValue | undefined): ComposerReadResultV1 {
    const parsed = ComposerReadResultV1Schema.safeParse(value);
    if (!parsed.success) {
        throw new PluginUiHostApiClientError(
            'invalid_payload',
            'Host returned an invalid Composer read result.',
        );
    }
    return parsed.data;
}

function readComposerSnapshot(value: JsonValue | undefined): ComposerSnapshotV1 {
    const parsed = ComposerSnapshotV1Schema.safeParse(value);
    if (!parsed.success) {
        throw new PluginUiHostApiClientError(
            'invalid_payload',
            'Host returned an invalid Composer observation.',
        );
    }
    return parsed.data;
}

function readComposerTransactionResult(value: JsonValue | undefined): ComposerTransactionResultV1 {
    const parsed = ComposerTransactionResultV1Schema.safeParse(value);
    if (!parsed.success) {
        throw new PluginUiHostApiClientError(
            'invalid_payload',
            'Host returned an invalid Composer transaction result.',
        );
    }
    return parsed.data;
}

function readComposerFocusResult(value: JsonValue | undefined): ComposerFocusResultV1 {
    const parsed = ComposerFocusResultV1Schema.safeParse(value);
    if (!parsed.success) {
        throw new PluginUiHostApiClientError(
            'invalid_payload',
            'Host returned an invalid Composer focus result.',
        );
    }
    return parsed.data;
}

function readComposerDecorationResult(value: JsonValue | undefined): ComposerDecorationResultV1 {
    const parsed = ComposerDecorationResultV1Schema.safeParse(value);
    if (!parsed.success) {
        throw new PluginUiHostApiClientError(
            'invalid_payload',
            'Host returned an invalid Composer decoration result.',
        );
    }
    return parsed.data;
}

function readComposerContentHandle(value: JsonValue | undefined): ComposerContentHandleV1 {
    const parsed = ComposerContentHandleV1Schema.safeParse(value);
    if (!parsed.success) {
        throw new PluginUiHostApiClientError(
            'invalid_payload',
            'Host returned an invalid Composer content handle.',
        );
    }
    return parsed.data;
}

function readComposerContentInspection(value: JsonValue | undefined): ComposerContentInspectResultV1 {
    const parsed = ComposerContentInspectWireResultV1Schema.safeParse(value);
    if (!parsed.success) {
        throw new PluginUiHostApiClientError(
            'invalid_payload',
            'Host returned an invalid Composer content inspection.',
        );
    }
    return Object.freeze({
        offset: parsed.data.offset,
        bytes: decodeBase64(parsed.data.bytesBase64),
        eof: parsed.data.eof,
    });
}

export async function createPluginUiHostApiClientFromTransport(
    options: CreatePluginUiHostApiClientFromTransportOptions,
): Promise<PluginUiHostApi> {
    const createRequestId = options.createRequestId ?? (() => defaultId('plugin-ui-request'));
    const createSubscriptionId = options.createSubscriptionId ?? (() => defaultId('plugin-ui-subscription'));
    const negotiationTimeoutMs = options.negotiationTimeoutMs ?? 30_000;
    const pending = new Map<string, PendingRequest>();
    const subscriptions = new Map<string, SubscriptionRecord>();
    const issuedInjectedRequestIds = options.createRequestId === undefined ? undefined : new Set<string>();
    const issuedInjectedSubscriptionIds = options.createSubscriptionId === undefined ? undefined : new Set<string>();
    let online = true;
    let terminalError: PluginUiHostApiClientError | undefined;
    let negotiated: { version: PluginUiHostApiVersion; surface: SurfaceContext } | undefined;
    const requestedApiRange = options.apiRange ?? PLUGIN_UI_HOST_API_COMPATIBLE_RANGE_V1;
    let negotiationTimeout: ReturnType<typeof setTimeout> | undefined;
    let resolveNegotiation!: () => void;
    let rejectNegotiation!: (error: PluginUiHostApiClientError) => void;
    const negotiation = new Promise<void>((resolve, reject) => { resolveNegotiation = resolve; rejectNegotiation = reject; });

    function unavailable(code = 'ui_host_unavailable', message = 'Plugin UI host API is unavailable.'): PluginUiHostApiClientError {
        return new PluginUiHostApiClientError(code, message, true);
    }
    function nextRequestId(): string {
        const requestId = createRequestId();
        if (requestId.trim() === '') throw new PluginUiHostApiClientError('invalid_request_id', 'The host API request id must not be empty.');
        if (issuedInjectedRequestIds?.has(requestId)) throw new PluginUiHostApiClientError('duplicate_request_id', 'The host API request id was already issued.');
        issuedInjectedRequestIds?.add(requestId);
        return requestId;
    }
    function nextSubscriptionId(): string {
        const subscriptionId = createSubscriptionId();
        if (subscriptionId.trim() === '') throw new PluginUiHostApiClientError('invalid_subscription_id', 'The host API subscription id must not be empty.');
        if (issuedInjectedSubscriptionIds?.has(subscriptionId)) throw new PluginUiHostApiClientError('duplicate_subscription_id', 'The host API subscription id was already issued.');
        issuedInjectedSubscriptionIds?.add(subscriptionId);
        return subscriptionId;
    }
    function settle(id: string, action: (request: PendingRequest) => void): void {
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        request.abortCleanup?.();
        action(request);
    }
    let transportSubscription: Disposable | undefined;
    let transportDisposed = false;
    function disposeTransport(): void {
        if (transportDisposed || transportSubscription === undefined) return;
        transportDisposed = true;
        void transportSubscription.dispose();
    }
    function terminate(error: PluginUiHostApiClientError): void {
        if (!online) return;
        online = false;
        terminalError = error;
        if (negotiationTimeout) clearTimeout(negotiationTimeout);
        rejectNegotiation(error);
        for (const id of [...pending.keys()]) settle(id, (request) => request.reject(error));
        subscriptions.clear();
        disposeTransport();
        // Last, so an observer sees a fully settled client rather than one still
        // holding pending requests it is about to reject.
        try {
            options.onDisconnected?.(error.code);
        } catch {
            // An observer's failure cannot keep the client pretending to be online.
        }
    }
    function disconnect(reason: string): void {
        terminate(unavailable(reason));
    }
    transportSubscription = options.transport.subscribe((raw) => {
        const parsed = PluginUiHostApiWireEnvelopeV1Schema.safeParse(raw);
        if (!parsed.success || !pluginUiHostApiWireIdentitiesEqual(options.identity, parsed.data.identity)) return;
        const message = parsed.data;
        if (message.kind === 'negotiated') {
            if (negotiated) {
                disconnect('invalid_negotiation');
                return;
            }
            if (message.apiVersion !== PLUGIN_UI_HOST_API_VERSION_V1) {
                disconnect('incompatible_api_version');
                return;
            }
            if (new Set(message.methods).size !== message.methods.length) {
                disconnect('invalid_negotiation');
                return;
            }
            try {
                if (negotiationTimeout) clearTimeout(negotiationTimeout);
                negotiated = {
                    version: {
                        apiVersion: message.apiVersion,
                        wireVersion: message.wireVersion,
                        // The one Protocol tuple is the only advertisable method
                        // vocabulary. Negotiation still reports factual handler
                        // availability; it no longer selects a semantic branch.
                        methods: message.methods.filter(isAdvertisableHostMethod),
                    },
                    surface: readSurface(message.surface),
                };
                resolveNegotiation();
            } catch (error) {
                terminate(error instanceof PluginUiHostApiClientError ? error : unavailable());
            }
            return;
        }
        if (message.kind === 'disconnected') { disconnect(message.reason); return; }
        if (message.kind === 'result') settle(message.requestId, (request) => {
            if (request.method === message.method) request.resolve(message.result);
            else request.reject(new PluginUiHostApiClientError('invalid_response_method'));
        });
        if (message.kind === 'error') settle(message.requestId, (request) => {
            if (request.method !== message.method) {
                request.reject(new PluginUiHostApiClientError('invalid_response_method'));
                return;
            }
            request.reject(new PluginUiHostApiClientError(
                message.error.code,
                message.error.message,
                message.error.retryable,
                {
                    ...(message.error.details === undefined ? {} : { details: message.error.details }),
                    ...(message.error.remediation === undefined ? {} : { remediation: message.error.remediation }),
                    ...(message.error.diagnostics === undefined ? {} : { diagnostics: message.error.diagnostics }),
                },
            ));
        });
        if (message.kind === 'subscription') {
            const record = subscriptions.get(message.subscriptionId);
            if (!record || record.retired) return;
            // Held until admission so an event racing the acknowledgement is
            // neither lost nor delivered out of order.
            if (!record.admitted) record.buffered.push(message.event);
            else deliverSubscriptionEvent(message.subscriptionId, record, message.event);
        }
    });
    if (!online) disposeTransport();

    negotiationTimeout = setTimeout(() => disconnect('negotiation_timeout'), negotiationTimeoutMs);
    if (options.signal?.aborted) disconnect('aborted');
    else options.signal?.addEventListener('abort', () => disconnect('aborted'), { once: true });
    await Promise.resolve(options.transport.send({ wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1, kind: 'negotiate', identity: options.identity, apiRange: requestedApiRange })).catch(() => disconnect('transport_unavailable'));
    await negotiation;
    if (terminalError) throw terminalError;
    if (!negotiated) throw unavailable('negotiation_failed');

    function send(envelope: PluginUiHostApiWireEnvelopeV1): void {
        void Promise.resolve(options.transport.send(envelope)).catch(() => disconnect('transport_unavailable'));
    }
    /**
     * The single settlement owner for anything the host answers by `requestId`:
     * ordinary operations AND subscription establishment. Cancel, abort and
     * duplicate-id behavior therefore cannot drift between the two.
     *
     * There is no wall-clock deadline here. The host answers every request it
     * admits, and the operations behind them are open-ended by design — a
     * `selectActionInput` form is held by a person. Abandonment is therefore
     * caller-driven (`signal`) or terminal (`terminate` settles every pending
     * request when the client goes offline), never a timer that guesses how
     * long a human may take.
     */
    function settleWithHost(input: Readonly<{
        method: CanonicalHostMethod;
        requestId: string;
        signal?: AbortSignal;
        envelope: PluginUiHostApiWireEnvelopeV1;
        /**
         * Fired when the CALLER abandons the operation (an abort) rather than
         * the host answering it. Establishment uses it to decide whether the
         * host may still admit — and therefore still owes a retirement.
         */
        onAbandon?: () => void;
    }>): Promise<JsonValue | undefined> {
        return new Promise((resolve, reject) => {
            const cancel = () => send({ wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1, kind: 'cancel', identity: options.identity, requestId: input.requestId });
            const abort = () => {
                input.onAbandon?.();
                cancel();
                settle(input.requestId, (entry) => entry.reject(new PluginUiHostApiClientError('aborted')));
            };
            input.signal?.addEventListener('abort', abort, { once: true });
            pending.set(input.requestId, {
                method: input.method,
                resolve,
                reject,
                ...(input.signal ? { abortCleanup: () => input.signal?.removeEventListener('abort', abort) } : {}),
            });
            send(input.envelope);
        });
    }
    /**
     * Is `method` in the host's factual advertised set? Widened to the canonical
     * vocabulary so a staged method is answered `false` here — never advertised,
     * therefore never requested — instead of failing to typecheck.
     */
    function advertises(method: CanonicalHostMethod): boolean {
        const advertised: readonly string[] = negotiated?.version.methods ?? [];
        return advertised.includes(method);
    }
    /**
     * A returned structured Action object is the sole author-visible value that
     * can retain a selected-operation currentness expectation. The association
     * is private to this client and never becomes Action input, a result field,
     * caller provenance, or a replayable token.
     */
    const selectedOperationByAction = new WeakMap<object, SelectedActionInputCarrier>();

    function request(
        method: CanonicalHostMethod,
        payload?: JsonValue,
        signal?: AbortSignal,
        selectedActionInput?: SelectedActionInputCarrier,
        consumeSelectedActionInput?: true,
        onIssued?: (requestId: string) => void,
    ): Promise<JsonValue | undefined> {
        if (!online) return Promise.reject(unavailable());
        if (!advertises(method)) return Promise.reject(new PluginUiHostApiClientError('unsupported_method', `Host method ${method} is unavailable.`));
        if (signal?.aborted) return Promise.reject(new PluginUiHostApiClientError('aborted'));
        let requestId: string;
        try { requestId = nextRequestId(); } catch (error) { return Promise.reject(error); }
        onIssued?.(requestId);
        return settleWithHost({
            method,
            requestId,
            ...(signal ? { signal } : {}),
            envelope: {
                wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
                kind: 'request',
                identity: options.identity,
                requestId,
                method,
                ...(payload === undefined ? {} : { payload }),
                ...(selectedActionInput === undefined
                    ? {}
                    : {
                        targetedOperation: selectedActionInput.operation,
                        selectedActionInput: selectedActionInput.result,
                    }),
                ...(consumeSelectedActionInput === undefined ? {} : { consumeSelectedActionInput }),
            },
        });
    }
    /**
     * Retire a subscription locally and, exactly once, at the host.
     *
     * `atHost` is false only when the host itself rejected establishment: it
     * never admitted the subscription, so telling it to dispose the resource would be
     * noise for a subscription that does not exist.
     */
    function retireSubscription(
        subscriptionId: string,
        record: SubscriptionRecord | undefined,
        atHost = true,
    ): void {
        if (!record || record.retired) return;
        record.retired = true;
        record.buffered.length = 0;
        subscriptions.delete(subscriptionId);
        if (!online || !atHost) return;
        let requestId: string;
        try { requestId = nextRequestId(); } catch { return; }
        send({ wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1, kind: 'disposeHostResource', identity: options.identity, requestId, subscriptionId });
    }
    /**
     * Acknowledged-async establishment (§3.6): the promise resolves only after
     * the host admits the subscription, and a rejected establishment never
     * yields a disposable. Abandoning establishment retires a late admission
     * instead of leaving an orphan subscription at the host.
     */
    async function subscribe(
        method: SubscriptionHostMethod,
        payload: JsonValue | undefined,
        deliver: (value: JsonValue, subscriptionId: string) => void,
        signal?: AbortSignal,
    ): Promise<EstablishedSubscription> {
        if (!online) throw unavailable();
        if (!advertises(method)) throw new PluginUiHostApiClientError('unsupported_method', `Host method ${method} is unavailable.`);
        if (signal?.aborted) throw new PluginUiHostApiClientError('aborted');
        const subscriptionId = nextSubscriptionId();
        const requestId = nextRequestId();
        const record: SubscriptionRecord = { method, deliver, admitted: false, retired: false, buffered: [] };
        subscriptions.set(subscriptionId, record);
        let abandoned = false;
        let establishment: JsonValue | undefined;
        try {
            establishment = await settleWithHost({
                method,
                requestId,
                ...(signal ? { signal } : {}),
                envelope: { wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1, kind: 'subscribe', identity: options.identity, requestId, subscriptionId, method, ...(payload === undefined ? {} : { payload }) },
                onAbandon: () => { abandoned = true; },
            });
        } catch (error) {
            // A host rejection means nothing was admitted; an abandoned
            // establishment may still be admitted late, so it is retired at the
            // host as well. Either way no disposable is produced.
            retireSubscription(subscriptionId, record, abandoned);
            throw error;
        }
        record.admitted = true;
        const buffered = record.buffered.splice(0, record.buffered.length);
        for (const event of buffered) {
            if (record.retired) break;
            deliverSubscriptionEvent(subscriptionId, record, event);
        }
        let disposed = false;
        return Object.freeze({ subscriptionId, establishment, dispose: () => {
            if (disposed) return;
            disposed = true;
            retireSubscription(subscriptionId, record);
        } });
    }
    /**
     * A malformed event terminates THAT subscription with one diagnostic; an
     * author listener exception is isolated and diagnosed, and never corrupts
     * the registry or terminates delivery.
     */
    function deliverSubscriptionEvent(subscriptionId: string, record: SubscriptionRecord, event: JsonValue): void {
        try {
            record.deliver(event, subscriptionId);
        } catch (error) {
            const code = error instanceof PluginUiHostApiClientError ? error.code : 'listener_failed';
            if (error instanceof PluginUiHostApiClientError) retireSubscription(subscriptionId, record);
            void request('diagnostic', diagnosticToJson({
                code: `plugin_ui_subscription_${code}`,
                severity: 'error',
                message: `Plugin UI ${record.method} subscription event was not delivered.`,
            })).catch(() => undefined);
        }
    }

    const initial = negotiated;
    // Hosted-web and injected-native contexts have the same one live snapshot
    // contract: a validated context watch event replaces the negotiated value
    // before it reaches its listener. A direct host read replaces that same
    // value too, so retiring the final watch listener cannot freeze later
    // `context()` calls. The host remains the producer and currentness owner.
    let currentSurface = initial.surface;
    const api = {
        version: () => initial.version,
        publishCurrentUiContext: (enrichment) => {
            const payload = PluginUiPublishCurrentUiContextRequestV1Schema.safeParse({ enrichment });
            if (!payload.success) {
                throw new PluginUiHostApiClientError(
                    'invalid_payload',
                    'Current UI context enrichment is invalid.',
                );
            }
            void request('publishCurrentUiContext', payload.data).catch(() => undefined);
        },
        context: async (requestOptions) => {
            const result = await request('context', undefined, requestOptions?.signal);
            if (result === undefined) {
                throw new PluginUiHostApiClientError('invalid_payload', 'Host context response is missing.');
            }
            const next = readRenderContextSnapshot(result);
            currentSurface = next.surface;
            options.onContextActivity?.(next.activity);
            return next.surface;
        },
        watchContext: async (listener, requestOptions) => {
            const subscription = await subscribe(
                'watchContext',
                undefined,
                (value) => {
                    const next = readRenderContextSnapshot(value);
                    currentSurface = next.surface;
                    options.onContextActivity?.(next.activity);
                    listener(next.surface);
                },
                requestOptions?.signal,
            );
            return Object.freeze({ dispose: subscription.dispose });
        },
        // The public interface carries typed overloads for host ActionSpecs; the
        // transport is uniform, so it implements the general JSON signature once.
        executeAction: (async (
            action: PluginReference,
            input?: JsonValue,
            requestOptions?: PluginUiActionExecutionOptions,
        ) => {
            const explicitSelectedActionInput = requestOptions?.selectedActionInput;
            const selectedActionInput = explicitSelectedActionInput === undefined
                ? (typeof action === 'object' && action !== null
                    ? selectedOperationByAction.get(action)
                    : undefined)
                : (() => {
                    const parsed = PluginUiSelectedActionInputCarrierV1Schema.safeParse(
                        explicitSelectedActionInput,
                    );
                    return parsed.success ? parsed.data : undefined;
                })();
            if (explicitSelectedActionInput !== undefined && !selectedActionInput) {
                return Promise.reject(new PluginUiHostApiClientError(
                    'invalid_payload',
                    'Selected Action input is invalid.',
                ));
            }
            // This is a closed mounted-host request fact, not an author API
            // option. A plugin cannot gain authority by asserting it: only an
            // exact host-selected carrier can make it onto the strict wire arm.
            const consumeSelectedActionInput = (
                requestOptions as (PluginUiActionExecutionOptions & Readonly<{
                    consumeSelectedActionInput?: unknown;
                }>) | undefined
            )?.consumeSelectedActionInput === true;
            if (consumeSelectedActionInput && !selectedActionInput) {
                return Promise.reject(new PluginUiHostApiClientError(
                    'invalid_payload',
                    'Selected Action input is required for terminal consumption.',
                ));
            }
            return (await request(
                'executeAction',
                createExecuteActionRequest(action, input),
                requestOptions?.signal,
                selectedActionInput,
                consumeSelectedActionInput ? true : undefined,
            )) ?? null;
        }
        ) as PluginUiHostApi['executeAction'],
        selectActionInput: async (selectionRequest, requestOptions) => {
            const payload = PluginUiSelectActionInputRequestV1Schema.safeParse(selectionRequest);
            if (!payload.success) {
                throw new PluginUiHostApiClientError(
                    'invalid_payload',
                    'selectActionInput request is invalid.',
                );
            }
            let selectionRequestId: string | undefined;
            const result = PluginUiSelectActionInputResultV1Schema.safeParse(await request(
                'selectActionInput',
                payload.data,
                requestOptions?.signal,
                undefined,
                undefined,
                (requestId) => { selectionRequestId = requestId; },
            ));
            if (!result.success) {
                throw new PluginUiHostApiClientError(
                    'invalid_payload',
                    'Host returned an invalid selectActionInput result.',
                );
            }
            if (result.data.kind === 'submitted' && 'operation' in payload.data) {
                const retainedResult = PluginUiSelectActionInputResultV1Schema.parse(
                    JSON.parse(JSON.stringify(result.data)),
                );
                if (retainedResult.kind !== 'submitted') {
                    throw new PluginUiHostApiClientError(
                        'invalid_payload',
                        'Host returned an invalid selectActionInput result.',
                    );
                }
                const selectedActionInput = Object.freeze({
                    operation: payload.data.operation,
                    result: retainedResult,
                });
                selectedOperationByAction.set(result.data.action, selectedActionInput);
                // `settleWithHost` correctly removes its in-flight abort
                // listener when the select request answers. The selected
                // settlement remains active after that answer, though, so its
                // original mount/account lifetime must still retire the exact
                // host entry. The request id is already the host's one
                // correlation key; no second selection registry is created.
                if (requestOptions?.signal && selectionRequestId !== undefined) {
                    const admittedSelectionRequestId = selectionRequestId;
                    const cancelSelection = () => send({
                        wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
                        kind: 'cancel',
                        identity: options.identity,
                        requestId: admittedSelectionRequestId,
                    });
                    if (requestOptions.signal.aborted) cancelSelection();
                    else requestOptions.signal.addEventListener('abort', cancelSelection, { once: true });
                }
            }
            return result.data;
        },
        readResource: async (resource, requestOptions): Promise<ResourceContent> => {
            const result = requireRecord(await request('readResource', { resource: asJsonReference(resource) }, requestOptions?.signal), 'resource result');
            requireExactKeys(result, ['contentType', 'digest', 'bytesBase64'], 'resource result');
            if (typeof result.contentType !== 'string' || result.contentType.trim() === '' || typeof result.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(result.digest) || typeof result.bytesBase64 !== 'string') throw new PluginUiHostApiClientError('invalid_payload');
            return { contentType: result.contentType, digest: result.digest, bytes: decodeBase64(result.bytesBase64) };
        },
        statOpenableContent: async (ref, requestOptions): Promise<OpenableContentStatResult> => (
            readOpenableContentStatResult(await request(
                'statOpenableContent',
                { ref: openableContentRefToJson(ref) },
                requestOptions?.signal,
            ))
        ),
        readOpenableContent: async (
            openableRequest: OpenableContentReadRequest,
            requestOptions,
        ): Promise<OpenableContentReadResult> => (
            readOpenableContentReadResult(await request(
                'readOpenableContent',
                {
                    ref: openableContentRefToJson(openableRequest.ref),
                    expectedRevision: openableRequest.expectedRevision,
                    ...(openableRequest.maxBytes === undefined ? {} : { maxBytes: openableRequest.maxBytes }),
                },
                requestOptions?.signal,
            ))
        ),
        watchResource: async (resource, listener, requestOptions) => {
            const subscription = await subscribe(
                'watchResource',
                { resource: asJsonReference(resource) },
                (value, subscriptionId) => listener(readResourceSubscriptionEvent(value, subscriptionId)),
                requestOptions?.signal,
            );
            const admittedDigest = readResourceWatchAdmittedDigest(
                subscription.establishment,
                subscription.subscriptionId,
            );
            return Object.freeze({
                dispose: subscription.dispose,
                ...(admittedDigest === undefined ? {} : { admittedDigest }),
            });
        },
        activeComposer: async (requestOptions) => (
            readActiveComposerResult(await request(
                'activeComposer',
                undefined,
                requestOptions?.signal,
            ))
        ),
        readComposer: async (ref, requestOptions): Promise<ComposerReadResultV1> => {
            const payload = PluginUiReadComposerRequestV1Schema.safeParse({ ref });
            if (!payload.success) {
                throw new PluginUiHostApiClientError(
                    'invalid_payload',
                    'readComposer request is invalid.',
                );
            }
            return readComposerReadResult(await request(
                'readComposer',
                payload.data,
                requestOptions?.signal,
            ));
        },
        watchComposer: async (ref, listener, requestOptions) => {
            const payload = PluginUiWatchComposerRequestV1Schema.safeParse({ ref });
            if (!payload.success) {
                throw new PluginUiHostApiClientError(
                    'invalid_payload',
                    'watchComposer request is invalid.',
                );
            }
            const subscription = await subscribe(
                'watchComposer',
                payload.data,
                (value) => listener(readComposerSnapshot(value)),
                requestOptions?.signal,
            );
            return Object.freeze({ dispose: subscription.dispose });
        },
        applyComposer: async (ref, transaction, requestOptions): Promise<ComposerTransactionResultV1> => {
            const payload = PluginUiApplyComposerRequestV1Schema.safeParse({ ref, transaction });
            if (!payload.success) {
                throw new PluginUiHostApiClientError(
                    'invalid_payload',
                    'applyComposer request is invalid.',
                );
            }
            return readComposerTransactionResult(await request(
                'applyComposer',
                requireTransportJsonObject(payload.data, 'applyComposer request'),
                requestOptions?.signal,
            ));
        },
        focusComposer: async (ref, requestOptions): Promise<ComposerFocusResultV1> => {
            const payload = PluginUiFocusComposerRequestV1Schema.safeParse({ ref });
            if (!payload.success) {
                throw new PluginUiHostApiClientError(
                    'invalid_payload',
                    'focusComposer request is invalid.',
                );
            }
            return readComposerFocusResult(await request(
                'focusComposer',
                payload.data,
                requestOptions?.signal,
            ));
        },
        setComposerDecorations: async (ref, key, decorations, requestOptions): Promise<ComposerDecorationResultV1> => {
            const payload = PluginUiSetComposerDecorationsRequestV1Schema.safeParse({
                ref,
                key,
                decorations,
            });
            if (!payload.success) {
                throw new PluginUiHostApiClientError(
                    'invalid_payload',
                    'setComposerDecorations request is invalid.',
                );
            }
            return readComposerDecorationResult(await request(
                'setComposerDecorations',
                payload.data,
                requestOptions?.signal,
            ));
        },
        acquireComposerInputLock: async (ref, lockRequest, requestOptions) => {
            const payload = PluginUiAcquireComposerInputLockRequestV1Schema.safeParse({
                ref,
                request: lockRequest,
            });
            if (!payload.success) {
                throw new PluginUiHostApiClientError(
                    'invalid_payload',
                    'acquireComposerInputLock request is invalid.',
                );
            }
            const subscription = await subscribe(
                'acquireComposerInputLock',
                payload.data,
                () => {
                    throw new PluginUiHostApiClientError(
                        'invalid_payload',
                        'A Composer input lock must not emit subscription events.',
                    );
                },
                requestOptions?.signal,
            );
            return Object.freeze({ dispose: subscription.dispose });
        },
        pickComposerMedia: async (
            ref,
            mediaRequest: ComposerContentPickMediaRequestV1,
            requestOptions,
        ): Promise<ComposerContentHandleV1> => {
            const payload = PluginUiPickComposerMediaRequestV1Schema.safeParse({
                ref,
                request: mediaRequest,
            });
            if (!payload.success) {
                throw new PluginUiHostApiClientError(
                    'invalid_payload',
                    'pickComposerMedia request is invalid.',
                );
            }
            return readComposerContentHandle(await request(
                'pickComposerMedia',
                payload.data,
                requestOptions?.signal,
            ));
        },
        inspectComposerContent: async (
            handle,
            inspectRequest: ComposerContentInspectRequestV1,
            requestOptions,
        ): Promise<ComposerContentInspectResultV1> => {
            const payload = PluginUiInspectComposerContentRequestV1Schema.safeParse({
                handle,
                request: inspectRequest,
            });
            if (!payload.success) {
                throw new PluginUiHostApiClientError(
                    'invalid_payload',
                    'inspectComposerContent request is invalid.',
                );
            }
            return readComposerContentInspection(await request(
                'inspectComposerContent',
                payload.data,
                requestOptions?.signal,
            ));
        },
        releaseComposerContent: async (handle, requestOptions): Promise<void> => {
            const payload = PluginUiReleaseComposerContentRequestV1Schema.safeParse({ handle });
            if (!payload.success) {
                throw new PluginUiHostApiClientError(
                    'invalid_payload',
                    'releaseComposerContent request is invalid.',
                );
            }
            await request('releaseComposerContent', payload.data, requestOptions?.signal);
        },
        // `destination`, `subPath`, and `instanceKey` all ride the one mounted
        // open request. The Protocol schema remains the owner of its bounded
        // values; this client only binds a bare local id to its own plugin. A
        // qualified destination stays intact for the host Surface Registry.
        openSurface: async (view, input, requestOptions) => {
            const destination = normalizePluginSurfaceDestination(view, options.identity.pluginId);
            await request('openSurface', {
                destination,
                ...(input === undefined ? {} : { input }),
                ...(requestOptions?.subPath === undefined ? {} : { subPath: requestOptions.subPath }),
                ...(requestOptions?.instanceKey === undefined ? {} : { instanceKey: requestOptions.instanceKey }),
            }, requestOptions?.signal);
        },
        // The page's own location, replaced in place. The request schema is the
        // sole normalizer and bound: an illegal or over-long location is
        // refused HERE rather than sent, so a page can never make the host
        // decide whether an escape attempt is a route.
        replacePageLocation: async (subPath, replaceOptions) => {
            const payload = PluginUiReplacePageLocationRequestV1Schema.safeParse({
                subPath,
                ...(replaceOptions?.backLocation === undefined
                    ? {}
                    : { backLocation: replaceOptions.backLocation }),
            });
            if (!payload.success) {
                throw new PluginUiHostApiClientError(
                    'invalid_payload',
                    'replacePageLocation request is invalid.',
                );
            }
            const settled = PluginUiReplacePageLocationResultV1Schema.safeParse(
                await request('replacePageLocation', payload.data, replaceOptions?.signal),
            );
            if (!settled.success) {
                throw new PluginUiHostApiClientError(
                    'invalid_payload',
                    'replacePageLocation result is invalid.',
                );
            }
            return Object.freeze(settled.data);
        },
        notify: async (message, notifyOptions) => { await request('notify', { message, ...(notifyOptions?.severity === undefined ? {} : { severity: notifyOptions.severity }) }, notifyOptions?.signal); },
        confirm: async (message, confirmOptions) => {
            const result = requireRecord(await request('confirm', { message, ...(confirmOptions?.title === undefined ? {} : { title: confirmOptions.title }) }, confirmOptions?.signal), 'confirm result');
            requireExactKeys(result, ['confirmed'], 'confirm result');
            if (typeof result.confirmed !== 'boolean') throw new PluginUiHostApiClientError('invalid_payload');
            return result.confirmed;
        },
        diagnostic: (data) => { void request('diagnostic', diagnosticToJson(data)).catch(() => undefined); },
        readClipboard: async (requestOptions) => {
            const result = requireRecord(await request('readClipboard', undefined, requestOptions?.signal), 'clipboard result');
            if (typeof result.value !== 'string') throw new PluginUiHostApiClientError('invalid_payload');
            return result.value;
        },
        writeClipboard: async (value, requestOptions) => { await request('writeClipboard', { value }, requestOptions?.signal); },
        openExternalLink: async (url, requestOptions) => { await request('openExternalLink', { url }, requestOptions?.signal); },
    } satisfies PluginUiHostApi;
    return api;
}
