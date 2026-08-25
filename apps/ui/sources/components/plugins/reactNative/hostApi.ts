import {
    PLUGIN_UI_HOST_API_VERSION_V1,
    PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
    PluginUiExecuteActionRequestV1Schema,
    PluginUiAcquireComposerInputLockRequestV1Schema,
    PluginUiActiveComposerResultV1Schema,
    PluginUiApplyComposerRequestV1Schema,
    PluginUiFocusComposerRequestV1Schema,
    PluginUiInspectComposerContentRequestV1Schema,
    PluginUiInspectComposerContentResultV1Schema,
    PluginUiHostApiRequestMethodV1Schema,
    PluginUiHostApiRequestEnvelopeV1Schema,
    PluginUiJsonValueV1Schema,
    PluginUiArtifactDigestV1Schema,
    PluginUiDisposeHostResourceRequestV1Schema,
    PluginUiResourceSubscriptionRequestV1Schema,
    PluginUiReadComposerRequestV1Schema,
    PluginUiPickComposerMediaRequestV1Schema,
    PluginUiPickComposerMediaResultV1Schema,
    PluginUiPublishCurrentUiContextRequestV1Schema,
    PluginUiReleaseComposerContentRequestV1Schema,
    PluginUiReplacePageLocationRequestV1Schema,
    PluginUiReplacePageLocationResultV1Schema,
    PluginUiSetComposerDecorationsRequestV1Schema,
    PluginUiSelectActionInputRequestV1Schema,
    PluginUiSelectActionInputResultV1Schema,
    PluginUiSelectedActionInputCarrierV1Schema,
    PluginUiWatchComposerRequestV1Schema,
    ComposerDecorationResultV1Schema,
    ComposerFocusResultV1Schema,
    ComposerReadResultV1Schema,
    ComposerSnapshotV1Schema,
    ComposerTransactionResultV1Schema,
    pluginUiSelectedActionInputsEqual,
    pluginUiTargetedContributionOperationKey,
    type PluginUiHostApiErrorCodeV1,
    type PluginUiHostApiRequestMethodV1,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiHostMethodV1,
    type PluginUiJsonValueV1,
    type PluginUiResourceSubscriptionEventV1,
    type PluginUiResourceSubscriptionRequestV1,
    type PluginUiWatchComposerRequestV1,
    type PluginUiSurfaceContextV1,
    type PluginUiTargetedContributionOperationV1,
    type PluginUiSelectActionInputResultV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    OpenableContentReadResultV1Schema,
    OpenableContentStatResultV1Schema,
} from '@happier-dev/protocol';
import type {
    PluginUiHostApi,
    PluginUiActionExecutionOptions,
    ResourceContent,
    SurfaceContext,
    ComposerSnapshotV1,
} from '@happier-dev/plugin-sdk/ui';
import {
    PluginError,
    type JsonValue,
    type PluginCancellationOptions,
    type PluginReference,
} from '@happier-dev/plugin-sdk';

import { resolveNegotiatedPluginSurfaceHostApiMethods } from '../hostApi/negotiatedMethods';
import { createPluginUiHostSubscriptionRegistry } from '../hostApi/subscriptions';
import {
    createPluginSurfaceHostApiPluginErrorData,
    settlePluginSurfaceHostApiRequest,
    type PluginSurfaceHostApiRequestOptions,
} from '../surfaces/createPluginSurfaceHostApi';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { decodeBase64 } from '@/encryption/base64';

export type PluginReactNativeHostApiRequestHandler = (
    request: PluginUiHostApiRequestEnvelopeV1,
    options?: PluginSurfaceHostApiRequestOptions,
) => PluginUiJsonValueV1 | Promise<PluginUiJsonValueV1>;

type PluginReactNativeHostRequestSubscription = Readonly<{
    subscriptionId: string;
    /**
     * Host-private watch establishment fact. The public SDK Disposable remains
     * intentionally contentless; the mounted Resource store uses this only to
     * suppress a redundant read when its baseline already has these bytes.
     */
    admittedDigest?: string;
    dispose: () => Promise<void>;
}>;

/**
 * Host-private request transport for the canonical author API. Its
 * `requestSurface` is the controller dispatch envelope, not a public renderer
 * context or a second source of author-visible surface facts.
 */
type PluginReactNativeHostRequestTransport = Readonly<{
    request: (
        method: PluginUiHostApiRequestMethodV1,
        payload?: PluginUiJsonValueV1,
        options?: PluginSurfaceHostApiRequestOptions,
    ) => Promise<PluginUiJsonValueV1 | undefined>;
    watchResource: (
        payload: PluginUiResourceSubscriptionRequestV1,
        listener: (event: PluginUiResourceSubscriptionEventV1) => void,
        options?: PluginSurfaceHostApiRequestOptions,
    ) => Promise<PluginReactNativeHostRequestSubscription>;
    watchComposer: (
        payload: PluginUiWatchComposerRequestV1 & Readonly<{ subscriptionId: string }>,
        listener: (snapshot: ComposerSnapshotV1) => void,
        options?: PluginSurfaceHostApiRequestOptions,
    ) => Promise<PluginReactNativeHostRequestSubscription>;
    acquireComposerInputLock: (
        payload: PluginUiJsonValueV1 & Readonly<{ subscriptionId: string }>,
        options?: PluginSurfaceHostApiRequestOptions,
    ) => Promise<PluginReactNativeHostRequestSubscription>;
    publishSubscriptionEvent: (event: PluginUiResourceSubscriptionEventV1) => boolean;
    publishComposerSubscriptionEvent: (input: Readonly<{
        subscriptionId: string;
        snapshot: ComposerSnapshotV1;
    }>) => boolean;
    dispose: () => void;
}>;

function createHostApiError(
    code: PluginUiHostApiErrorCodeV1,
    diagnostics: readonly string[] = [],
): PluginError {
    return new PluginError(createPluginSurfaceHostApiPluginErrorData(code, diagnostics));
}

function throwHostApiError(
    code: PluginUiHostApiErrorCodeV1,
    diagnostics: readonly string[] = [],
): never {
    throw createHostApiError(code, diagnostics);
}

function createRequestEnvelope(input: Readonly<{
    requestId: string;
    surface: PluginUiSurfaceContextV1;
    method: PluginUiHostApiRequestMethodV1;
    payload?: PluginUiJsonValueV1;
}>): PluginUiHostApiRequestEnvelopeV1 {
    const envelope: PluginUiHostApiRequestEnvelopeV1 = {
        version: 1,
        requestId: input.requestId,
        surface: input.surface,
        method: input.method,
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
    };
    const parsed = PluginUiHostApiRequestEnvelopeV1Schema.safeParse(envelope);
    if (!parsed.success) {
        throwHostApiError('invalid_payload');
    }
    return envelope;
}

