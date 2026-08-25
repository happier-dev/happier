import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
    PEER_MACHINE_RPC_DIRECT_PATH_V1,
    PEER_MACHINE_RPC_DIRECT_PATH_V2,
    PEER_MEDIATION_RECEIPTS,
    createPeerMachineRpcResultHashV1,
    type PeerMachineRpcCommandReceiptSuccessV1,
    type PeerMachineRpcDirectResponseV1,
    type PeerMachineRpcDirectResponseV2,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import type { DaemonPeerMediationDirectFlowObserver } from '../observability/events';
import type { DirectRouteGrantTrustRoot } from '../verifyDirectRouteGrantV1';
import { createAtomicRouteGrantConsumption } from '../tunnel/grantConsumption';
import {
    type PeerMachineRpcDirectExpectedBinding,
    validatePeerMachineRpcDirectRequest,
} from './validateRequest';
import {
    createPeerMachineRpcCallLimiter,
    type PeerMachineRpcCallLimiter,
} from './callLimits';
import {
    createPeerMachineRpcVerificationQuarantine,
    type PeerMachineRpcVerificationQuarantine,
} from './quarantine';
import {
    createPeerMachineRpcReplayKeyCache,
    type PeerMachineRpcReplayKeyCache,
} from './replayKeys';

export type PeerMachineRpcDirectHandlerManager = Readonly<{
    invokeLocal(
        method: string,
        params: unknown,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<unknown>;
}>;

export type PeerMachineRpcDirectRuntimeOptions = Readonly<{
    rpcHandlerManager: PeerMachineRpcDirectHandlerManager;
    callLimiter?: PeerMachineRpcCallLimiter;
    quarantine?: PeerMachineRpcVerificationQuarantine;
    replayKeyCache?: PeerMachineRpcReplayKeyCache;
    localPerPeerMaxConcurrentCalls?: number;
    /** Scope-bound PMS-9 observer supplied by the loopback composition root (P1-9). */
    observability?: DaemonPeerMediationDirectFlowObserver;
}>;

export type RegisterPeerMediationMachineRpcDirectRoutesOptions = PeerMachineRpcDirectRuntimeOptions & Readonly<{
    nowMs: () => number;
    expected: PeerMachineRpcDirectExpectedBinding;
    trustRoots: readonly DirectRouteGrantTrustRoot[];
}>;

function isMethodNotFoundResult(value: unknown): boolean {
    return Boolean(
        value
        && typeof value === 'object'
        && (value as { errorCode?: unknown }).errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND,
    );
}

function createCommandReceipt(input: Readonly<{
    requestHash: string;
    replayKey: string;
    issuedAtMs: number;
    result: unknown;
}>): PeerMachineRpcCommandReceiptSuccessV1 {
    return {
        v: 1,
        issuer: 'daemon',
        issuedAtMs: input.issuedAtMs,
        requestHash: input.requestHash,
        replayKey: input.replayKey,
        resultHash: createPeerMachineRpcResultHashV1(input.result),
    };
}

function createDirectPeerRequestLifetime(
    request: FastifyRequest,
    reply: FastifyReply,
): Readonly<{
    signal: AbortSignal;
    dispose: () => void;
}> {
    const controller = new AbortController();
    const abort = () => {
        if (!controller.signal.aborted) {
            controller.abort(new Error('Direct peer RPC request ended'));
        }
    };
    const abortIfResponseDidNotFinish = () => {
        if (!reply.raw.writableEnded) {
            abort();
        }
    };
    request.raw.once('aborted', abort);
    reply.raw.once('close', abortIfResponseDidNotFinish);
    if (request.raw.aborted) {
        abort();
    }
    return {
        signal: controller.signal,
        dispose: () => {
            request.raw.removeListener('aborted', abort);
            reply.raw.removeListener('close', abortIfResponseDidNotFinish);
        },
    };
}

export function registerPeerMediationMachineRpcDirectRoutes(
    app: FastifyInstance,
    options: RegisterPeerMediationMachineRpcDirectRoutesOptions,
): void {
    const callLimiter = options.callLimiter ?? createPeerMachineRpcCallLimiter({
        nowMs: options.nowMs,
        localPerPeerMaxConcurrentCalls: options.localPerPeerMaxConcurrentCalls,
    });
    const quarantine = options.quarantine ?? createPeerMachineRpcVerificationQuarantine({
        nowMs: options.nowMs,
    });
    const replayKeyCache = options.replayKeyCache ?? createPeerMachineRpcReplayKeyCache({
        nowMs: options.nowMs,
    });
    const grantConsumption = createAtomicRouteGrantConsumption({ activationFailurePolicy: 'release' });
    app.addHook('onClose', async () => {
        grantConsumption.clear();
    });

    const observe = (input: Readonly<{
        flowId: string;
        kind: Parameters<DaemonPeerMediationDirectFlowObserver['emit']>[0]['kind'];
        reasonCode?: string;
    }>): void => {
        options.observability?.emit({
            flowKind: 'machine_rpc',
            flowId: input.flowId,
            kind: input.kind,
            ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        });
    };

    const handleRequest = async (
        body: unknown,
        signal: AbortSignal,
    ): Promise<PeerMachineRpcDirectResponseV1 | PeerMachineRpcDirectResponseV2> => {
        const validation = validatePeerMachineRpcDirectRequest({
            body,
            expected: options.expected,
            trustRoots: options.trustRoots,
            nowMs: options.nowMs(),
            callLimiter,
            quarantine,
            replayKeyCache,
        });
        if (!validation.ok) {
            observe({
                flowId: validation.response.requestId,
                kind: 'flow.denied',
                reasonCode: validation.response.reasonCode,
            });
            return validation.response;
        }
        observe({ flowId: validation.request.requestId, kind: 'flow.started' });

        const reservation = validation.request.v === 2
            ? grantConsumption.reserve({
                grantId: validation.grant.grantId,
                expiresAt: validation.grant.exp,
                nowMs: options.nowMs(),
            })
            : null;
        if (validation.request.v === 2 && !reservation) {
            validation.releaseCallLimit();
            observe({
                flowId: validation.request.requestId,
                kind: 'cap.exceeded',
                reasonCode: 'direct_call_limit_exceeded',
            });
            return {
                v: 2,
                ok: false,
                receipt: PEER_MEDIATION_RECEIPTS.rpcFellBackToServer,
                requestId: validation.request.requestId,
                method: validation.request.method,
                reasonCode: 'direct_call_limit_exceeded',
            };
        }

        try {
            reservation?.commit();
            let result: unknown;
            try {
                result = await options.rpcHandlerManager.invokeLocal(
                    validation.request.method,
                    validation.request.params,
                    { signal },
                );
            } catch (error) {
                observe({
                    flowId: validation.request.requestId,
                    kind: 'flow.errored',
                    reasonCode: 'handler_unavailable',
                });
                if (validation.request.v === 1) throw error;
                return {
                    v: 2,
                    ok: false,
                    receipt: PEER_MEDIATION_RECEIPTS.rpcFellBackToServer,
                    requestId: validation.request.requestId,
                    method: validation.request.method,
                    reasonCode: 'handler_unavailable',
                };
            }
            if (isMethodNotFoundResult(result)) {
                observe({
                    flowId: validation.request.requestId,
                    kind: 'flow.errored',
                    reasonCode: 'handler_unavailable',
                });
                return {
                    v: validation.request.v,
                    ok: false,
                    receipt: PEER_MEDIATION_RECEIPTS.rpcFellBackToServer,
                    requestId: validation.request.requestId,
                    method: validation.request.method,
                    reasonCode: 'handler_unavailable',
                };
            }

            observe({ flowId: validation.request.requestId, kind: 'flow.closed' });
            return {
                v: validation.request.v,
                ok: true,
                receipt: PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded,
                requestId: validation.request.requestId,
                method: validation.request.method,
                routeKind: validation.request.routeKind,
                result,
                ...(validation.commandReceiptRequired && validation.request.commandReceipt
                    ? {
                        commandReceipt: createCommandReceipt({
                            requestHash: validation.request.commandReceipt.requestHash,
                            replayKey: validation.request.commandReceipt.replayKey,
                            issuedAtMs: options.nowMs(),
                            result,
                        }),
                    }
                    : {}),
            };
        } finally {
            validation.releaseCallLimit();
        }
    };

    const handleRouteRequest = async (request: FastifyRequest, reply: FastifyReply) => {
        const lifetime = createDirectPeerRequestLifetime(request, reply);
        try {
            return await handleRequest(request.body, lifetime.signal);
        } finally {
            lifetime.dispose();
        }
    };

    app.post(PEER_MACHINE_RPC_DIRECT_PATH_V1, handleRouteRequest);
    app.post(PEER_MACHINE_RPC_DIRECT_PATH_V2, handleRouteRequest);
}
