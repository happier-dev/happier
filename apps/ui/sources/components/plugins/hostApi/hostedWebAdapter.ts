import {
    PLUGIN_HOSTED_WEB_COLLECTION_UI_QUERY_BRIDGE_KIND_V1,
    PLUGIN_UI_HOST_SUBSCRIPTION_METHODS_V1,
    PLUGIN_UI_HOST_API_VERSION_V1,
    PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
    ComposerSnapshotV1Schema,
    PluginHostedWebBridgeCollectionUiQueryMessageEnvelopeV1Schema,
    PluginHostedWebBridgeHostMessageEnvelopeV1Schema,
    PluginHostedWebBridgeResponseEnvelopeV1Schema,
    PluginHostedWebCollectionUiQueryBridgeRequestV1Schema,
    PluginUiHostApiRequestEnvelopeV1Schema,
    PluginUiHostApiWireEnvelopeV1Schema,
    PluginUiSelectActionInputRequestV1Schema,
    PluginUiSelectActionInputResultV1Schema,
    pluginUiSelectedActionInputMatchesOperation,
    pluginUiSelectedActionInputsEqual,
    pluginUiTargetedContributionOperationKey,
    readPluginUiHostApiErrorPayload,
    isPluginUiHostApiVersionCompatibleV1,
    type PluginHostedWebBridgeEnvelopeV1,
    type PluginHostedWebBridgeHostMessageEnvelopeV1,
    type PluginHostedWebCollectionUiQueryBridgeChangeV1,
    type PluginHostedWebCollectionUiQueryBridgeOperationV1,
    type PluginHostedWebCollectionUiQueryBridgeResponseV1,
    type PluginUiLaunchInputV1,
    type PluginUiSubPathV1,
    type ComposerRefV1,
    type PluginHostedWebBridgeResponseEnvelopeV1,
    type PluginUiHostApiErrorCodeV1,
    type PluginUiHostMethodV1,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiHostApiWireEnvelopeV1,
    type PluginUiHostApiWireIdentityV1,
    type PluginUiJsonValueV1,
    type ComposerSnapshotV1,
    type PluginUiResourceSubscriptionEventV1,
    type PluginUiSurfaceContextV1,
    type PluginUiTargetedContributionOperationV1,
    type PluginUiSelectActionInputResultV1,
} from '@happier-dev/protocol/plugins/ui';

import { resolveNegotiatedPluginSurfaceHostApiMethods } from './negotiatedMethods';
import {
    createPluginUiHostReadyStateStore,
    pluginUiSurfaceContextsMatch,
    type PluginUiHostReadyStateChange,
    type PluginUiHostReadyStateSnapshot,
} from './readyState';
import type { PluginSurfaceHostApiRequestOptions } from '../surfaces/createPluginSurfaceHostApi';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

export type PluginHostedWebHostApiRequestHandler = (
    request: PluginUiHostApiRequestEnvelopeV1,
    options?: PluginSurfaceHostApiRequestOptions,
) => PluginUiJsonValueV1 | Promise<PluginUiJsonValueV1>;

/**
 * Data owns query semantics; this mounted transport owns only the one framed
 * request/cancel/currentness/disposal lifecycle around that owner.
 */