function readResourceWatchAdmittedDigest(
    value: PluginUiJsonValueV1 | undefined,
    subscriptionId: string,
): string | undefined {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
    if (record?.subscriptionId !== subscriptionId) return undefined;
    const digest = PluginUiArtifactDigestV1Schema.safeParse(record.digest);
    return digest.success ? digest.data : undefined;
}

function createPluginReactNativeHostRequestTransport(params: Readonly<{
    requestSurface: PluginUiSurfaceContextV1;
    requestIdPrefix: string;
    handleRequest: PluginReactNativeHostApiRequestHandler;
    isRequestSurfaceCurrent?: (surface: PluginUiSurfaceContextV1) => boolean;
    createRequestId?: () => string;
}>): PluginReactNativeHostRequestTransport {
    const resourceListeners = new Map<string, (event: PluginUiResourceSubscriptionEventV1) => void>();
    const settledResourceSubscriptionIds = new Set<string>();
    const composerListeners = new Map<string, (snapshot: ComposerSnapshotV1) => void>();
    const settledComposerSubscriptionIds = new Set<string>();
    let disposed = false;
    let sequence = 0;
    const createRequestId = params.createRequestId ?? (() => {
        sequence += 1;
        return `${params.requestIdPrefix}:${sequence}`;
    });
    const subscriptions = createPluginUiHostSubscriptionRegistry({
        deliverSubscriptionEvent: (event) => {
            resourceListeners.get(event.subscriptionId)?.(event);
        },
        deliverSubscriptionValue: ({ subscriptionId, value }) => {
            const parsed = ComposerSnapshotV1Schema.safeParse(value);
            if (parsed.success) composerListeners.get(subscriptionId)?.(parsed.data);
        },
    });

    function assertActive(): void {
        if (disposed || params.isRequestSurfaceCurrent?.(params.requestSurface) === false) {
            throwHostApiError('stale_surface');
        }
    }

    /**
     * The direct RN/RNW carrier has no cancellation wire. Caller withdrawal
     * therefore settles this carrier immediately, while the mounted handler
     * may finish its own work in the background. A response that wins first
     * stays authoritative; a later response after withdrawal is inert.
     */
    function settleWithCallerCancellation<T>(
        settlement: Promise<T>,
        signal: AbortSignal | undefined,
    ): Promise<T> {
        if (!signal) return settlement;
        if (signal.aborted) {
            return Promise.reject(createHostApiError('unavailable', ['aborted']));
        }
        let removeAbortListener: (() => void) | undefined;
        const cancellation = new Promise<never>((_resolve, reject) => {
            const onAbort = () => reject(createHostApiError('unavailable', ['aborted']));
            removeAbortListener = () => signal.removeEventListener('abort', onAbort);
            signal.addEventListener('abort', onAbort, { once: true });
        });
        return Promise.race([settlement, cancellation]).finally(() => {
            removeAbortListener?.();
        });
    }

    async function request(
        rawMethod: PluginUiHostApiRequestMethodV1,
        payload?: PluginUiJsonValueV1,
        options?: PluginSurfaceHostApiRequestOptions,
    ): Promise<PluginUiJsonValueV1 | undefined> {
        const parsedMethod = PluginUiHostApiRequestMethodV1Schema.safeParse(rawMethod);
        if (!parsedMethod.success) {
            throwHostApiError('unsupported_method');
        }
        const method = parsedMethod.data;
        if (method === 'context') {
            assertActive();
            return params.requestSurface;
        }
        assertActive();
        throwIfAborted(options?.signal);
        const envelope = createRequestEnvelope({
            requestId: createRequestId(),
            surface: params.requestSurface,
            method,
            ...(payload !== undefined ? { payload } : {}),
        });

        const response = await settleWithCallerCancellation(
            settlePluginSurfaceHostApiRequest(
                envelope,
                () => params.handleRequest(envelope, options),
            ),
            options?.signal,
        );
        if (response.kind === 'error') {
            throwHostApiError(response.payload.code, response.payload.diagnostics);
        }
        return response.payload;
    }

    async function disposeSettledHostResource(subscriptionId: string): Promise<void> {
        const disposePayload = PluginUiDisposeHostResourceRequestV1Schema.parse({
            subscriptionId,
        });
        const envelope = createRequestEnvelope({
            requestId: createRequestId(),
            surface: params.requestSurface,
            method: 'disposeHostResource',
            payload: disposePayload,
        });
        try {
            await params.handleRequest(envelope);
        } catch {
            // Surface retirement remains authoritative even when host cleanup fails.
        }
    }

    async function watchResource(
        payload: PluginUiResourceSubscriptionRequestV1,
        listener: (event: PluginUiResourceSubscriptionEventV1) => void,
        options?: PluginSurfaceHostApiRequestOptions,
    ): Promise<PluginReactNativeHostRequestSubscription> {
        const parsedPayload = PluginUiResourceSubscriptionRequestV1Schema.safeParse(payload);
        if (!parsedPayload.success) {
            throwHostApiError('invalid_payload');
        }
        const subscriptionId = parsedPayload.data.subscriptionId;
        // Register before opening the host watch. Its pump may publish as soon
        // as the daemon accepts the subscription; registering after awaiting
        // the response would silently drop that first invalidation.
        resourceListeners.set(subscriptionId, listener);
        subscriptions.register({
            surface: params.requestSurface,
            subscriptionId,
        });
        let locallyRetired = false;
        const retirePendingSubscription = () => {
            if (locallyRetired) return;
            locallyRetired = true;
            resourceListeners.delete(subscriptionId);
            settledResourceSubscriptionIds.delete(subscriptionId);
            subscriptions.dispose({
                surface: params.requestSurface,
                subscriptionId,
            });
        };
        if (options?.signal?.aborted) {
            retirePendingSubscription();
            throwHostApiError('unavailable', ['aborted']);
        }
        const abortSignal = options?.signal;
        let abandoned = false;
        let removeAbortListener: (() => void) | undefined;
        const abortPromise = abortSignal
            ? new Promise<never>((_resolve, reject) => {
                const onAbort = () => {
                    abandoned = true;
                    retirePendingSubscription();
                    reject(createHostApiError('unavailable', ['aborted']));
                };
                removeAbortListener = () => abortSignal.removeEventListener('abort', onAbort);
                abortSignal.addEventListener('abort', onAbort, { once: true });
            })
            : undefined;
        const establishment = request('watchResource', parsedPayload.data, options);
        let established: PluginUiJsonValueV1 | undefined;
        try {
            established = await (abortPromise
                ? Promise.race([establishment, abortPromise])
                : establishment);
        } catch (error) {
            removeAbortListener?.();
            retirePendingSubscription();
            if (abandoned) {
                // The caller's typed cancellation settles immediately. A host
                // that nevertheless admits this now-retired request is still
                // owed its exact subscription cleanup once that late ACK lands.
                void establishment.then(
                    () => disposeSettledHostResource(subscriptionId),
                    () => undefined,
                ).catch(() => undefined);
            }
            throw error;
        }
        removeAbortListener?.();
        const admittedDigest = readResourceWatchAdmittedDigest(
            established,
            subscriptionId,
        );
        if (
            disposed
            || params.isRequestSurfaceCurrent?.(params.requestSurface) === false
            || options?.signal?.aborted
        ) {
            retirePendingSubscription();
            await disposeSettledHostResource(subscriptionId);
            if (options?.signal?.aborted) {
                throwHostApiError('unavailable', ['aborted']);
            }
            throwHostApiError('stale_surface');
        }
        settledResourceSubscriptionIds.add(subscriptionId);

        return Object.freeze({
            subscriptionId,
            ...(admittedDigest === undefined ? {} : { admittedDigest }),
            dispose: async () => {
                retirePendingSubscription();
                await disposeSettledHostResource(subscriptionId);
            },
        });
    }

    async function establishComposerHostResource(
        method: Extract<PluginUiHostApiRequestMethodV1, 'watchComposer' | 'acquireComposerInputLock'>,
        payload: PluginUiJsonValueV1 & Readonly<{ subscriptionId: string }>,
        listener?: (snapshot: ComposerSnapshotV1) => void,
        options?: PluginSurfaceHostApiRequestOptions,
    ): Promise<PluginReactNativeHostRequestSubscription> {
        if (options?.signal?.aborted) {
            throwHostApiError('unavailable', ['aborted']);
        }
        const abortSignal = options?.signal;
        let locallyRetired = false;
        const retirePendingSubscription = () => {
            if (locallyRetired) return;
            locallyRetired = true;
            composerListeners.delete(payload.subscriptionId);
            settledComposerSubscriptionIds.delete(payload.subscriptionId);
            subscriptions.dispose({
                surface: params.requestSurface,
                subscriptionId: payload.subscriptionId,
            });
        };
        // Register before the host confirms establishment. The mounted document
        // may publish its current Composer snapshot synchronously with that
        // acknowledgement; registering afterwards would lose that first value.
        if (listener) composerListeners.set(payload.subscriptionId, listener);
        subscriptions.register({
            surface: params.requestSurface,
            subscriptionId: payload.subscriptionId,
        });
        let abandoned = false;
        let removeAbortListener: (() => void) | undefined;
        const abortPromise = abortSignal
            ? new Promise<never>((_resolve, reject) => {
                const onAbort = () => {
                    abandoned = true;
                    retirePendingSubscription();
                    reject(createHostApiError('unavailable', ['aborted']));
                };
                removeAbortListener = () => abortSignal.removeEventListener('abort', onAbort);
                abortSignal.addEventListener('abort', onAbort, { once: true });
            })
            : undefined;
        const establishment = request(method, payload, options);
        try {
            await (abortPromise
                ? Promise.race([establishment, abortPromise])
                : establishment);
        } catch (error) {
            removeAbortListener?.();
            retirePendingSubscription();
            if (abandoned) {
                // The host can still acknowledge a request whose author-side
                // establishment was cancelled. Retire that late lease through
                // the one existing generic disposer rather than leaving a
                // Composer-only cleanup path behind.
                void establishment.then(
                    () => disposeSettledHostResource(payload.subscriptionId),
                    () => undefined,
                ).catch(() => undefined);
            }
            throw error;
        }
        removeAbortListener?.();
        if (
            disposed
            || params.isRequestSurfaceCurrent?.(params.requestSurface) === false
            || options?.signal?.aborted
        ) {
            retirePendingSubscription();
            await disposeSettledHostResource(payload.subscriptionId);
            if (options?.signal?.aborted) {
                throwHostApiError('unavailable', ['aborted']);
            }
            throwHostApiError('stale_surface');
        }
        settledComposerSubscriptionIds.add(payload.subscriptionId);
        return Object.freeze({
            subscriptionId: payload.subscriptionId,
            dispose: async () => {
                retirePendingSubscription();
                await disposeSettledHostResource(payload.subscriptionId);
            },
        });
    }

    async function watchComposer(
        payload: PluginUiWatchComposerRequestV1 & Readonly<{ subscriptionId: string }>,
        listener: (snapshot: ComposerSnapshotV1) => void,
        options?: PluginSurfaceHostApiRequestOptions,
    ): Promise<PluginReactNativeHostRequestSubscription> {
        const parsedPayload = PluginUiWatchComposerRequestV1Schema.safeParse({ ref: payload.ref });
        if (!parsedPayload.success || !payload.subscriptionId.trim()) {
            throwHostApiError('invalid_payload');
        }
        return await establishComposerHostResource(
            'watchComposer',
            { subscriptionId: payload.subscriptionId, ...parsedPayload.data },
            listener,
            options,
        );
    }

    async function acquireComposerInputLock(
        payload: PluginUiJsonValueV1 & Readonly<{ subscriptionId: string }>,
        options?: PluginSurfaceHostApiRequestOptions,
    ): Promise<PluginReactNativeHostRequestSubscription> {
        if (!payload.subscriptionId.trim()) throwHostApiError('invalid_payload');
        return await establishComposerHostResource('acquireComposerInputLock', payload, undefined, options);
    }

    return Object.freeze({
        request,
        watchResource,
        watchComposer,
        acquireComposerInputLock,
        publishSubscriptionEvent: (event) => subscriptions.publish(params.requestSurface, event),
        publishComposerSubscriptionEvent: (input) => {
            const parsed = ComposerSnapshotV1Schema.safeParse(input.snapshot);
            if (!parsed.success) return false;
            return subscriptions.publishValue(params.requestSurface, {
                subscriptionId: input.subscriptionId,
                value: parsed.data,
            });
        },
        dispose: () => {
            const activeSubscriptionIds = [
                ...new Set([...settledResourceSubscriptionIds, ...settledComposerSubscriptionIds]),
            ];
            disposed = true;
            resourceListeners.clear();
            settledResourceSubscriptionIds.clear();
            composerListeners.clear();
            settledComposerSubscriptionIds.clear();
            subscriptions.disposeSurface(params.requestSurface);
            for (const subscriptionId of activeSubscriptionIds) {
                void disposeSettledHostResource(subscriptionId);
            }
        },
    });
}

