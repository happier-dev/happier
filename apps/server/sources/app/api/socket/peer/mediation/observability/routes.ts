import {
    PEER_MEDIATION_OBSERVABILITY_DELTA_SOCKET_EVENT,
    PEER_MEDIATION_OBSERVABILITY_SNAPSHOT_SOCKET_EVENT,
    PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT,
    PEER_MEDIATION_OBSERVABILITY_UNSUBSCRIBE_SOCKET_EVENT,
    FeaturesResponseSchema,
    PeerMediationObservabilityDeltaV1Schema,
    PeerMediationObservabilitySnapshotV1Schema,
    PeerMediationObservabilitySubscribeRequestV1Schema,
    PeerMediationObservabilityUnsubscribeRequestV1Schema,
    readServerEnabledBit,
} from "@happier-dev/protocol";

import type {
    PeerMediationObservabilityScope,
    PeerMediationObservabilityStore,
} from "./store";

export type PeerMediationObservabilityPrincipal =
    | Readonly<{ kind: "accountOwner"; accountId: string }>
    | Readonly<{ kind: "machineOwner"; accountId: string; machineId: string }>
    | Readonly<{ kind: "sessionOwner"; accountId: string; sessionId: string }>
    | Readonly<{ kind: "publicPreview"; publicExposureId: string }>
    | Readonly<{ kind: "pluginSurface"; accountId: string; pluginId: string; surfaceId: string }>
    | Readonly<{ kind: "adminOperator"; accountId: string; audited: boolean }>;

export type PeerMediationObservabilityAuthorizationDenied =
    Readonly<{ ok: false; reasonCode: "observability_scope_forbidden" | "observability_unavailable" }>;

export type PeerMediationObservabilityAuthorizationResult =
    | Readonly<{ ok: true }>
    | PeerMediationObservabilityAuthorizationDenied;

export type PeerMediationObservabilitySubscribeResponse =
    | Readonly<{ ok: true; sequence: number }>
    | PeerMediationObservabilityAuthorizationDenied;

export type PeerMediationObservabilityUnsubscribeResponse =
    | Readonly<{ ok: true }>
    | PeerMediationObservabilityAuthorizationDenied;

type PeerMediationObservabilityFeaturePayloadProvider = unknown | (() => unknown);

type PeerMediationObservabilitySocket = Readonly<{
    on: (event: string, handler: (payload?: unknown, callback?: (response: unknown) => void) => unknown) => unknown;
    emit: (event: string, payload: unknown) => unknown;
}>;

const registeredSockets = new WeakSet<object>();

export function isPeerMediationObservabilityReadAvailable(payload: unknown): boolean {
    const parsed = FeaturesResponseSchema.safeParse(payload);
    return parsed.success
        && readServerEnabledBit(parsed.data, "machines.peerMediation.observability") === true;
}

function readFeaturePayload(provider: PeerMediationObservabilityFeaturePayloadProvider): unknown {
    try {
        return typeof provider === "function" ? provider() : provider;
    } catch {
        return {};
    }
}

function sameAccount(accountId: string, scope: PeerMediationObservabilityScope): boolean {
    if (scope.kind === "publicPreview") return false;
    return scope.accountId === accountId;
}

export function authorizePeerMediationObservabilityRead(input: Readonly<{
    principal: PeerMediationObservabilityPrincipal;
    scope: PeerMediationObservabilityScope;
}>): PeerMediationObservabilityAuthorizationResult {
    const { principal, scope } = input;
    if (principal.kind === "adminOperator") {
        return principal.audited ? { ok: true } : { ok: false, reasonCode: "observability_scope_forbidden" };
    }
    if (principal.kind === "accountOwner") {
        return sameAccount(principal.accountId, scope)
            ? { ok: true }
            : { ok: false, reasonCode: "observability_scope_forbidden" };
    }
    if (principal.kind === "machineOwner" && scope.kind === "machine") {
        return principal.accountId === scope.accountId && principal.machineId === scope.machineId
            ? { ok: true }
            : { ok: false, reasonCode: "observability_scope_forbidden" };
    }
    if (principal.kind === "sessionOwner" && scope.kind === "session") {
        return principal.accountId === scope.accountId && principal.sessionId === scope.sessionId
            ? { ok: true }
            : { ok: false, reasonCode: "observability_scope_forbidden" };
    }
    if (principal.kind === "publicPreview" && scope.kind === "publicPreview") {
        return principal.publicExposureId === scope.publicExposureId
            ? { ok: true }
            : { ok: false, reasonCode: "observability_scope_forbidden" };
    }
    if (principal.kind === "pluginSurface" && scope.kind === "pluginSurface") {
        return principal.accountId === scope.accountId
            && principal.pluginId === scope.pluginId
            && principal.surfaceId === scope.surfaceId
            ? { ok: true }
            : { ok: false, reasonCode: "observability_scope_forbidden" };
    }
    return { ok: false, reasonCode: "observability_scope_forbidden" };
}

