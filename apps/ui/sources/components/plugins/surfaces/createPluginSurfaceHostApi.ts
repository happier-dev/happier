import {
    PLUGIN_UI_HOST_METHODS_V1,
    PluginUiHostMethodV1Schema,
    PluginUiSurfaceContextV1Schema,
    type PluginUiHostApiErrorCodeV1,
    type PluginUiHostApiRequestMethodV1,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiHostMethodV1,
    type PluginUiJsonValueV1,
    type PluginUiSurfaceContextV1,
    type PluginUiSelectActionInputResultV1,
    type PluginUiTargetedContributionOperationV1,
} from '@happier-dev/protocol/plugins/ui';

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
    signal?: AbortSignal;
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

function errorPayload(
    code: PluginUiHostApiErrorCodeV1,
    diagnostics: readonly string[] = [],
): PluginUiJsonValueV1 {
    return { code, diagnostics: [...diagnostics] };
}

export type CreatePluginSurfaceHostApiInput = Readonly<{
    surfaceContext: PluginUiSurfaceContextV1;
    handlers?: PluginSurfaceHostApiHandlers;
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
        errorPayload('invalid_payload', diagnostics);
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
    const handlers = input.handlers ?? {};
    const installedMethods = resolveInstalledPluginSurfaceHostMethods(handlers);
    const isMethodAvailable = input.isMethodAvailable;
    const resolveLiveInstalledMethods = (): readonly PluginUiHostMethodV1[] => {
        // A retired mount cannot serve even its locally synthesized context.
        // Keep the advertised set aligned with the same currentness predicate
        // that rejects a request below; otherwise a consumer could negotiate a
        // stale method that the only request owner must refuse.
        if (input.isCurrent?.() === false) return Object.freeze([]);
        if (!isMethodAvailable) return installedMethods;
        return Object.freeze(installedMethods.filter((method) => isMethodAvailable(method)));
    };
    const onDispose = input.onDispose;
    let disposed = false;

    return Object.freeze({
        platform: surfaceContext.platform,
        channel: surfaceContext.channel,
        get installedMethods(): readonly PluginUiHostMethodV1[] {
            return resolveLiveInstalledMethods();
        },
        get admissionMethods(): readonly PluginUiHostMethodV1[] {
            return input.isCurrent?.() === false ? Object.freeze([]) : installedMethods;
        },
        ...(onDispose
            ? {
                dispose: (): void => {
                    if (disposed) return;
                    disposed = true;
                    onDispose();
                },
            }
            : {}),
        handleRequest: (
            request: PluginUiHostApiRequestEnvelopeV1,
            options?: PluginSurfaceHostApiRequestOptions,
        ): PluginUiJsonValueV1 | Promise<PluginUiJsonValueV1> => {
            if (input.isCurrent?.() === false) {
                return errorPayload('stale_surface', ['plugin_surface_retired']);
            }
            const releasedMethod = PluginUiHostMethodV1Schema.safeParse(request.method);
            if (releasedMethod.success && !resolveLiveInstalledMethods().includes(releasedMethod.data)) {
                return errorPayload('unsupported_method', [`host_api_method_not_installed:${request.method}`]);
            }
            if (request.method === 'context') return surfaceContext;

            const handler = handlers[request.method];
            if (handler) return handler(request, options);
            if (input.fallback) return input.fallback(request, options);
            return errorPayload('unsupported_method', [`host_api_method_not_installed:${request.method}`]);
        },
    });
}