export type CanonicalPluginReactNativeHostApiAdapter = Readonly<{
    api: PluginUiHostApi;
    /**
     * EU-4b: deliver one live resource invalidation into the ONE subscription
     * registry this adapter already owns. `PluginSurfaceHost` connects the
     * mount's invalidation sink here; nothing else publishes, and no second
     * registry exists.
     */
    publishResourceSubscriptionEvent: (event: PluginUiResourceSubscriptionEventV1) => boolean;
    /** Deliver one exact Composer snapshot through this mount's existing subscription lifecycle. */
    publishComposerSubscriptionEvent: (input: Readonly<{
        subscriptionId: string;
        snapshot: ComposerSnapshotV1;
    }>) => boolean;
    /**
     * The mount's context producer (UI-D03). `PluginSurfaceHost` calls this when
     * locale, theme, contrast, text scale, motion, screen-reader state or safe
     * areas change, and every established `watchContext` subscriber receives it
     * in order. An identical snapshot is not republished.
     */
    pushSurfaceContext: (surface: SurfaceContext) => void;
    dispose: () => void;
}>;

/**
 * The canonical React Native transport's factual method set (UI-D02/UI-D03).
 *
 * `context` and `watchContext` are both answered by the adapter from the ONE
 * mount-owned surface fact — the snapshot for the read, the push producer for
 * the subscription — so a mount that owns a valid surface serves both. Every
 * other method needs an installed host request handler. A mount whose surface
 * snapshot did not validate installs nothing at all and therefore advertises
 * nothing, including `watchContext`.
 *
 * This is a transport projection of `PLUGIN_UI_HOST_METHODS_V1`, not a second
 * vocabulary: the tuple stays the only place a method name is declared. The
 * rule itself lives in `../hostApi/negotiatedMethods.ts` because the hosted-web
 * transport applies exactly the same one; this mount is simply the transport
 * that can always push, being in-process.
 */
