import type { BrowserSurfaceUnavailableReason } from '@/components/browser/surfaces/BrowserSurfaceFallback';
import type { BrowserAdapterUnavailableReasonCode } from '@/sync/domains/browser/adapters/availability';
import type { BrowserPreviewRefusalReasonCode } from '@/sync/domains/browser/adapters/targets/localPreview';
import { t } from '@/text';
import type { PluginMachineOriginRejectionReasonV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import type { LocalServiceNativePrerequisiteV1, LocalServiceEstablishmentFailureV1 } from '@happier-dev/protocol/local/services/launcher/v1';

/**
 * The surface family a reason code is rendered into. Each kind selects the
 * vocabulary and the generic fallback so a surface never borrows another
 * surface's copy.
 */
export type ReasonCopyKind =
    | 'browserFrame' // BrowserAdapterUnavailableReasonCode (frame content)
    | 'browserStatus' // same vocabulary, status-bar surface
    | 'browserSurface' // BrowserSurfaceUnavailableReason (surface-state tokens)
    | 'browserLaunchpad' // launchpad-card disabledReason/detail tokens
    | 'localServiceLauncher' // local-service launcher reason/state tokens
    | 'localServiceInventory' // local-service inventory scan diagnostic codes
    | 'localServiceAction' // daemon LocalServiceActionResultV1 refusal/failure reason codes
    | 'simulatorPreview' // simulator preview availability reason codes
    | 'streamPlayer' // live-stream player error/diagnostic reason codes
    | 'pluginRuntime' // plugin runtime load/fallback diagnostic codes
    | 'widget' // native/authored widget host admission, not plugin-runtime availability
    | 'browserDiagnosticsInteraction'; // why the diagnostics drawer's interactive tools are off

export type ResolvedReasonCopy = Readonly<{
    /** Localized card title for terminal-state surfaces. */
    title: string;
    /** Localized, user-facing body. Never the raw reason code. */
    body: string;
    /** Optional localized next step. */
    nextStep?: string;
    /** Back-compat alias for body while existing inline/status callers migrate. */
    message: string;
    /** The raw input code, preserved for diagnostics-only surfaces (test-ids, logs). */
    diagnosticCode: string | null;
}>;

/**
 * Factual surface state stays with its Resource, renderer, or route owner.
 * This is only the one presentation projection shared by plugin-surface
 * adapters: it decides whether a state replaces content, retains last-known
 * good content, or leaves current content alone, and localizes any shared
 * state-card chrome without ever exposing a machine reason as product copy.
 */
export type PluginSurfacePresentationState =
    | 'loading'
    | 'available'
    | 'refreshing'
    | 'stale'
    | 'offline'
    | 'unavailable'
    | 'failedRetry';

export type PluginSurfaceStatePresentation = Readonly<{
    state: PluginSurfacePresentationState;
    /** Whether the caller replaces, retains, or continues its current content. */
    disposition: 'replace' | 'retain' | 'content';
    /** Raw diagnostic remains diagnostics-only even when no card is rendered. */
    diagnosticCode: string | null;
    /** Shared card chrome for a replacement state; renderer-specific cards may retain their own title. */
    card: Readonly<{
        kind: 'loading' | 'error' | 'unavailable';
        title: string;
        reason?: string;
        accessibilitySemantics: 'status' | 'alert';
    }> | null;
    /** A bounded status notice that accompanies retained, available content. */
    contentNotice: Readonly<{
        title: string;
        reason: string;
        accessibilitySemantics: 'status';
    }> | null;
    /** Semantic next step only; the route or renderer still owns the callback. */
    recoveryAction: Readonly<{
        kind: 'retry' | 'repair' | 'updateCompatible' | 'managePlugin' | 'enable';
        label: string;
    }> | null;
}>;

function resolvePluginSurfacePresentationCopy(input: Readonly<{
    state: PluginSurfacePresentationState;
    title?: string;
    reason: ResolvedReasonCopy;
    hasSpecificReason: boolean;
}>): Readonly<{
    title?: string;
    reason: string;
}> {
    switch (input.state) {
        case 'loading':
            return Object.freeze({
                title: t('pluginSurfaces.state.loading.title'),
                reason: t('pluginSurfaces.state.loading.reason'),
            });
        case 'refreshing':
            return Object.freeze({
                title: t('pluginSurfaces.state.refreshing.title'),
                reason: t('pluginSurfaces.state.refreshing.reason'),
            });
        case 'stale':
            return Object.freeze({
                title: t('pluginSurfaces.state.stale.title'),
                reason: input.hasSpecificReason ? input.reason.body : t('pluginSurfaces.state.stale.reason'),
            });
        case 'offline':
            return Object.freeze({
                title: t('pluginSurfaces.state.offline.title'),
                reason: input.hasSpecificReason ? input.reason.body : t('pluginSurfaces.state.offline.reason'),
            });
        case 'available':
        case 'unavailable':
        case 'failedRetry':
            break;
    }
    return Object.freeze({
        title: input.title,
        reason: input.reason.body,
    });
}

/**
 * Known browser frame / status reason codes → a localized message key.
 *
 * The full `BrowserAdapterUnavailableReasonCode` enum is covered, plus the
 * in-frame caller codes (`browser_profile_missing`,
 * `hosted_plugin_security_policy_blocked`, `invalid_url`, `owner_disconnected`)
 * that are interpolated at the frame chokepoint but are not part of the adapter
 * enum. Adjacent desktop-webview codes that carry no user-meaningful distinction
 * share one message while keeping their raw code on `diagnosticCode`.
 */
const BROWSER_REASON_KEYS = {
    desktop_engine_unavailable: 'browserShell.unavailable.desktopEngineUnavailable',
    desktop_webview_child_view_unverified: 'browserShell.unavailable.desktopWebView',
    desktop_webview_linux_display_unavailable: 'browserShell.unavailable.desktopWebView',
    desktop_webview_native_command_unavailable: 'browserShell.unavailable.desktopWebView',
    desktop_webview_native_contract_invalid: 'browserShell.unavailable.desktopWebView',
    desktop_webview_unsupported_platform: 'browserShell.unavailable.desktopWebViewUnsupportedPlatform',
    desktop_webview_wayland_gtk_unimplemented: 'browserShell.unavailable.desktopWebView',
    desktop_webview_x11_child_unverified: 'browserShell.unavailable.desktopWebView',
    electron_engine_unavailable: 'browserShell.unavailable.desktopEngineUnavailable',
    external_url_policy_denied: 'browserShell.unavailable.externalUrlPolicyDenied',
    external_url_unavailable: 'browserShell.unavailable.externalUrlUnavailable',
    simulator_preview_unavailable: 'browserShell.unavailable.simulatorPreviewUnavailable',
    sidecar_runtime_unavailable: 'browserShell.unavailable.sidecarRuntimeUnavailable',
    streamed_browser_unavailable: 'browserShell.unavailable.streamedBrowserUnavailable',
    managed_package_missing: 'browserShell.unavailable.managedPackageMissing',
    browser_runtime_provisioning_failed: 'browserShell.unavailable.provisioningFailed',
    sandbox_unavailable: 'browserShell.unavailable.sandboxUnavailable',
    tauri_host_unavailable: 'browserShell.unavailable.hostUnavailable',
    target_kind_unavailable: 'browserShell.unavailable.targetKindUnavailable',
    browser_profile_missing: 'browserShell.unavailable.browserProfileMissing',
    hosted_plugin_security_policy_blocked: 'browserShell.unavailable.hostedPluginBlocked',
    invalid_url: 'browserShell.unavailable.invalidUrl',
    owner_disconnected: 'browserShell.unavailable.ownerDisconnected',
    browser_context_annotation_iframe_capture_unavailable: 'browserShell.unavailable.annotationIframeCaptureUnavailable',
    browser_context_annotation_capture_unavailable: 'browserShell.unavailable.annotationCaptureUnavailable',
    preview_ended: 'browserShell.unavailable.previewEnded',
    preview_transport_unavailable: 'browserShell.unavailable.previewTransportUnavailable',
} as const satisfies Record<
    BrowserAdapterUnavailableReasonCode | 'managed_package_missing' | 'browser_runtime_provisioning_failed' | 'sandbox_unavailable' | 'browser_profile_missing' | 'hosted_plugin_security_policy_blocked' | 'invalid_url' | 'owner_disconnected'
    | 'browser_context_annotation_iframe_capture_unavailable' | 'browser_context_annotation_capture_unavailable'
    | BrowserPreviewRefusalReasonCode,
    BrowserMessageKey
>;

const BROWSER_DIAGNOSTICS_INTERACTION_KEYS = {
    adapter_unavailable: 'browserDiagnostics.host.interaction.unavailableReason.adapter',
    collector_unavailable: 'browserDiagnostics.host.interaction.unavailableReason.collector',
    policy_denied: 'browserDiagnostics.host.interaction.unavailableReason.policy',
} as const;

/** A relay preview's refusals name what happened to the page, not that a surface is unavailable. */
const BROWSER_FRAME_TITLE_KEYS = {
    preview_ended: 'browserShell.unavailable.previewEndedTitle',
    preview_transport_unavailable: 'browserShell.unavailable.previewTransportUnavailableTitle',
} as const satisfies Record<BrowserPreviewRefusalReasonCode, string>;

const BROWSER_SURFACE_KEYS = {
    disabled: 'browserShell.unavailable.surface.disabled',
    view_targets_disabled: 'browserShell.unavailable.surface.viewTargetsDisabled',
    host_lost: 'browserShell.unavailable.surface.hostLost',
    adapter_recovering: 'browserShell.unavailable.surface.adapterRecovering',
    live_state_lost: 'browserShell.unavailable.surface.liveStateLost',
    unsupported_target: 'browserShell.unavailable.surface.unsupportedTarget',
} as const satisfies Record<BrowserSurfaceUnavailableReason, BrowserSurfaceMessageKey>;

const LOCAL_SERVICE_LAUNCHER_KEYS = {
    launch_unavailable: 'localServices.launcher.unavailableReason.launchUnavailable',
    preview_registration_unavailable: 'localServices.launcher.unavailableReason.previewRegistrationUnavailable',
    browser_target_unavailable: 'localServices.launcher.unavailableReason.browserTargetUnavailable',
    starting: 'localServices.launcher.unavailableReason.starting',
    stopping: 'localServices.rowStatus.stopping',
    stopped: 'localServices.rowStatus.stopped',
    failed: 'localServices.rowStatus.failed',
    stale: 'localServices.launcher.unavailableReason.stale',
    unavailable: 'localServices.launcher.unavailableReason.unavailable',
    // Unsettled native custody (CA2-02): not Running, and Stop is the cleanup.
    managed_service_native_state_unknown: 'localServices.launcher.unavailableReason.nativeStateUnknown',
    managed_service_native_cleanup_unconfirmed: 'localServices.launcher.unavailableReason.nativeCleanupUnconfirmed',
} as const satisfies Record<string, LocalServiceLauncherMessageKey>;

/**
 * Inventory scan diagnostic → what the scan could not do, in one sentence. Three causes on purpose:
 * the opened-projects read failed, the scan was cut short (rows may be missing), or the machine
 * could not list its processes at all. An unmapped code keeps the neutral title-only fallback.
 */
const LOCAL_SERVICE_INVENTORY_KEYS = {
    local_services_accepted_workspaces_unavailable: 'localServices.inventory.scanCause.workspacesUnavailable',
    linux_procfs_scan_deadline_exceeded: 'localServices.inventory.scanCause.partial',
    darwin_lsof_scan_partial: 'localServices.inventory.scanCause.partial',
    linux_procfs_scan_failed: 'localServices.inventory.scanCause.failed',
    linux_process_fact_scan_failed: 'localServices.inventory.scanCause.failed',
    darwin_lsof_scan_failed: 'localServices.inventory.scanCause.failed',
    darwin_process_fact_scan_failed: 'localServices.inventory.scanCause.failed',
    windows_netstat_scan_failed: 'localServices.inventory.scanCause.failed',
    windows_process_fact_scan_failed: 'localServices.inventory.scanCause.failed',
} as const;

/**
 * Daemon `LocalServiceActionResultV1.reasonCode` → the one sentence the user can act on.
 *
 * `DESIGN.md`'s error-copy rule asks what failed *in
 * language the user can act on* and whether the operation can be retried, needs permission, or must
 * wait. A stopped Service names that outcome and points to Services instead of offering a futile retry.
 *
 * The map stays explicit per code rather than pattern-matching a suffix, so an unmapped code added
 * by a newer daemon is visible to a grep and falls to the generic "didn't complete" sentence instead
 * of silently joining the wrong family. The raw code is never rendered; it stays on
 * `diagnosticCode` (see `noInternalCodesInPrimaryUi.test.ts`).
 */
const LOCAL_SERVICE_ACTION_KEYS = {
    action_outcome_unknown: 'localServices.actions.failure.outcomeUnknown',
    // Preview admission can race Stop before custody is removed. No endpoint
    // is admissible then; this is not an attempted action that needs retrying.
    preview_target_unresolved: 'localServices.actions.failure.previewNotReady',
    service_not_listening: 'localServices.actions.failure.serviceNotRunning',
    preview_service_not_listening: 'localServices.actions.failure.serviceNotRunning',
    unknown_managed_service: 'localServices.actions.failure.serviceNotRunning',
    preview_unknown_managed_service: 'localServices.actions.failure.serviceNotRunning',
    preview_registration_failed: 'localServices.actions.failure.previewFailed',
    preview_server_unavailable: 'localServices.actions.failure.previewUnavailable',
    preview_runtime_unavailable: 'localServices.actions.failure.previewUnavailable',
    preview_token_secret_missing: 'localServices.actions.failure.previewUnavailable',
    preview_public_base_url_missing: 'localServices.actions.failure.previewUnavailable',
    preview_hostname_collision: 'localServices.actions.failure.previewFailed',
    // Refused: a policy, a permission, or a confirmation the user can go and change.
    requester_credentials_unavailable: 'localServices.actions.failure.refused',
    session_not_authorized: 'localServices.actions.failure.refused',
    non_loopback_target: 'localServices.actions.failure.refused',
    permission_denied: 'localServices.actions.failure.refused',
    forbidden: 'localServices.actions.failure.refused',
    confirmation_nonce_invalid: 'localServices.actions.failure.refused',
    confirmation_required: 'localServices.actions.failure.refused',
    ownership_not_established: 'localServices.actions.failure.refused',
    terminate_feature_disabled: 'localServices.actions.failure.refused',
    terminate_permission_denied: 'localServices.actions.failure.refused',

    // Unavailable: this machine cannot do this to this service, and retrying will not change it.
    // Services Open refused before any tab was admitted (the target has no browser mapping).
    browser_target_unavailable: 'localServices.actions.failure.unavailable',
    browser_adapter_unavailable: 'localServices.actions.failure.unavailable',
    // The in-app browser view is what is missing, not the Service or the Machine.
    browser_view_unavailable: 'localServices.actions.failure.browserViewUnavailable',
    inventory_unavailable: 'localServices.actions.failure.unavailable',
    endpoint_scheme_unknown: 'localServices.actions.failure.unavailable',
    invalid_resource: 'localServices.actions.failure.unavailable',
    invalid_preview_resource: 'localServices.actions.failure.unavailable',
    preview_account_unavailable: 'localServices.actions.failure.unavailable',
    preview_session_mismatch: 'localServices.actions.failure.unavailable',
    action_account_scope_changed: 'localServices.actions.failure.unavailable',
    action_home_signed_out: 'localServices.actions.failure.unavailable',
    runtime_action_disabled: 'localServices.actions.failure.unavailable',
    identity_changed: 'localServices.actions.failure.unavailable',
    launcher_start_unsupported: 'localServices.actions.failure.unavailable',
    low_signal_process: 'localServices.actions.failure.unavailable',
    managed_restart_unavailable: 'localServices.actions.failure.unavailable',
    managed_stop_executor_unavailable: 'localServices.actions.failure.unavailable',
    managed_stop_unavailable: 'localServices.actions.failure.unavailable',
    process_identity_unavailable: 'localServices.actions.failure.unavailable',
    restart_not_configured: 'localServices.actions.failure.unavailable',
    terminate_detected_executor_unavailable: 'localServices.actions.failure.unavailable',
    unknown_inventory_entry: 'localServices.actions.failure.unavailable',
    unsafe_pid: 'localServices.actions.failure.unavailable',
    wrong_machine: 'localServices.actions.failure.unavailable',
    wrong_target_kind: 'localServices.actions.failure.unavailable',

    // Didn't complete: it was attempted and did not finish, or could not be confirmed. Retryable.
    forget_verification_failed: 'localServices.actions.failure.incomplete',
    listener_state_unverifiable: 'localServices.actions.failure.incomplete',
    managed_restart_executor_failed: 'localServices.actions.failure.incomplete',
    managed_restart_verification_failed: 'localServices.actions.failure.incomplete',
    managed_stop_executor_failed: 'localServices.actions.failure.incomplete',
    managed_stop_verification_failed: 'localServices.actions.failure.incomplete',
    port_not_released: 'localServices.actions.failure.incomplete',
    port_release_unverified: 'localServices.actions.failure.incomplete',
    process_tree_unresolved: 'localServices.actions.failure.incomplete',
    terminate_detected_executor_failed: 'localServices.actions.failure.incomplete',
    terminate_no_process_signaled: 'localServices.actions.failure.incomplete',
    terminate_signal_failed: 'localServices.actions.failure.incomplete',

    // Front-door refusals, from `ActionExecutor.execute`'s `{ ok:false, errorCode }` envelope.
    action_disabled: 'localServices.actions.failure.refused',
    invalid_parameters: 'localServices.actions.failure.unavailable',
} as const satisfies Record<string, LocalServiceActionMessageKey>;

type BrowserMessageKey =
    | 'browserShell.unavailable.desktopEngineUnavailable'
    | 'browserShell.unavailable.desktopWebView'
    | 'browserShell.unavailable.desktopWebViewUnsupportedPlatform'
    | 'browserShell.unavailable.externalUrlPolicyDenied'
    | 'browserShell.unavailable.externalUrlUnavailable'
    | 'browserShell.unavailable.simulatorPreviewUnavailable'
    | 'browserShell.unavailable.sidecarRuntimeUnavailable'
    | 'browserShell.unavailable.streamedBrowserUnavailable'
    | 'browserShell.unavailable.managedPackageMissing'
    | 'browserShell.unavailable.provisioningFailed'
    | 'browserShell.unavailable.sandboxUnavailable'
    | 'browserShell.unavailable.hostUnavailable'
    | 'browserShell.unavailable.targetKindUnavailable'
    | 'browserShell.unavailable.browserProfileMissing'
    | 'browserShell.unavailable.hostedPluginBlocked'
    | 'browserShell.unavailable.invalidUrl'
    | 'browserShell.unavailable.ownerDisconnected'
    | 'browserShell.unavailable.annotationIframeCaptureUnavailable'
    | 'browserShell.unavailable.annotationCaptureUnavailable'
    | 'browserShell.unavailable.previewEnded'
    | 'browserShell.unavailable.previewTransportUnavailable'
    | 'browserShell.unavailable.previewPortNotAllowed';

type BrowserSurfaceMessageKey =
    | 'browserShell.unavailable.surface.disabled'
    | 'browserShell.unavailable.surface.viewTargetsDisabled'
    | 'browserShell.unavailable.surface.hostLost'
    | 'browserShell.unavailable.surface.adapterRecovering'
    | 'browserShell.unavailable.surface.liveStateLost'
    | 'browserShell.unavailable.surface.unsupportedTarget';

const SIMULATOR_PREVIEW_KEYS = {
    no_simulator_devices: 'simulatorPreview.availability.noDevices',
    capture_unavailable: 'simulatorPreview.availability.captureUnavailable',
    capture_degraded: 'simulatorPreview.availability.captureDegraded',
    stream_degraded: 'simulatorPreview.availability.streamDegraded',
    stream_error: 'simulatorPreview.availability.streamUnavailable',
} as const satisfies Record<string, SimulatorPreviewMessageKey>;

const STREAM_PLAYER_KEYS = {
    permission_expired: 'streamPlayer.status.permissionExpired',
    lease_expired: 'streamPlayer.status.leaseExpired',
    low_bandwidth: 'streamPlayer.status.lowBandwidth',
    webcodecs_decoder_unavailable: 'streamPlayer.status.decoderUnavailable',
} as const satisfies Record<string, StreamPlayerMessageKey>;

/**
 * Widget facts that are durable access states rather than start-up ones: an authored definition the
 * viewer's Account cannot read. They name the widget, never a transient wait.
 */
const WIDGET_KEYS = {
    widget_definition_unavailable: 'projects.widgets.definitionUnavailable',
    widget_definition_account_mismatch: 'projects.widgets.definitionUnavailable',
} as const;

/**
 * Plugin runtime load/fallback diagnostics grouped into user-meaningful
 * families. Hosted-web terminal facts that have different recovery guidance
 * remain distinct here; the raw per-code distinction also stays on
 * `diagnosticCode` for QA channels.
 */
const PLUGIN_RUNTIME_KEYS = {
    plugin_daemon_unsupported: 'pluginSurfaces.originReason.daemon_unsupported',
    plugin_daemon_invalid_response: 'pluginSurfaces.originReason.daemon_invalid_response',
    plugin_daemon_unavailable: 'pluginSurfaces.originReason.daemon_unavailable',
    plugin_activation_failed: 'pluginSurfaces.originReason.activation_refused',
    activation_failed: 'pluginSurfaces.originReason.activation_refused',
    plugin_source_not_ready: 'pluginSurfaces.originReason.source_not_ready',
    plugin_collection_contract_conflict: 'pluginRuntime.collectionConflict',
    plugin_resource_admission_unavailable: 'pluginRuntime.resourceAdmissionUnavailable',
    plugin_host_access_disclosure_mismatch: 'pluginRuntime.hostAccessMismatch',
    artifact_bytes_rpc_unavailable: 'pluginRuntime.routeUnavailable',
    artifact_bytes_response_invalid: 'pluginRuntime.responseInvalid',
    artifact_bytes_fetch_failed: 'pluginRuntime.transportUnavailable',
    transport_unavailable: 'pluginRuntime.transportUnavailable',
    plugin_resource_transport_unavailable: 'pluginRuntime.transportUnavailable',
    plugin_resource_transport_not_supported: 'pluginRuntime.routeUnavailable',
    plugin_resource_transport_error: 'pluginRuntime.transportUnavailable',
    plugin_resource_transport_timeout: 'pluginRuntime.transportUnavailable',
    targeted_contributions_unsupported: 'pluginRuntime.routeUnavailable',
    targeted_contributions_invalid_response: 'pluginRuntime.responseInvalid',
    targeted_contributions_timeout: 'pluginRuntime.transportUnavailable',
    targeted_contributions_error: 'pluginRuntime.transportUnavailable',
    artifact_source_unavailable: 'pluginRuntime.sourceUnavailable',
    artifact_not_current: 'pluginRuntime.viewNotCurrent',
    plugin_generation_stale: 'pluginRuntime.viewNotCurrent',
    plugin_occurrence_stale: 'pluginRuntime.viewNotCurrent',
    plugin_action_generation_retired: 'pluginRuntime.viewNotCurrent',
    artifact_lease_revoked: 'pluginRuntime.viewNotCurrent',
    source_unavailable: 'pluginRuntime.sourceUnavailable',
    response_invalid: 'pluginRuntime.responseInvalid',
    details_destination_policy_unavailable: 'pluginRuntime.disabledByPolicy',
    details_destination_platform_unavailable: 'pluginRuntime.disabledByPolicy',
    crash_threshold_reached: 'pluginRuntime.crashLoop',
    feature_disabled: 'pluginRuntime.disabledByPolicy',
    disabled: 'pluginRuntime.disabledByPolicy',
    plugin_disabled: 'pluginRuntime.disabledByPolicy',
    feature_gate_disabled: 'pluginRuntime.disabledByPolicy',
    required_feature_disabled: 'pluginRuntime.disabledByPolicy',
    channel_policy_denied: 'pluginRuntime.disabledByPolicy',
    channel_denied: 'pluginRuntime.disabledByPolicy',
    platform_denied: 'pluginRuntime.disabledByPolicy',
    compatibility_platform_unsupported: 'pluginRuntime.disabledByPolicy',
    compatibility_channel_unsupported: 'pluginRuntime.disabledByPolicy',
    compatibility_feature_disabled: 'pluginRuntime.disabledByPolicy',
    profile_mode_unsupported: 'pluginRuntime.disabledByPolicy',
    hosted_web_policy_denied: 'pluginRuntime.hostedWebPolicyDenied',
    hosted_web_sandbox_unavailable: 'pluginRuntime.hostedWebSandboxUnavailable',
    hosted_web_security_unavailable: 'pluginRuntime.hostedWebSecurityUnavailable',
    hosted_web_profile_isolation_unavailable: 'pluginRuntime.hostedWebSecurityUnavailable',
    hosted_web_frame_origin_unavailable: 'pluginRuntime.hostedWebFrameOriginUnavailable',
    hosted_web_bridge_nonce_unavailable: 'pluginRuntime.hostedWebBridgeNonceUnavailable',
    hosted_web_bridge_timeout: 'pluginRuntime.hostedWebBridgeTimeout',
    hosted_web_endpoint_policy_denied: 'pluginRuntime.hostedWebEndpointPolicyDenied',
    e2ee_unavailable: 'pluginRuntime.missingRequirement',
    artifact_hosting_not_opted_in: 'pluginRuntime.disabledByPolicy',
    artifact_hosting_unsupported: 'pluginRuntime.missingRequirement',
    hosted_web_static_artifact_missing: 'pluginRuntime.missingRequirement',
    hosted_web_frame_adapter_unavailable: 'pluginRuntime.missingRequirement',
    native_artifact_store_unavailable: 'pluginRuntime.missingRequirement',
    missing_native_capability: 'pluginRuntime.missingRequirement',
    required_permission_missing: 'pluginRuntime.missingRequirement',
    entry_missing: 'pluginRuntime.missingRequirement',
    plugin_machine_unreachable: 'pluginSurfaces.originReason.home_unreachable',
    runtime_mismatch: 'pluginRuntime.missingRequirement',
    artifact_source_integrity_invalid: 'pluginRuntime.integrityFailed',
    artifact_graph_mismatch: 'pluginRuntime.integrityFailed',
    artifact_slot_ambiguous: 'pluginRuntime.integrityFailed',
    artifact_source_ambiguous: 'pluginRuntime.integrityFailed',
    artifact_integrity_invalid: 'pluginRuntime.integrityFailed',
    integrity_failed: 'pluginRuntime.integrityFailed',
    // The page's machines carry different plugin versions and none is chosen yet.
    installationConflict: 'pluginRuntime.installationConflict',
    artifact_incompatible: 'pluginRuntime.incompatible',
    update_required: 'pluginRuntime.incompatible',
    host_ui_api_incompatible: 'pluginRuntime.incompatible',
    module_instantiation_failed: 'pluginRuntime.authorFailure',
    unknown_host_module: 'pluginRuntime.authorFailure',
    invalid_executable_export: 'pluginRuntime.authorFailure',
    invalid_surface_module: 'pluginRuntime.authorFailure',
    artifact_graph_invalid: 'pluginRuntime.authorFailure',
    hosted_web_artifact_tier_invalid: 'pluginRuntime.authorFailure',
    native_artifact_response_table_invalid: 'pluginRuntime.authorFailure',
    // The daemon's generated-UI artifact owner: the installed plugin carries no
    // usable built view for this platform. Waiting never changes that answer.
    generated_react_native_artifact_missing: 'pluginRuntime.authorFailure',
    generated_react_native_artifact_ambiguous: 'pluginRuntime.authorFailure',
    generated_react_native_artifact_graph_invalid: 'pluginRuntime.authorFailure',
    generated_react_native_bundler_mismatch: 'pluginRuntime.authorFailure',
    generated_react_native_export_missing: 'pluginRuntime.authorFailure',
    generated_react_native_platform_undeclared: 'pluginRuntime.authorFailure',
    generated_hosted_web_artifact_missing: 'pluginRuntime.authorFailure',
    generated_hosted_web_artifact_ambiguous: 'pluginRuntime.authorFailure',
    generated_hosted_web_artifact_graph_invalid: 'pluginRuntime.authorFailure',
    generated_hosted_web_bundler_mismatch: 'pluginRuntime.authorFailure',
    generated_react_native_plugin_root_unavailable: 'pluginRuntime.sourceUnavailable',
    generated_hosted_web_plugin_root_unavailable: 'pluginRuntime.sourceUnavailable',
    plugin_revoked: 'pluginRuntime.retired',
    plugin_uninstalled: 'pluginRuntime.retired',
    revoked: 'pluginRuntime.retired',
    uninstalled: 'pluginRuntime.retired',
} as const satisfies Record<string, PluginRuntimeMessageKey>;

type SimulatorPreviewMessageKey =
    | 'simulatorPreview.availability.noDevices'
    | 'simulatorPreview.availability.captureUnavailable'
    | 'simulatorPreview.availability.captureDegraded'
    | 'simulatorPreview.availability.streamDegraded'
    | 'simulatorPreview.availability.streamUnavailable';

type StreamPlayerMessageKey =
    | 'streamPlayer.status.permissionExpired'
    | 'streamPlayer.status.leaseExpired'
    | 'streamPlayer.status.lowBandwidth'
    | 'streamPlayer.status.decoderUnavailable';

type PluginRuntimeMessageKey =
    | `pluginSurfaces.originReason.${'home_unreachable' | 'daemon_unsupported' | 'daemon_invalid_response' | 'daemon_unavailable' | 'activation_refused' | 'source_not_ready'}`
    | 'pluginRuntime.collectionConflict'
    | 'pluginRuntime.resourceAdmissionUnavailable'
    | 'pluginRuntime.hostAccessMismatch'
    | 'pluginRuntime.routeUnavailable'
    | 'pluginRuntime.responseInvalid'
    | 'pluginRuntime.transportUnavailable'
    | 'pluginRuntime.sourceUnavailable'
    | 'pluginRuntime.viewNotCurrent'
    | 'pluginSurfaces.state.offline.reason'
    | 'pluginRuntime.crashLoop'
    | 'pluginRuntime.installationConflict'
    | 'pluginRuntime.disabledByPolicy'
    | 'pluginRuntime.hostedWebPolicyDenied'
    | 'pluginRuntime.hostedWebSandboxUnavailable'
    | 'pluginRuntime.hostedWebSecurityUnavailable'
    | 'pluginRuntime.hostedWebFrameOriginUnavailable'
    | 'pluginRuntime.hostedWebBridgeNonceUnavailable'
    | 'pluginRuntime.hostedWebBridgeTimeout'
    | 'pluginRuntime.hostedWebEndpointPolicyDenied'
    | 'pluginRuntime.missingRequirement'
    | 'pluginRuntime.integrityFailed'
    | 'pluginRuntime.incompatible'
    | 'pluginRuntime.authorFailure'
    | 'pluginRuntime.retired'
    | 'pluginRuntime.unavailableGeneric';

/** Picker rows and the surrounding surface explain the same Administration refusal. */
export function resolvePluginExecutionOriginReasonDetail(reason: PluginMachineOriginRejectionReasonV1 | 'no_materialization' | 'different_versions'): string {
    switch (reason) {
        case 'home_unreachable':
        case 'release_unavailable':
        case 'non_portable':
        case 'source_not_ready':
        case 'daemon_unsupported':
        case 'daemon_invalid_response':
        case 'daemon_unavailable':
        case 'activation_refused':
        case 'no_materialization': return t(`pluginSurfaces.originReason.${reason}`);
        case 'content_conflict': return t('settingsPlugins.executionOriginReleaseContentConflict');
        case 'disabled': return t('settingsPlugins.machineMatrix.state.disabled');
        case 'untrusted': return t('settingsPlugins.machineMatrix.state.untrusted');
        case 'incompatible': return t('settingsPlugins.machineMatrix.state.incompatible');
        case 'machine_local': return t('settingsPlugins.machineMatrix.state.localOnly');
        case 'offline': return t('settingsProviders.detail.machineOffline');
        case 'stale': return t('settingsPlugins.machineMatrix.state.staleOffline');
        case 'missing': return t('settingsPlugins.targetSelection.missing');
        case 'replaced': return t('settingsPlugins.targetSelection.replaced');
        case 'revoked': return t('settingsPlugins.targetSelection.revoked');
        case 'plugin_mismatch': return t('settingsPlugins.targetSelection.pluginMismatch');
        case 'different_versions': return t('settingsPlugins.targetSelection.differentVersions');
        case 'unknown': return t('settingsPlugins.targetSelection.unknown');
    }
}

/**
 * One honest sentence for a plugin that Administration found on a Machine but could not use, and
 * whether the way forward is the plugin's own page. `machine` is the one Machine that refused, or
 * `undefined` when several did. Returns `null` when nothing is installed (the caller leads to installing)
 * so "install it" is only ever said when it is true.
 */
export function describePluginExecutionOriginRefusal(params: Readonly<{
    reasons: readonly (PluginMachineOriginRejectionReasonV1 | 'no_materialization')[];
    plugin: string;
    machine: string | undefined;
}>): Readonly<{ sentence: string; manage: boolean }> | null {
    const reasons = params.reasons.filter((reason): reason is PluginMachineOriginRejectionReasonV1 => reason !== 'no_materialization' && reason !== 'missing');
    if (reasons.length === 0) return null;
    if (params.machine === undefined) {
        return { sentence: t('settingsPlugins.surfaces.pluginNotReadyAnywhere', { plugin: params.plugin }), manage: true };
    }
    const groupOf = (reason: PluginMachineOriginRejectionReasonV1) => {
        switch (reason) {
            case 'activation_refused':
            case 'daemon_unsupported':
            case 'daemon_invalid_response': return 'start';
            case 'offline':
            case 'stale':
            case 'home_unreachable':
            case 'daemon_unavailable': return 'unreachable';
            default: return 'notReady';
        }
    };
    // Mixed causes have no single next step: lead to the plugin's page, where each Machine's state is shown.
    const groups = new Set(reasons.map(groupOf));
    const values = { plugin: params.plugin, machine: params.machine };
    if (groups.size === 1 && groups.has('start')) return { sentence: t('settingsPlugins.surfaces.pluginCouldNotStart', values), manage: false };
    if (groups.size === 1 && groups.has('unreachable')) return { sentence: t('settingsPlugins.surfaces.pluginMachineUnreachable', values), manage: false };
    return { sentence: t('settingsPlugins.surfaces.pluginNotReady', values), manage: true };
}

/**
 * The one reason → next-step classification for plugin surfaces.
 *
 * - `retry`: transient — asking again can change the answer (transport,
 *   timeouts, a daemon projection error). Only offered when the caller owns a
 *   real retry path for the failing phase.
 * - `repair` / `updateCompatible` / `managePlugin` / `enable`: configuration —
 *   the fix lives on the plugin's own management page.
 * - `null`: neither a retry nor plugin management can fix it (unsupported
 *   platform/channel/daemon, an invalid link, a policy denial); the card
 *   explains the situation and offers no misleading button.
 */
function resolvePluginSurfaceRecoveryAction(
    reasonCode: string | null | undefined,
): PluginSurfaceStatePresentation['recoveryAction'] {
    switch (reasonCode) {
        case 'targeted_contributions_error':
        case 'targeted_contributions_timeout':
        case 'hosted_web_bridge_timeout':
        case 'artifact_source_unavailable':
        case 'source_unavailable':
        case 'generated_react_native_plugin_root_unavailable':
        case 'generated_hosted_web_plugin_root_unavailable':
        case 'artifact_unavailable':
        case 'transport_unavailable':
        case 'plugin_resource_transport_unavailable':
        case 'artifact_bytes_fetch_failed':
        case 'artifact_bytes_response_invalid':
        case 'response_invalid':
        case 'plugin_resource_transport_error':
        case 'plugin_resource_transport_timeout':
        case 'targeted_contributions_invalid_response':
        case 'artifact_bytes_rpc_unavailable':
        case 'plugin_resource_transport_not_supported':
        case 'load_timeout':
        case 'load_error':
        case 'local_artifact_failure':
        case 'render_error':
        case 'hosted_web_artifact_load_failed':
            return Object.freeze({ kind: 'retry', label: t('common.retry') });
        case 'artifact_source_integrity_invalid':
        case 'artifact_graph_mismatch':
        case 'artifact_slot_ambiguous':
        case 'artifact_source_ambiguous':
        case 'artifact_integrity_invalid':
        case 'integrity_failed':
            return Object.freeze({ kind: 'repair', label: t('settingsPlugins.managePlugin') });
        case 'artifact_incompatible':
        case 'update_required':
        case 'host_ui_api_incompatible':
            return Object.freeze({ kind: 'updateCompatible', label: t('common.update') });
        case 'required_permission_missing':
        case 'artifact_not_current':
        case 'plugin_collection_contract_conflict':
        case 'plugin_resource_admission_unavailable':
        case 'plugin_host_access_disclosure_mismatch':
        case 'plugin_app_page_unavailable':
        case 'module_instantiation_failed':
        case 'unknown_host_module':
        case 'invalid_executable_export':
        case 'invalid_surface_module':
        case 'artifact_graph_invalid':
        case 'hosted_web_artifact_tier_invalid':
        case 'native_artifact_response_table_invalid':
        case 'generated_react_native_artifact_missing':
        case 'generated_react_native_artifact_ambiguous':
        case 'generated_react_native_artifact_graph_invalid':
        case 'generated_react_native_bundler_mismatch':
        case 'generated_react_native_export_missing':
        case 'generated_react_native_platform_undeclared':
        case 'generated_hosted_web_artifact_missing':
        case 'generated_hosted_web_artifact_ambiguous':
        case 'generated_hosted_web_artifact_graph_invalid':
        case 'generated_hosted_web_bundler_mismatch':
            return Object.freeze({ kind: 'managePlugin', label: t('settingsPlugins.managePlugin') });
        case 'feature_disabled':
        case 'disabled':
        case 'plugin_disabled':
            return Object.freeze({ kind: 'enable', label: t('common.enable') });
        case 'plugin_revoked':
        case 'plugin_uninstalled':
        case 'revoked':
        case 'uninstalled':
        case 'artifact_lease_revoked':
            return Object.freeze({ kind: 'managePlugin', label: t('settingsPlugins.managePlugin') });
        default:
            return null;
    }
}

type LocalServiceLauncherMessageKey =
    | 'localServices.rowStatus.stopping'
    | 'localServices.rowStatus.stopped'
    | 'localServices.rowStatus.failed'
    | 'localServices.launcher.unavailableReason.launchUnavailable'
    | 'localServices.launcher.unavailableReason.previewRegistrationUnavailable'
    | 'localServices.launcher.unavailableReason.browserTargetUnavailable'
    | 'localServices.launcher.unavailableReason.starting'
    | 'localServices.launcher.unavailableReason.stale'
    | 'localServices.launcher.unavailableReason.nativeStateUnknown'
    | 'localServices.launcher.unavailableReason.nativeCleanupUnconfirmed'
    | 'localServices.launcher.unavailableReason.unavailable';

type LocalServiceActionMessageKey =
    | 'localServices.actions.failure.outcomeUnknown'
    | 'localServices.actions.failure.serviceNotRunning'
    | 'localServices.actions.failure.previewNotReady'
    | 'localServices.actions.failure.previewFailed'
    | 'localServices.actions.failure.previewUnavailable'
    | 'localServices.actions.failure.refused'
    | 'localServices.actions.failure.unavailable'
    | 'localServices.actions.failure.browserViewUnavailable'
    | 'localServices.actions.failure.incomplete';

function resolveGenericMessage(kind: ReasonCopyKind, servicesActionOffered = false): string {
    switch (kind) {
        case 'browserLaunchpad':
            return t('browserLaunchpad.status.unavailableGeneric');
        case 'localServiceLauncher':
            return t('localServices.launcher.status.unavailableGeneric');
        case 'localServiceInventory':
            // Inventory scan diagnostics are scan-level facts, not per-service failures:
            // a neutral "scan needs attention" line, raw code kept on diagnosticCode only.
            return t('localServices.inventory.errorTitle');
        case 'localServiceAction':
            // An unmapped daemon code means the action was attempted and did not finish; the
            // retryable sentence is the honest default, never the raw code.
            return t('localServices.actions.failure.incomplete', { servicesActionOffered });
        case 'simulatorPreview':
            return t('simulatorPreview.availability.unavailableGeneric');
        case 'streamPlayer':
            return t('streamPlayer.status.errorGeneric');
        case 'pluginRuntime':
            return t('pluginRuntime.unavailableGeneric');
        case 'widget':
            return t('common.unavailable');
        case 'browserDiagnosticsInteraction':
            return t('browserDiagnostics.host.interaction.unavailableReason.generic');
        case 'browserFrame':
        case 'browserStatus':
        case 'browserSurface':
            return t('browserShell.unavailable.generic');
    }
}

function resolveTitle(kind: ReasonCopyKind): string {
    switch (kind) {
        case 'widget':
            return t('widgetAdd.areaUnavailableTitle');
        case 'localServiceInventory':
            return t('localServices.inventory.errorTitle');
        case 'localServiceAction':
            // A refused action is not an "unavailable surface": the caller supplies the specific
            // "Couldn't stop <service>" title, and this generic one only backstops a bare resolve.
            return t('localServices.actions.failure.title');
        case 'simulatorPreview':
        case 'streamPlayer':
            return t('streamPlayer.status.unavailable');
        case 'pluginRuntime':
        case 'browserFrame':
        case 'browserStatus':
        case 'browserSurface':
        case 'browserLaunchpad':
        case 'localServiceLauncher':
            return t('common.unavailable');
        case 'browserDiagnosticsInteraction':
            return t('browserDiagnostics.host.interaction.title');
    }
}

function resolveKnownMessage(kind: ReasonCopyKind, reasonCode: string, servicesActionOffered = false): string | null {
    switch (kind) {
        case 'widget': {
            const key = WIDGET_KEYS[reasonCode as keyof typeof WIDGET_KEYS];
            return key ? t(key) : null;
        }
        case 'browserDiagnosticsInteraction': {
            const key = BROWSER_DIAGNOSTICS_INTERACTION_KEYS[reasonCode as keyof typeof BROWSER_DIAGNOSTICS_INTERACTION_KEYS];
            return key ? t(key) : null;
        }
        case 'browserFrame':
        case 'browserStatus': {
            const key = BROWSER_REASON_KEYS[reasonCode as keyof typeof BROWSER_REASON_KEYS];
            return key ? t(key) : null;
        }
        case 'browserSurface': {
            const key = BROWSER_SURFACE_KEYS[reasonCode as keyof typeof BROWSER_SURFACE_KEYS];
            return key ? t(key) : null;
        }
        case 'localServiceLauncher': {
            const key = LOCAL_SERVICE_LAUNCHER_KEYS[reasonCode as keyof typeof LOCAL_SERVICE_LAUNCHER_KEYS];
            return key ? t(key) : null;
        }
        case 'localServiceInventory': {
            const key = LOCAL_SERVICE_INVENTORY_KEYS[reasonCode as keyof typeof LOCAL_SERVICE_INVENTORY_KEYS];
            return key ? t(key) : null;
        }
        case 'localServiceAction': {
            const key = LOCAL_SERVICE_ACTION_KEYS[reasonCode as keyof typeof LOCAL_SERVICE_ACTION_KEYS];
            return key === 'localServices.actions.failure.unavailable' || key === 'localServices.actions.failure.browserViewUnavailable' ? t(key)
                : key ? t(key, { servicesActionOffered }) : null;
        }
        case 'simulatorPreview': {
            const key = SIMULATOR_PREVIEW_KEYS[reasonCode as keyof typeof SIMULATOR_PREVIEW_KEYS];
            return key ? t(key) : null;
        }
        case 'streamPlayer': {
            const key = STREAM_PLAYER_KEYS[reasonCode as keyof typeof STREAM_PLAYER_KEYS];
            return key ? t(key) : null;
        }
        case 'pluginRuntime': {
            const key = PLUGIN_RUNTIME_KEYS[reasonCode as keyof typeof PLUGIN_RUNTIME_KEYS];
            return key ? t(key) : null;
        }
        case 'browserLaunchpad': {
            if (reasonCode === 'local_service_preview_refresh_failed') {
                return t('browserLaunchpad.error.previewRefreshFailed');
            }
            // Launchpad disabledReason/detail are free-form strings; a known browser
            // adapter code still maps cleanly, anything else uses the generic fallback.
            const key = BROWSER_REASON_KEYS[reasonCode as keyof typeof BROWSER_REASON_KEYS];
            return key ? t(key) : null;
        }
    }
}

/**
 * The ONE reason-code → product-copy mapper. Maps a known internal reason code
 * to a localized, user-facing message. Unknown codes fall back to a generic
 * localized "unavailable" message — the raw code is NEVER returned for primary
 * UI. The raw code is preserved on `diagnosticCode` for diagnostics-only
 * surfaces (test-ids, logs).
 */
export function resolveReasonCopy(input: Readonly<{
    reasonCode: string | null | undefined;
    kind: ReasonCopyKind;
    prerequisite?: LocalServiceNativePrerequisiteV1;
    establishmentFailure?: LocalServiceEstablishmentFailureV1;
    machineName?: string;
    serviceName?: string;
    /** True only when this presentation offers a Services control. */
    servicesActionOffered?: boolean;
    /** The surrounding title already names the Service, so the body does not repeat it as a prefix. */
    serviceNamedByTitle?: boolean;
}>): ResolvedReasonCopy {
    const rawCode = input.reasonCode ?? null;
    const frameTitleKey = input.kind === 'browserFrame' && rawCode
        ? BROWSER_FRAME_TITLE_KEYS[rawCode as keyof typeof BROWSER_FRAME_TITLE_KEYS] : undefined;
    const startFailed = input.kind === 'localServiceAction' && rawCode === 'plugin_managed_service_establishment_failed';
    const title = startFailed ? t('localServices.actions.failure.startFailedTitle') : frameTitleKey ? t(frameTitleKey) : resolveTitle(input.kind);
    const known = rawCode ? resolveKnownMessage(input.kind, rawCode, input.servicesActionOffered) : null;
    const prerequisite = input.kind === 'localServiceAction' && rawCode === 'native_tool_unavailable' ? input.prerequisite : undefined;
    const failure = input.kind === 'localServiceAction' && rawCode === 'plugin_managed_service_establishment_failed'
        ? input.establishmentFailure : undefined;
    const serviceKey = input.kind === 'localServiceAction' && rawCode
        ? LOCAL_SERVICE_ACTION_KEYS[rawCode as keyof typeof LOCAL_SERVICE_ACTION_KEYS] : undefined;
    const stoppedService = serviceKey === 'localServices.actions.failure.serviceNotRunning';
    const body = startFailed && input.serviceName
        ? t('localServices.actions.failure.namedStartFailed', { service: input.serviceName })
        : stoppedService ? input.serviceName
        ? t('localServices.actions.failure.namedServiceNotRunning', { service: input.serviceName, servicesActionOffered: input.servicesActionOffered })
        : t('localServices.actions.failure.serviceNotRunning', { servicesActionOffered: input.servicesActionOffered })
        : input.kind === 'localServiceLauncher' && rawCode === 'project_service_binding_unavailable' && input.machineName
        ? t('localServices.launcher.unavailableReason.bindingUnavailableOnMachine', { machine: input.machineName })
        : prerequisite ? t(`localServices.actions.failure.docker.${prerequisite.cause}`, { machine: prerequisite.machineName })
        : failure?.cause === 'port_in_use' && failure.port !== undefined ? t(failure.sameProject
            ? 'localServices.actions.failure.portInUseSameProject' : 'localServices.actions.failure.portInUse', { port: failure.port })
        : failure?.exitCode !== undefined ? t('localServices.actions.failure.processExit', { code: String(failure.exitCode) })
        : startFailed ? t('localServices.actions.failure.startFailed')
        : known ?? resolveGenericMessage(input.kind, input.servicesActionOffered);
    const namedBody = input.kind === 'localServiceAction' && input.serviceName && !input.serviceNamedByTitle && !stoppedService && !startFailed
        ? t('localServices.actions.failure.namedReason', { service: input.serviceName, reason: body }) : body;
    return {
        title,
        body: namedBody,
        message: namedBody,
        diagnosticCode: rawCode,
    };
}

/**
 * A local-service action refused by a policy, permission or confirmation the person can go and change:
 * the one family of failures that needs them, drawn amber. Every other failure is rose.
 */
export function isLocalServiceActionRefusedByPolicy(reasonCode: string | null | undefined): boolean {
    return Boolean(reasonCode)
        && LOCAL_SERVICE_ACTION_KEYS[reasonCode as keyof typeof LOCAL_SERVICE_ACTION_KEYS] === 'localServices.actions.failure.refused';
}

/**
 * Projects already-owned plugin-surface facts into shared state-card chrome.
 * It has no lifecycle, cache, retry, or currentness authority: callers supply
 * the factual state and whether they still hold a valid retained snapshot.
 */
export function resolvePluginSurfaceStatePresentation(input: Readonly<{
    state: PluginSurfacePresentationState;
    /** Native host admissions must not borrow plugin-runtime terminal vocabulary. */
    reasonKind?: 'pluginRuntime' | 'widget';
    reasonCode?: string | null;
    /** Typed Resource replies may carry their cause under a generic envelope code. */
    diagnostics?: readonly string[];
    /** A renderer may retain its established localized title without owning copy selection. */
    title?: string;
    /** Only the factual content owner may assert that its last-known-good content is retained. */
    hasRetainedContent?: boolean;
    /**
     * The plugin's display name. A terminal card that fills a whole page has no
     * header around it, so it names what failed instead of a bare "Unavailable".
     */
    subjectName?: string | null;
}>): PluginSurfaceStatePresentation {
    const reasonCode = input.reasonKind !== 'widget'
        && (!input.reasonCode || input.reasonCode === 'unavailable' || input.reasonCode === 'plugin_resource_unavailable')
        ? input.diagnostics?.find((code) => Object.hasOwn(PLUGIN_RUNTIME_KEYS, code)) ?? input.reasonCode
        : input.reasonCode;
    const reason = resolveReasonCopy({
        reasonCode,
        kind: input.reasonKind ?? 'pluginRuntime',
    });
    const subjectName = input.subjectName?.trim();
    const namedTitle = !subjectName
        ? undefined
        : input.state === 'unavailable'
            ? t('pluginSurfaces.state.namedUnavailable', { name: subjectName })
            : input.state === 'failedRetry'
                ? t('pluginSurfaces.state.namedFailed', { name: subjectName })
                : undefined;
    const copy = resolvePluginSurfacePresentationCopy({
        state: input.state,
        title: namedTitle ?? input.title,
        reason,
        hasSpecificReason: !!reasonCode && resolveKnownMessage(input.reasonKind ?? 'pluginRuntime', reasonCode) !== null,
    });
    // A widget's own durable fact is one sentence: the generic "unavailable" title would only repeat it.
    const widgetFactCard = input.reasonKind === 'widget' && !!reasonCode && resolveKnownMessage('widget', reasonCode) !== null;
    const unavailableCard = (): PluginSurfaceStatePresentation['card'] => Object.freeze({
        kind: 'unavailable',
        title: widgetFactCard ? reason.body : copy.title ?? reason.title,
        ...(widgetFactCard ? {} : { reason: copy.reason }),
        accessibilitySemantics: 'status',
    });
    const loadingCard = (): PluginSurfaceStatePresentation['card'] => Object.freeze({
        kind: 'loading',
        title: copy.title ?? t('common.loading'),
        reason: copy.reason,
        accessibilitySemantics: 'status',
    });
    const failedRetryCard = (): PluginSurfaceStatePresentation['card'] => Object.freeze({
        kind: 'error',
        title: copy.title ?? t('common.error'),
        reason: copy.reason,
        accessibilitySemantics: 'alert',
    });
    const contentNotice = input.state === 'available'
        ? null
        : input.hasRetainedContent
            ? Object.freeze({
                title: copy.title
                    ?? (input.state === 'failedRetry' ? t('common.error') : reason.title),
                reason: copy.reason,
                accessibilitySemantics: 'status' as const,
            })
            : null;
    // Loading is not a failure: nothing needs recovering while content is on its way.
    const recoveryAction = input.state === 'loading' || input.state === 'refreshing'
        ? null
        : resolvePluginSurfaceRecoveryAction(reasonCode);

    if (input.state !== 'available' && input.hasRetainedContent) {
        return Object.freeze({
            state: input.state,
            disposition: 'retain',
            diagnosticCode: reason.diagnosticCode,
            card: null,
            contentNotice: contentNotice!,
            recoveryAction,
        });
    }

    switch (input.state) {
        case 'available':
            return Object.freeze({
                state: input.state,
                disposition: 'content',
                diagnosticCode: reason.diagnosticCode,
                card: null,
                contentNotice,
                recoveryAction,
            });
        case 'refreshing':
            return Object.freeze({
                state: input.state,
                disposition: 'replace',
                diagnosticCode: reason.diagnosticCode,
                card: loadingCard(),
                contentNotice: null,
                recoveryAction,
            });
        case 'stale':
        case 'offline':
            return Object.freeze({
                state: input.state,
                disposition: 'replace',
                diagnosticCode: reason.diagnosticCode,
                card: unavailableCard(),
                contentNotice: null,
                recoveryAction,
            });
        case 'failedRetry':
            return Object.freeze({
                state: input.state,
                disposition: 'replace',
                diagnosticCode: reason.diagnosticCode,
                card: failedRetryCard(),
                contentNotice: null,
                recoveryAction,
            });
        case 'loading':
            return Object.freeze({
                state: input.state,
                disposition: 'replace',
                diagnosticCode: reason.diagnosticCode,
                card: loadingCard(),
                contentNotice: null,
                recoveryAction,
            });
        case 'unavailable':
            return Object.freeze({
                state: input.state,
                disposition: 'replace',
                diagnosticCode: reason.diagnosticCode,
                card: unavailableCard(),
                contentNotice: null,
                recoveryAction,
            });
    }
}
