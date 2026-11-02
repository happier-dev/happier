import {
    PLUGIN_UI_HOST_METHODS_V1,
    PluginUiHostMethodV1Schema,
    PluginUiHostApiErrorPayloadV1Schema,
    PluginUiHostApiResponseEnvelopeV1Schema,
    PluginUiSurfaceContextV1Schema,
    type PluginUiHostApiErrorPayloadV1,
    type PluginUiHostApiRequestMethodV1,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiHostApiResponseEnvelopeV1,
    type PluginUiHostMethodV1,
    type PluginUiJsonValueV1,
    type PluginUiSurfaceContextV1,
    type PluginUiSelectActionInputResultV1,
    type PluginUiTargetedContributionOperationV1,
} from '@happier-dev/protocol/plugins/ui';
import { isPluginError, type PluginErrorData } from '@happier-dev/plugin-sdk';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy/resolveReasonCopy';

/**
 * The CALLER's cancellation for one in-flight request (§3.4).
 *
 * The request envelope is JSON and carries a request, not a lifetime, so the
 * author's `PluginCancellationOptions` signal reaches the mount beside it rather
 * than inside it. Every transport that can observe a caller withdrawing a
 * request — the React Native adapter directly, the hosted-web bridge through its
 * `cancel` wire message — passes it here, so cancellation has ONE in-process
 * mechanism instead of one per transport.
 *
 * A handler that owns nothing cancellable ignores it. A handler holding
 * something in front of the user (the confirmation dialog) must retire it, and
 * must not report the withdrawal as a user decision.
 */
export type PluginSurfaceHostApiRequestOptions = Readonly<{
    /** The existing subscription carrier owns delivery and release, never author JSON. */
    entityDragDropSubscription?: Readonly<{
        publish: (state: import('@happier-dev/protocol/plugins/ui').PluginUiEntityDragDropStateV1) => void;
        retain: (release: () => void) => void;
    }>;
    signal?: AbortSignal;
    /** Physical iframe/WebView embedding, measured by its host rather than authored JSON. */
    getHostedFrameBounds?: () => Promise<import('@/components/ui/treeDragDrop/treeDragDropTypes').WindowBounds | null>;
    /** Host-private one-use proof minted by the exact physical frame. */
    consumeHostTransientActivation?: () => boolean;
    /**
     * Host-private admission handle retained only from an exact target-scoped
     * form selection. It is never decoded from a public action payload.
     */
    targetedOperation?: PluginUiTargetedContributionOperationV1;
    /**
     * The complete host-selected settlement retained beside the exact admitted
     * operation. It never comes from an author Action payload; the hosted/RN
     * transports restore it only after their private selected-operation lookup.
     */
    selectedActionInput?: Extract<
        PluginUiSelectActionInputResultV1,
        Readonly<{ kind: 'submitted' }>
    >;
}>;

export type PluginSurfaceHostApiV1 = Readonly<{
    platform: PluginUiSurfaceContextV1['platform'];
    channel: PluginUiSurfaceContextV1['channel'];
    /**
     * The host-method set this mount can actually serve (UI-D02). Derived from
     * the installed handlers plus the locally answered `context`; never a
     * constant, so a mount that installs nothing advertises nothing.
     */
    installedMethods: readonly PluginUiHostMethodV1[];
    /**
     * The current mount's structurally installed method set for renderer
     * admission. It is stable across transient availability changes, but clears
     * when the mount retires so a stale surface cannot be admitted.
     */
    admissionMethods: readonly PluginUiHostMethodV1[];
    handleRequest: (
        request: PluginUiHostApiRequestEnvelopeV1,
        options?: PluginSurfaceHostApiRequestOptions,
    ) => PluginUiJsonValueV1 | Promise<PluginUiJsonValueV1>;
    /** Physical host readiness committed; resume calls held by this same facade. */
    notifyConnectionSettled?: () => void;
    /** Host-private pre-invocation admission; nested Actions share this facade's waiter. */
    waitForConnectionSettlement?: (
        error: PluginUiHostApiErrorPayloadV1,
        request: PluginUiHostApiRequestEnvelopeV1,
        options?: PluginSurfaceHostApiRequestOptions,
    ) => Promise<void> | null;
    /**
     * Retire whatever the installed handlers put in front of the user (§3.4:
     * feedback and confirmation retire with the surface). Idempotent, and absent
     * when nothing installed here owns user-visible state.
     */
    dispose?: () => void;
}>;

