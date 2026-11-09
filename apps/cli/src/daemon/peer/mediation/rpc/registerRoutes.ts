import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PEER_MACHINE_RPC_DIRECT_PATH_V2 } from '@happier-dev/protocol/machines/peer/mediation/rpc/directV2';
import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol/machines/peer/mediation/receipts';
import type { PeerMachineRpcDirectResponseV2 } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import type { DaemonPeerMediationDirectFlowObserver } from '../observability/events';
import type { DirectRouteGrantTrustRoot } from '../verifyDirectRouteGrant';
import { createAtomicRouteGrantConsumption } from '../tunnel/grantConsumption';
import {
    type PeerMachineRpcDirectExpectedBinding,
    validatePeerMachineRpcDirectRequest,
} from './validateRequest';

export type PeerMachineRpcDirectHandlerManager = Readonly<{
    invokeLocal(
        method: string,
        params: unknown,
        options?: Readonly<{
            signal?: AbortSignal;
            /** Only the verified Home-signed route grant supplies these host-side facts. */
            verifiedPeerAccountId?: string;
            verifiedPeerAuthority?: 'present_user' | 'account_automation';
        }>,
    ): Promise<unknown>;
}>;

export type PeerMachineRpcDirectRuntimeOptions = Readonly<{
    rpcHandlerManager: PeerMachineRpcDirectHandlerManager;
    /** Scope-bound PMS-9 observer supplied by the loopback composition root (P1-9). */
    observability?: DaemonPeerMediationDirectFlowObserver;
}>;

export type RegisterPeerMediationMachineRpcDirectRoutesOptions = PeerMachineRpcDirectRuntimeOptions & Readonly<{
    nowMs: () => number;
    expected: PeerMachineRpcDirectExpectedBinding;
    trustRoots: readonly DirectRouteGrantTrustRoot[];
    resolveTrustRoots?: () => readonly DirectRouteGrantTrustRoot[];
}>;

function isMethodNotFoundResult(value: unknown): boolean {
    return Boolean(
        value
        && typeof value === 'object'
        && (value as { errorCode?: unknown }).errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND,
    );
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
    ): Promise<PeerMachineRpcDirectResponseV2> => {
        const validation = validatePeerMachineRpcDirectRequest({
            body,
            expected: options.expected,
            trustRoots: options.resolveTrustRoots?.() ?? options.trustRoots,
            nowMs: options.nowMs(),
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

        reservation?.commit();
        let result: unknown;
        let handlerFailureCode: string | undefined;
        try {
            result = await options.rpcHandlerManager.invokeLocal(
                validation.request.method,
                validation.request.params,
                { signal, verifiedPeerAccountId: validation.grant.accountId,
                    verifiedPeerAuthority: validation.grant.callerAuthority ?? 'account_automation' },
            );
        } catch (error) {
            // The route was available and dispatch already happened. Preserve
            // the handler's typed failure in the ordinary RPC result.
            handlerFailureCode = readRpcErrorCode(error) ?? 'handler_failed';
            result = { error: 'Direct RPC handler failed', errorCode: handlerFailureCode };
        }
        if (!handlerFailureCode && isMethodNotFoundResult(result)) {
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

        observe({ flowId: validation.request.requestId, kind: handlerFailureCode ? 'flow.errored' : 'flow.closed',
            ...(handlerFailureCode ? { reasonCode: handlerFailureCode } : {}) });
        return {
            v: validation.request.v,
            ok: true,
            receipt: PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded,
            requestId: validation.request.requestId,
            method: validation.request.method,
            routeKind: validation.request.routeKind,
            result,
        };
    };

    const handleRouteRequest = async (request: FastifyRequest, reply: FastifyReply) => {
        const lifetime = createDirectPeerRequestLifetime(request, reply);
        try {
            return await handleRequest(request.body, lifetime.signal);
        } finally {
            lifetime.dispose();
        }
    };

    app.post(PEER_MACHINE_RPC_DIRECT_PATH_V2, handleRouteRequest);
}
