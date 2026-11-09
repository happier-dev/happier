import * as React from 'react';

import { resolvePluginSurfaceStateAction } from '@/components/sessions/panes/PluginSurfaceFallback';
import { SurfaceStateCard, type SurfaceStateAction } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolvePluginSurfaceStatePresentation } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

export type PluginHostedWebUnavailableDiagnosticCode =
    | 'asset_not_declared'
    | 'directory_listing_disabled'
    | 'invalid_request_path'
    | 'mime_type_not_allowed'
    | 'source_map_unavailable'
    | 'artifact_file_not_declared'
    | 'artifact_bytes_rpc_unavailable'
    | 'artifact_bytes_response_invalid'
    | 'artifact_bytes_fetch_failed'
    | 'plugin_host_access_disclosure_mismatch'
    | 'plugin_collection_contract_conflict'
    | 'plugin_resource_admission_unavailable'
    | 'account_availability_not_loaded'
    | 'account_availability_scope_mismatch'
    | 'account_scope_changed'
    | 'artifact_graph_invalid'
    | 'artifact_graph_mismatch'
    | 'artifact_incompatible'
    | 'artifact_lease_revoked'
    | 'artifact_not_current'
    | 'artifact_slot_ambiguous'
    | 'artifact_source_ambiguous'
    | 'artifact_source_integrity_invalid'
    | 'artifact_source_unavailable'
    | 'artifact_hosting_not_opted_in'
    | 'artifact_hosting_unsupported'
    | 'e2ee_unavailable'
    | 'disabled'
    | 'feature_disabled'
    | 'hosted_web_artifact_tier_invalid'
    | 'hosted_web_artifact_policy_invalid'
    | 'hosted_web_artifact_bundle_invalid'
    | 'hosted_web_bridge_nonce_unavailable'
    | 'hosted_web_bridge_policy_absent'
    | 'hosted_web_bridge_timeout'
    | 'hosted_web_endpoint_policy_denied'
    | 'hosted_web_frame_adapter_unavailable'
    | 'hosted_web_frame_origin_unavailable'
    | 'hosted_web_policy_denied'
    | 'hosted_web_preview_expired'
    | 'hosted_web_preview_unavailable'
    | 'hosted_web_profile_isolation_unavailable'
    | 'hosted_web_sandbox_unavailable'
    | 'hosted_web_security_unavailable'
    | 'hosted_web_static_artifact_missing'
    | 'operation_cancelled'
    | 'host_ui_api_incompatible'
    | 'invalid_executable_export'
    | 'module_instantiation_failed'
    | 'native_artifact_resource_registration_failed'
    | 'native_artifact_response_table_invalid'
    | 'native_artifact_revocation_pending'
    | 'native_artifact_store_unavailable'
    | 'plugin_disabled'
    | 'plugin_revoked'
    | 'plugin_uninstalled'
    | 'response_invalid'
    | 'server_generation_changed'
    | 'source_unavailable'
    | 'transport_unavailable'
    | 'unknown_host_module'
    | 'revoked'
    | 'uninstalled'
    | 'update_required';

/**
 * Keep the state-card diagnostic channel bounded to known host/runtime facts.
 * The card itself renders only localized copy via `resolveReasonCopy`.
 */
export function readPluginHostedWebUnavailableDiagnosticCode(
    value: unknown,
): PluginHostedWebUnavailableDiagnosticCode | null {
    switch (value) {
        case 'asset_not_declared':
        case 'directory_listing_disabled':
        case 'invalid_request_path':
        case 'mime_type_not_allowed':
        case 'source_map_unavailable':
        case 'artifact_file_not_declared':
        case 'artifact_bytes_rpc_unavailable':
        case 'artifact_bytes_response_invalid':
        case 'artifact_bytes_fetch_failed':
        case 'plugin_host_access_disclosure_mismatch':
        case 'plugin_collection_contract_conflict':
        case 'plugin_resource_admission_unavailable':
        case 'account_availability_not_loaded':
        case 'account_availability_scope_mismatch':
        case 'account_scope_changed':
        case 'artifact_graph_invalid':
        case 'artifact_graph_mismatch':
        case 'artifact_incompatible':
        case 'artifact_lease_revoked':
        case 'artifact_not_current':
        case 'artifact_slot_ambiguous':
        case 'artifact_source_ambiguous':
        case 'artifact_source_integrity_invalid':
        case 'artifact_source_unavailable':
        case 'artifact_hosting_not_opted_in':
        case 'artifact_hosting_unsupported':
        case 'e2ee_unavailable':
        case 'disabled':
        case 'feature_disabled':
        case 'hosted_web_artifact_tier_invalid':
        case 'hosted_web_artifact_policy_invalid':
        case 'hosted_web_artifact_bundle_invalid':
        case 'hosted_web_bridge_nonce_unavailable':
        case 'hosted_web_bridge_policy_absent':
        case 'hosted_web_bridge_timeout':
        case 'hosted_web_endpoint_policy_denied':
        case 'hosted_web_frame_adapter_unavailable':
        case 'hosted_web_frame_origin_unavailable':
        case 'hosted_web_policy_denied':
        case 'hosted_web_preview_expired':
        case 'hosted_web_preview_unavailable':
        case 'hosted_web_profile_isolation_unavailable':
        case 'hosted_web_sandbox_unavailable':
        case 'hosted_web_security_unavailable':
        case 'hosted_web_static_artifact_missing':
        case 'host_ui_api_incompatible':
        case 'invalid_executable_export':
        case 'module_instantiation_failed':
        case 'native_artifact_resource_registration_failed':
        case 'native_artifact_response_table_invalid':
        case 'native_artifact_revocation_pending':
        case 'native_artifact_store_unavailable':
        case 'operation_cancelled':
        case 'plugin_disabled':
        case 'plugin_revoked':
        case 'plugin_uninstalled':
        case 'response_invalid':
        case 'server_generation_changed':
        case 'source_unavailable':
        case 'transport_unavailable':
        case 'unknown_host_module':
        case 'revoked':
        case 'uninstalled':
        case 'update_required':
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
    /** Route-owned recovery callback; the shared presentation owner supplies its semantic label. */
    recoveryAction?: SurfaceStateAction;
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
    const action = resolvePluginSurfaceStateAction({
            recoveryAction: presentation.recoveryAction,
            onRetry: props.onRetry,
            manageAction: props.recoveryAction,
        });
    return (
        <SurfaceStateCard
            testID="plugin-hosted-web-unavailable"
            kind={card.kind}
            title={card.title}
            reason={card.reason}
            diagnosticCode={presentation.diagnosticCode}
            accessibilitySemantics={card.accessibilitySemantics}
            action={action}
        />
    );
}