export function resolveCanonicalPluginReactNativeHostApiMethods(
    installedMethods: readonly PluginUiHostMethodV1[],
): readonly PluginUiHostMethodV1[] {
    return resolveNegotiatedPluginSurfaceHostApiMethods({
        installedMethods,
        canPushToSurface: true,
    });
}

function canonicalReferencePayload(reference: string | Readonly<{ pluginId: string; localId: string }>): PluginUiJsonValueV1 {
    return typeof reference === 'string'
        ? reference
        : { pluginId: reference.pluginId, localId: reference.localId };
}

function canonicalSurfaceDestinationPayload(
    destination: PluginReference,
    callerPluginId: string,
): PluginUiJsonValueV1 {
    // `openSurface` is the one reference-bearing request whose Protocol payload
    // is always an exact contribution identity. Keep bare author references
    // caller-relative at this transport boundary while preserving an explicit
    // cross-plugin target verbatim; Action and Resource payloads retain their
    // own Protocol-owned reference shapes above.
    return typeof destination === 'string'
        ? { pluginId: callerPluginId, localId: destination }
        : { pluginId: destination.pluginId, localId: destination.localId };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throwHostApiError('unavailable', ['aborted']);
    }
}

function readCanonicalResource(value: PluginUiJsonValueV1 | undefined): ResourceContent {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, PluginUiJsonValueV1>>
        : null;
    const contentType = typeof record?.contentType === 'string' ? record.contentType : '';
    const digest = typeof record?.digest === 'string' ? record.digest : '';
    const bytesBase64 = typeof record?.bytesBase64 === 'string' ? record.bytesBase64 : '';
    if (!contentType || !digest || !bytesBase64) {
        throwHostApiError('invalid_payload', ['resource_response_invalid']);
    }
    try {
        return Object.freeze({
            contentType,
            digest,
            bytes: decodeBase64(bytesBase64, 'base64'),
        });
    } catch {
        throwHostApiError('invalid_payload', ['resource_bytes_invalid']);
    }
}

function readCanonicalOpenableContentStat(value: PluginUiJsonValueV1 | undefined) {
    const parsed = OpenableContentStatResultV1Schema.safeParse(value);
    if (!parsed.success) {
        throwHostApiError('invalid_payload', ['openable_content_stat_response_invalid']);
    }
    return parsed.data;
}

function readCanonicalOpenableContentRead(value: PluginUiJsonValueV1 | undefined) {
    const parsed = OpenableContentReadResultV1Schema.safeParse(value);
    if (!parsed.success) {
        throwHostApiError('invalid_payload', ['openable_content_read_response_invalid']);
    }
    return parsed.data;
}

function readCanonicalActiveComposer(value: PluginUiJsonValueV1 | undefined) {
    const parsed = PluginUiActiveComposerResultV1Schema.safeParse(value);
    if (!parsed.success) throwHostApiError('invalid_payload', ['active_composer_response_invalid']);
    return parsed.data;
}

function readCanonicalComposer(value: PluginUiJsonValueV1 | undefined) {
    const parsed = ComposerReadResultV1Schema.safeParse(value);
    if (!parsed.success) throwHostApiError('invalid_payload', ['read_composer_response_invalid']);
    return parsed.data;
}

function readCanonicalComposerTransaction(value: PluginUiJsonValueV1 | undefined) {
    const parsed = ComposerTransactionResultV1Schema.safeParse(value);
    if (!parsed.success) throwHostApiError('invalid_payload', ['apply_composer_response_invalid']);
    return parsed.data;
}

function readCanonicalComposerFocus(value: PluginUiJsonValueV1 | undefined) {
    const parsed = ComposerFocusResultV1Schema.safeParse(value);
    if (!parsed.success) throwHostApiError('invalid_payload', ['focus_composer_response_invalid']);
    return parsed.data;
}

function readCanonicalComposerDecorations(value: PluginUiJsonValueV1 | undefined) {
    const parsed = ComposerDecorationResultV1Schema.safeParse(value);
    if (!parsed.success) throwHostApiError('invalid_payload', ['set_composer_decorations_response_invalid']);
    return parsed.data;
}

function readCanonicalComposerMediaHandle(value: PluginUiJsonValueV1 | undefined) {
    const parsed = PluginUiPickComposerMediaResultV1Schema.safeParse(value);
    if (!parsed.success) throwHostApiError('invalid_payload', ['pick_composer_media_response_invalid']);
    return parsed.data;
}

function readCanonicalComposerContentInspection(value: PluginUiJsonValueV1 | undefined) {
    const parsed = PluginUiInspectComposerContentResultV1Schema.safeParse(value);
    if (!parsed.success) throwHostApiError('invalid_payload', ['inspect_composer_content_response_invalid']);
    try {
        return Object.freeze({
            offset: parsed.data.offset,
            bytes: decodeBase64(parsed.data.bytesBase64, 'base64'),
            eof: parsed.data.eof,
        });
    } catch {
        throwHostApiError('invalid_payload', ['inspect_composer_content_bytes_invalid']);
    }
}