export type PluginSurfaceHostApiMethodHandler = (
    request: PluginUiHostApiRequestEnvelopeV1,
    options?: PluginSurfaceHostApiRequestOptions,
) => PluginUiJsonValueV1 | Promise<PluginUiJsonValueV1>;

/**
 * `context` is answered by this factory from the parsed surface context, so it is
 * the one request method a mount never installs. Every other member of the single
 * canonical vocabulary (`PLUGIN_UI_HOST_METHODS_V1` plus the transport-only
 * operations) is installable.
 */
export type PluginSurfaceHostApiHandlers = Partial<
    Record<
        Exclude<PluginUiHostApiRequestMethodV1, 'context'>,
        PluginSurfaceHostApiMethodHandler
    >
>;

/**
 * `handleRequest` is an incumbent host-local raw-JSON seam: declarative
 * controls consume its result directly, while both physical transports settle
 * it below. Keep host failures ordinary strict JSON at that seam, but retain
 * their local producer identity until the one shared settlement point. This
 * lexical WeakMap never serializes or crosses a bundle/transport boundary, so
 * an Action result is always classified by provenance rather than its JSON
 * members (including a domain `{ code: 'timeout' }`).
 */
const pluginSurfaceHostApiErrorPayloads = new WeakMap<object, Readonly<{
    payload: PluginUiHostApiErrorPayloadV1;
    connectionPendingEligible: boolean;
}>>();

/**
 * Creates a host-owned raw failure for direct host-local consumers. Its
 * identity is retained only until the shared physical-transport settlement
 * below; the returned value itself remains ordinary strict JSON.
 */
export function createPluginSurfaceHostApiError(
    code: string,
    diagnostics: readonly string[] = [],
    message?: string,
    options?: Readonly<{ connectionPendingEligible?: boolean }> & Pick<PluginUiHostApiErrorPayloadV1, 'layer' | 'phase' | 'retryable'>,
): PluginUiJsonValueV1 {
    const writtenMessage = message ?? (options?.layer ? resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: code }).body : undefined);
    const payload = PluginUiHostApiErrorPayloadV1Schema.parse({
        code,
        ...(options?.layer === undefined ? {} : { layer: options.layer }),
        ...(options?.phase === undefined ? {} : { phase: options.phase }),
        ...(options?.retryable === undefined ? {} : { retryable: options.retryable }),
        ...(writtenMessage === undefined ? {} : { message: writtenMessage }),
        diagnostics: diagnostics.flatMap((diagnostic) => {
            const normalized = diagnostic.trim();
            return normalized.length > 0 ? [normalized] : [];
        }),
    });
    const result = Object.freeze({
        ...payload,
        diagnostics: Object.freeze([...payload.diagnostics]),
    }) satisfies PluginUiJsonValueV1;
    pluginSurfaceHostApiErrorPayloads.set(result, { payload, connectionPendingEligible: options?.connectionPendingEligible === true });
    return result;
}

/**
 * Projects the shared mounted-host failure vocabulary to the one public SDK
 * exception shape consumed by both physical transports.
 */
export function createPluginSurfaceHostApiPluginErrorData(
    code: string,
    diagnostics: readonly string[] = [],
    message?: string,
    metadata?: Pick<PluginUiHostApiErrorPayloadV1, 'layer' | 'phase' | 'retryable'>,
): PluginErrorData {
    return {
        name: 'PluginError',
        code,
        ...(message === undefined ? {} : { message }),
        // A coarse wrapper code says nothing about whether an effect entered.
        retryable: metadata?.retryable ?? false,
        ...(metadata && (metadata.layer !== undefined || metadata.phase !== undefined) ? { details: {
            ...(metadata.layer === undefined ? {} : { layer: metadata.layer }),
            ...(metadata.phase === undefined ? {} : { phase: metadata.phase }),
        } } : {}),
        ...(diagnostics.length === 0
            ? {}
            : {
                diagnostics: diagnostics.map((diagnostic) => ({
                    code: diagnostic,
                    severity: 'error' as const,
                })),
            }),
    };
}

