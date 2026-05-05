import type { FastifyInstance } from 'fastify';
import {
    PEER_MACHINE_RPC_DIRECT_PATH_V1,
    PEER_MEDIATION_RECEIPTS,
    createPeerMachineRpcResultHashV1,
    type PeerMachineRpcCommandReceiptSuccessV1,
    type PeerMachineRpcDirectResponseV1,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import type { DirectRouteGrantTrustRoot } from '../verifyDirectRouteGrantV1';
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

export type PeerMachineRpcDirectHandlerManager = Readonly<{
    invokeLocal(method: string, params: unknown): Promise<unknown>;
}>;

export type PeerMachineRpcDirectRuntimeOptions = Readonly<{
    rpcHandlerManager: PeerMachineRpcDirectHandlerManager;
    callLimiter?: PeerMachineRpcCallLimiter;
    quarantine?: PeerMachineRpcVerificationQuarantine;
    localPerPeerMaxConcurrentCalls?: number;
    revokeGrant?: (input: Readonly<{ grantId: string; grantFamilyId?: string }>) => void;
}>;

export type RegisterPeerMediationMachineRpcDirectRoutesOptions = PeerMachineRpcDirectRuntimeOptions & Readonly<{
    nowMs: () => number;
    expected: PeerMachineRpcDirectExpectedBinding;
    trustRoots: readonly DirectRouteGrantTrustRoot[];
    revokedGrantIds?: ReadonlySet<string>;
    revokedGrantFamilyIds?: ReadonlySet<string>;
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

    app.post(PEER_MACHINE_RPC_DIRECT_PATH_V1, async (request): Promise<PeerMachineRpcDirectResponseV1> => {
        const validation = validatePeerMachineRpcDirectRequest({
            body: request.body,
            expected: options.expected,
            trustRoots: options.trustRoots,
            nowMs: options.nowMs(),
            revokedGrantIds: options.revokedGrantIds,
            revokedGrantFamilyIds: options.revokedGrantFamilyIds,
            callLimiter,
            quarantine,
        });
        if (!validation.ok) {
            if (validation.response.reasonCode === 'quarantined' && validation.grant) {
                options.revokeGrant?.({
                    grantId: validation.grant.grantId,
                    ...(validation.grant.grantFamilyId ? { grantFamilyId: validation.grant.grantFamilyId } : {}),
                });
            }
            return validation.response;
        }

        try {
            const result = await options.rpcHandlerManager.invokeLocal(
                validation.request.method,
                validation.request.params,
            );
            if (isMethodNotFoundResult(result)) {
                return {
                    v: 1,
                    ok: false,
                    receipt: PEER_MEDIATION_RECEIPTS.rpcFellBackToServer,
                    requestId: validation.request.requestId,
                    method: validation.request.method,
                    reasonCode: 'handler_unavailable',
                };
            }

            return {
                v: 1,
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
    });
}
