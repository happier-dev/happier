import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol/machines/peer/mediation/receipts';
import { PeerMachineRpcDirectRequestV2Schema } from '@happier-dev/protocol/machines/peer/mediation/rpc/directV2';
import { createPeerMachineRpcRequestHashV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/commandReceiptV1';
import { isMachineRpcDirectRoutePolicy, resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import type { DirectPeerRouteKindV1, PeerFlowKindV1, PeerMachineRpcDirectFallbackReasonCodeV1, PeerMachineRpcDirectRequestV2, PeerMachineRpcDirectResponseV2, SignedDirectRouteGrantV2 } from '@happier-dev/protocol';

import {
    verifyDirectRouteGrantV2,
    type DirectRouteGrantTrustRoot,
} from '../verifyDirectRouteGrant';
import type { PeerMachineRpcCallLimiter } from './callLimits';
import type { PeerMachineRpcVerificationQuarantine } from './quarantine';
import type { PeerMachineRpcReplayKeyCache } from './replayKeys';

export type PeerMachineRpcDirectExpectedBinding = Readonly<{
    accountId: string;
    machineId: string;
    flowKind: PeerFlowKindV1;
    routeKind: DirectPeerRouteKindV1;
    endpointFingerprint: string;
}>;

type PeerMachineRpcDirectRequest = PeerMachineRpcDirectRequestV2;
type PeerMachineRpcDirectResponse = PeerMachineRpcDirectResponseV2;
type PeerMachineRpcDirectFailureResponse = Extract<PeerMachineRpcDirectResponse, { ok: false }>;
type DirectRouteGrantPayload = SignedDirectRouteGrantV2['payload'];

export type PeerMachineRpcDirectValidationResult =
    | Readonly<{
        ok: true;
        request: PeerMachineRpcDirectRequest;
        grant: DirectRouteGrantPayload;
        releaseCallLimit: () => void;
        commandReceiptRequired: boolean;
    }>
    | Readonly<{
        ok: false;
        response: PeerMachineRpcDirectFailureResponse;
        grant?: DirectRouteGrantPayload;
    }>;

export type ValidatePeerMachineRpcDirectRequestOptions = Readonly<{
    body: unknown;
    expected: PeerMachineRpcDirectExpectedBinding;
    trustRoots: readonly DirectRouteGrantTrustRoot[];
    nowMs: number;
    callLimiter: PeerMachineRpcCallLimiter;
    quarantine: PeerMachineRpcVerificationQuarantine;
    replayKeyCache: PeerMachineRpcReplayKeyCache;
}>;

function fallback(input: Readonly<{
    requestId: string;
    method: string;
    reasonCode: PeerMachineRpcDirectFallbackReasonCodeV1;
}>): PeerMachineRpcDirectFailureResponse {
    const response = {
        ok: false as const,
        receipt: PEER_MEDIATION_RECEIPTS.rpcFellBackToServer,
        requestId: input.requestId,
        method: input.method,
        reasonCode: input.reasonCode,
    };
    return { v: 2, ...response };
}

function mapGrantFailureReason(reasonCode: string): PeerMachineRpcDirectFallbackReasonCodeV1 {
    switch (reasonCode) {
        case 'grant_expired':
        case 'grant_not_yet_valid':
        case 'grant_revoked':
        case 'grant_unknown_key':
        case 'grant_bad_signature':
            return reasonCode;
        case 'grant_endpoint_mismatch':
            return 'endpoint_mismatch';
        case 'grant_invalid':
            return 'grant_invalid';
        case 'proof_bad_signature':
            return 'nonce_bad_signature';
        case 'proof_grant_digest_mismatch':
            return 'nonce_binding_mismatch';
        case 'proof_invalid':
        case 'proof_grant_invalid':
            return 'nonce_invalid';
        default:
            return 'grant_scope_mismatch';
    }
}

function quarantineKey(input: Readonly<{
    expected: PeerMachineRpcDirectExpectedBinding;
}>) {
    return {
        accountId: input.expected.accountId,
        machineId: input.expected.machineId,
        endpointFingerprint: input.expected.endpointFingerprint,
    };
}

function validateCommandReceipt(input: Readonly<{
    request: PeerMachineRpcDirectRequest;
    grantId: string;
    grantExpiresAtMs: number;
    replayKeyCache: PeerMachineRpcReplayKeyCache;
}>): PeerMachineRpcDirectFallbackReasonCodeV1 | null {
    const receipt = input.request.commandReceipt;
    if (!receipt) return 'command_receipt_required';

    const expectedRequestHash = createPeerMachineRpcRequestHashV1({
        method: input.request.method,
        params: input.request.params,
        grantId: input.grantId,
        endpointFingerprint: input.request.endpointFingerprint,
        replayKey: receipt.replayKey,
    });
    if (receipt.issuer !== 'ui' || receipt.requestHash !== expectedRequestHash) {
        return 'command_receipt_rejected';
    }
    if (!input.replayKeyCache.claim({
        grantId: input.grantId,
        replayKey: receipt.replayKey,
        expiresAtMs: input.grantExpiresAtMs,
    })) {
        return 'command_receipt_rejected';
    }
    return null;
}

export function validatePeerMachineRpcDirectRequest(
    options: ValidatePeerMachineRpcDirectRequestOptions,
): PeerMachineRpcDirectValidationResult {
    const parsedV2 = PeerMachineRpcDirectRequestV2Schema.safeParse(options.body);
    if (!parsedV2.success) {
        return {
            ok: false,
            response: fallback({
                requestId: 'unknown',
                method: 'unknown',
                reasonCode: 'invalid_request',
            }),
        };
    }
    const request = parsedV2.data;
    if (request.flowKind !== 'machine_rpc') {
        return {
            ok: false,
            response: fallback({
                requestId: request.requestId,
                method: request.method,
                reasonCode: 'grant_scope_mismatch',
            }),
        };
    }

    const qKey = quarantineKey({
        expected: options.expected,
    });
    if (options.quarantine.isQuarantined(qKey)) {
        return {
            ok: false,
            response: fallback({
                requestId: request.requestId,
                method: request.method,
                reasonCode: 'quarantined',
            }),
        };
    }

    const grantVerification = verifyDirectRouteGrantV2({
        grant: request.grant,
        proof: request.proof,
        trustRoots: options.trustRoots,
        nowMs: options.nowMs,
        expected: {
            accountId: options.expected.accountId,
            machineId: options.expected.machineId,
            flowKind: 'machine_rpc',
            routeKind: options.expected.routeKind,
            endpointFingerprint: options.expected.endpointFingerprint,
        },
    });
    if (!grantVerification.valid) {
        // A signing root can disappear during an authenticated Home refresh or while that
        // authority is temporarily unavailable. Refuse the request, but do not convert a
        // legitimate stale grant into a local endpoint quarantine that survives authority
        // recovery. Bad signatures and all other verification failures still count.
        if (grantVerification.reasonCode !== 'grant_unknown_key') {
            options.quarantine.recordVerificationFailure(qKey);
        }
        return {
            ok: false,
            response: fallback({
                requestId: request.requestId,
                method: request.method,
                reasonCode: mapGrantFailureReason(grantVerification.reasonCode),
            }),
        };
    }

    options.quarantine.recordVerificationSuccess(qKey);

    if (request.routeKind !== grantVerification.payload.routeKind) {
        return {
            ok: false,
            grant: grantVerification.payload,
            response: fallback({
                requestId: request.requestId,
                method: request.method,
                reasonCode: 'grant_scope_mismatch',
            }),
        };
    }

    if (request.endpointFingerprint !== options.expected.endpointFingerprint) {
        return {
            ok: false,
            grant: grantVerification.payload,
            response: fallback({
                requestId: request.requestId,
                method: request.method,
                reasonCode: 'endpoint_mismatch',
            }),
        };
    }

    const policy = resolveMachineRpcRoutePolicy(request.method);
    if (policy.serverRequiredReason === 'unclassified') {
        return {
            ok: false,
            grant: grantVerification.payload,
            response: fallback({
                requestId: request.requestId,
                method: request.method,
                reasonCode: 'method_unclassified',
            }),
        };
    }
    if (!isMachineRpcDirectRoutePolicy(policy)) {
        return {
            ok: false,
            grant: grantVerification.payload,
            response: fallback({
                requestId: request.requestId,
                method: request.method,
                reasonCode: 'server_required',
            }),
        };
    }

    const scope = grantVerification.payload.scope;
    if (scope.kind !== 'machine_rpc' || !scope.allowedMethods.includes(request.method) || grantVerification.payload.exp === null) {
        return {
            ok: false,
            grant: grantVerification.payload,
            response: fallback({
                requestId: request.requestId,
                method: request.method,
                reasonCode: 'method_not_allowed_by_grant',
            }),
        };
    }

    if (policy.commandReceiptRequired) {
        const receiptFailure = validateCommandReceipt({
            request,
            grantId: grantVerification.payload.grantId,
            grantExpiresAtMs: grantVerification.payload.exp,
            replayKeyCache: options.replayKeyCache,
        });
        if (receiptFailure) {
            return {
                ok: false,
                grant: grantVerification.payload,
                response: fallback({
                    requestId: request.requestId,
                    method: request.method,
                    reasonCode: receiptFailure,
                }),
            };
        }
    }

    const acquired = options.callLimiter.tryAcquire({
        key: {
            accountId: grantVerification.payload.accountId,
            machineId: grantVerification.payload.machineId,
            endpointFingerprint: request.endpointFingerprint,
            grantId: grantVerification.payload.grantId,
        },
        scope: {
            maxCalls: scope.maxCalls,
            maxIdleMs: scope.maxIdleMs,
        },
    });
    if (!acquired.ok) {
        return {
            ok: false,
            grant: grantVerification.payload,
            response: fallback({
                requestId: request.requestId,
                method: request.method,
                reasonCode: acquired.reasonCode,
            }),
        };
    }

    return {
        ok: true,
        request,
        grant: grantVerification.payload,
        releaseCallLimit: acquired.release,
        commandReceiptRequired: policy.commandReceiptRequired,
    };
}
