import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolvePluginSurfaceStatePresentation } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

export type PluginHostedWebUnavailableDiagnosticCode =
    | 'account_scope_changed'
    | 'artifact_hosting_not_opted_in'
    | 'artifact_hosting_unsupported'
    | 'e2ee_unavailable'
    | 'feature_disabled'
    | 'hosted_web_bridge_nonce_unavailable'
    | 'hosted_web_bridge_policy_absent'
    | 'hosted_web_bridge_timeout'
    | 'hosted_web_endpoint_policy_denied'
    | 'hosted_web_frame_adapter_unavailable'
    | 'hosted_web_frame_origin_unavailable'
    | 'hosted_web_policy_denied'
    | 'hosted_web_preview_expired'
    | 'hosted_web_preview_unavailable'
    | 'hosted_web_sandbox_unavailable'
    | 'hosted_web_security_unavailable'
    | 'hosted_web_static_artifact_missing'
    | 'operation_cancelled'
    | 'response_invalid'
    | 'server_generation_changed'
    | 'transport_unavailable';

/**
 * Keep the state-card diagnostic channel bounded to known host/runtime facts.
 * The card itself renders only localized copy via `resolveReasonCopy`.
 */
export function readPluginHostedWebUnavailableDiagnosticCode(
    value: unknown,
): PluginHostedWebUnavailableDiagnosticCode | null {
    switch (value) {
        case 'account_scope_changed':
        case 'artifact_hosting_not_opted_in':
        case 'artifact_hosting_unsupported':
        case 'e2ee_unavailable':
        case 'feature_disabled':
        case 'hosted_web_bridge_nonce_unavailable':
        case 'hosted_web_bridge_policy_absent':
        case 'hosted_web_bridge_timeout':
        case 'hosted_web_endpoint_policy_denied':
        case 'hosted_web_frame_adapter_unavailable':
        case 'hosted_web_frame_origin_unavailable':
        case 'hosted_web_policy_denied':
        case 'hosted_web_preview_expired':
        case 'hosted_web_preview_unavailable':
        case 'hosted_web_sandbox_unavailable':
        case 'hosted_web_security_unavailable':
        case 'hosted_web_static_artifact_missing':
        case 'operation_cancelled':
        case 'response_invalid':
        case 'server_generation_changed':
        case 'transport_unavailable':
            return value;
        default:
            return null;
    }
}

export function PluginHostedWebUnavailable(props: Readonly<{
    /** Raw runtime diagnostic exposed only through SurfaceStateCard's QA marker. */
    diagnosticCode?: PluginHostedWebUnavailableDiagnosticCode | null;
    /** Mount-local retry; source selection and capability issuance remain with their incumbent owners. */
    onRetry?: () => void;
}>): React.ReactElement {
    const presentation = resolvePluginSurfaceStatePresentation({
        state: 'unavailable',
        reasonCode: props.diagnosticCode,
        title: t('pluginRuntime.hostedWebUnavailableTitle'),
    });
    const card = presentation.card;
    if (!card) {
        throw new Error('plugin_hosted_web_unavailable_presentation_missing_card');
    }
    return (
        <SurfaceStateCard
            testID="plugin-hosted-web-unavailable"
            kind={card.kind}
            title={card.title}
            reason={card.reason}
            diagnosticCode={presentation.diagnosticCode}
            accessibilitySemantics={card.accessibilitySemantics}
            action={props.onRetry ? { label: t('common.retry'), onPress: props.onRetry } : undefined}
        />
    );
}
