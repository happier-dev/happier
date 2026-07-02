import {
    PluginHostedWebBridgeEnvelopeV1Schema,
    type PluginHostedWebBridgeEnvelopeV1,
} from '@happier-dev/protocol';

export type PluginHostedWebBridgeValidationCode =
    | 'invalid_message'
    | 'origin_mismatch'
    | 'nonce_mismatch'
    | 'session_mismatch'
    | 'plugin_mismatch'
    | 'contribution_mismatch'
    | 'surface_mismatch'
    | 'message_kind_denied';

export type PluginHostedWebBridgeValidationResult =
    | Readonly<{ ok: true; envelope: PluginHostedWebBridgeEnvelopeV1 }>
    | Readonly<{ ok: false; code: PluginHostedWebBridgeValidationCode }>;

export function validatePluginHostedWebBridgeMessage(params: Readonly<{
    message: unknown;
    origin: string;
    expectedOrigin: string;
    expectedPluginId: string;
    expectedContributionId: string;
    expectedSurfaceId: string;
    expectedNonce: string;
    expectedSessionId?: string | null;
    allowedMessageKinds: ReadonlySet<string>;
}>): PluginHostedWebBridgeValidationResult {
    if (params.origin !== params.expectedOrigin) {
        return Object.freeze({ ok: false, code: 'origin_mismatch' });
    }

    const parsed = PluginHostedWebBridgeEnvelopeV1Schema.safeParse(params.message);
    if (!parsed.success) {
        return Object.freeze({ ok: false, code: 'invalid_message' });
    }
    const envelope = parsed.data;

    if (envelope.nonce !== params.expectedNonce) {
        return Object.freeze({ ok: false, code: 'nonce_mismatch' });
    }
    if (params.expectedSessionId && envelope.sessionId !== params.expectedSessionId) {
        return Object.freeze({ ok: false, code: 'session_mismatch' });
    }
    if (envelope.pluginId !== params.expectedPluginId) {
        return Object.freeze({ ok: false, code: 'plugin_mismatch' });
    }
    if (envelope.contributionId !== params.expectedContributionId) {
        return Object.freeze({ ok: false, code: 'contribution_mismatch' });
    }
    if (envelope.surfaceId !== params.expectedSurfaceId) {
        return Object.freeze({ ok: false, code: 'surface_mismatch' });
    }
    if (!params.allowedMessageKinds.has(envelope.kind)) {
        return Object.freeze({ ok: false, code: 'message_kind_denied' });
    }

    return Object.freeze({ ok: true, envelope });
}