/** Read only the closed failure metadata from the incumbent SDK details seam. */
export function readPluginSurfaceHostApiFailureMetadata(
    details: unknown,
): Pick<PluginUiHostApiErrorPayloadV1, 'layer' | 'phase'> {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
    const layer = PluginUiHostApiErrorPayloadV1Schema.shape.layer.safeParse(Reflect.get(details, 'layer'));
    const phase = PluginUiHostApiErrorPayloadV1Schema.shape.phase.safeParse(Reflect.get(details, 'phase'));
    return {
        ...(layer.success && layer.data !== undefined ? { layer: layer.data } : {}),
        ...(phase.success && phase.data !== undefined ? { phase: phase.data } : {}),
    };
}

export function readPluginSurfaceHostApiErrorPayload(
    value: unknown,
): PluginUiHostApiErrorPayloadV1 | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return pluginSurfaceHostApiErrorPayloads.get(value)?.payload ?? null;
}

/**
 * Converts one mounted-host settlement into the Protocol-owned response
 * envelope. Both physical transports consume this single boundary, so a
 * plugin Action result is never classified from the shape of its JSON.
 */
export async function settlePluginSurfaceHostApiRequest(
    request: PluginUiHostApiRequestEnvelopeV1,
    invoke: () => PluginUiJsonValueV1 | Promise<PluginUiJsonValueV1>,
): Promise<PluginUiHostApiResponseEnvelopeV1> {
    const base = {
        version: 1 as const,
        requestId: request.requestId,
        surface: request.surface,
        method: request.method,
    };
    try {
        const payload = await invoke();
        const error = readPluginSurfaceHostApiErrorPayload(payload);
        return PluginUiHostApiResponseEnvelopeV1Schema.parse(error
            ? { ...base, kind: 'error' as const, payload: error }
            : { ...base, kind: 'result' as const, payload });
    } catch (error) {
        if (isPluginError(error)) {
            return PluginUiHostApiResponseEnvelopeV1Schema.parse({ ...base, kind: 'error', payload: {
                code: error.code, message: error.message, retryable: error.retryable,
                ...readPluginSurfaceHostApiFailureMetadata(error.details),
                diagnostics: error.diagnostics?.map(diagnostic => diagnostic.code) ?? [],
            } });
        }
        const aborted = error !== null && typeof error === 'object'
            && 'name' in error && error.name === 'AbortError';
        return PluginUiHostApiResponseEnvelopeV1Schema.parse({
            ...base,
            kind: 'error',
            payload: aborted ? {
                code: 'unavailable',
                diagnostics: ['plugin_ui_invocation_aborted'],
            } : {
                code: 'internal_error',
                diagnostics: ['host_api_handler_failed'],
            },
        });
    }
}

export type CreatePluginSurfaceHostApiInput = Readonly<{
    surfaceContext: PluginUiSurfaceContextV1;
    handlers?: PluginSurfaceHostApiHandlers;
    /** Mounted semantic bundles may change without withdrawing the physical caller. */
    readHandlers?: () => PluginSurfaceHostApiHandlers;
    /** Controller-projected host support whose execution binding may be unavailable. */
    admissionMethods?: readonly PluginUiHostMethodV1[];
    fallback?: PluginSurfaceHostApiMethodHandler;
    /**
     * The bound controller's mount predicate. This factory only consumes it at
     * the request facade; it never creates a second lifecycle/epoch owner.
     */
    isCurrent?: () => boolean;
    /**
     * A controller-owned live capability predicate. It can narrow an otherwise
     * installed method during an environment refresh without replacing the
     * mount, its public adapter, or its cancellation lifetime.
     */
    isMethodAvailable?: (method: PluginUiHostMethodV1) => boolean;
    /** Host-private context for an existing provenance-tagged unavailable result. */
    resolveUnavailableError?: (error: PluginUiHostApiErrorPayloadV1, request: PluginUiHostApiRequestEnvelopeV1) => PluginUiHostApiErrorPayloadV1 | undefined;
    /** Positive host readiness observation; unrelated or settled refusals remain terminal. */
    isConnectionPending?: (error: PluginUiHostApiErrorPayloadV1, request: PluginUiHostApiRequestEnvelopeV1) => boolean;
    /** Called once when the mount retires this host API. */
    onDispose?: () => void;
}>;

