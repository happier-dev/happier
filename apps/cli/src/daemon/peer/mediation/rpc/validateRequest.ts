import {
    PEER_MEDIATION_RECEIPTS,
    PeerMachineRpcDirectRequestV1Schema,
    PeerMachineRpcDirectRequestV2Schema,
    createPeerMachineRpcRequestHashV1,
    isMachineRpcDirectRoutePolicy,
    resolveMachineRpcRoutePolicy,
    type DirectPeerRouteKindV1,
    type PeerFlowKindV1,
    type PeerMachineRpcDirectFallbackReasonCodeV1,
    type PeerMachineRpcDirectRequestV1,
    type PeerMachineRpcDirectRequestV2,
    type PeerMachineRpcDirectResponseV1,
    type PeerMachineRpcDirectResponseV2,
    type SignedDirectRouteGrantV1,
    type SignedDirectRouteGrantV2,
} from '@happier-dev/protocol';

import {
    verifyDirectRouteGrantV1,
    verifyDirectRouteGrantV2,
    verifyPeerRouteNonceV1,
    type DirectRouteGrantTrustRoot,
} from '../verifyDirectRouteGrantV1';
import type { PeerMachineRpcCallLimiter } from './callLimits';
import type { PeerMachineRpcVerificationQuarantine } from './quarantine';
import type { PeerMachineRpcReplayKeyCache } from './replayKeys';

export type PeerMachineRpcDirectExpectedBinding = Readonly<{
    accountId: string;
    machineId: string;
    flowKind: PeerFlowKindV1;
    routeKind: DirectPeerRouteKindV1;
    endpointFingerprint: string;
    accountPublicKey?: string;
}>;

type PeerMachineRpcDirectRequest = PeerMachineRpcDirectRequestV1 | PeerMachineRpcDirectRequestV2;
type PeerMachineRpcDirectResponse = PeerMachineRpcDirectResponseV1 | PeerMachineRpcDirectResponseV2;
type PeerMachineRpcDirectFailureResponse = Extract<PeerMachineRpcDirectResponse, { ok: false }>;
type DirectRouteGrantPayload = SignedDirectRouteGrantV1['payload'] | SignedDirectRouteGrantV2['payload'];

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
    version: 1 | 2;
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
    return input.version === 2 ? { v: 2, ...response } : { v: 1, ...response };
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
    const parsedV1 = parsedV2.success ? null : PeerMachineRpcDirectRequestV1Schema.safeParse(options.body);
    if (!parsedV2.success && !parsedV1?.success) {
        return {
            ok: false,
            response: fallback({
                requestId: 'unknown',
                method: 'unknown',
                version: 1,
                reasonCode: 'invalid_request',
            }),
        };
    }
    const request: PeerMachineRpcDirectRequest = parsedV2.success
      ? parsedV2.data
      : PeerMachineRpcDirectRequestV1Schema.parse(options.body);
    if (request.flowKind !== 'machine_rpc') {
        return {
            ok: false,
            response: fallback({
                requestId: request.requestId,
                method: request.method,
                version: request.v,
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
                version: request.v,
                reasonCode: 'quarantined',
            }),
        };
    }

    const grantVerification = request.v === 2
      ? verifyDirectRouteGrantV2({
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
      })
      : verifyDirectRouteGrantV1({
        grant: request.grant,
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
        options.quarantine.recordVerificationFailure(qKey);
        return {
            ok: false,
            response: fallback({
                requestId: request.requestId,
                method: request.method,
                version: request.v,
                reasonCode: mapGrantFailureReason(grantVerification.reasonCode),
            }),
        };
    }

    const nonceVerification = request.v === 1 && options.expected.accountPublicKey
      ? verifyPeerRouteNonceV1({
        proof: request.nonceProof,
        accountPublicKey: options.expected.accountPublicKey,
        expected: {
            grantId: grantVerification.payload.grantId,
            routeKind: grantVerification.payload.routeKind,
            flowKind: grantVerification.payload.flowKind,
            endpointFingerprint: grantVerification.payload.endpointFingerprint,
        },
      })
      : request.v === 1
        ? { valid: false as const, reasonCode: 'nonce_invalid' as const }
        : { valid: true as const };
    if (!nonceVerification.valid) {
        options.quarantine.recordVerificationFailure(qKey);
        const reasonCode = options.quarantine.isQuarantined(qKey)
            ? 'quarantined'
            : nonceVerification.reasonCode;
        return {
            ok: false,
            grant: grantVerification.payload,
            response: fallback({
                requestId: request.requestId,
                method: request.method,
                version: request.v,
                reasonCode,
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
                version: request.v,
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
                version: request.v,
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
                version: request.v,
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
                version: request.v,
                reasonCode: 'server_required',
            }),
        };
    }

    const scope = grantVerification.payload.scope;
    if (scope.kind !== 'machine_rpc' || !scope.allowedMethods.includes(request.method)) {
        return {
            ok: false,
            grant: grantVerification.payload,
            response: fallback({
                requestId: request.requestId,
                method: request.method,
                version: request.v,
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
                    version: request.v,
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
                version: request.v,
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
