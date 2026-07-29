import {
    createUnavailableRuntimeActionExecutor,
    getActionSpec,
    PeerMediationObservabilitySubscribeRequestV1Schema,
    PeerMediationObservabilityUnsubscribeRequestV1Schema,
    resolveRuntimeActionExecutionFamily,
    type PeerMediationObservabilityDeltaV1,
    type PeerMediationObservabilityScopeV1,
    type RuntimeActionExecute,
    type RuntimeActionExecuteArgs,
} from '@happier-dev/protocol';

import { isDaemonPeerMediationObservabilityReadAvailable } from './access';
import type { DaemonPeerMediationObservabilityStore } from './store';

/**
 * Peer-mediation observability read-path executor (PMS-1 / finding #49 / DEF-14..16).
 *
 * The write-path (store + emitter wired into the relay terminators at machine-sync bootstrap) is
 * live, but the read-path was dead: the runtime store was never consumed, and the three
 * `peerMediation.observability.{snapshot,subscribe,unsubscribe}` ActionSpecs had no executor. This
 * module is that executor. It routes:
 *   - snapshot    → `store.snapshot(machineId, accountId)`
 *   - subscribe   → POLL-BACKED snapshot-cursor (returns snapshot + `sequence`); registers a live
 *                   `store.subscribe` push listener ONLY when an out-of-band `emitDelta` sink is
 *                   wired (the daemon control RPC surface is request/response, so there is no live
 *                   socket-push channel — see the subscribe branch for the full disposition).
 *   - unsubscribe → the disposer returned by the prior subscribe (no-op when poll-backed)
 *
 * Reads are fail-closed: the server feature gate (`machines.peerMediation.observability`) must be
 * enabled (`isDaemonPeerMediationObservabilityReadAvailable`), and every request is authorized
 * against the daemon's own machine scope so a caller cannot read another machine/account's flows.
 */

type DaemonPeerMediationObservabilityFeaturePayload = Readonly<{
    features?: unknown;
    capabilities?: unknown;
}>;

type DaemonPeerMediationObservabilityFeaturePayloadProvider =
    | DaemonPeerMediationObservabilityFeaturePayload
    | (() => DaemonPeerMediationObservabilityFeaturePayload);

/**
 * The shared-store handoff carried across the daemon's Api provider bridge (PMS-WIRE).
 *
 * The write-path owner (the machine-sync bootstrap relay terminators) and the read-path owner (the
 * execution-run runtime-action dispatch) live in two separately-constructed daemon runtimes. To keep
 * a single observability store between them, the bootstrap-scoped store is published onto the Api
 * provider bridge as this bundle, and the dispatch chain reads it back to build the executor below.
 * The bundle carries the daemon's own scope identity so a caller can never read another
 * machine/account's flows.
 */
export type DaemonPeerMediationObservabilityRuntimeActionContext = Readonly<{
    store: DaemonPeerMediationObservabilityStore;
    accountId: string;
    machineId: string;
}>;

export type CreatePeerMediationObservabilityDaemonRuntimeActionExecutorInput = Readonly<{
    store: DaemonPeerMediationObservabilityStore;
    accountId: string;
    machineId: string;
    featurePayload: DaemonPeerMediationObservabilityFeaturePayloadProvider;
    /**
     * Push sink for subscription deltas. Subscribe registers a store listener that forwards each
     * delta here; the action surface is request/response so the live stream is delivered out-of-band
     * through this callback (e.g. the daemon socket relay). Optional for narrow unit callers.
     */
    emitDelta?: (delta: PeerMediationObservabilityDeltaV1) => void;
    fallback?: RuntimeActionExecute;
}>;

const invalidParametersResult = {
    ok: false,
    errorCode: 'invalid_parameters',
    error: 'invalid_parameters',
} as const;

type PeerMediationObservabilityDisabledReason =
    | 'peer_mediation_observability_read_unavailable'
    | 'observability_scope_forbidden';

function disabledResult(reason: PeerMediationObservabilityDisabledReason) {
    return {
        ok: false as const,
        errorCode: 'runtime_action_disabled',
        error: `runtime_action_disabled:peerMediation:${reason}`,
    };
}

function isPeerMediationRuntimeAction(actionId: RuntimeActionExecuteArgs['actionId']): boolean {
    return resolveRuntimeActionExecutionFamily(actionId) === 'peerMediation';
}