/**
 * The factual installed set for a mount (UI-D02): `context`, answered here from
 * the validated snapshot, plus every canonical method carrying an installed
 * handler. Transport-only operations are never advertised, and `fallback` is
 * deliberately not counted — it types an unhandled method as unavailable, it
 * does not install one.
 */
export function resolveInstalledPluginSurfaceHostMethods(
    handlers: PluginSurfaceHostApiHandlers,
): readonly PluginUiHostMethodV1[] {
    return Object.freeze(PLUGIN_UI_HOST_METHODS_V1.filter(
        (method) => method === 'context' || handlers[method] !== undefined,
    ));
}

function createDisabledPluginSurfaceHostApi(
    diagnostics: readonly string[],
): PluginSurfaceHostApiV1 {
    const failClosed = (): PluginUiJsonValueV1 =>
        createPluginSurfaceHostApiError('invalid_payload', diagnostics);
    return Object.freeze({
        platform: 'web',
        channel: 'store',
        // Without a valid surface snapshot not even `context` is installed.
        installedMethods: Object.freeze([]),
        admissionMethods: Object.freeze([]),
        handleRequest: failClosed,
    });
}

/** Host-only Protocol adapter. Author code consumes PluginUiHostApi from plugin-sdk/ui. */
export function createPluginSurfaceHostApi(
    input: CreatePluginSurfaceHostApiInput,
): PluginSurfaceHostApiV1 {
    const parsedContext = PluginUiSurfaceContextV1Schema.safeParse(input.surfaceContext);
    if (!parsedContext.success) {
        return createDisabledPluginSurfaceHostApi([
            'host_api_surface_context_invalid',
            ...parsedContext.error.issues.map(
                (issue) => `surface_context:${issue.path.join('.') || '<root>'}:${issue.code}`,
            ),
        ]);
    }
    const surfaceContext = parsedContext.data;
    const readHandlers = () => input.readHandlers?.() ?? input.handlers ?? {};
    const readInstalledMethods = () => resolveInstalledPluginSurfaceHostMethods(readHandlers());
    const readAdmissionMethods = () => {
        const installedMethods = readInstalledMethods();
        return Object.freeze(PLUGIN_UI_HOST_METHODS_V1.filter(method =>
            installedMethods.includes(method) || input.admissionMethods?.includes(method),
        ));
    };
    const isMethodAvailable = input.isMethodAvailable;
    let disposed = false;
    const connectionWaiters = new Set<() => void>();
    const waitForConnectionSettlement: NonNullable<PluginSurfaceHostApiV1['waitForConnectionSettlement']> = (error, request, options) => {
        if (input.isConnectionPending?.(error, request) !== true) return null;
        if (disposed || input.isCurrent?.() === false || options?.signal?.aborted) return Promise.resolve();
        return new Promise<void>(resolve => {
            const finish = () => {
                connectionWaiters.delete(resume);
                options?.signal?.removeEventListener('abort', finish);
                resolve();
            };
            const resume = () => {
                if (!disposed && input.isCurrent?.() !== false && input.isConnectionPending?.(error, request) === true) return;
                finish();
            };
            connectionWaiters.add(resume);
            options?.signal?.addEventListener('abort', finish, { once: true });
        });
    };
    const enrichUnavailable = (result: PluginUiJsonValueV1, request: PluginUiHostApiRequestEnvelopeV1,
        options?: PluginSurfaceHostApiRequestOptions): PluginUiJsonValueV1 | Promise<PluginUiJsonValueV1> => {
        const error = readPluginSurfaceHostApiErrorPayload(result);
        if (error?.code !== 'unavailable') return result;
        // An entered Action may report the same diagnostic as a cold daemon
        // gate. Only the dispatcher's exact pre-invocation signal permits
        // replay here; nested continuations wait below their entered caller.
        const eligible = request.method !== 'executeAction'
            || (result !== null && typeof result === 'object'
                && pluginSurfaceHostApiErrorPayloads.get(result)?.connectionPendingEligible === true);
        const pending = eligible ? waitForConnectionSettlement(error, request, options) : null;
        // Only the controller's positive, pre-invocation readiness refusal can
        // enter this wait. Domain results and settled outages stay terminal.
        // The physical host wakes it on connection settlement; no polling or
        // author-side retry can repeat an already-admitted effect.
        if (pending) {
            if (disposed || input.isCurrent?.() === false) {
                return createPluginSurfaceHostApiError('stale_surface', ['plugin_surface_retired']);
            }
            return pending.then(() => handleRequest(request, options));
        }
        const resolved = input.resolveUnavailableError?.(error, request) ?? error;
        return resolved === error ? result : createPluginSurfaceHostApiError(resolved.code, resolved.diagnostics, resolved.message, resolved);
    };
    const resolveLiveInstalledMethods = (): readonly PluginUiHostMethodV1[] => {
        // A retired mount cannot serve even its locally synthesized context.
        // Keep the advertised set aligned with the same currentness predicate
        // that rejects a request below; otherwise a consumer could negotiate a
        // stale method that the only request owner must refuse.
        if (disposed || input.isCurrent?.() === false) return Object.freeze([]);
        const installedMethods = readInstalledMethods();
        if (!isMethodAvailable) return installedMethods;
        return Object.freeze(installedMethods.filter((method) => isMethodAvailable(method)));
    };
    const onDispose = input.onDispose;
    function handleRequest(
        request: PluginUiHostApiRequestEnvelopeV1,
        options?: PluginSurfaceHostApiRequestOptions,
    ): PluginUiJsonValueV1 | Promise<PluginUiJsonValueV1> {
        if (disposed || input.isCurrent?.() === false) {
            return createPluginSurfaceHostApiError('stale_surface', ['plugin_surface_retired']);
        }
        if (options?.signal?.aborted) {
            return createPluginSurfaceHostApiError('unavailable', ['plugin_ui_invocation_aborted']);
        }
        const releasedMethod = PluginUiHostMethodV1Schema.safeParse(request.method);
        const handlers = readHandlers();
        // A request admits only its addressed method. Enumerating the full
        // live set repeats currentness and unrelated method admissions;
        // negotiation getters still read that complete set independently.
        if (releasedMethod.success && ((releasedMethod.data !== 'context' && handlers[releasedMethod.data] === undefined)
            || (isMethodAvailable !== undefined && !isMethodAvailable(releasedMethod.data)))) {
            // Structural absence and transient narrowing are different facts.
            // Keep the method admitted while its connection is pending; a
            // settled outage still returns the existing unavailable envelope.
            return readAdmissionMethods().includes(releasedMethod.data)
                ? enrichUnavailable(createPluginSurfaceHostApiError(
                    'unavailable',
                    [`host_api_method_unavailable:${request.method}`], undefined, { connectionPendingEligible: true },
                ), request, options)
                : createPluginSurfaceHostApiError(
                    'unsupported_method',
                    [`host_api_method_not_installed:${request.method}`],
                );
        }
        if (request.method === 'context') return surfaceContext;

        const handler = handlers[request.method];
        const invoke = handler ?? input.fallback;
        if (invoke) {
            const result = invoke(request, options);
            if (!input.resolveUnavailableError && !input.isConnectionPending) return result;
            return result instanceof Promise
                ? result.then(value => enrichUnavailable(value, request, options))
                : enrichUnavailable(result, request, options);
        }
        return createPluginSurfaceHostApiError(
            'unsupported_method',
            [`host_api_method_not_installed:${request.method}`],
        );
    }
    const notifyConnectionSettled = () => {
        for (const resume of [...connectionWaiters]) resume();
    };
    return Object.freeze({
        platform: surfaceContext.platform,
        channel: surfaceContext.channel,
        get installedMethods(): readonly PluginUiHostMethodV1[] { return resolveLiveInstalledMethods(); },
        get admissionMethods(): readonly PluginUiHostMethodV1[] {
            return disposed || input.isCurrent?.() === false ? Object.freeze([]) : readAdmissionMethods();
        },
        handleRequest,
        notifyConnectionSettled,
        waitForConnectionSettlement,
        dispose: (): void => {
            if (disposed) return;
            disposed = true;
            notifyConnectionSettled();
            onDispose?.();
        },
    });
}