/**
 * Canonical public SDK adapter for generated renderer artifacts. The request
 * transport above is host-private plumbing, not an alternate public API.
 *
 * UI-D02: `installedMethods` is the mount's factual host-method set (see
 * `resolveInstalledPluginSurfaceHostMethods`). `version().methods` is that set
 * intersected with what this adapter implements — never a constant — and calling
 * a method outside it fails with a typed `unsupported_method` instead of
 * dispatching into a host that cannot serve it.
 *
 * **What `PluginCancellationOptions` means here**, decided once for every member
 * rather than per method:
 *
 * - `context` / `watchContext` settle from mount-owned facts with nothing
 *   awaited, so the entry check IS the whole window;
 * - all in-flight request calls pass caller cancellation through the one
 *   transport seam, which rejects promptly when withdrawal wins and ignores a
 *   later mounted-handler response;
 * - `confirm` is the only member whose in-flight window is bounded by the USER,
 *   so the signal is forwarded to the mount: aborting dismisses the dialog and
 *   the withdrawal is never reported as a decline;
 * - outward effects (`executeAction`, `notify`, `openSurface`, `writeClipboard`,
 *   `openExternalLink`) preserve a host settlement that wins before caller
 *   withdrawal; cancellation does not promise to roll back a host effect.
 */
