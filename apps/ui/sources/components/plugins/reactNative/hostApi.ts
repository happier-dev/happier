import {
    PluginUiWidgetAreaRequestV1Schema,
    PluginUiWidgetAreaResultV1Schema,
    PluginUiWatchEntityDragDropRequestV1Schema, PluginUiEntityDragDropStateV1Schema,
    PluginUiReadEntityDragItemRequestV1Schema,
    PluginUiReadEntityDragItemResultV1Schema,
    PluginUiUpdateEntityDragDropRequestV1Schema,
    PluginUiUpdateEntityDragDropResultV1Schema,
    PLUGIN_UI_HOST_API_VERSION_V1,
    PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
    PLUGIN_UI_HOST_SUBSCRIPTION_METHODS_V1,
    PluginUiExecuteActionRequestV1Schema,
    PluginUiEphemeralInputSettlementV1Schema,
    PluginUiAcquireComposerInputLockRequestV1Schema,
    PluginUiActiveComposerResultV1Schema,
    PluginUiApplyComposerRequestV1Schema,
    PluginUiFocusComposerRequestV1Schema,
    PluginUiInspectComposerContentRequestV1Schema,
    PluginUiInspectComposerContentResultV1Schema,
    PluginUiHostApiRequestMethodV1Schema,
    PluginUiHostApiRequestEnvelopeV1Schema,
    PluginUiJsonValueV1Schema,
    PluginUiOpenNewSessionRequestV1Schema,
    PluginUiOpenConnectedAccountsRequestV1Schema,
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
    PluginUiWatchComposerRequestV1Schema,
    PluginUiReadSessionRequestV1Schema,
    PluginUiReadSessionResultV1Schema,
    PluginUiReadStoredImageRequestV1Schema,
    PluginUiReadStoredImageResultV1Schema,
    PluginUiRespondToSessionPermissionRequestV1Schema,
    PluginUiRespondToSessionPermissionResultV1Schema,
    PluginUiWatchSessionRequestV1Schema,
    PluginUiWatchLiveStreamRequestV1Schema,
    ComposerDecorationResultV1Schema,
    ComposerFocusResultV1Schema,
    ComposerReadResultV1Schema,
    ComposerSnapshotV1Schema,
    ComposerTransactionResultV1Schema,
    type PluginUiHostApiErrorCodeV1,
    type PluginUiHostApiRequestMethodV1,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiHostMethodV1,
    type PluginUiJsonValueV1,
    type PluginUiResourceSubscriptionEventV1,
    type PluginUiResourceSubscriptionRequestV1,
    type PluginUiWatchComposerRequestV1,
    type PluginUiWatchSessionRequestV1,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    OpenableContentReadResultV1Schema,
    OpenableContentStatResultV1Schema,
} from '@happier-dev/protocol/plugins/openableContent';
import { qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
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
import {
    decodePluginUiClipboardReadResult,
    decodePluginUiConfirmResult,
    decodePluginUiResourceContent,
    encodePluginUiDiagnostic,
} from '@happier-dev/plugin-sdk/host/ui';

import { resolveNegotiatedPluginSurfaceHostApiMethods } from '../hostApi/negotiatedMethods';
import { pluginSurfaceSettlementSurvivesRetirement } from '../hostApi/outwardEffectSettlement';
import { createPluginUiHostSubscriptionRegistry } from '../hostApi/subscriptions';
import {
    createPluginSurfaceHostApiPluginErrorData,
    settlePluginSurfaceHostApiRequest,
    type PluginSurfaceHostApiRequestOptions,
} from '../surfaces/createPluginSurfaceHostApi';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { decodeBase64 } from '@/encryption/base64';
import { createSelectedActionInputCustody } from '../hostApi/selectedActionInputCustody';

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
    watchEntityDragDrop: (payload: import('@happier-dev/protocol/plugins/ui').PluginUiWatchEntityDragDropRequestV1 & Readonly<{ subscriptionId: string }>, listener: (state: import('@happier-dev/protocol/plugins/ui').PluginUiEntityDragDropStateV1) => void, options?: PluginSurfaceHostApiRequestOptions) => Promise<PluginReactNativeHostRequestSubscription>;
    watchLiveStream: (payload: import('@happier-dev/protocol/plugins/ui').PluginUiWatchLiveStreamRequestV1,
        listener: (event: PluginUiResourceSubscriptionEventV1) => void,
        options?: PluginSurfaceHostApiRequestOptions) => Promise<PluginReactNativeHostRequestSubscription>;
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
    /** A Session watch rides the same invalidation-signal lifecycle as a Resource watch. */
    watchSession: (
        payload: PluginUiWatchSessionRequestV1 & Readonly<{ subscriptionId: string }>,
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
     * therefore settles this carrier immediately — for EVERY signal-accepting
     * request, with no per-method allowlist — while the mounted handler may
     * finish its own work in the background. A response that wins the race
     * stays authoritative; a later response after withdrawal is inert. The
     * signal still travels beside the request, so a handler holding something
     * in front of the user (a confirmation dialog) can retire it and never
     * report the withdrawal as a user decision.
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

    /**
     * Establishment methods whose settlement is a host-RESOURCE lease rather
     * than an author-visible result. Their post-establishment currentness — and
     * the exact late-admission host cleanup it owes — is owned by the
     * subscription establishment paths below, so the plain-request settlement
     * rule in `request` deliberately leaves them to that owner. This is the
     * Protocol's canonical subscription family, not a second list.
     */
    const subscriptionEstablishmentMethods = new Set<PluginUiHostApiRequestMethodV1>(
        PLUGIN_UI_HOST_SUBSCRIPTION_METHODS_V1,
    );

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

        const settlement = settlePluginSurfaceHostApiRequest(
            envelope,
            () => params.handleRequest(envelope, options),
        );
        const response = await (subscriptionEstablishmentMethods.has(method)
            ? settlement
            : settleWithCallerCancellation(settlement, options?.signal));
        // The ONE settlement rule both physical carriers apply (§3.5): a
        // retirement the carrier only observes AFTER the mounted owner settled
        // an outward effect must not erase it — the navigation or settlement
        // already happened, and `stale_surface` would tell the author nothing
        // happened after something did, inviting a blind retry. Reads and
        // decisions are answers ABOUT the mount, so the same shared classifier
        // still refuses them from a mount that can no longer vouch for the
        // answer. This replaces the per-method post-request `assertActive`
        // placement it once took: adding a method can no longer require a
        // second, implicit retirement decision.
        if (
            method !== 'disposeHostResource'
            && (disposed || params.isRequestSurfaceCurrent?.(params.requestSurface) === false)
            && !subscriptionEstablishmentMethods.has(method)
            && !pluginSurfaceSettlementSurvivesRetirement({ method, response, requestPayload: payload })
        ) {
            throwHostApiError('stale_surface');
        }
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
        return await establishInvalidationSubscription(
            'watchResource',
            parsedPayload.data.subscriptionId,
            parsedPayload.data,
            listener,
            options,
        );
    }

    async function watchSession(
        payload: PluginUiWatchSessionRequestV1 & Readonly<{ subscriptionId: string }>,
        listener: (event: PluginUiResourceSubscriptionEventV1) => void,
        options?: PluginSurfaceHostApiRequestOptions,
    ): Promise<PluginReactNativeHostRequestSubscription> {
        const parsedPayload = PluginUiWatchSessionRequestV1Schema.safeParse({ sessionId: payload.sessionId });
        const subscriptionId = payload.subscriptionId.trim();
        if (!parsedPayload.success || !subscriptionId) {
            throwHostApiError('invalid_payload');
        }
        return await establishInvalidationSubscription(
            'watchSession',
            subscriptionId,
            { subscriptionId, ...parsedPayload.data },
            listener,
            options,
        );
    }

    /**
     * The one invalidation-signal establishment lifecycle. Resource and
     * Session watches differ only in their request payload; registry
     * bookkeeping, late-admission custody and `disposeHostResource`
     * retirement are shared.
     */
    async function establishInvalidationSubscription(
        method: Extract<PluginUiHostApiRequestMethodV1, 'watchResource' | 'watchSession' | 'watchLiveStream'>,
        subscriptionId: string,
        requestPayload: PluginUiJsonValueV1,
        listener: (event: PluginUiResourceSubscriptionEventV1) => void,
        options?: PluginSurfaceHostApiRequestOptions,
    ): Promise<PluginReactNativeHostRequestSubscription> {
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
        const establishment = request(method, requestPayload, options);
        let established: PluginUiJsonValueV1 | undefined;
        try {
            established = await (abortPromise
                ? Promise.race([establishment, abortPromise])
                : establishment);
        } catch (error) {
            removeAbortListener?.();
            retirePendingSubscription();
            if (abandoned) {
                // The outer establishment owner settles caller withdrawal
                // promptly. If the mounted owner admits the lease afterwards,
                // retire that exact late acknowledgement only after it exists;
                // disposing before admission can be a no-op and leak the lease.
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
                // Same late-admission custody as the Resource watch: the
                // caller settles promptly, then an admitted host lease is
                // disposed only after its acknowledgement exists.
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
        watchEntityDragDrop: async (payload, listener, options) => {
            let active = true;
            let release: (() => void) | undefined;
            const retire = () => { active = false; release?.(); };
            subscriptions.register({ surface: params.requestSurface, subscriptionId: payload.subscriptionId, release: retire, deliverValue: value => listener(PluginUiEntityDragDropStateV1Schema.parse(value)) });
            try {
                await request('watchEntityDragDrop', payload, { ...options, entityDragDropSubscription: {
                    retain: value => { if (active) release = value; else value(); },
                    publish: state => { subscriptions.publishValue(params.requestSurface, { subscriptionId: payload.subscriptionId, value: state }); },
                } });
            } catch (error) { subscriptions.dispose({ surface: params.requestSurface, subscriptionId: payload.subscriptionId }); throw error; }
            return { subscriptionId: payload.subscriptionId, dispose: async () => { subscriptions.dispose({ surface: params.requestSurface, subscriptionId: payload.subscriptionId }); } };
        },
        watchResource,
        watchSession,
        watchLiveStream: async (payload, listener, options) => {
            const parsed = PluginUiWatchLiveStreamRequestV1Schema.safeParse(payload);
            if (!parsed.success) throwHostApiError('invalid_payload');
            return await establishInvalidationSubscription('watchLiveStream', parsed.data.subscriptionId, parsed.data, listener, options);
        },
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

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throwHostApiError('unavailable', ['aborted']);
    }
}

function readCanonicalResource(value: PluginUiJsonValueV1 | undefined): ResourceContent {
    const decoded = decodePluginUiResourceContent(
        value,
        (bytesBase64) => decodeBase64(bytesBase64, 'base64'),
    );
    if (!decoded.ok) throwHostApiError('invalid_payload', [decoded.diagnostic]);
    return decoded.value;
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
 * - EVERY in-flight request call settles caller withdrawal promptly at the one
 *   request carrier — no per-method allowlist — and a mounted-handler response
 *   that loses that race is inert; the signal still travels beside the request,
 *   so a handler holding something in front of the user (`confirm`) retires it
 *   and never reports the withdrawal as a user decision;
 * - a host settlement that wins before withdrawal stays authoritative;
 *   cancellation does not promise to roll back a host effect;
 * - post-settlement retirement is decided ONCE by the shared outward-effect
 *   classifier (`../hostApi/outwardEffectSettlement`) at the request carrier,
 *   not by per-method `assertActive` placement: an accepted outward effect
 *   (including `openNewSession` and a terminal `settleEphemeralInput`)
 *   survives the retirement it caused, while reads and decisions are still
 *   refused from a mount that can no longer vouch for them. Subscription
 *   establishments keep their own establishment-currentness owner with its
 *   exact late-admission host cleanup.
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
    const selectedInputs = createSelectedActionInputCustody();
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

    /**
     * Admission for the two fire-and-forget members (`publishCurrentUiContext`,
     * `diagnostic`). They return nothing, acknowledge nothing and are called
     * from author effects and cleanups, so a synchronous throw there is not a
     * typed answer the author can act on: it unwinds React's commit and takes
     * the app down. A retired mount's publication is already void — the host
     * retired its slot synchronously — and a method the daemon has only
     * transiently withdrawn is re-advertised on recovery. Both are dropped,
     * exactly as the hosted-web client transport drops a failed request.
     * A method this mount can never serve still fails loudly as
     * `unsupported_method`: that is a capability verdict, not currentness.
     */
    function admitFireAndForget(method: PluginUiHostMethodV1): boolean {
        if (disposed || params.isCurrent?.() === false) return false;
        if (resolveNegotiatedMethods().includes(method)) return true;
        if (resolveStructuralMethods().includes(method)) return false;
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
        widgetArea: async (request, options) => {
            assertActive(options?.signal);
            assertInstalled('widgetArea');
            const payload = PluginUiWidgetAreaRequestV1Schema.safeParse(request);
            if (!payload.success) throwHostApiError('invalid_payload');
            const result = PluginUiWidgetAreaResultV1Schema.safeParse(await transport.request('widgetArea', payload.data,
                options?.signal ? { signal: options.signal } : undefined));
            if (!result.success) throwHostApiError('invalid_payload');
            return result.data;
        },
        watchEntityDragDrop: async (request, listener, options) => {
            assertActive(options?.signal); assertInstalled('watchEntityDragDrop');
            const payload = PluginUiWatchEntityDragDropRequestV1Schema.parse(request);
            subscriptionSequence += 1;
            const subscription = await transport.watchEntityDragDrop({ ...payload, subscriptionId: `${params.requestIdPrefix}:entity:${subscriptionSequence}` }, listener, options);
            if (disposed || options?.signal?.aborted) { await subscription.dispose(); assertActive(options?.signal); }
            return disposable(() => { void subscription.dispose(); });
        },
        readEntityDragItem: async (request, options) => {
            assertActive(options?.signal); assertInstalled('readEntityDragItem');
            const payload = PluginUiReadEntityDragItemRequestV1Schema.safeParse(request);
            if (!payload.success) throwHostApiError('invalid_payload');
            const result = PluginUiReadEntityDragItemResultV1Schema.safeParse(await transport.request('readEntityDragItem', payload.data, options?.signal ? { signal: options.signal } : undefined));
            if (!result.success) throwHostApiError('invalid_payload');
            return result.data;
        },
        updateEntityDragDrop: async (request, options) => {
            assertActive(options?.signal); assertInstalled('updateEntityDragDrop');
            const payload = PluginUiUpdateEntityDragDropRequestV1Schema.safeParse(request);
            if (!payload.success) throwHostApiError('invalid_payload');
            const result = PluginUiUpdateEntityDragDropResultV1Schema.safeParse(await transport.request('updateEntityDragDrop', payload.data, options?.signal ? { signal: options.signal } : undefined));
            if (!result.success) throwHostApiError('invalid_payload');
            return result.data;
        },
        version: () => Object.freeze({
            apiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
            wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
            // This mount's structural contract is stable. Transient daemon
            // reachability is reported by assertInstalled as typed
            // `unavailable`, matching the hosted-web negotiation semantics.
            methods: resolveStructuralMethods(),
        }),
        publishCurrentUiContext: (enrichment) => {
            const payload = PluginUiPublishCurrentUiContextRequestV1Schema.safeParse({ enrichment });
            if (!payload.success) throwHostApiError('invalid_payload');
            if (!admitFireAndForget('publishCurrentUiContext')) return;
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
            input?: JsonValue,
            options?: PluginUiActionExecutionOptions,
        ) => {
            assertActive(options?.signal);
            assertInstalled('executeAction');
            // This adapter only serializes the Protocol-owned raw request. It
            // does not classify host Actions or bind contributed references;
            // the mounted dispatcher owns both decisions after this transport.
            const actionRequest = PluginUiExecuteActionRequestV1Schema.safeParse({
                action,
                ...(input === undefined ? {} : { input }),
            });
            if (!actionRequest.success) throwHostApiError('invalid_payload');
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
            const custody = selectedInputs.settle(action, options?.selectedActionInput, consumeSelectedActionInput);
            if (!custody.ok) throwHostApiError('invalid_payload', [custody.reason]);
            const targetedSelection = custody.selected;
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
            const parsedResult = PluginUiSelectActionInputResultV1Schema.safeParse(result);
            if (!parsedResult.success) {
                throwHostApiError('invalid_payload', ['select_action_input_response_invalid']);
            }
            if (parsedResult.data.kind === 'submitted' && 'operation' in parsedRequest.data) {
                selectedInputs.retain(parsedRequest.data.operation, parsedResult.data, options?.signal);
            }
            return parsedResult.data;
        },
        openNewSession: async (openRequest, options) => {
            assertActive(options?.signal);
            assertInstalled('openNewSession');
            const payload = PluginUiOpenNewSessionRequestV1Schema.safeParse(openRequest);
            if (!payload.success) throwHostApiError('invalid_payload');
            const selected = options?.preparedReviewWorkspace === undefined
                ? undefined
                : selectedInputs.resolve(options.preparedReviewWorkspace);
            if (
                (payload.data.checkoutIntent === 'preparedReviewWorkspace')
                    !== (selected !== undefined)
            ) {
                throwHostApiError('invalid_payload', ['prepared_review_workspace_selection_invalid']);
            }
            // A preparation is a terminal use of this exact selected operation.
            // Retire it before crossing the mounted host boundary so success,
            // failure, cancellation and an ambiguous transport result cannot
            // leave a replayable workspace mutation.
            selected?.release();
            const requestOptions = options?.signal || selected
                ? {
                    ...(options?.signal ? { signal: options.signal } : {}),
                    ...(selected
                        ? {
                            targetedOperation: selected.carrier.operation,
                            selectedActionInput: selected.carrier.result,
                        }
                        : {}),
                }
                : undefined;
            await transport.request(
                'openNewSession',
                payload.data,
                requestOptions,
            );
            // No post-settlement `assertActive`: opening the New Session screen
            // routinely retires the requesting surface, so an accepted launch
            // stays a success (the shared outward-effect classifier owns that
            // decision at the request carrier).
        },
        settleEphemeralInput: async (settlement, options) => {
            assertActive(options?.signal);
            assertInstalled('settleEphemeralInput');
            const payload = PluginUiEphemeralInputSettlementV1Schema.safeParse(settlement);
            if (!payload.success) throwHostApiError('invalid_payload');
            await transport.request(
                'settleEphemeralInput',
                payload.data,
                options?.signal ? { signal: options.signal } : undefined,
            );
            // No post-settlement `assertActive`: the mounted owner records the
            // settlement and closes the ephemeral surface as a consequence, so
            // the accepted settlement stays a success (the shared outward-effect
            // classifier owns that decision at the request carrier).
        },
        readResource: async (resource, options) => {
            assertActive(options?.signal);
            assertInstalled('readResource');
            const result = await transport.request('readResource', {
                resource: canonicalReferencePayload(resource),
            }, options?.signal ? { signal: options.signal } : undefined);
            return readCanonicalResource(result);
        },
        statOpenableContent: async (ref, options) => {
            assertActive(options?.signal);
            assertInstalled('statOpenableContent');
            const result = await transport.request('statOpenableContent', {
                ref: { kind: ref.kind, handle: ref.handle },
            }, options?.signal ? { signal: options.signal } : undefined);
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
        readSession: async (sessionId, options) => {
            assertActive(options?.signal);
            assertInstalled('readSession');
            const payload = PluginUiReadSessionRequestV1Schema.safeParse({ sessionId });
            if (!payload.success) throwHostApiError('invalid_payload');
            const result = PluginUiReadSessionResultV1Schema.safeParse(await transport.request(
                'readSession',
                payload.data,
                options?.signal ? { signal: options.signal } : undefined,
            ));
            if (!result.success) throwHostApiError('invalid_payload');
            return result.data;
        },
        readStoredImage: async (image, options) => {
            assertActive(options?.signal);
            assertInstalled('readStoredImage');
            const payload = PluginUiReadStoredImageRequestV1Schema.safeParse({ image });
            if (!payload.success) throwHostApiError('invalid_payload');
            const result = PluginUiReadStoredImageResultV1Schema.safeParse(await transport.request(
                'readStoredImage',
                payload.data,
                options?.signal ? { signal: options.signal } : undefined,
            ));
            if (!result.success) throwHostApiError('invalid_payload');
            return result.data;
        },
        watchSession: async (sessionId, listener, options) => {
            assertActive(options?.signal);
            assertInstalled('watchSession');
            subscriptionSequence += 1;
            const subscription = await transport.watchSession(
                {
                    subscriptionId: `${params.requestIdPrefix}:session:${subscriptionSequence}`,
                    sessionId,
                },
                listener,
                options?.signal ? { signal: options.signal } : undefined,
            );
            if (disposed || options?.signal?.aborted) {
                await subscription.dispose();
                assertActive(options?.signal);
            }
            return disposable(() => { void subscription.dispose(); });
        },
        watchLiveStream: async (reference, listener, options) => {
            assertActive(options?.signal); assertInstalled('watchLiveStream');
            subscriptionSequence += 1;
            const subscription = await transport.watchLiveStream({ reference,
                subscriptionId: `${params.requestIdPrefix}:stream:${subscriptionSequence}` }, listener,
                options?.signal ? { signal: options.signal } : undefined);
            if (disposed || options?.signal?.aborted) { await subscription.dispose(); assertActive(options?.signal); }
            return disposable(() => { void subscription.dispose(); });
        },
        respondToSessionPermission: async (responseRequest, options) => {
            assertActive(options?.signal);
            assertInstalled('respondToSessionPermission');
            const payload = PluginUiRespondToSessionPermissionRequestV1Schema.safeParse(responseRequest);
            if (!payload.success) throwHostApiError('invalid_payload');
            const result = PluginUiRespondToSessionPermissionResultV1Schema.safeParse(await transport.request(
                'respondToSessionPermission',
                payload.data,
                options?.signal ? { signal: options.signal } : undefined,
            ));
            if (!result.success) throwHostApiError('invalid_payload');
            return result.data;
        },
        activeComposer: async (options) => {
            assertActive(options?.signal);
            assertInstalled('activeComposer');
            const result = await transport.request(
                'activeComposer',
                undefined,
                options?.signal ? { signal: options.signal } : undefined,
            );
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
            // The settlement rule at the request carrier refuses a staged media
            // decision from a retired mount, so such a handle can never
            // re-enter a live draft. The transfer owner retains completed
            // stages for its own explicit-release/expiry lifecycle.
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
        openConnectedAccounts: async (request = {}, options) => {
            assertActive(options?.signal);
            assertInstalled('openConnectedAccounts');
            const payload = PluginUiOpenConnectedAccountsRequestV1Schema.safeParse(request);
            if (!payload.success) throwHostApiError('invalid_payload');
            await transport.request('openConnectedAccounts', payload.data, options);
        },
        openSurface: async (destination, input, options) => {
            assertActive(options?.signal);
            assertInstalled('openSurface');
            await transport.request('openSurface', {
                destination: qualifyPluginContributionReferenceV1(
                    destination,
                    params.requestSurface.pluginId,
                ),
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
                ...(options?.action === undefined ? {} : { action: options.action }),
            }, options?.signal ? { signal: options.signal } : undefined);
            // A host that ignored the cancellation still may not answer a
            // question the author withdrew: the request carrier settles a
            // mid-flight withdrawal as the typed failure — never a boolean the
            // plugin would read as the user's decision — while the signal
            // beside the request lets the mount dismiss the open dialog.
            const decoded = decodePluginUiConfirmResult(result);
            if (!decoded.ok) throwHostApiError('invalid_payload', [decoded.diagnostic]);
            return decoded.value;
        },
        diagnostic: (data) => {
            if (!admitFireAndForget('diagnostic')) return;
            void transport.request('diagnostic', encodePluginUiDiagnostic(data)).catch(() => undefined);
        },
        readClipboard: async (options) => {
            assertActive(options?.signal);
            assertInstalled('readClipboard');
            const result = await transport.request(
                'readClipboard',
                undefined,
                options?.signal ? { signal: options.signal } : undefined,
            );
            const decoded = decodePluginUiClipboardReadResult(result);
            if (!decoded.ok) throwHostApiError('invalid_payload', [decoded.diagnostic]);
            return decoded.value;
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
            selectedInputs.dispose();
            for (const dispose of [...disposables]) dispose();
            contextWatchers.clear();
            transport.dispose();
        },
    });
}