function readFeaturePayload(
    provider: DaemonPeerMediationObservabilityFeaturePayloadProvider,
): DaemonPeerMediationObservabilityFeaturePayload {
    try {
        return typeof provider === 'function' ? provider() : provider;
    } catch {
        return {};
    }
}

function isAuthorizedMachineScope(input: Readonly<{
    accountId: string;
    machineId: string;
    scope: PeerMediationObservabilityScopeV1;
}>): boolean {
    return input.scope.kind === 'machine'
        && input.scope.accountId === input.accountId
        && input.scope.machineId === input.machineId;
}

function parseRuntimeActionInput(args: RuntimeActionExecuteArgs): Readonly<
    | { ok: true; input: unknown }
    | { ok: false; result: typeof invalidParametersResult }
> {
    const spec = getActionSpec(args.actionId);
    const parsed = spec.inputSchema.safeParse(args.input ?? {});
    return parsed.success
        ? { ok: true, input: parsed.data }
        : { ok: false, result: invalidParametersResult };
}

export function createPeerMediationObservabilityDaemonRuntimeActionExecutor(
    input: CreatePeerMediationObservabilityDaemonRuntimeActionExecutorInput,
): RuntimeActionExecute {
    const fallback = input.fallback ?? createUnavailableRuntimeActionExecutor();
    let unsubscribe: (() => void) | null = null;

    function closeSubscription(): void {
        unsubscribe?.();
        unsubscribe = null;
    }

    function snapshot() {
        return input.store.snapshot(input.machineId, input.accountId);
    }

    return async (args) => {
        if (!isPeerMediationRuntimeAction(args.actionId)) {
            return await fallback(args);
        }

        // Execution-boundary gate: fail closed when the server feature decision is disabled rather
        // than relying on the UI to hide the surface.
        if (!isDaemonPeerMediationObservabilityReadAvailable(readFeaturePayload(input.featurePayload))) {
            return disabledResult('peer_mediation_observability_read_unavailable');
        }

        const parsed = parseRuntimeActionInput(args);
        if (!parsed.ok) return parsed.result;

        if (args.actionId === 'peerMediation.observability.snapshot') {
            const requestedMachineId = (parsed.input as Readonly<{ machineId?: string }>)?.machineId;
            if (typeof requestedMachineId === 'string' && requestedMachineId !== input.machineId) {
                return disabledResult('observability_scope_forbidden');
            }
            return { ok: true as const, snapshot: snapshot() };
        }

        if (args.actionId === 'peerMediation.observability.subscribe') {
            const request = PeerMediationObservabilitySubscribeRequestV1Schema.safeParse(parsed.input);
            if (!request.success) return invalidParametersResult;
            if (!isAuthorizedMachineScope({
                accountId: input.accountId,
                machineId: input.machineId,
                scope: request.data.scope,
            })) {
                return disabledResult('observability_scope_forbidden');
            }

            // PMS-1 subscribe transport disposition — POLL-BACKED (honest, not faked).
            // The daemon control RPC surface is request/response (HTTP/fastify); there is no live
            // socket-push channel for observability deltas. So subscribe is a SNAPSHOT-CURSOR
            // contract: it returns the current snapshot + its `sequence`, and a caller advances by
            // re-reading `snapshot` (poll). A live push is delivered ONLY when an out-of-band
            // `emitDelta` sink is wired (e.g. a future socket relay) — when one is present we
            // register the store listener so the relay streams deltas. When ABSENT we do NOT
            // register a dead listener forwarding to nothing, because that would imply a push the
            // surface cannot deliver. Either way the leaf is honestly backed (real snapshot +
            // sequence cursor), so it leaves the deferred-allowlist rather than being a faked stream.
            closeSubscription();
            const emitDelta = input.emitDelta;
            if (emitDelta) {
                unsubscribe = input.store.subscribe(input.machineId, input.accountId, (delta) => {
                    emitDelta(delta);
                });
            }

            const initialSnapshot = snapshot();
            return { ok: true as const, snapshot: initialSnapshot, sequence: initialSnapshot.sequence };
        }

        if (args.actionId === 'peerMediation.observability.unsubscribe') {
            const request = PeerMediationObservabilityUnsubscribeRequestV1Schema.safeParse(parsed.input ?? {});
            if (!request.success) return invalidParametersResult;
            if (request.data.scope && !isAuthorizedMachineScope({
                accountId: input.accountId,
                machineId: input.machineId,
                scope: request.data.scope,
            })) {
                return disabledResult('observability_scope_forbidden');
            }
            closeSubscription();
            return { ok: true as const };
        }

        return await fallback(args);
    };
}