export type PluginHostedWebCollectionUiQueryBridge = Readonly<{
    handle(
        operation: PluginHostedWebCollectionUiQueryBridgeOperationV1,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<PluginHostedWebCollectionUiQueryBridgeResponseV1>;
    dispose(): void;
}>;

export type PluginHostedWebCollectionUiQueryBridgeFactory = (
    input: Readonly<{
        publish(change: PluginHostedWebCollectionUiQueryBridgeChangeV1): void;
    }>,
) => PluginHostedWebCollectionUiQueryBridge;

export type PluginHostedWebCanonicalHostApiBinding = Readonly<{
    identity: PluginUiHostApiWireIdentityV1;
    surface: PluginUiJsonValueV1;
    methods: readonly PluginUiHostMethodV1[];
}>;

/**
 * The host->frame sink the mounted frame supplies (EU-8). Its presence is what
 * makes this transport able to serve a subscription at all.
 */
export type PluginHostedWebHostMessageSink = (
    envelope: PluginHostedWebBridgeHostMessageEnvelopeV1,
) => void;

/**
 * The subscription methods this transport has a PRODUCER for.
 *
 * `watchContext` is answered from the mount's own surface fact, which this
 * adapter holds and pushes. `watchResource` (EU-4b) and a factual
 * `watchComposer` and Composer input locks are established through the
 * mount's own host handlers, then use this same framed subscription lifecycle
 * for delivery or lease retirement. Neither is served unless the mount
 * actually installed it; the `satisfies` binding keeps this inside the
 * canonical vocabulary.
 */
const HOSTED_WEB_PRODUCED_SUBSCRIPTION_METHODS = new Set<PluginUiHostMethodV1>(
    [
        'watchContext',
        'watchResource',
        'watchComposer',
        'acquireComposerInputLock',
    ] as const satisfies readonly PluginUiHostMethodV1[],
);
const HOSTED_WEB_HOST_RESOURCE_SUBSCRIPTION_METHODS = new Set<PluginUiHostMethodV1>(
    [
        'watchResource',
        'watchComposer',
        'acquireComposerInputLock',
    ] as const satisfies readonly PluginUiHostMethodV1[],
);
const CANONICAL_SUBSCRIPTION_METHODS = new Set<PluginUiHostMethodV1>(
    PLUGIN_UI_HOST_SUBSCRIPTION_METHODS_V1,
);

export type PluginHostedWebHostApiAuditEvent = Readonly<{
    type: 'readyRecorded' | 'readyDuplicate' | 'readyStale' | 'readyTimedOut';
    surface: PluginUiSurfaceContextV1;
}>;

/**
 * The mounted document owner lends this exact physical publisher only to a
 * factual Composer child. It addresses the bridge's existing guest-owned
 * subscription id; it is not a second event channel or registry.
 */
export type PluginHostedWebComposerSubscriptionPublisher = (input: Readonly<{
    subscriptionId: string;
    snapshot: ComposerSnapshotV1;
}>) => boolean;

export type PluginHostedWebHostApiBridgeHandler = ((
    envelope: PluginHostedWebBridgeEnvelopeV1,
) => Promise<PluginHostedWebBridgeResponseEnvelopeV1>) & Readonly<{
    getReadyState(): PluginUiHostReadyStateSnapshot;
    recordReadyTimeout(): PluginUiHostReadyStateSnapshot;
    /**
     * The mount's context producer for this transport — the hosted-web twin of
     * `CanonicalPluginReactNativeHostApiAdapter.pushSurfaceContext`. Every
     * established `watchContext` subscription observes the new snapshot in
     * order; an identical snapshot is not republished, so establishing a
     * subscription is not itself an event.
     */
    pushSurfaceContext(surface: PluginUiJsonValueV1): void;
    /**
     * EU-4b: deliver one live resource invalidation to whichever established
     * subscription it names. The event comes from the mount's ONE invalidation
     * sink — the same sink the React Native transport observes — so hosted web
     * gains delivery without a second subscription owner or a second producer.
     */
    publishResourceSubscriptionEvent(
        event: PluginUiResourceSubscriptionEventV1,
    ): boolean;
    /** Delivers one exact Composer snapshot through the existing framed wire. */
    publishComposerSubscriptionEvent: PluginHostedWebComposerSubscriptionPublisher;
    dispose(): void;
}>;

/**
 * The hosted wire cannot retain the SDK client's object identity (the RN
 * transport has a retained value). This is a mount-local lookup key for one
 * exact admitted operation, including its role. It is not guest authority.
 */
function createBridgeResponse(params: Readonly<{
    envelope: PluginHostedWebBridgeEnvelopeV1;
    kind: PluginHostedWebBridgeResponseEnvelopeV1['kind'];
    payload: PluginUiJsonValueV1;
}>): PluginHostedWebBridgeResponseEnvelopeV1 {
    return PluginHostedWebBridgeResponseEnvelopeV1Schema.parse({
        version: 1,
        pluginId: params.envelope.pluginId,
        contributionId: params.envelope.contributionId,
        surfaceId: params.envelope.surfaceId,
        sessionId: params.envelope.sessionId,
        nonce: params.envelope.nonce,
        sequence: params.envelope.sequence,
        requestSequence: params.envelope.sequence,
        kind: params.kind,
        payload: params.payload,
    });
}

function createBridgeError(
    envelope: PluginHostedWebBridgeEnvelopeV1,
    code: PluginUiHostApiErrorCodeV1,
    diagnostics: readonly string[] = [],
): PluginHostedWebBridgeResponseEnvelopeV1 {
    return createBridgeResponse({
        envelope,
        kind: 'error',
        payload: {
            code,
            diagnostics: [...diagnostics],
        },
    });
}

function isLifecycleBridgeMessage(kind: PluginHostedWebBridgeEnvelopeV1['kind']): boolean {
    return kind === 'heightChanged'
        || kind === 'error';
}

function wireIdentitiesMatch(
    expected: PluginUiHostApiWireIdentityV1,
    actual: PluginUiHostApiWireIdentityV1,
): boolean {
    return expected.pluginId === actual.pluginId
        && expected.pluginVersion === actual.pluginVersion
        && expected.viewId === actual.viewId
        && expected.generation === actual.generation
        && expected.sessionId === actual.sessionId;
}

export function createPluginHostedWebHostApiBridgeHandler(params: Readonly<{
    surface: PluginUiSurfaceContextV1;
    requestIdPrefix: string;
    /**
     * The per-mount bridge nonce the host minted and the frame URL carries. A
     * host push echoes it exactly as a response does, so the guest applies ONE
     * addressing check to both directions.
     */
    bridgeNonce: string;
    handleRequest?: PluginHostedWebHostApiRequestHandler;
    /**
     * The mounted host supplies this only when its canonical Account-lifetime
     * Data client and the descriptor's declared bridge arm are both present.
     */
    createCollectionUiQueryBridge?: PluginHostedWebCollectionUiQueryBridgeFactory;
    canonicalHostApi?: PluginHostedWebCanonicalHostApiBinding;
    /**
     * The mounted owner may change the factual installed-method set without
     * changing the bound surface. A later guest `negotiate` reads this current
     * fact; it is deliberately not a second bridge or lifetime owner.
     */
    readInstalledMethods?: () => readonly PluginUiHostMethodV1[];
    /**
     * EU-8: the mounted frame's host->frame sink. Absent when no frame is
     * attached, which is exactly when this transport must not advertise a
     * subscription method.
     */
    postToFrame?: PluginHostedWebHostMessageSink;
    bootstrap?: Readonly<{
        frameOrigin: string;
        launchInput?: PluginUiLaunchInputV1;
        subPath?: PluginUiSubPathV1;
        composerRef?: ComposerRefV1;
    }>;
    /** The bound controller owns currentness; this adapter only consults it. */
    isCurrent?: () => boolean;
    onReadyStateChange?: (state: PluginUiHostReadyStateChange) => void;
    audit?: (event: PluginHostedWebHostApiAuditEvent) => void;
    nowMs?: () => number;
}>): PluginHostedWebHostApiBridgeHandler {
    const readyState = createPluginUiHostReadyStateStore({ nowMs: params.nowMs });
    // UI-D02/UI-D03: what this transport can actually serve. The mount's
    // factually installed methods run through the ONE negotiated-method rule
    // (shared with the React Native mount), are narrowed to what the hosted-web
    // transport carries, and are narrowed again to the mount-owned methods alone
    // when no host request handler is wired.
    const resolveCanonicalMethods = () => new Set<PluginUiHostMethodV1>(
        resolveNegotiatedPluginSurfaceHostApiMethods({
            installedMethods: params.readInstalledMethods?.() ?? params.canonicalHostApi?.methods ?? [],
            canPushToSurface: params.postToFrame !== undefined,
        }).filter((method) => {
            if (CANONICAL_SUBSCRIPTION_METHODS.has(method)) {
                return HOSTED_WEB_PRODUCED_SUBSCRIPTION_METHODS.has(method);
            }
            return method === 'context' || params.handleRequest !== undefined;
        }),
    );
    let canonicalMethods = resolveCanonicalMethods();
    /**
     * In-flight canonical requests, keyed by wire request id, each holding the
     * caller's cancellation. A `cancel` message both suppresses the answer and
     * ABORTS the request at the mount — otherwise a hosted-web plugin that
     * withdrew a `confirm` left the dialog on screen waiting for an answer
     * nobody would receive, the same defect the React Native adapter had.
     */
    const canonicalPending = new Map<string, AbortController>();
    /**
     * A successful selectActionInput is the only producer for targeted execute
     * provenance in this wire transport. There is one latest active settlement
     * per admitted operation; a replacement atomically retires its predecessor.
     * The guest's later envelope is an untrusted value lookup only.
     */
    const selectedTargetedOperations = new Map<string, Readonly<{
        operation: PluginUiTargetedContributionOperationV1;
        result: Extract<PluginUiSelectActionInputResultV1, Readonly<{ kind: 'submitted' }>>;
        /** The guest's one existing select request correlation id. */
        selectionRequestId: string;
    }>>();

    function hasRetainedSelectedTargetedOperationRequestId(requestId: string): boolean {
        for (const retained of selectedTargetedOperations.values()) {
            if (retained.selectionRequestId === requestId) return true;
        }
        return false;
    }

    function retireSelectedTargetedOperationBySelectionRequestId(requestId: string): void {
        for (const [operationKey, retained] of selectedTargetedOperations) {
            if (retained.selectionRequestId !== requestId) continue;
            // A replacement uses a fresh request id. The reference guard keeps
            // a stale raw cancel from deleting a newer settlement even if a
            // malicious guest tries to collide operation identities.
            if (selectedTargetedOperations.get(operationKey) === retained) {
                selectedTargetedOperations.delete(operationKey);
            }
            return;
        }
    }
    /**
     * Outer bridge request sequences are transport-owned correlation. Keeping
     * cancellation here avoids inventing a second Data request identity.
     */
    const collectionUiQueryPending = new Map<number, AbortController>();
    /**
     * Established `watchContext` subscriptions, by the guest's own subscription
     * id. The id is the guest's, so a retirement it sends and an event the host
     * pushes address the same subscription without a second identity space.
     */
    const contextSubscriptions = new Set<string>();
    /**
     * The bridge's one host-resource subscription registry, keyed by the
     * guest's own subscription id. Resource and factual Composer watches use
     * the same request/retire/currentness lifecycle; only their published
     * values differ. A pending entry has reached the mount but has not yet
     * acknowledged establishment. `retired` keeps that same id unavailable
     * only while an admitted cleanup or late establishment is settling, so a
     * raw guest cannot reuse the id and make the old completion act on its
     * successor.
     */
    const hostResourceSubscriptions = new Map<string, 'pending' | 'active' | 'retired'>();
    let currentSurface: PluginUiJsonValueV1 | undefined = params.canonicalHostApi?.surface;
    let currentSurfaceSemanticKey = currentSurface === undefined
        ? undefined
        : stableJsonStringify(currentSurface);
    const currentBootstrap = params.bootstrap;
    let pushSequence = 0;
    let disposed = false;

    function isCurrent(): boolean {
        try {
            return params.isCurrent?.() ?? true;
        } catch {
            return false;
        }
    }

    /**
     * Post one canonical wire envelope to the frame.
     *
     * Every host-originated fact goes through here, so the frame sees exactly
     * one host->frame envelope shape and the surface identity on it is always
     * the mount's own. A frame that is not attached simply receives nothing —
     * there is deliberately no queue: the sink is installed with the frame,
     * long before a guest can establish anything, so a buffer would only hide a
     * wiring bug.
     */
    function pushToFrame(
        wire: PluginUiHostApiWireEnvelopeV1,
        terminal = false,
    ): void {
        const sink = params.postToFrame;
        if (!sink || (!terminal && !isCurrent())) return;
        pushSequence += 1;
        const envelope = PluginHostedWebBridgeHostMessageEnvelopeV1Schema.safeParse({
            version: 1,
            direction: 'hostToFrame',
            pluginId: params.surface.pluginId,
            contributionId: params.surface.contributionId,
            surfaceId: params.surface.surfaceId,
            ...(params.surface.sessionId === undefined ? {} : { sessionId: params.surface.sessionId }),
            nonce: params.bridgeNonce,
            sequence: pushSequence,
            kind: 'hostApi',
            payload: wire,
        });
        // A host that cannot build a valid envelope pushes nothing rather than
        // shipping an unparseable message the guest would silently drop.
        if (envelope.success) sink(envelope.data);
    }

    /** The Data wakeup uses the exact same mounted host->frame sink and nonce. */
    function pushCollectionUiQueryChange(
        change: PluginHostedWebCollectionUiQueryBridgeChangeV1,
    ): void {
        const sink = params.postToFrame;
        if (disposed || !sink || !isCurrent()) return;
        pushSequence += 1;
        const envelope = PluginHostedWebBridgeCollectionUiQueryMessageEnvelopeV1Schema.safeParse({
            version: 1,
            direction: 'hostToFrame',
            pluginId: params.surface.pluginId,
            contributionId: params.surface.contributionId,
            surfaceId: params.surface.surfaceId,
            ...(params.surface.sessionId === undefined ? {} : { sessionId: params.surface.sessionId }),
            nonce: params.bridgeNonce,
            sequence: pushSequence,
            kind: PLUGIN_HOSTED_WEB_COLLECTION_UI_QUERY_BRIDGE_KIND_V1,
            payload: change,
        });
        if (envelope.success) sink(envelope.data);
    }

    function pushBootstrapToFrame(): void {
        const sink = params.postToFrame;
        const binding = params.canonicalHostApi;
        const bootstrap = currentBootstrap;
        if (disposed || !sink || !binding || !bootstrap || !isCurrent()) return;
        pushSequence += 1;
        const envelope = PluginHostedWebBridgeHostMessageEnvelopeV1Schema.safeParse({
            version: 1,
            direction: 'hostToFrame',
            pluginId: params.surface.pluginId,
            contributionId: params.surface.contributionId,
            surfaceId: params.surface.surfaceId,
            ...(params.surface.sessionId === undefined ? {} : { sessionId: params.surface.sessionId }),
            nonce: params.bridgeNonce,
            sequence: pushSequence,
            origin: bootstrap.frameOrigin,
            kind: 'bootstrap',
            payload: {
                apiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
                wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
                identity: binding.identity,
                ...(bootstrap.subPath === undefined ? {} : { subPath: bootstrap.subPath }),
                ...(bootstrap.launchInput === undefined ? {} : { launchInput: bootstrap.launchInput }),
                ...(bootstrap.composerRef === undefined ? {} : { composerRef: bootstrap.composerRef }),
            },
        });
        if (envelope.success) sink(envelope.data);
    }

    // The Data adapter is created once for this mounted transport, over the
    // existing Account-lifetime client. It has no independent lifecycle.
    const collectionUiQueryBridge = params.createCollectionUiQueryBridge?.({
        publish: pushCollectionUiQueryChange,
    });

    /**
     * Retire one daemon-side subscription through the mount's own transport
     * operation. Best effort by design: local retirement is already final, and
     * the daemon reclaims a subscription nobody polls.
     */
    async function retireHostResourceSubscription(subscriptionId: string): Promise<void> {
        if (!params.handleRequest) return;
        const request = PluginUiHostApiRequestEnvelopeV1Schema.safeParse({
            version: 1,
            requestId: `${params.requestIdPrefix}:canonical:resource-retire:${subscriptionId}`,
            surface: params.surface,
            method: 'disposeHostResource',
            payload: { subscriptionId },
        });
        if (!request.success) return;
        try {
            await params.handleRequest(request.data);
        } catch {
            // Local retirement remains final when the host boundary is unavailable.
        }
    }

    function canonicalBridgeResponse(
        envelope: PluginHostedWebBridgeEnvelopeV1,
        wire: PluginUiHostApiWireEnvelopeV1,
    ): PluginHostedWebBridgeResponseEnvelopeV1 {
        return createBridgeResponse({ envelope, kind: 'result', payload: wire });
    }

    function canonicalBridgeAck(
        envelope: PluginHostedWebBridgeEnvelopeV1,
    ): PluginHostedWebBridgeResponseEnvelopeV1 {
        return createBridgeResponse({ envelope, kind: 'ack', payload: null });
    }

    function canonicalDisconnected(
        envelope: PluginHostedWebBridgeEnvelopeV1,
        reason: string,
    ): PluginHostedWebBridgeResponseEnvelopeV1 {
        const binding = params.canonicalHostApi;
        if (!binding) return createBridgeError(envelope, 'unsupported_method');
        return canonicalBridgeResponse(envelope, PluginUiHostApiWireEnvelopeV1Schema.parse({
            wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
            kind: 'disconnected',
            identity: binding.identity,
            reason,
        }));
    }

    function canonicalRequestError(
        envelope: PluginHostedWebBridgeEnvelopeV1,
        // Any wire message the host answers by request id: an ordinary request
        // and a subscription establishment settle through the same path, so
        // they must fail through the same typed envelope too.
        message: Readonly<{
            identity: PluginUiHostApiWireIdentityV1;
            requestId: string;
            method: PluginUiHostMethodV1;
        }>,
        code: string,
        diagnostics: readonly string[] = [],
    ): PluginHostedWebBridgeResponseEnvelopeV1 {
        return canonicalBridgeResponse(envelope, PluginUiHostApiWireEnvelopeV1Schema.parse({
            wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
            kind: 'error',
            identity: message.identity,
            requestId: message.requestId,
            method: message.method,
            error: {
                name: 'PluginError',
                code,
                retryable: code === 'unavailable' || code === 'timeout',
                ...(diagnostics.length === 0
                    ? {}
                    : {
                        diagnostics: diagnostics.map((diagnostic) => ({
                            code: diagnostic,
                            severity: 'error' as const,
                        })),
                    }),
            },
        }));
    }

    async function handleCanonicalWireEnvelope(
        envelope: PluginHostedWebBridgeEnvelopeV1,
    ): Promise<PluginHostedWebBridgeResponseEnvelopeV1> {
        const binding = params.canonicalHostApi;
        if (!binding) return createBridgeError(envelope, 'unsupported_method');
        const parsed = PluginUiHostApiWireEnvelopeV1Schema.safeParse(envelope.payload);
        if (!parsed.success) return createBridgeError(envelope, 'invalid_payload');
        const message = parsed.data;
        if (!wireIdentitiesMatch(binding.identity, message.identity)) {
            return canonicalDisconnected(envelope, 'stale_surface');
        }
        if (disposed) return canonicalDisconnected(envelope, 'host_api_handler_disposed');

        if (message.kind === 'negotiate') {
            if (!isPluginUiHostApiVersionCompatibleV1(message.apiRange)) {
                return canonicalDisconnected(envelope, 'incompatible_api_version');
            }
            const negotiatedMethods = resolveCanonicalMethods();
            canonicalMethods = negotiatedMethods;
            return canonicalBridgeResponse(envelope, PluginUiHostApiWireEnvelopeV1Schema.parse({
                wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
                kind: 'negotiated',
                identity: binding.identity,
                apiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
                methods: [...canonicalMethods],
                // The snapshot a late negotiation receives is the CURRENT one,
                // not the one this handler was constructed with — otherwise a
                // frame that reloads after a theme change negotiates stale facts
                // and only learns the truth on its next push.
                surface: currentSurface ?? binding.surface,
            }));
        }
        if (message.kind === 'cancel') {
            retireSelectedTargetedOperationBySelectionRequestId(message.requestId);
            canonicalPending.get(message.requestId)?.abort();
            return canonicalBridgeAck(envelope);
        }
        if (message.kind === 'disposeHostResource') {
            contextSubscriptions.delete(message.subscriptionId);
            const state = hostResourceSubscriptions.get(message.subscriptionId);
            if (state === 'active') {
                hostResourceSubscriptions.set(message.subscriptionId, 'retired');
                await retireHostResourceSubscription(message.subscriptionId);
                if (hostResourceSubscriptions.get(message.subscriptionId) === 'retired') {
                    hostResourceSubscriptions.delete(message.subscriptionId);
                }
            } else if (state === 'pending') {
                // A pending request cannot be retired until its mount-side
                // host-resource call settles. Retain its id as a short-lived
                // tombstone so an immediate reuse cannot steal that settlement.
                hostResourceSubscriptions.set(message.subscriptionId, 'retired');
            }
            return canonicalBridgeAck(envelope);
        }
        if (message.kind === 'subscribe') {
            // Establishment is answered on the RESPONSE path and events arrive
            // on the push path, exactly as the React Native mount does it: the
            // client admits the subscription when this settles and buffers any
            // event that races the acknowledgement.
            // A subscription method this transport cannot feed is refused here
            // as well as withheld from the advertised set, so an author who
            // ignores `version().methods` still gets a typed refusal instead of
            // a subscription that observes nothing forever.
            if (!HOSTED_WEB_PRODUCED_SUBSCRIPTION_METHODS.has(message.method)
                || !canonicalMethods.has(message.method)) {
                return canonicalRequestError(envelope, message, 'unsupported_method');
            }
            if (
                contextSubscriptions.has(message.subscriptionId)
                || hostResourceSubscriptions.has(message.subscriptionId)
            ) {
                return canonicalRequestError(
                    envelope,
                    message,
                    'invalid_payload',
                    ['duplicate_subscription_id'],
                );
            }
            let admission: PluginUiJsonValueV1 | undefined;
            if (HOSTED_WEB_HOST_RESOURCE_SUBSCRIPTION_METHODS.has(message.method)) {
                // Establishment reaches the mount's own `watchResource`,
                // factual `watchComposer`, or Composer-lock handler. The
                // guest's own id is the key, so request retirement and typed
                // event delivery address the same existing lifecycle rather
                // than a second channel.
                if (!params.handleRequest) {
                    return canonicalRequestError(envelope, message, 'unavailable');
                }
                const request = PluginUiHostApiRequestEnvelopeV1Schema.safeParse({
                    version: 1,
                    requestId: `${params.requestIdPrefix}:canonical:${message.requestId}`,
                    surface: params.surface,
                    method: message.method,
                    payload: {
                        subscriptionId: message.subscriptionId,
                        ...(message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload)
                            ? message.payload
                            : {}),
                    },
                });
                if (!request.success) return canonicalRequestError(envelope, message, 'invalid_payload');
                hostResourceSubscriptions.set(message.subscriptionId, 'pending');
                try {
                    admission = await params.handleRequest(request.data);
                    const hostError = readPluginUiHostApiErrorPayload(admission);
                    if (hostError) {
                        hostResourceSubscriptions.delete(message.subscriptionId);
                        return canonicalRequestError(envelope, message, hostError.code, hostError.diagnostics);
                    }
                } catch {
                    hostResourceSubscriptions.delete(message.subscriptionId);
                    return canonicalRequestError(envelope, message, 'internal_error', ['host_api_handler_failed']);
                }
                if (disposed || !isCurrent() || hostResourceSubscriptions.get(message.subscriptionId) !== 'pending') {
                    // The mount admitted a subscription after either this bridge,
                    // its bound surface, or the guest subscription retired. The
                    // completion is the first safe point at which the one
                    // host-resource lifecycle can close it. Keep its retired id
                    // reserved until that id-only cleanup settles, otherwise a
                    // successor could be mistaken for the abandoned observer.
                    await retireHostResourceSubscription(message.subscriptionId);
                    hostResourceSubscriptions.delete(message.subscriptionId);
                    return canonicalDisconnected(
                        envelope,
                        disposed ? 'host_api_handler_disposed' : 'stale_surface',
                    );
                }
                hostResourceSubscriptions.set(message.subscriptionId, 'active');
            } else {
                contextSubscriptions.add(message.subscriptionId);
            }
            return canonicalBridgeResponse(envelope, PluginUiHostApiWireEnvelopeV1Schema.parse({
                wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
                kind: 'result',
                identity: binding.identity,
                requestId: message.requestId,
                method: message.method,
                // The canonical Resource-watch owner has already established
                // this subscription and returned its baseline. The bridge is
                // transport-only: preserve that JSON acknowledgement so the
                // SDK client can match its exact subscription and validate the
                // canonical digest before using it as a baseline.
                ...(admission === undefined ? {} : { result: admission }),
            }));
        }
        if (message.kind !== 'request') return canonicalBridgeAck(envelope);
        if (!canonicalMethods.has(message.method)) {
            return canonicalRequestError(envelope, message, 'unsupported_method');
        }
        if (message.method === 'context') {
            return canonicalBridgeResponse(envelope, PluginUiHostApiWireEnvelopeV1Schema.parse({
                wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
                kind: 'result',
                identity: binding.identity,
                requestId: message.requestId,
                method: message.method,
                result: currentSurface ?? binding.surface,
            }));
        }
        if (!params.handleRequest) return canonicalRequestError(envelope, message, 'unavailable');
        const request = PluginUiHostApiRequestEnvelopeV1Schema.safeParse({
            version: 1,
            requestId: `${params.requestIdPrefix}:canonical:${message.requestId}`,
            surface: params.surface,
            method: message.method,
            ...(message.payload === undefined ? {} : { payload: message.payload }),
        });
        if (!request.success) return canonicalRequestError(envelope, message, 'invalid_payload');
        const selectionRequest = message.method === 'selectActionInput'
            ? PluginUiSelectActionInputRequestV1Schema.safeParse(request.data.payload)
            : null;
        if (selectionRequest && !selectionRequest.success) {
            return canonicalRequestError(envelope, message, 'invalid_payload');
        }
        // This one bridge owns request correlation. A raw guest cannot reuse a
        // completed select request id as an execution id and make its later
        // cancel ambiguous with the retained selection lifetime.
        if (
            canonicalPending.has(message.requestId)
            || hasRetainedSelectedTargetedOperationRequestId(message.requestId)
        ) {
            return canonicalRequestError(envelope, message, 'invalid_payload', ['duplicate_request_id']);
        }
        let targetedSelection: Readonly<{
            operation: PluginUiTargetedContributionOperationV1;
            result: Extract<PluginUiSelectActionInputResultV1, Readonly<{ kind: 'submitted' }>>;
        }> | undefined;
        let targetedSelectionKey: string | undefined;
        if (message.targetedOperation !== undefined || message.selectedActionInput !== undefined) {
            const selectedKey = message.targetedOperation === undefined
                ? undefined
                : pluginUiTargetedContributionOperationKey(message.targetedOperation);
            targetedSelectionKey = selectedKey;
            targetedSelection = selectedKey === undefined
                ? undefined
                : selectedTargetedOperations.get(selectedKey);
            if (
                message.method !== 'executeAction'
                || message.targetedOperation === undefined
                || message.selectedActionInput === undefined
                || !targetedSelection
                || !pluginUiSelectedActionInputMatchesOperation(
                    message.selectedActionInput,
                    message.targetedOperation,
                )
                || !pluginUiSelectedActionInputsEqual(
                    targetedSelection.result,
                    message.selectedActionInput,
                )
            ) {
                return canonicalRequestError(envelope, message, 'invalid_payload');
            }
        }
        if (message.consumeSelectedActionInput === true) {
            // The strict wire schema already requires the exact paired carrier;
            // this reference check is the mounted host's authority boundary.
            // It deletes before `handleRequest`, so success, failure and
            // cancellation cannot leave a replayable selected settlement.
            if (
                targetedSelection === undefined
                || targetedSelectionKey === undefined
                || selectedTargetedOperations.get(targetedSelectionKey) !== targetedSelection
            ) {
                return canonicalRequestError(envelope, message, 'invalid_payload');
            }
            selectedTargetedOperations.delete(targetedSelectionKey);
        }
        const cancellation = new AbortController();
        canonicalPending.set(message.requestId, cancellation);
        try {
            const result = await params.handleRequest(request.data, {
                signal: cancellation.signal,
                ...(targetedSelection === undefined
                    ? {}
                    : {
                        targetedOperation: targetedSelection.operation,
                        selectedActionInput: targetedSelection.result,
                    }),
            });
            if (disposed || cancellation.signal.aborted) return canonicalBridgeAck(envelope);
            if (!isCurrent()) return canonicalRequestError(envelope, message, 'stale_surface');
            const hostError = readPluginUiHostApiErrorPayload(result);
            if (hostError) return canonicalRequestError(envelope, message, hostError.code, hostError.diagnostics);
            if (selectionRequest?.success && 'operation' in selectionRequest.data) {
                const selectionResult = PluginUiSelectActionInputResultV1Schema.safeParse(result);
                if (selectionResult.success && selectionResult.data.kind === 'submitted') {
                    if (!pluginUiSelectedActionInputMatchesOperation(
                        selectionResult.data,
                        selectionRequest.data.operation,
                    )) {
                        return canonicalRequestError(envelope, message, 'invalid_payload');
                    }
                    const selectedKey = pluginUiTargetedContributionOperationKey(
                        selectionRequest.data.operation,
                    );
                    // The wire result crosses into guest ownership. Retain an
                    // exact private JSON copy so later guest mutation cannot
                    // alter the host-selected input supplied to canonical
                    // action dispatch. Strict reparse keeps the retained copy
                    // on the Protocol boundary without relying on a runtime-
                    // specific structured-clone global.
                    const retainedResult = PluginUiSelectActionInputResultV1Schema.parse(
                        JSON.parse(JSON.stringify(selectionResult.data)),
                    );
                    if (retainedResult.kind === 'submitted') {
                        selectedTargetedOperations.set(selectedKey, {
                            operation: selectionRequest.data.operation,
                            result: retainedResult,
                            selectionRequestId: message.requestId,
                        });
                    }
                }
            }
            return canonicalBridgeResponse(envelope, PluginUiHostApiWireEnvelopeV1Schema.parse({
                wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
                kind: 'result',
                identity: binding.identity,
                requestId: message.requestId,
                method: message.method,
                ...(result === undefined ? {} : { result }),
            }));
        } catch {
            return canonicalRequestError(envelope, message, 'internal_error', ['host_api_handler_failed']);
        } finally {
            canonicalPending.delete(message.requestId);
        }
    }

    async function handleCollectionUiQueryBridgeEnvelope(
        envelope: PluginHostedWebBridgeEnvelopeV1,
    ): Promise<PluginHostedWebBridgeResponseEnvelopeV1> {
        const bridge = collectionUiQueryBridge;
        if (!bridge) return createBridgeError(envelope, 'unsupported_method');
        const parsed = PluginHostedWebCollectionUiQueryBridgeRequestV1Schema.safeParse(envelope.payload);
        if (!parsed.success) return createBridgeError(envelope, 'invalid_payload');
        if (parsed.data.kind === 'cancel') {
            collectionUiQueryPending.get(parsed.data.requestSequence)?.abort();
            return canonicalBridgeAck(envelope);
        }
        if (collectionUiQueryPending.has(envelope.sequence)) {
            return createBridgeError(envelope, 'invalid_payload', [
                'hosted_web_duplicate_request_sequence',
            ]);
        }

        const cancellation = new AbortController();
        collectionUiQueryPending.set(envelope.sequence, cancellation);
        try {
            const response = await bridge.handle(parsed.data.operation, {
                signal: cancellation.signal,
            });
            if (disposed || cancellation.signal.aborted) return canonicalBridgeAck(envelope);
            if (!isCurrent()) return createBridgeError(envelope, 'stale_surface');
            return createBridgeResponse({ envelope, kind: 'result', payload: response });
        } catch {
            if (disposed || cancellation.signal.aborted) return canonicalBridgeAck(envelope);
            if (!isCurrent()) return createBridgeError(envelope, 'stale_surface');
            return createBridgeError(envelope, 'internal_error', [
                'hosted_web_collection_ui_query_failed',
            ]);
        } finally {
            if (collectionUiQueryPending.get(envelope.sequence) === cancellation) {
                collectionUiQueryPending.delete(envelope.sequence);
            }
        }
    }

    async function handleBridgeEnvelope(
        envelope: PluginHostedWebBridgeEnvelopeV1,
    ): Promise<PluginHostedWebBridgeResponseEnvelopeV1> {
        const sessionlessInitialReady = envelope.kind === 'ready'
            && envelope.sessionId === undefined
            && params.surface.pluginId === envelope.pluginId
            && params.surface.contributionId === envelope.contributionId
            && params.surface.surfaceId === envelope.surfaceId;
        if (!sessionlessInitialReady && !pluginUiSurfaceContextsMatch(params.surface, envelope)) {
            params.audit?.({ type: 'readyStale', surface: params.surface });
            return createBridgeError(envelope, 'stale_surface');
        }
        if (!isCurrent()) {
            return createBridgeError(envelope, 'stale_surface');
        }
        if (sessionlessInitialReady && readyState.read(params.surface).state !== 'pending') {
            params.audit?.({ type: 'readyStale', surface: params.surface });
            return createBridgeError(envelope, 'stale_surface');
        }
        if (envelope.kind === 'hostApi') {
            if (!disposed && readyState.read(params.surface).state !== 'ready') {
                return createBridgeError(envelope, 'unavailable', [
                    'hosted_web_bootstrap_required',
                ]);
            }
            return handleCanonicalWireEnvelope(envelope);
        }
        if (envelope.kind === PLUGIN_HOSTED_WEB_COLLECTION_UI_QUERY_BRIDGE_KIND_V1) {
            if (!disposed && readyState.read(params.surface).state !== 'ready') {
                return createBridgeError(envelope, 'unavailable', [
                    'hosted_web_bootstrap_required',
                ]);
            }
            if (disposed) {
                return createBridgeError(envelope, 'unavailable', ['host_api_handler_disposed']);
            }
            return handleCollectionUiQueryBridgeEnvelope(envelope);
        }
        if (disposed) {
            return createBridgeError(envelope, 'unavailable', ['host_api_handler_disposed']);
        }

        if (envelope.kind === 'ready') {
            const recorded = readyState.recordReady(params.surface);
            if (recorded.result === 'recorded') {
                // The strict guest-ready message is the only bootstrap trigger.
                // It has already passed source/origin/nonce/address validation
                // in the frame adapter before reaching this owner.
                pushBootstrapToFrame();
                params.onReadyStateChange?.({
                    state: 'ready',
                    surface: params.surface,
                    updatedAtMs: recorded.snapshot.updatedAtMs,
                    diagnostics: [],
                });
                params.audit?.({ type: 'readyRecorded', surface: params.surface });
            } else {
                params.audit?.({ type: 'readyDuplicate', surface: params.surface });
            }
            return createBridgeResponse({
                envelope,
                kind: 'ack',
                payload: {
                    accepted: true,
                    surface: params.surface,
                    readyState: recorded.result,
                    capabilities: {
                        collectionUiQuery: collectionUiQueryBridge !== undefined,
                    },
                },
            });
        }

        if (isLifecycleBridgeMessage(envelope.kind)) {
            return createBridgeResponse({
                envelope,
                kind: 'ack',
                payload: { accepted: true },
            });
        }
        return createBridgeError(envelope, 'unsupported_method');
    }

    const handler = Object.assign(handleBridgeEnvelope, {
        getReadyState: (): PluginUiHostReadyStateSnapshot => readyState.read(params.surface),
        pushSurfaceContext: (surface: PluginUiJsonValueV1): void => {
            const binding = params.canonicalHostApi;
            if (disposed || !binding || !isCurrent() || surface === currentSurface) return;
            const surfaceSemanticKey = stableJsonStringify(surface);
            if (surfaceSemanticKey === currentSurfaceSemanticKey) return;
            currentSurface = surface;
            currentSurfaceSemanticKey = surfaceSemanticKey;
            for (const subscriptionId of [...contextSubscriptions]) {
                pushToFrame(PluginUiHostApiWireEnvelopeV1Schema.parse({
                    wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
                    kind: 'subscription',
                    identity: binding.identity,
                    subscriptionId,
                    event: surface,
                }));
            }
        },
        publishResourceSubscriptionEvent: (event: PluginUiResourceSubscriptionEventV1): boolean => {
            const binding = params.canonicalHostApi;
            if (disposed || !binding || !isCurrent() || hostResourceSubscriptions.get(event.subscriptionId) !== 'active') return false;
            pushToFrame(PluginUiHostApiWireEnvelopeV1Schema.parse({
                wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
                kind: 'subscription',
                identity: binding.identity,
                subscriptionId: event.subscriptionId,
                event: event as unknown as PluginUiJsonValueV1,
            }));
            // A terminal arm ends the subscription at the host too, so a later
            // event cannot address a subscription the guest already retired.
            if (event.kind === 'complete' || event.kind === 'error') {
                hostResourceSubscriptions.delete(event.subscriptionId);
            }
            return true;
        },
        publishComposerSubscriptionEvent: (
            input: Parameters<PluginHostedWebComposerSubscriptionPublisher>[0],
        ): boolean => {
            const binding = params.canonicalHostApi;
            const snapshot = ComposerSnapshotV1Schema.safeParse(input.snapshot);
            if (!snapshot.success
                || disposed
                || !binding
                || !isCurrent()
                || hostResourceSubscriptions.get(input.subscriptionId) !== 'active') {
                return false;
            }
            pushToFrame(PluginUiHostApiWireEnvelopeV1Schema.parse({
                wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
                kind: 'subscription',
                identity: binding.identity,
                subscriptionId: input.subscriptionId,
                event: snapshot.data,
            }));
            return true;
        },
        recordReadyTimeout: (): PluginUiHostReadyStateSnapshot => {
            const snapshot = readyState.recordTimeout(params.surface);
            if (snapshot.state === 'timedOut') {
                params.onReadyStateChange?.({
                    state: 'timedOut',
                    surface: params.surface,
                    updatedAtMs: snapshot.updatedAtMs,
                    diagnostics: snapshot.diagnostics,
                });
                params.audit?.({ type: 'readyTimedOut', surface: params.surface });
            }
            return snapshot;
        },
        dispose: (): void => {
            if (disposed) return;
            const binding = params.canonicalHostApi;
            // §3.12: retirement must reach the frame, not wait to be discovered
            // on the frame's next request. The guest terminates every pending
            // call and every subscription the moment it lands, which is what
            // makes a retired surface inert instead of quietly stale. Pushed
            // BEFORE `disposed` flips so the envelope is still built.
            if (binding) {
                pushToFrame(PluginUiHostApiWireEnvelopeV1Schema.parse({
                    wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
                    kind: 'disconnected',
                    identity: binding.identity,
                    reason: 'host_api_handler_disposed',
                }), true);
            }
            disposed = true;
            contextSubscriptions.clear();
            for (const [subscriptionId, state] of hostResourceSubscriptions) {
                if (state === 'active') void retireHostResourceSubscription(subscriptionId);
            }
            hostResourceSubscriptions.clear();
            for (const cancellation of canonicalPending.values()) cancellation.abort();
            canonicalPending.clear();
            selectedTargetedOperations.clear();
            for (const cancellation of collectionUiQueryPending.values()) cancellation.abort();
            collectionUiQueryPending.clear();
            collectionUiQueryBridge?.dispose();
            readyState.reset(params.surface);
        },
    });

    return handler;
}