function authorizeAvailableRead(input: Readonly<{
    featurePayload: PeerMediationObservabilityFeaturePayloadProvider;
    principal: PeerMediationObservabilityPrincipal;
    scope: PeerMediationObservabilityScope;
}>): PeerMediationObservabilityAuthorizationResult {
    if (!isPeerMediationObservabilityReadAvailable(readFeaturePayload(input.featurePayload))) {
        return { ok: false, reasonCode: "observability_unavailable" };
    }
    return authorizePeerMediationObservabilityRead({
        principal: input.principal,
        scope: input.scope,
    });
}

function scopeKey(scope: PeerMediationObservabilityScope): string {
    if (scope.kind === "account") return `account:${scope.accountId}`;
    if (scope.kind === "machine") return `machine:${scope.accountId}:${scope.machineId}`;
    if (scope.kind === "session") return `session:${scope.accountId}:${scope.sessionId}`;
    if (scope.kind === "publicPreview") return `publicPreview:${scope.publicExposureId}`;
    return `pluginSurface:${scope.accountId}:${scope.pluginId}:${scope.surfaceId}`;
}

export function registerPeerMediationObservabilitySocketRoutes(
    socket: PeerMediationObservabilitySocket,
    options: Readonly<{
        store: PeerMediationObservabilityStore;
        featurePayload: PeerMediationObservabilityFeaturePayloadProvider;
        principal: PeerMediationObservabilityPrincipal;
    }>,
): void {
    const socketObject = socket as object;
    if (registeredSockets.has(socketObject)) {
        throw new Error("Peer mediation observability routes already registered on this socket");
    }
    registeredSockets.add(socketObject);

    const subscriptions = new Map<string, () => void>();

    function closeSubscription(key: string): void {
        const unsubscribe = subscriptions.get(key);
        if (!unsubscribe) return;
        subscriptions.delete(key);
        unsubscribe();
    }

    function closeAllSubscriptions(): void {
        for (const key of [...subscriptions.keys()]) closeSubscription(key);
    }

    socket.on(PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT, (raw, callback) => {
        const parsed = PeerMediationObservabilitySubscribeRequestV1Schema.safeParse(raw);
        if (!parsed.success) {
            callback?.({ ok: false, reasonCode: "observability_scope_forbidden" });
            return;
        }
        const scope = parsed.data.scope;
        const authorization = authorizeAvailableRead({
            featurePayload: options.featurePayload,
            principal: options.principal,
            scope,
        });
        if (!authorization.ok) {
            callback?.(authorization);
            return;
        }

        const key = scopeKey(scope);
        closeSubscription(key);
        const unsubscribe = options.store.subscribe(scope, (delta) => {
            const nextAuthorization = authorizeAvailableRead({
                featurePayload: options.featurePayload,
                principal: options.principal,
                scope,
            });
            if (!nextAuthorization.ok) {
                closeSubscription(key);
                return;
            }
            socket.emit(
                PEER_MEDIATION_OBSERVABILITY_DELTA_SOCKET_EVENT,
                PeerMediationObservabilityDeltaV1Schema.parse(delta),
            );
        });
        subscriptions.set(key, unsubscribe);

        const snapshot = PeerMediationObservabilitySnapshotV1Schema.parse(options.store.snapshot(scope));
        socket.emit(PEER_MEDIATION_OBSERVABILITY_SNAPSHOT_SOCKET_EVENT, snapshot);
        callback?.({ ok: true, sequence: snapshot.sequence });
    });

    socket.on(PEER_MEDIATION_OBSERVABILITY_UNSUBSCRIBE_SOCKET_EVENT, (raw, callback) => {
        const parsed = PeerMediationObservabilityUnsubscribeRequestV1Schema.safeParse(raw ?? {});
        if (!parsed.success) {
            callback?.({ ok: false, reasonCode: "observability_scope_forbidden" });
            return;
        }
        if (!parsed.data.scope) {
            closeAllSubscriptions();
            callback?.({ ok: true });
            return;
        }
        const authorization = authorizePeerMediationObservabilityRead({
            principal: options.principal,
            scope: parsed.data.scope,
        });
        if (!authorization.ok) {
            callback?.(authorization);
            return;
        }
        closeSubscription(scopeKey(parsed.data.scope));
        callback?.({ ok: true });
    });

    socket.on("disconnect", () => {
        closeAllSubscriptions();
    });
}
