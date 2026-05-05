import {
    PEER_MEDIATION_RECEIPTS,
    PeerMachineRpcDirectRequestV1Schema,
    createPeerMachineRpcRequestHashV1,
    isMachineRpcDirectRoutePolicy,
    resolveMachineRpcRoutePolicy,
    type DirectPeerRouteKindV1,
    type PeerFlowKindV1,
    type PeerMachineRpcDirectFallbackReasonCodeV1,
    type PeerMachineRpcDirectRequestV1,
    type PeerMachineRpcDirectResponseV1,
    type SignedDirectRouteGrantV1,
} from '@happier-dev/protocol';

import {
    verifyDirectRouteGrantV1,
    verifyPeerRouteNonceV1,
    type DirectRouteGrantTrustRoot,
} from '../verifyDirectRouteGrantV1';
import type { PeerMachineRpcCallLimiter } from './callLimits';
import type { PeerMachineRpcVerificationQuarantine } from './quarantine';

export type PeerMachineRpcDirectExpectedBinding = Readonly<{
    accountId: string;
    machineId: string;
    flowKind: PeerFlowKindV1;
    routeKind: DirectPeerRouteKindV1;
    endpointFingerprint: string;
    accountPublicKey: string;
}>;

export type PeerMachineRpcDirectValidationResult =
    | Readonly<{
        ok: true;
        request: PeerMachineRpcDirectRequestV1;
        grant: SignedDirectRouteGrantV1['payload'];
        releaseCallLimit: () => void;
        commandReceiptRequired: boolean;
    }>
    | Readonly<{
        ok: false;
        response: PeerMachineRpcDirectResponseV1;
        grant?: SignedDirectRouteGrantV1['payload'];
    }>;

export type ValidatePeerMachineRpcDirectRequestOptions = Readonly<{
    body: unknown;
    expected: PeerMachineRpcDirectExpectedBinding;
    trustRoots: readonly DirectRouteGrantTrustRoot[];
    nowMs: number;
    revokedGrantIds?: ReadonlySet<string>;
    revokedGrantFamilyIds?: ReadonlySet<string>;
    callLimiter: PeerMachineRpcCallLimiter;
    quarantine: PeerMachineRpcVerificationQuarantine;
}>;

function fallback(input: Readonly<{
    requestId: string;
    method: string;
    reasonCode: PeerMachineRpcDirectFallbackReasonCodeV1;
}>): PeerMachineRpcDirectResponseV1 {
    return {
        v: 1,
        ok: false,
        receipt: PEER_MEDIATION_RECEIPTS.rpcFellBackToServer,
        requestId: input.requestId,
        method: input.method,
        reasonCode: input.reasonCode,
    };
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
        default:
            return 'grant_scope_mismatch';
    }
}

function quarantineKey(input: Readonly<{
    expected: PeerMachineRpcDirectExpectedBinding;
    endpointFingerprint?: string;
}>) {
    return {
        accountId: input.expected.accountId,
        machineId: input.expected.machineId,
        endpointFingerprint: input.endpointFingerprint ?? input.expected.endpointFingerprint,
    };
}

function validateCommandReceipt(input: Readonly<{
    request: PeerMachineRpcDirectRequestV1;
    grantId: string;
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
    return null;
}

export function validatePeerMachineRpcDirectRequest(
    options: ValidatePeerMachineRpcDirectRequestOptions,
): PeerMachineRpcDirectValidationResult {
    const parsed = PeerMachineRpcDirectRequestV1Schema.safeParse(options.body);
    if (!parsed.success) {
        return {
            ok: false,
            response: fallback({
                requestId: 'unknown',
                method: 'unknown',
                reasonCode: 'invalid_request',
            }),
        };
    }
    const request = parsed.data;
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
        endpointFingerprint: request.endpointFingerprint,
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

    const grantVerification = verifyDirectRouteGrantV1({
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
        revokedGrantIds: options.revokedGrantIds,
        revokedGrantFamilyIds: options.revokedGrantFamilyIds,
    });
    if (!grantVerification.valid) {
        options.quarantine.recordVerificationFailure(qKey);
        return {
            ok: false,
            response: fallback({
                requestId: request.requestId,
                method: request.method,
                reasonCode: mapGrantFailureReason(grantVerification.reasonCode),
            }),
        };
    }

    const nonceVerification = verifyPeerRouteNonceV1({
        proof: request.nonceProof,
        accountPublicKey: options.expected.accountPublicKey,
        expected: {
            grantId: grantVerification.payload.grantId,
            routeKind: grantVerification.payload.routeKind,
            flowKind: grantVerification.payload.flowKind,
            endpointFingerprint: grantVerification.payload.endpointFingerprint,
        },
    });
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
    if (scope.kind !== 'machine_rpc' || !scope.allowedMethods.includes(request.method)) {
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