export function createCanonicalPluginReactNativeHostApiAdapter(params: Readonly<{
    surface: SurfaceContext;
    requestSurface: PluginUiSurfaceContextV1;
    requestIdPrefix: string;
    handleRequest: PluginReactNativeHostApiRequestHandler;
    installedMethods: readonly PluginUiHostMethodV1[];
    /**
     * Reads the controller's current factual method set without replacing this
     * mount-scoped adapter when a daemon reconnects or temporarily revalidates.
     */
    getInstalledMethods?: () => readonly PluginUiHostMethodV1[];
    /**
     * Reads the controller's STRUCTURAL method set (`admissionMethods`), which
     * excludes transient availability narrowing. It is what separates a method
     * this mount can never serve from one it merely cannot serve right now;
     * without it every absence reads as a permanent capability verdict.
     */
    getAdmissionMethods?: () => readonly PluginUiHostMethodV1[];
    /** Consumes the mount controller's currentness fact; this adapter does not own it. */
    isCurrent?: () => boolean;
}>): CanonicalPluginReactNativeHostApiAdapter {
    const isCurrent = params.isCurrent;
    const transport = createPluginReactNativeHostRequestTransport({
        requestSurface: params.requestSurface,
        requestIdPrefix: params.requestIdPrefix,
        handleRequest: params.handleRequest,
        ...(isCurrent ? { isRequestSurfaceCurrent: () => isCurrent() } : {}),
    });
    // Derived from the canonical vocabulary so a method added to the owner and
    // to `PluginUiHostApi` is advertised here without touching this file.
    const resolveNegotiatedMethods = (): readonly PluginUiHostMethodV1[] =>
        resolveCanonicalPluginReactNativeHostApiMethods(
            params.getInstalledMethods?.() ?? params.installedMethods,
        );
    const resolveStructuralMethods = (): readonly PluginUiHostMethodV1[] =>
        resolveCanonicalPluginReactNativeHostApiMethods(
            params.getAdmissionMethods?.() ?? params.getInstalledMethods?.() ?? params.installedMethods,
        );
    let currentSurface = params.surface;
    let currentSurfaceSemanticKey = stableJsonStringify(currentSurface);
    // The operation is never serialized in the public executeAction payload.
    // Each admitted operation retains only its latest selected settlement.
    type RetainedSelectedActionInput = Readonly<{
        /**
         * The strict public-shaped carrier remains distinct from the host-only
         * lifetime hook below. It is the only value allowed through the
         * Protocol parser when an immediate Action reuses a selection.
         */
        carrier: Readonly<{
            operation: PluginUiTargetedContributionOperationV1;
            result: Extract<PluginUiSelectActionInputResultV1, Readonly<{ kind: 'submitted' }>>;
        }>;
        /** Retires only this exact host-private retained settlement. */
        release: () => void;
    }>;
    const selectedOperationByAction = new WeakMap<object, RetainedSelectedActionInput>();
    const selectedActionInputByOperation = new Map<string, RetainedSelectedActionInput>();

    function resolveActiveSelectedActionInput(
        candidate: unknown,
    ): RetainedSelectedActionInput | undefined {
        const parsed = PluginUiSelectedActionInputCarrierV1Schema.safeParse(candidate);
        if (!parsed.success) return undefined;
        const retained = selectedActionInputByOperation.get(
            pluginUiTargetedContributionOperationKey(parsed.data.operation),
        );
        return retained && pluginUiSelectedActionInputsEqual(retained.carrier.result, parsed.data.result)
            ? retained
            : undefined;
    }
    function isCurrentSelectedActionInput(
        retained: RetainedSelectedActionInput,
    ): boolean {
        return selectedActionInputByOperation.get(
            pluginUiTargetedContributionOperationKey(retained.carrier.operation),
        ) === retained;
    }
    const contextWatchers = new Set<(surface: SurfaceContext) => void>();
    let disposed = false;
    let subscriptionSequence = 0;
    const disposables = new Set<() => void>();

    function assertActive(signal?: AbortSignal): void {
        if (disposed || params.isCurrent?.() === false) {
            throwHostApiError('stale_surface');
        }
        throwIfAborted(signal);
    }

    function assertInstalled(method: PluginUiHostMethodV1): void {
        if (resolveNegotiatedMethods().includes(method)) return;
        // This adapter deliberately outlives a daemon reconnect, so its method
        // set is a CURRENT availability fact. A method the mount structurally
        // installs is re-advertised on recovery; reporting it as
        // `unsupported_method` hands the caller a permanent capability verdict
        // it will never revisit, which is how an outage at mount time turns
        // into a session-long loss of live Resources.
        if (resolveStructuralMethods().includes(method)) {
            throwHostApiError('unavailable', [`host_api_method_unavailable:${method}`]);
        }
        throwHostApiError('unsupported_method', [`host_api_method_not_installed:${method}`]);
    }

    function disposable(dispose: () => void): Readonly<{ dispose: () => void }> {
        let active = true;
        const wrapped = () => {
            if (!active) return;
            active = false;
            disposables.delete(wrapped);
            dispose();
        };
        disposables.add(wrapped);
        return Object.freeze({ dispose: wrapped });
    }

    const apiShape: PluginUiHostApi = {
        version: () => Object.freeze({
            apiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
            wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
            // This mount's structural contract is stable. Transient daemon
            // reachability is reported by assertInstalled as typed
            // `unavailable`, matching the hosted-web negotiation semantics.
            methods: resolveStructuralMethods(),
        }),
        publishCurrentUiContext: (enrichment) => {
            assertActive();
            assertInstalled('publishCurrentUiContext');
            const payload = PluginUiPublishCurrentUiContextRequestV1Schema.safeParse({ enrichment });
            if (!payload.success) throwHostApiError('invalid_payload');
            // Like the browser transport, publication has no acknowledgement or
            // author-visible ID. The mount/controller remains the authority for
            // admission and synchronous retirement; a late transport failure
            // cannot leave a second client-side context owner behind.
            void transport.request('publishCurrentUiContext', payload.data).catch(() => undefined);
        },
        context: async (options) => {
            assertActive(options?.signal);
            assertInstalled('context');
            return currentSurface;
        },
        // UI-D03: a real subscription over the mount's push producer. It never
        // emits a synthetic first snapshot — `context()` is the read — and it is
        // established through a promise so an abandoned or stale establishment
        // rejects instead of yielding a disposable that observes nothing.
        watchContext: async (listener, options) => {
            assertActive(options?.signal);
            assertInstalled('watchContext');
            contextWatchers.add(listener);
            return disposable(() => {
                contextWatchers.delete(listener);
            });
        },
        // The public interface carries typed host-ActionSpec overloads; the
        // transport is uniform, so the adapter implements the general signature
        // once and is cast to the overloaded member.
        executeAction: (async (
            action: PluginReference,
            input: JsonValue,
            options?: PluginUiActionExecutionOptions,
        ) => {
            assertActive(options?.signal);
            assertInstalled('executeAction');
            // This adapter only serializes the Protocol-owned raw request. It
            // does not classify host Actions or bind contributed references;
            // the mounted dispatcher owns both decisions after this transport.
            const actionRequest = PluginUiExecuteActionRequestV1Schema.safeParse({
                action,
                input,
            });
            if (!actionRequest.success) throwHostApiError('invalid_payload');
            const explicitSelectedActionInput = options?.selectedActionInput;
            const directSelectedActionInput = explicitSelectedActionInput === undefined
                && action && typeof action === 'object'
                ? selectedOperationByAction.get(action)
                : undefined;
            const targetedSelection = explicitSelectedActionInput === undefined
                ? (directSelectedActionInput === undefined
                    ? undefined
                    : (isCurrentSelectedActionInput(directSelectedActionInput)
                        ? directSelectedActionInput
                        : undefined))
                : resolveActiveSelectedActionInput(explicitSelectedActionInput);
            if (
                (explicitSelectedActionInput !== undefined || directSelectedActionInput !== undefined)
                && !targetedSelection
            ) {
                throwHostApiError('invalid_payload', ['selected_action_input_inactive']);
            }
            // This mounted-host fact intentionally has no public SDK option
            // type. It can only remove an exact active host-selected carrier;
            // it cannot manufacture one or grant an Action any authority.
            const consumeSelectedActionInput = (
                options as (PluginUiActionExecutionOptions & Readonly<{
                    consumeSelectedActionInput?: unknown;
                }>) | undefined
            )?.consumeSelectedActionInput === true;
            // A terminal relay is one-shot even when the outer dispatcher
            // fails, observes cancellation, or returns an ambiguous result.
            // Delete synchronously before crossing that external boundary.
            if (consumeSelectedActionInput) {
                if (!targetedSelection) {
                    throwHostApiError('invalid_payload', ['selected_action_input_required_for_consumption']);
                }
                targetedSelection.release();
            }
            const requestOptions = options?.signal || targetedSelection
                ? {
                    ...(options?.signal ? { signal: options.signal } : {}),
                    ...(targetedSelection
                        ? {
                            targetedOperation: targetedSelection.carrier.operation,
                            selectedActionInput: targetedSelection.carrier.result,
                        }
                        : {}),
                }
                : undefined;
            const result = requestOptions
                ? await transport.request('executeAction', actionRequest.data, requestOptions)
                : await transport.request('executeAction', actionRequest.data);
            // The host response is the canonical settlement. Once an outward
            // effect succeeds, later local retirement must not hide that known
            // result and encourage a blind retry.
            return result;
        }) as PluginUiHostApi['executeAction'],
        selectActionInput: async (selectionRequest, options) => {
            assertActive(options?.signal);
            assertInstalled('selectActionInput');
            const parsedRequest = PluginUiSelectActionInputRequestV1Schema.safeParse(selectionRequest);
            if (!parsedRequest.success) throwHostApiError('invalid_payload');
            const result = await transport.request(
                'selectActionInput',
                parsedRequest.data,
                options?.signal ? { signal: options.signal } : undefined,
            );
            assertActive(options?.signal);
            const parsedResult = PluginUiSelectActionInputResultV1Schema.safeParse(result);
            if (!parsedResult.success) {
                throwHostApiError('invalid_payload', ['select_action_input_response_invalid']);
            }
            if (parsedResult.data.kind === 'submitted' && 'operation' in parsedRequest.data) {
                // The parsed value below is returned to author code.
                // Retain a separately parsed JSON copy for the mount-private
                // immediate-execute association so later JavaScript mutation
                // of that public object cannot rewrite host-selected input or
                // Account-ref facts. The Protocol result is bounded JSON, so
                // this avoids relying on a runtime-specific clone global in
                // React Native while the strict parser preserves the owner
                // schema at the private boundary.
                const retainedResult = PluginUiSelectActionInputResultV1Schema.parse(
                    JSON.parse(JSON.stringify(parsedResult.data)),
                );
                if (retainedResult.kind !== 'submitted') {
                    throwHostApiError('invalid_payload', ['select_action_input_response_invalid']);
                }
                const operationKey = pluginUiTargetedContributionOperationKey(parsedRequest.data.operation);
                const selectionSignal = options?.signal;
                let selectedActionInput!: RetainedSelectedActionInput;
                const release = () => {
                    // A late abort for a superseded selection must never retire
                    // its replacement for the same canonical operation key.
                    if (selectedActionInputByOperation.get(operationKey) !== selectedActionInput) return;
                    selectedActionInputByOperation.delete(operationKey);
                    selectionSignal?.removeEventListener('abort', release);
                };
                selectedActionInput = Object.freeze({
                    carrier: Object.freeze({
                        operation: parsedRequest.data.operation,
                        result: retainedResult,
                    }),
                    release,
                });
                selectedActionInputByOperation.get(operationKey)?.release();
                selectedActionInputByOperation.set(operationKey, selectedActionInput);
                if (selectionSignal?.aborted) release();
                else selectionSignal?.addEventListener('abort', release, { once: true });
                selectedOperationByAction.set(parsedResult.data.action, selectedActionInput);
            }
            return parsedResult.data;
        },
        readResource: async (resource, options) => {
            assertActive(options?.signal);
            assertInstalled('readResource');
            const result = await transport.request('readResource', {
                resource: canonicalReferencePayload(resource),
            }, options?.signal ? { signal: options.signal } : undefined);
            assertActive(options?.signal);
            return readCanonicalResource(result);
        },
        statOpenableContent: async (ref, options) => {
            assertActive(options?.signal);
            assertInstalled('statOpenableContent');
            const result = await transport.request('statOpenableContent', {
                ref: { kind: ref.kind, handle: ref.handle },
            }, options?.signal ? { signal: options.signal } : undefined);
            assertActive(options?.signal);
            return readCanonicalOpenableContentStat(result);
        },
        readOpenableContent: async (request, options) => {
            assertActive(options?.signal);
            assertInstalled('readOpenableContent');
            const result = await transport.request('readOpenableContent', {
                ref: { kind: request.ref.kind, handle: request.ref.handle },
                expectedRevision: request.expectedRevision,
                ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
            }, options?.signal ? { signal: options.signal } : undefined);
            assertActive(options?.signal);
            return readCanonicalOpenableContentRead(result);
        },
        // EU-4b: a real subscription over the mount's daemon-backed
        // `watchResource` handler. The host-private request transport owns
        // establishment, registry bookkeeping and `disposeHostResource`
        // retirement, so this public member delegates rather than creating a
        // second subscription lifecycle. It is advertised only when the mount
        // installed the handler.
        watchResource: async (resource, listener, options) => {
            assertActive(options?.signal);
            assertInstalled('watchResource');
            subscriptionSequence += 1;
            const subscription = await transport.watchResource(
                {
                    subscriptionId: `${params.requestIdPrefix}:resource:${subscriptionSequence}`,
                    resource: canonicalReferencePayload(resource) as PluginUiResourceSubscriptionRequestV1['resource'],
                },
                listener,
                options?.signal ? { signal: options.signal } : undefined,
            );
            // An author who abandoned establishment must not be left holding a
            // live daemon subscription.
            if (disposed || options?.signal?.aborted) {
                await subscription.dispose();
                assertActive(options?.signal);
            }
            const disposableSubscription = disposable(() => { void subscription.dispose(); });
            return Object.freeze({
                ...disposableSubscription,
                ...(subscription.admittedDigest === undefined
                    ? {}
                    : { admittedDigest: subscription.admittedDigest }),
            });
        },
        activeComposer: async (options) => {
            assertActive(options?.signal);
            assertInstalled('activeComposer');
            const result = await transport.request(
                'activeComposer',
                undefined,
                options?.signal ? { signal: options.signal } : undefined,
            );
            assertActive(options?.signal);
            return readCanonicalActiveComposer(result);
        },
        readComposer: async (ref, options) => {
            assertActive(options?.signal);
            assertInstalled('readComposer');
            const payload = PluginUiReadComposerRequestV1Schema.safeParse({ ref });
            if (!payload.success) throwHostApiError('invalid_payload');
            const result = await transport.request(
                'readComposer',
                payload.data,
                options?.signal ? { signal: options.signal } : undefined,
            );
            assertActive(options?.signal);
            return readCanonicalComposer(result);
        },
        watchComposer: async (ref, listener, options) => {
            assertActive(options?.signal);
            assertInstalled('watchComposer');
            const payload = PluginUiWatchComposerRequestV1Schema.safeParse({ ref });
            if (!payload.success) throwHostApiError('invalid_payload');
            subscriptionSequence += 1;
            const subscription = await transport.watchComposer({
                subscriptionId: `${params.requestIdPrefix}:composer:${subscriptionSequence}`,
                ...payload.data,
            }, listener, options?.signal ? { signal: options.signal } : undefined);
            if (disposed || options?.signal?.aborted) {
                await subscription.dispose();
                assertActive(options?.signal);
            }
            return disposable(() => { void subscription.dispose(); });
        },
        applyComposer: async (ref, transaction, options) => {
            assertActive(options?.signal);
            assertInstalled('applyComposer');
            const payload = PluginUiApplyComposerRequestV1Schema.safeParse({ ref, transaction });
            if (!payload.success) throwHostApiError('invalid_payload');
            return readCanonicalComposerTransaction(await transport.request(
                'applyComposer',
                PluginUiJsonValueV1Schema.parse(payload.data),
                options?.signal ? { signal: options.signal } : undefined,
            ));
        },
        focusComposer: async (ref, options) => {
            assertActive(options?.signal);
            assertInstalled('focusComposer');
            const payload = PluginUiFocusComposerRequestV1Schema.safeParse({ ref });
            if (!payload.success) throwHostApiError('invalid_payload');
            return readCanonicalComposerFocus(await transport.request(
                'focusComposer',
                payload.data,
                options?.signal ? { signal: options.signal } : undefined,
            ));
        },
        setComposerDecorations: async (ref, key, decorations, options) => {
            assertActive(options?.signal);
            assertInstalled('setComposerDecorations');
            const payload = PluginUiSetComposerDecorationsRequestV1Schema.safeParse({ ref, key, decorations });
            if (!payload.success) throwHostApiError('invalid_payload');
            return readCanonicalComposerDecorations(await transport.request(
                'setComposerDecorations',
                payload.data,
                options?.signal ? { signal: options.signal } : undefined,
            ));
        },
        acquireComposerInputLock: async (ref, lockRequest, options) => {
            assertActive(options?.signal);
            assertInstalled('acquireComposerInputLock');
            const payload = PluginUiAcquireComposerInputLockRequestV1Schema.safeParse({
                ref,
                request: lockRequest,
            });
            if (!payload.success) throwHostApiError('invalid_payload');
            subscriptionSequence += 1;
            const subscription = await transport.acquireComposerInputLock({
                subscriptionId: `${params.requestIdPrefix}:composer-lock:${subscriptionSequence}`,
                ...payload.data,
            }, options?.signal ? { signal: options.signal } : undefined);
            if (disposed || options?.signal?.aborted) {
                await subscription.dispose();
                assertActive(options?.signal);
            }
            return disposable(() => { void subscription.dispose(); });
        },
        pickComposerMedia: async (ref, mediaRequest, options) => {
            assertActive(options?.signal);
            assertInstalled('pickComposerMedia');
            const payload = PluginUiPickComposerMediaRequestV1Schema.safeParse({
                ref,
                request: mediaRequest,
            });
            if (!payload.success) throwHostApiError('invalid_payload');
            const result = await transport.request(
                'pickComposerMedia',
                payload.data,
                options?.signal ? { signal: options.signal } : undefined,
            );
            // A staged handle acquired for a retired mount must not re-enter a
            // live draft. The transfer owner retains completed stages for its
            // own explicit-release/expiry lifecycle.
            assertActive(options?.signal);
            return readCanonicalComposerMediaHandle(result);
        },
        inspectComposerContent: async (handle, inspectRequest, options) => {
            assertActive(options?.signal);
            assertInstalled('inspectComposerContent');
            const payload = PluginUiInspectComposerContentRequestV1Schema.safeParse({
                handle,
                request: inspectRequest,
            });
            if (!payload.success) throwHostApiError('invalid_payload');
            const result = await transport.request(
                'inspectComposerContent',
                payload.data,
                options?.signal ? { signal: options.signal } : undefined,
            );
            assertActive(options?.signal);
            return readCanonicalComposerContentInspection(result);
        },
        releaseComposerContent: async (handle, options) => {
            assertActive(options?.signal);
            assertInstalled('releaseComposerContent');
            const payload = PluginUiReleaseComposerContentRequestV1Schema.safeParse({ handle });
            if (!payload.success) throwHostApiError('invalid_payload');
            await transport.request(
                'releaseComposerContent',
                payload.data,
                options?.signal ? { signal: options.signal } : undefined,
            );
        },
        openSurface: async (destination, input, options) => {
            assertActive(options?.signal);
            assertInstalled('openSurface');
            await transport.request('openSurface', {
                destination: canonicalSurfaceDestinationPayload(destination, params.requestSurface.pluginId),
                ...(input !== undefined ? { input: input as PluginUiJsonValueV1 } : {}),
                // EU-5b: the plugin-local location inside a full-page
                // destination. Forwarded verbatim; the mounted handler's
                // Protocol schema owns what a legal location is.
                ...(options?.subPath !== undefined ? { subPath: options.subPath } : {}),
                ...(options?.instanceKey !== undefined ? { instanceKey: options.instanceKey } : {}),
            }, options?.signal ? { signal: options.signal } : undefined);
        },
        // EU-5b's interaction counterpart: the page's OWN location, replaced in
        // place. It is a separate method from `openSurface` because it is a
        // separate contract — no destination selection, no history entry — and
        // because it answers with the location the host settled on, which the
        // page renders even when that is not the location it asked for.
        replacePageLocation: async (subPath, options) => {
            assertActive(options?.signal);
            assertInstalled('replacePageLocation');
            const payload = PluginUiReplacePageLocationRequestV1Schema.safeParse({
                subPath,
                ...(options?.backLocation === undefined ? {} : { backLocation: options.backLocation }),
            });
            if (!payload.success) throwHostApiError('invalid_payload');
            const settled = PluginUiReplacePageLocationResultV1Schema.safeParse(await transport.request(
                'replacePageLocation',
                payload.data,
                options?.signal ? { signal: options.signal } : undefined,
            ));
            if (!settled.success) throwHostApiError('invalid_payload', ['page_location_result_invalid']);
            return Object.freeze(settled.data);
        },
        notify: async (message, options) => {
            assertActive(options?.signal);
            assertInstalled('notify');
            await transport.request('notify', {
                message,
                ...(options?.severity === undefined ? {} : { severity: options.severity }),
            }, options?.signal ? { signal: options.signal } : undefined);
        },
        // The one method whose in-flight window is bounded by the USER rather
        // than by host work, so the author's signal must reach the mount and not
        // merely be read on the way in: an abort after the dialog opened has to
        // dismiss it, and a late answer to a withdrawn question is inert.
        confirm: async (message, options) => {
            assertActive(options?.signal);
            assertInstalled('confirm');
            const result = await transport.request('confirm', {
                message,
                ...(options?.title === undefined ? {} : { title: options.title }),
            }, options?.signal ? { signal: options.signal } : undefined);
            // A host that ignored the cancellation still may not answer a
            // question the author withdrew: the typed failure is the settlement,
            // never a boolean the plugin would read as the user's decision.
            assertActive(options?.signal);
            const record = result && typeof result === 'object' && !Array.isArray(result)
                ? result as Readonly<Record<string, PluginUiJsonValueV1>>
                : null;
            // The user's answer is the settlement. A malformed reply is a typed
            // failure rather than a silent `false`, which would read as a decline
            // the user never made.
            if (typeof record?.confirmed !== 'boolean') {
                throwHostApiError('invalid_payload', ['confirm_response_invalid']);
            }
            return record.confirmed;
        },
        diagnostic: (data) => {
            assertActive();
            assertInstalled('diagnostic');
            void transport.request('diagnostic', data as PluginUiJsonValueV1).catch(() => undefined);
        },
        readClipboard: async (options) => {
            assertActive(options?.signal);
            assertInstalled('readClipboard');
            const result = await transport.request(
                'readClipboard',
                undefined,
                options?.signal ? { signal: options.signal } : undefined,
            );
            assertActive(options?.signal);
            if (typeof result === 'string') return result;
            const record = result && typeof result === 'object' && !Array.isArray(result)
                ? result as Readonly<Record<string, PluginUiJsonValueV1>>
                : null;
            if (typeof record?.value === 'string') return record.value;
            throwHostApiError('invalid_payload', ['clipboard_read_response_invalid']);
        },
        writeClipboard: async (value, options) => {
            assertActive(options?.signal);
            assertInstalled('writeClipboard');
            await transport.request(
                'writeClipboard',
                { value },
                options?.signal ? { signal: options.signal } : undefined,
            );
        },
        openExternalLink: async (url, options) => {
            assertActive(options?.signal);
            assertInstalled('openExternalLink');
            await transport.request(
                'openExternalLink',
                { url },
                options?.signal ? { signal: options.signal } : undefined,
            );
        },
    };
    const api = Object.freeze(apiShape);

    return Object.freeze({
        api,
        publishResourceSubscriptionEvent: (event) => transport.publishSubscriptionEvent(event),
        publishComposerSubscriptionEvent: (input) => transport.publishComposerSubscriptionEvent(input),
        pushSurfaceContext: (surface: SurfaceContext) => {
            if (disposed || surface === currentSurface) return;
            const surfaceSemanticKey = stableJsonStringify(surface);
            if (surfaceSemanticKey === currentSurfaceSemanticKey) return;
            currentSurface = surface;
            currentSurfaceSemanticKey = surfaceSemanticKey;
            // Serialized per push and isolated per listener: one author's
            // failure never stops the next subscriber from observing the change.
            for (const watcher of [...contextWatchers]) {
                try {
                    watcher(surface);
                } catch {
                    // Diagnosed by the surface's own error boundary; the
                    // subscription registry stays intact.
                }
            }
        },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            for (const selectedActionInput of selectedActionInputByOperation.values()) {
                selectedActionInput.release();
            }
            for (const dispose of [...disposables]) dispose();
            contextWatchers.clear();
            transport.dispose();
        },
    });
}
