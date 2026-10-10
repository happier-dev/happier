import {
    UI_SURFACE_ISOLATION_PROFILE_VERSION_V1,
    UiSurfaceExecutableApprovalKeyV1Schema,
    admitCallerAuthoredUiSurfaceCapabilitiesV1,
    buildUiSurfaceExecutableApprovalKeyStringV1,
    createUiSurfaceExecutableSecurityFingerprintV1,
    createUiSurfaceRequestedCapabilitiesDigestV1,
    PluginHostedHtmlSourceV1Schema,
    type PluginUiHostMethodV1,
    type NormalizedUiSurfaceCapabilityRequestV1,
    type UiSurfaceExecutableApprovalKeyV1,
    type PluginHostedHtmlSourceV1,
} from '@happier-dev/protocol/plugins/ui';

import { buildHostedHtmlDocument } from '@/components/plugins/hostedWeb/buildHostedHtmlDocument';

export type PreparedCallerHostedHtmlSurface =
    | Readonly<{
        kind: 'admitted';
        /** Raw authored source for HostedFrameHost, which installs the shell once. */
        frameSource: Readonly<{
            bundle: PluginHostedHtmlSourceV1;
            networkOrigins: NormalizedUiSurfaceCapabilityRequestV1['networkOrigins'];
        }>;
        /** Audit/review rendering of the exact host shell; never rewrap this value. */
        document: string;
        advertisedHostMethods: readonly PluginUiHostMethodV1[];
        /** The exact immutable mount input; outer Session authority binds refs. */
        capabilityManifest: Readonly<{
            version: 1;
            requested: NormalizedUiSurfaceCapabilityRequestV1;
            advertisedHostMethods: readonly PluginUiHostMethodV1[];
        }>;
        approval: UiSurfaceExecutableApprovalKeyV1;
        approvalKey: string;
    }>
    | Readonly<{
        kind: 'rejected';
        code:
            | 'source_invalid'
            | 'approval_scope_invalid'
            | 'capability_request_invalid'
            | 'host_method_outside_caller_ceiling';
    }>;

/**
 * Prepares caller-authored by-value HTML at the Session authority boundary.
 *
 * Installed plugins do not enter this adapter: their independently admitted
 * public ABI and full trusted Host API continue through PluginSurfaceHost.
 * This adapter only validates the caller ceiling, derives the stable approval
 * identity, and builds the host-owned shell. Session access/revision/currentness
 * and remembered-approval storage remain with the outer Session owner.
 */
export function prepareCallerHostedHtmlSurface(input: Readonly<{
    serverIdentityId: string;
    accountId: string;
    approvalSubject: string;
    source: unknown;
    requestedCapabilities?: unknown;
    admittedHostMethods: readonly PluginUiHostMethodV1[];
    frameIdentity: Readonly<{ instanceId: string; mountNonce: string }>;
    hostOrigin: string;
}>): PreparedCallerHostedHtmlSurface {
    const source = PluginHostedHtmlSourceV1Schema.safeParse(input.source);
    if (!source.success) return Object.freeze({ kind: 'rejected', code: 'source_invalid' });
    const admission = admitCallerAuthoredUiSurfaceCapabilitiesV1({
        request: input.requestedCapabilities,
        admittedHostMethods: input.admittedHostMethods,
    });
    if (admission.kind === 'rejected') return admission;
    // Partial capability intersection is intentional: a current realm may
    // serve only part of a caller document's reviewed request. But when an
    // explicit host-method request has no admitted method at all, mounting a
    // frame cannot provide any of the authority it asked for. Keep the authored
    // source visible as typed unavailable and create no physical frame.
    if (
        admission.capabilities.hostMethods.length > 0
        && admission.advertisedHostMethods.length === 0
    ) {
        return Object.freeze({ kind: 'rejected', code: 'capability_request_invalid' } as const);
    }
    const executableSecurityFingerprint = createUiSurfaceExecutableSecurityFingerprintV1({
        source: source.data,
        isolationProfileVersion: UI_SURFACE_ISOLATION_PROFILE_VERSION_V1,
        networkOrigins: admission.capabilities.networkOrigins,
    });
    const requestedCapabilitiesDigest = createUiSurfaceRequestedCapabilitiesDigestV1(admission.capabilities);
    const approval = UiSurfaceExecutableApprovalKeyV1Schema.safeParse({
        serverIdentityId: input.serverIdentityId,
        accountId: input.accountId,
        approvalSubject: input.approvalSubject,
        executableSecurityFingerprint,
        requestedCapabilitiesDigest,
    });
    if (!approval.success) return Object.freeze({ kind: 'rejected', code: 'approval_scope_invalid' });
    let document: string;
    try {
        document = buildHostedHtmlDocument(
            source.data,
            {
                identity: input.frameIdentity,
                frameOrigin: 'null',
                hostOrigin: input.hostOrigin,
            },
            { networkOrigins: admission.capabilities.networkOrigins },
        );
    } catch {
        // A structurally valid bundle can still reference missing or invalid
        // local assets. Keep that authored-content failure at this boundary.
        return Object.freeze({ kind: 'rejected', code: 'source_invalid' });
    }
    return Object.freeze({
        kind: 'admitted',
        frameSource: Object.freeze({
            bundle: source.data,
            networkOrigins: admission.capabilities.networkOrigins,
        }),
        document,
        advertisedHostMethods: admission.advertisedHostMethods,
        capabilityManifest: Object.freeze({
            version: 1 as const,
            requested: admission.capabilities,
            advertisedHostMethods: admission.advertisedHostMethods,
        }),
        approval: approval.data,
        approvalKey: buildUiSurfaceExecutableApprovalKeyStringV1(approval.data),
    });
}
