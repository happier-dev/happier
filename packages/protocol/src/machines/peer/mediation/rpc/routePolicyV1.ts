import { HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD } from '../../../../marketplace/internal.js';
import { RPC_METHODS, SESSION_RPC_METHODS } from '../../../../rpc/index.js';
import { MachineLiveStreamRelayCapsV1Schema, type MachineLiveStreamRelayCaps } from '../stream/v1.js';
import { resolveMachineRpcGovernance, type MachineRpcGovernanceClassification } from './governanceV1.js';

export type { MachineRpcGovernanceClassification } from './governanceV1.js';

export type MachineRpcMethod =
  | (typeof RPC_METHODS)[keyof typeof RPC_METHODS]
  | (typeof SESSION_RPC_METHODS)[keyof typeof SESSION_RPC_METHODS];

export type MachineRpcRouteClass = 'server_required' | 'direct_ephemeral' | 'direct_medium_risk_receipted';

export type MachineRpcServerRequiredReason =
  | 'unclassified' | 'durable_session_write' | 'transcript_write'
  | 'pending_queue' | 'server_sequence_assignment' | 'reconnect_catch_up'
  | 'cross_device_fanout' | 'auth' | 'sharing' | 'billing'
  | 'automation' | 'account_change' | 'server_persistence'
  | 'destructive_or_recovery_mutation' | 'ambiguous';

// server_required covers durable/transcript/pending_queue/sequence/auth/sharing/billing/automation/account/fanout methods.

export type MachineRpcRoutePolicyScopeV1 = Readonly<{
  accountRequired: boolean;
  machineRequired: boolean;
  sessionRequired: boolean;
  serverRequired: boolean;
}>;

export type MachineRpcRouteRelayFallbackPolicyV1 = Readonly<{
  /**
   * Legacy Machine-RPC fallback classification. This is not a
   * `PeerFlowKindV1` and never admits or identifies a `voice_media` tunnel.
   */
  flowKind: 'daemon_voice_audio';
  defaultSharedServerMode: 'disabled';
  authorizationRequired: boolean;
  relayCapsRequired: boolean;
  meteringRequired: boolean;
  lifecycleReceiptRequired: boolean;
  capProfile: 'machine_live_stream_relay_caps_v1';
}>;

export type MachineRpcRoutePolicyV1 = Readonly<{
  method: string;
  routeClass: MachineRpcRouteClass;
  rationale: string;
  ownerPacket: 'PMS-5';
  rpcClassification: MachineRpcGovernanceClassification;
  actionSpecId?: string;
  commandReceiptRequired: boolean;
  scope: MachineRpcRoutePolicyScopeV1;
  serverRequiredReason?: MachineRpcServerRequiredReason;
  relayFallback?: MachineRpcRouteRelayFallbackPolicyV1;
}>;

export type MachineRpcRelayFallbackDeploymentKind = 'shared_server' | 'self_hosted';

export const DAEMON_VOICE_AUDIO_RELAY_CAP_PROFILE_ID = 'machine_live_stream_relay_caps_v1';
export const VOICE_MEDIA_RELAY_TUNNEL_ID_PREFIX = 'voice-media:';

export function createVoiceMediaRelayTunnelId(input: Readonly<{
  machineId: string;
  requestId: string;
}>): string {
  return `${VOICE_MEDIA_RELAY_TUNNEL_ID_PREFIX}${input.machineId}:${input.requestId}`;
}

export function isVoiceMediaRelayTunnelId(tunnelId: string): boolean {
  return tunnelId.startsWith(VOICE_MEDIA_RELAY_TUNNEL_ID_PREFIX)
    && tunnelId.length > VOICE_MEDIA_RELAY_TUNNEL_ID_PREFIX.length;
}

export type MachineRpcRelayFallbackDecision = Readonly<
  | {
    ok: true;
    routeKind: 'server_relay';
    caps: MachineLiveStreamRelayCaps;
    policy: MachineRpcRouteRelayFallbackPolicyV1;
  }
  | {
    ok: false;
    routeKind: 'server_relay';
    reasonCode: 'relay_fallback_not_supported' | 'relay_disabled_by_policy' | 'relay_caps_required' | 'invalid_relay_caps';
  }
>;

export type MachineRpcRoutePolicyValidationResult = Readonly<{
  ok: boolean;
  policies: readonly MachineRpcRoutePolicyV1[];
  missingMethods: readonly string[];
  unknownMethods: readonly string[];
  duplicateMethods: readonly string[];
  invalidMethods: readonly string[];
}>;

const DIRECT_EPHEMERAL_SCOPE: MachineRpcRoutePolicyScopeV1 = Object.freeze({ accountRequired: true, machineRequired: true, sessionRequired: false, serverRequired: false });

const SERVER_REQUIRED_SCOPE: MachineRpcRoutePolicyScopeV1 = Object.freeze({ accountRequired: true, machineRequired: true, sessionRequired: false, serverRequired: true });

const SESSION_SERVER_REQUIRED_SCOPE: MachineRpcRoutePolicyScopeV1 = Object.freeze({ accountRequired: true, machineRequired: true, sessionRequired: true, serverRequired: true });

function directEphemeral(
  method: MachineRpcMethod,
  rationale: string,
): MachineRpcRoutePolicyV1 {
  return {
    method,
    routeClass: 'direct_ephemeral',
    rationale,
    ownerPacket: 'PMS-5',
    ...resolveMachineRpcGovernance(method),
    commandReceiptRequired: false,
    scope: DIRECT_EPHEMERAL_SCOPE,
  };
}

function directMediumRiskReceipted(
  method: MachineRpcMethod,
  rationale: string,
  relayFallback?: MachineRpcRouteRelayFallbackPolicyV1,
): MachineRpcRoutePolicyV1 {
  return {
    method,
    routeClass: 'direct_medium_risk_receipted',
    rationale,
    ownerPacket: 'PMS-5',
    ...resolveMachineRpcGovernance(method),
    commandReceiptRequired: true,
    scope: DIRECT_EPHEMERAL_SCOPE,
    ...(relayFallback ? { relayFallback } : {}),
  };
}

function serverRequired(
  method: MachineRpcMethod,
  serverRequiredReason: MachineRpcServerRequiredReason,
  rationale: string,
  scope: MachineRpcRoutePolicyScopeV1 = SERVER_REQUIRED_SCOPE,
): MachineRpcRoutePolicyV1 {
  return {
    method,
    routeClass: 'server_required',
    rationale,
    ownerPacket: 'PMS-5',
    ...resolveMachineRpcGovernance(method),
    commandReceiptRequired: false,
    scope,
    serverRequiredReason,
  };
}

function serverRequiredRows(
  methods: readonly MachineRpcMethod[],
  serverRequiredReason: MachineRpcServerRequiredReason,
  rationale: string,
  scope?: MachineRpcRoutePolicyScopeV1,
): readonly MachineRpcRoutePolicyV1[] {
  return methods.map((method) => serverRequired(method, serverRequiredReason, rationale, scope));
}

function actionSpecServerRequired(
  method: MachineRpcMethod,
  serverRequiredReason: MachineRpcServerRequiredReason,
  rationale: string,
  actionSpecId: string,
  scope?: MachineRpcRoutePolicyScopeV1,
): MachineRpcRoutePolicyV1 {
  return {
    ...serverRequired(method, serverRequiredReason, rationale, scope),
    rpcClassification: 'action_spec_bound',
    actionSpecId,
  };
}

const HOST_PRIVATE_PLUGIN_INSTALL_DECISION_ROUTE_POLICY: MachineRpcRoutePolicyV1 = Object.freeze({
  method: HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
  routeClass: 'direct_medium_risk_receipted',
  rationale: 'Present-user plugin installation approval mutates daemon-owned trust and installation state through a host-private exact-machine command; direct routing requires command receipt coverage.',
  ownerPacket: 'PMS-5',
  rpcClassification: 'internal_only',
  commandReceiptRequired: true,
  scope: DIRECT_EPHEMERAL_SCOPE,
});

const DIRECT_EPHEMERAL_POLICIES = Object.freeze([
  directEphemeral(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST, 'Daemon-local execution run registry read; no server persistence, transcript write, or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_MEMORY_STATUS, 'Daemon-local memory worker status read with no mutation or server persistence.'),
  directEphemeral(RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET, 'Daemon-local memory settings read with no account mutation.'),
  directEphemeral(RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS, 'Daemon-local voice inference worker status read.'),
  directEphemeral(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LIST, 'Daemon-local installed/available model list read.'),
  directEphemeral(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS, 'Daemon-local model status read.'),
  directEphemeral(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG, 'Resolver-backed speech catalog read; SavedSecret material remains inside the daemon operation.'),
  directEphemeral(RPC_METHODS.DAEMON_EXTENSIONS_RELOAD_STATUS, 'Daemon-local extension reload status read.'),
  directEphemeral(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, 'Daemon-local contribution registry projection describe read.'),
  directEphemeral(RPC_METHODS.DAEMON_MARKETPLACE_INDEX_QUERY, 'Daemon-local marketplace index query reads the current machine-owned source projection without server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_GET, 'Daemon-local npm registry profile read keeps private registry configuration inside the selected machine boundary.'),
  directEphemeral(RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_STATUS_GET, 'Daemon-local Agent session-hook status returns only portable installation state and diagnostics.'),
  directEphemeral(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET, 'Daemon-local plugin settings read with no server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_WATCH, 'Daemon-local plugin settings invalidation wait returns only revision and status with no setting values, server persistence, or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_PLUGIN_SECRET_STATUS, 'Daemon-local declared plugin-secret status projects only safe presence and revision through the current generation-bound custody service; no material, server persistence, or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_PLUGIN_INVOCATION_LOGS_READ, 'Exact-machine bounded structured plugin-log read through the canonical daemon logger; no server persistence, new log store, or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_PLUGIN_ACTION_FORM_CONNECTED_ACCOUNT_OPTIONS_RESOLVE, 'Daemon-local, generation-leased Connected Account form option read derives one Action-declared select authorization and returns only bounded safe labels plus opaque exact account references; no durable form state, account enumeration, or server persistence.'),
  directEphemeral(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ, 'Daemon-local installed plugin UI artifact byte read with no server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_PLUGIN_COMPOSER_REFERENCE_SEARCH, 'Daemon-local generation-leased composer-reference picker search returns bounded candidates through the canonical registered reference; no durable resolved context, server persistence, or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ, 'Daemon-local generation-leased plugin resource snapshot read for a mounted plugin UI surface; no server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN, 'Daemon-local plugin resource invalidation subscription open; establishes one bounded daemon-side observer and returns its current digest without server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT, 'Daemon-local plugin resource invalidation long-poll; returns one bounded signal carrying no resource bytes, without server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE, 'Daemon-local plugin resource invalidation subscription retirement with no server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_STATUS, 'Exact-machine Voice diagnostics status reads private daemon-local retention state without mutation or server persistence.'),
  directEphemeral(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_CHUNK, 'Exact-machine Voice diagnostics export chunk reads encrypted bytes from an already-authorized ephemeral download session.'),
  directEphemeral(RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT, 'Daemon-local local-services inventory snapshot read with no server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH, 'Daemon-local local-services inventory refresh with typed snapshot response and no server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH, 'Daemon-local local-services inventory change long-poll; parks on the daemon-local inventory event producer and answers with one bounded typed snapshot or a no-change result, with no server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT, 'Daemon-local local-services launcher snapshot read with no server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT, 'Daemon-local local-services preview snapshot read with no server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS, 'Daemon-local public-preview status read returns server-derived exposure state through an explicit machine/session/preview-bound snapshot without mutating exposure state.'),
  directEphemeral(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_COPY_URL, 'Daemon-local public-preview copy URL reads an already-active known public exposure URL without creating or inferring exposure state.'),
  directEphemeral(RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH, 'Daemon-local browser control command dispatch (human-owner navigate/reload/stop/close/setTarget on a daemon-authoritative view) routed to the shared control broker with typed validation and no durable server mutation or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT, 'Daemon-local browser diagnostics snapshot read with bounded redacted events and no server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_BROWSER_RECORDING_START, 'Daemon-local browser recording start command with typed runtime validation and no server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_BROWSER_RECORDING_STOP, 'Daemon-local browser recording stop command with typed runtime validation and no server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_BROWSER_RECORDING_CANCEL, 'Daemon-local browser recording cancel command with typed runtime validation and no server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_BROWSER_RECORDING_STATUS, 'Daemon-local browser recording status read with no server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_BROWSER_RECORDING_LIST, 'Daemon-local browser recording list read with no server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_BROWSER_RECORDING_CLEANUP, 'Daemon-local browser recording retention cleanup trigger with typed runtime validation and no server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME, 'Reverse daemon->UI native-view recording frame capture request: the daemon asks the connected desktop UI to write one reference-only PNG frame from the Wry WebView it owns, bounded by the recording byte cap, with no server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_SNAPSHOT, 'Daemon-local simulator preview snapshot read with no server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_ACTION, 'Daemon-local simulator preview action dispatch with typed adapter validation and no durable server mutation.'),
  directEphemeral(RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES, 'Daemon-local prompt asset type catalog read.'),
  directEphemeral(RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_ADAPTERS, 'Daemon-local prompt registry adapter catalog read.'),
  directEphemeral(RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_SOURCES, 'Daemon-local prompt registry source catalog read.'),
  directEphemeral(RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_GET, 'Daemon-local marketplace source registry read.'),
  directEphemeral(RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET, 'Daemon-local session-runner runtime status read with no server persistence or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET, 'Daemon-local additive session-runner status read carrying only exact process-currentness evidence beside the unchanged V1 aggregate.'),
  directEphemeral(RPC_METHODS.SCM_BACKEND_DESCRIBE, 'Daemon-local source-control backend capability describe read.'),
  directEphemeral(RPC_METHODS.CAPABILITIES_DESCRIBE, 'Daemon-local capability descriptor read.'),
] satisfies readonly MachineRpcRoutePolicyV1[]);

const DIRECT_MEDIUM_RISK_RECEIPTED_POLICIES = Object.freeze([
  directMediumRiskReceipted(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE, 'Daemon-local private-preview openOrCreate mutates the machine-scoped preview registry and mints a BrowserViewTarget-bearing snapshot row; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_REVOKE, 'Daemon-local private-preview revoke unregisters a machine-scoped preview registry row; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START, 'Daemon-local local-services launcher start can launch local service targets; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_OPEN_PREVIEW, 'Daemon-local local-services launcher openPreview resolves and opens a local preview target; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_REGISTER_PREVIEW, 'Daemon-local local-services launcher registerPreview persists a private preview target; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_HISTORY_CLEAR, 'Daemon-local local-services launcher history clear mutates the daemon-owned launcher feed; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE, 'Daemon-local local-services action dispatch can stop/restart/terminate local services; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE, 'Daemon-mediated public-preview create can expose a local service through a public URL; direct routing requires command receipt coverage and server-side authorization.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_REVOKE, 'Daemon-mediated public-preview revoke terminates a public exposure; direct routing requires command receipt coverage and server-side authorization.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_BROWSER_CONTEXT_DISPATCH, 'Daemon-local browser context dispatch can capture, attach, clear, or annotate browser context through one typed runtime dispatcher; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_MUTATE, 'Daemon-local npm registry profile mutation writes private machine configuration; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_INSTALL, 'Explicit Agent session-hook install mutates machine-local Agent configuration and rotates a scoped credential; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_DISABLE, 'Explicit Agent session-hook disable mutates machine-local Agent configuration; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_ENABLE, 'Explicit Agent session-hook enable mutates machine-local Agent configuration; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_UNINSTALL, 'Explicit Agent session-hook uninstall removes owned machine-local configuration and revokes its scoped credential; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET, 'Daemon-local plugin settings mutation writes machine-scoped configuration; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_PLUGIN_COLLECTION_CANDIDATE_PREPARATION_EXECUTE, 'Daemon-owned Collection candidate preparation invokes only exact trusted target callbacks and writes bounded non-authoritative Account Data stages; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_PLUGIN_SECRET_SET, 'Daemon-local declared plugin-secret creation or replacement mutates the selected machine custody through its current generation-bound service; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_PLUGIN_SECRET_DELETE, 'Daemon-local declared plugin-secret deletion mutates the selected machine custody through its current generation-bound service; direct routing requires command receipt coverage.'),
  HOST_PRIVATE_PLUGIN_INSTALL_DECISION_ROUTE_POLICY,
  directMediumRiskReceipted(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE, 'Daemon-local structured-message action execution enters the canonical plugin action executor; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_CONFIGURE, 'Exact-machine Voice diagnostics configuration mutates private local retention policy; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_DELETE_ALL, 'Exact-machine Voice diagnostics delete-all destroys private retained artifacts and active export sessions; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_REVOKE_CAPTURE, 'Exact-machine Voice diagnostics revocation mutates local capture authorization; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_INIT, 'Exact-machine Voice diagnostics export init authorizes and opens an encrypted ephemeral download session; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_FINALIZE, 'Exact-machine Voice diagnostics export finalize closes an ephemeral download session; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_ABORT, 'Exact-machine Voice diagnostics export abort closes an ephemeral download session; direct routing requires command receipt coverage.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START, 'Delivers a server-minted signed live-stream start request to the source daemon; direct routing requires command receipt coverage before the server re-verifies the echoed authorization.'),
  directMediumRiskReceipted(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL, 'Daemon-local session-runner bulk restart mutates local runtime processes; direct routing requires command receipt coverage.'),
] satisfies readonly MachineRpcRoutePolicyV1[]);

const DAEMON_VOICE_AUDIO_RELAY_FALLBACK_POLICY = Object.freeze({
  flowKind: 'daemon_voice_audio',
  defaultSharedServerMode: 'disabled',
  authorizationRequired: true,
  relayCapsRequired: true,
  meteringRequired: true,
  lifecycleReceiptRequired: true,
  capProfile: DAEMON_VOICE_AUDIO_RELAY_CAP_PROFILE_ID,
} satisfies MachineRpcRouteRelayFallbackPolicyV1);

const DAEMON_VOICE_AUDIO_DIRECT_METHODS = [
  RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_SYNTHESIZE,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CHUNK,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_FINALIZE,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_START,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_NEXT,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_STATUS,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS,
  RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_INIT,
  RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_CHUNK,
  RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_FINALIZE,
  RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE,
  RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE,
  RPC_METHODS.DAEMON_VOICE_SPEECH_DOWNLOAD_CHUNK,
  RPC_METHODS.DAEMON_VOICE_SPEECH_DOWNLOAD_FINALIZE,
] as const;

const DAEMON_VOICE_AUDIO_DIRECT_METHOD_SET = new Set<string>(DAEMON_VOICE_AUDIO_DIRECT_METHODS);

const DAEMON_VOICE_AUDIO_DIRECT_POLICIES = Object.freeze(
  DAEMON_VOICE_AUDIO_DIRECT_METHODS.map((method) => directMediumRiskReceipted(
    method,
    'Daemon voice audio/control operation is daemon-local and direct-preferred only with command receipts; server relay fallback remains opt-in and requires signed authorization, relay caps, metering, and lifecycle receipts for remote web or native mobile clients without a direct route.',
    DAEMON_VOICE_AUDIO_RELAY_FALLBACK_POLICY,
  )),
);

const SESSION_DURABLE_METHODS = [
  RPC_METHODS.SPAWN_HAPPY_SESSION, RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE, RPC_METHODS.SESSION_SPAWN_NEW, RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE, RPC_METHODS.DAEMON_SPAWN_SESSION_ABANDON, RPC_METHODS.STOP_SESSION, RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY, RPC_METHODS.SESSION_FORK, RPC_METHODS.SESSION_FORK_PROVIDER_SAFE,
  RPC_METHODS.SESSION_PERMISSION_RESPOND, RPC_METHODS.SESSION_USER_ACTION_ANSWER, RPC_METHODS.SESSION_PERMISSION_MODE_SET,
  RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH,
  RPC_METHODS.DAEMON_SESSION_GOAL_GET,
  RPC_METHODS.DAEMON_SESSION_GOAL_SET,
  RPC_METHODS.DAEMON_SESSION_GOAL_CLEAR,
  RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
  RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL,
  RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
  RPC_METHODS.APPROVAL_REQUEST_LIST, RPC_METHODS.APPROVAL_REQUEST_GET, RPC_METHODS.APPROVAL_REQUEST_CREATE, RPC_METHODS.APPROVAL_REQUEST_DECIDE,
  RPC_METHODS.SESSIONS_SUBAGENTS_LIST, RPC_METHODS.SESSIONS_SUBAGENTS_GET, RPC_METHODS.SESSIONS_SUBAGENTS_WATCH,
  RPC_METHODS.SESSIONS_SUBAGENTS_UPSERT, RPC_METHODS.SESSIONS_SUBAGENTS_UPDATE_STATUS, RPC_METHODS.SESSIONS_SUBAGENTS_COMPLETE,
  SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS,
  SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_MATERIALIZE_NEXT,
  SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1,
  SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ACCEPTED_V1,
  SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ABANDONED_V1,
  SESSION_RPC_METHODS.SESSION_GOAL_GET,
  SESSION_RPC_METHODS.SESSION_GOAL_SET,
  SESSION_RPC_METHODS.SESSION_GOAL_CLEAR,
  SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
  SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL,
  SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
  SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE,
  SESSION_RPC_METHODS.SESSION_WORK_STATE_GET,
  SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK,
  SESSION_RPC_METHODS.SESSION_CHECKPOINT,
  SESSION_RPC_METHODS.SESSION_RESTORE,
  SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
  SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, SESSION_RPC_METHODS.EXECUTION_RUN_START, SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
  SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START, SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1,
  SESSION_RPC_METHODS.EXECUTION_RUN_SEND, SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
  SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2, SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1,
  SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL, SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
  SESSION_RPC_METHODS.EXECUTION_RUN_LIST, SESSION_RPC_METHODS.EXECUTION_RUN_GET, SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
  SESSION_RPC_METHODS.SESSION_ROLLBACK,
] as const;

const PLUGIN_PERMISSION_GRANT_METHODS = [
  RPC_METHODS.PLUGIN_PERMISSION_GRANTS_LIST,
  RPC_METHODS.PLUGIN_PERMISSION_GRANTS_REQUEST,
  RPC_METHODS.PLUGIN_PERMISSION_GRANTS_GRANT,
  RPC_METHODS.PLUGIN_PERMISSION_GRANTS_REVOKE,
  RPC_METHODS.PLUGIN_PERMISSION_GRANTS_DISMISS_REQUEST,
] as const;

const REVIEW_COMMENT_METHODS = [
  RPC_METHODS.REVIEW_COMMENTS_CREATE,
  RPC_METHODS.REVIEW_COMMENTS_LIST,
  RPC_METHODS.REVIEW_COMMENTS_GET,
  RPC_METHODS.REVIEW_COMMENTS_TRANSITION,
  RPC_METHODS.REVIEW_COMMENTS_EDIT,
  RPC_METHODS.REVIEW_COMMENTS_REPLY,
  RPC_METHODS.REVIEW_COMMENTS_REDACT,
  RPC_METHODS.REVIEW_COMMENTS_SET_DISPOSITION,
  RPC_METHODS.REVIEW_COMMENTS_ATTACH_EVIDENCE,
  RPC_METHODS.REVIEW_COMMENTS_BULK_TRANSITION,
  RPC_METHODS.REVIEW_COMMENTS_CLAIM_PUBLICATION_DISPATCH,
] as const;

const SESSION_AUTH_CONTROL_METHODS = [
  SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION,
  SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY,
  SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION,
  SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT,
  SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
  SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP,
  SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH,
] as const;

const SESSION_USAGE_LIMIT_RECOVERY_CREDIT_METHODS = [
  RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT,
  SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT,
] as const;

const TRANSFER_CONTROL_METHODS = [
  RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE,
  RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT, RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE, RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
  RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
  RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE,
  RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT, RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CAPABILITY_GET_V1,
  RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE,
  RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT, RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_CHUNK,
  RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_FINALIZE, RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_ABORT, RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
  RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK, RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE, RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT,
  RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_INIT, RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_CHUNK,
  RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_FINALIZE, RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_ABORT,
] as const;

const LOCAL_MUTATION_METHODS = [
  RPC_METHODS.STOP_DAEMON,
  RPC_METHODS.DAEMON_TERMINAL_ENSURE,
  RPC_METHODS.DAEMON_TERMINAL_INPUT,
  RPC_METHODS.DAEMON_TERMINAL_RESIZE,
  RPC_METHODS.DAEMON_TERMINAL_CLOSE,
  RPC_METHODS.DAEMON_TERMINAL_RESTART,
  RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT,
  RPC_METHODS.DAEMON_MEMORY_SETTINGS_SET,
  RPC_METHODS.DAEMON_VOICE_SPEECH_SETTINGS_ACTION_EXECUTE,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LICENSE_ACCEPT,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_REMOVE,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_ABORT,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CANCEL,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_ACK,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_CANCEL,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_ABORT,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_CANCEL,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CANCEL,
  RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_ABORT,
  RPC_METHODS.DAEMON_VOICE_SPEECH_DOWNLOAD_ABORT,
  RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE,
  RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE,
  RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFIRM,
  RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFLICT_CONFIRM,
  RPC_METHODS.DAEMON_EXTENSIONS_RELOAD,
  RPC_METHODS.DAEMON_PLUGIN_UI_REACT_NATIVE_CRASH_REPORT_SUBMIT,
  RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE,
  RPC_METHODS.DAEMON_PROMPT_REGISTRY_SCAN_SOURCE,
  RPC_METHODS.DAEMON_PROMPT_REGISTRY_INSTALL,
  RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_SET,
  RPC_METHODS.WRITE_FILE,
  RPC_METHODS.CREATE_DIRECTORY,
  RPC_METHODS.RENAME_PATH,
  RPC_METHODS.DELETE_PATH,
  RPC_METHODS.SCM_CHANGE_INCLUDE,
  RPC_METHODS.SCM_CHANGE_EXCLUDE,
  RPC_METHODS.SCM_CHANGE_DISCARD,
  RPC_METHODS.SCM_COMMIT_CREATE,
  RPC_METHODS.SCM_COMMIT_BACKOUT,
  RPC_METHODS.SCM_BRANCH_CREATE,
  RPC_METHODS.SCM_BRANCH_CHECKOUT,
  RPC_METHODS.SCM_BRANCH_MERGE,
  RPC_METHODS.SCM_BRANCH_REBASE,
  RPC_METHODS.SCM_BRANCH_OPERATION_CONTINUE,
  RPC_METHODS.SCM_BRANCH_OPERATION_ABORT,
  RPC_METHODS.SCM_WORKTREE_CREATE,
  RPC_METHODS.SCM_WORKTREE_REMOVE,
  RPC_METHODS.SCM_WORKTREE_PRUNE,
  RPC_METHODS.SCM_REMOTE_ADD,
  RPC_METHODS.SCM_REMOTE_SET_URL,
  RPC_METHODS.SCM_REMOTE_REMOVE,
  RPC_METHODS.SCM_REMOTE_FETCH,
  RPC_METHODS.SCM_REMOTE_PUSH,
  RPC_METHODS.SCM_REMOTE_PULL,
  RPC_METHODS.SCM_REMOTE_PUBLISH,
  RPC_METHODS.SCM_STASH_DROP,
  RPC_METHODS.SCM_STASH_POP,
  RPC_METHODS.SCM_STASH_APPLY,
  RPC_METHODS.SCM_PULL_REQUEST_CHECKOUT,
  RPC_METHODS.SCM_PULL_REQUEST_PREPARE_WORKTREE,
  RPC_METHODS.SCM_PULL_REQUEST_RUN_STACKED,
  RPC_METHODS.SCM_REPOSITORY_CLONE,
  RPC_METHODS.SCM_REPOSITORY_INIT,
  RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK,
] as const;

const AMBIGUOUS_READ_OR_EXTERNAL_METHODS = [
  RPC_METHODS.DAEMON_TERMINAL_STREAM_READ,
  RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES,
  RPC_METHODS.DAEMON_TERMINAL_STREAM_ACK,
  RPC_METHODS.DAEMON_MEMORY_SEARCH,
  RPC_METHODS.DAEMON_MEMORY_GET_WINDOW,
  RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE,
  RPC_METHODS.DAEMON_PROVIDERS_PROBE,
  RPC_METHODS.DAEMON_PROVIDERS_MODELS,
  RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD,
  RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
  RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
  RPC_METHODS.DAEMON_PROVIDERS_BINDING_STATUS,
  RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREVIEW,
  RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER,
  RPC_METHODS.DAEMON_SERVER_WORK_STATUS,
  RPC_METHODS.DAEMON_SESSION_VENDOR_PLUGIN_CATALOG_LIST,
  RPC_METHODS.DAEMON_SESSION_SKILL_CATALOG_LIST,
  RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE,
  RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
  RPC_METHODS.PREVIEW_ENV,
  RPC_METHODS.READ_FILE,
  RPC_METHODS.LIST_DIRECTORY,
  RPC_METHODS.GET_DIRECTORY_TREE,
  RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS,
  RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY,
  RPC_METHODS.STAT_FILE,
  RPC_METHODS.RIPGREP,
  RPC_METHODS.DIFFTASTIC,
  RPC_METHODS.SESSION_LOG_TAIL,
  RPC_METHODS.TRANSCRIPT_PAGE,
  RPC_METHODS.TRANSCRIPT_READ_AFTER,
  RPC_METHODS.TRANSCRIPT_FOLLOW,
  // Releasing a follow lease is classified with the follow that created it: one lease lifecycle
  // cannot be created on the server route and released on a direct one. It is also an ActionSpec
  // `write`, so it is not eligible for a receipt-free direct class.
  RPC_METHODS.TRANSCRIPT_UNFOLLOW,
  RPC_METHODS.TRANSCRIPT_SEARCH,
  RPC_METHODS.SCM_STATUS_SNAPSHOT,
  RPC_METHODS.SCM_DIFF_FILE,
  RPC_METHODS.SCM_DIFF_COMMIT,
  RPC_METHODS.SCM_LOG_LIST,
  RPC_METHODS.SCM_BRANCH_LIST,
  RPC_METHODS.SCM_STASH_LIST,
  RPC_METHODS.SCM_STASH_SHOW,
  RPC_METHODS.SCM_WORKTREES_ENRICHMENT,
  RPC_METHODS.SCM_PULL_REQUEST_LIST,
  RPC_METHODS.SCM_PULL_REQUEST_GET,
  RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE,
  RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS,
  RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE,
  RPC_METHODS.CAPABILITIES_DETECT,
  RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS,
  RPC_METHODS.BUGREPORT_GET_LOG_TAIL,
  RPC_METHODS.WORKSPACE_ANCHORS_RESOLVE,
  RPC_METHODS.WORKSPACE_FAVICON_RESOLVE,
  SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST,
  SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST,
] as const;

const SERVER_PERSISTENCE_METHODS = [
  RPC_METHODS.DAEMON_SESSION_HANDOFF_START,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_CONFIRM_V2,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V2,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2,
  RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
  RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH,
  RPC_METHODS.BUGREPORT_UPLOAD_ARTIFACT,
  RPC_METHODS.TRANSCRIPT_IMPORT,
] as const;

const AUTOMATION_METHODS = [
  RPC_METHODS.DAEMON_MCP_SERVERS_TEST,
  RPC_METHODS.DAEMON_MCP_SERVERS_DETECT,
  RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW,
  RPC_METHODS.CAPABILITIES_INVOKE,
] as const;

const ACCOUNT_QUOTA_RECOVERY_METHODS = [
  RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME,
] as const;

const VOICE_CLIENT_CREDENTIAL_METHODS = [
  RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_MATERIALIZE,
  RPC_METHODS.DAEMON_VOICE_CLIENT_MEDIATED_CREDENTIAL_MATERIALIZE,
  RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_INSPECT,
  RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_REQUEST,
] as const;

export const MACHINE_RPC_ROUTE_POLICIES = Object.freeze([
  ...DIRECT_EPHEMERAL_POLICIES,
  ...DIRECT_MEDIUM_RISK_RECEIPTED_POLICIES,
  ...DAEMON_VOICE_AUDIO_DIRECT_POLICIES,
  actionSpecServerRequired(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESUME_V3, 'destructive_or_recovery_mutation', 'Interrupted handoff Resume records explicit revision-bound recovery intent and stays server-routed.', 'session.handoff.prepare_target.resume'),
  serverRequired(RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2, 'destructive_or_recovery_mutation', 'Predecessor V2 target Resume can start a session runtime and stays server-routed.'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE, 'destructive_or_recovery_mutation', 'External-session link creation mutates durable session linkage and stays server-routed.', 'sessions.external.link.ensure'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH, 'destructive_or_recovery_mutation', 'External-session follow mutates follow leases and stays server-routed.', 'sessions.external.follow'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH, 'destructive_or_recovery_mutation', 'External-session unfollow mutates follow leases and stays server-routed.', 'sessions.external.unfollow'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET, 'destructive_or_recovery_mutation', 'External-session background-follow changes stay server-routed.', 'sessions.external.backgroundFollow.set'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER, 'destructive_or_recovery_mutation', 'External-session takeover moves ownership into Happier runtime and stays server-routed.', 'sessions.external.takeover'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START, 'destructive_or_recovery_mutation', 'External-session materialization starts a durable operation and stays server-routed.', 'sessions.external.materialize.start'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER_START, 'destructive_or_recovery_mutation', 'External-session takeover start selects a durable operation claim and stays server-routed.', 'sessions.external.takeover.start'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET, 'server_persistence', 'External-session operation status passively reads durable operation state and stays server-routed.', 'sessions.external.operation.status.get'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_CANCEL, 'destructive_or_recovery_mutation', 'External-session operation cancellation records explicit durable intent and stays server-routed.', 'sessions.external.operation.cancel'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME, 'destructive_or_recovery_mutation', 'External-session operation Resume records explicit durable recovery intent and stays server-routed.', 'sessions.external.operation.resume'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RETRY, 'destructive_or_recovery_mutation', 'External-session operation Retry records explicit durable recovery intent and stays server-routed.', 'sessions.external.operation.retry'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_DISCARD, 'destructive_or_recovery_mutation', 'External-session operation discard is destructive and stays server-routed.', 'sessions.external.operation.discard'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST, 'ambiguous', 'External-session candidate discovery can expose local provider metadata and stays server-routed.', 'sessions.external.candidates.list'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET, 'ambiguous', 'External-session status reads process/provider state and stay server-routed.', 'sessions.external.status.get'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE, 'reconnect_catch_up', 'External-session transcript page reads participate in reconnect/catch-up semantics and stay server-routed.', 'sessions.external.transcript.page'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER, 'reconnect_catch_up', 'External-session transcript read-after reads participate in reconnect/catch-up semantics and stay server-routed.', 'sessions.external.transcript.readAfter'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST_LEGACY, 'ambiguous', 'Legacy direct-session alias for external-session candidate discovery stays server-routed.', 'sessions.external.candidates.list'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE_LEGACY, 'destructive_or_recovery_mutation', 'Legacy direct-session alias for external-session link creation stays server-routed.', 'sessions.external.link.ensure'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSION_ATTACH_LEGACY, 'destructive_or_recovery_mutation', 'Legacy direct-session alias for external-session follow stays server-routed.', 'sessions.external.follow'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSION_DETACH_LEGACY, 'destructive_or_recovery_mutation', 'Legacy direct-session alias for external-session unfollow stays server-routed.', 'sessions.external.unfollow'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET_LEGACY, 'destructive_or_recovery_mutation', 'Legacy direct-session alias for external-session follow policy stays server-routed.', 'sessions.external.backgroundFollow.set'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET_LEGACY, 'ambiguous', 'Legacy direct-session alias for external-session status stays server-routed.', 'sessions.external.status.get'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE_LEGACY, 'reconnect_catch_up', 'Legacy direct-session alias for external-session transcript page stays server-routed.', 'sessions.external.transcript.page'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER_LEGACY, 'reconnect_catch_up', 'Legacy direct-session alias for external-session transcript read-after stays server-routed.', 'sessions.external.transcript.readAfter'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY, 'destructive_or_recovery_mutation', 'Legacy direct-session alias for external-session takeover stays server-routed.', 'sessions.external.takeover'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY, 'destructive_or_recovery_mutation', 'Legacy direct-session takeoverPersist alias stays server-routed through external-session takeover.', 'sessions.external.takeover'),
  actionSpecServerRequired(SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR, 'destructive_or_recovery_mutation', 'Terminal composer clear mutates a live session runtime draft and stays server-routed.', 'session.terminalComposer.clear', SESSION_SERVER_REQUIRED_SCOPE),
  actionSpecServerRequired(SESSION_RPC_METHODS.SESSION_PENDING_INPUT_INTERRUPT_AND_RUN, 'destructive_or_recovery_mutation', 'Interrupt-and-run stops a live provider turn and promotes an exact queued prompt, so it stays on the authenticated server-scoped session route.', 'session.pendingInput.interruptAndRun', SESSION_SERVER_REQUIRED_SCOPE),
  ...serverRequiredRows(PLUGIN_PERMISSION_GRANT_METHODS, 'auth', 'Plugin permission grant reads and mutations are authorization policy state and stay server-routed.'),
  ...serverRequiredRows(REVIEW_COMMENT_METHODS, 'server_persistence', 'Review comment reads and mutations operate on durable review-comment state and stay server-routed.'),
  ...serverRequiredRows(SESSION_AUTH_CONTROL_METHODS, 'auth', 'Session connected-service auth runtime controls expose or mutate authentication state and stay server-routed.', SESSION_SERVER_REQUIRED_SCOPE),
  ...serverRequiredRows(
    [
      SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_OPEN_V1,
      SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_NEXT_V1,
      SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_CANCEL_V1,
    ],
    'auth',
    'Managed-service endpoint open, bounded body reads, and cancellation remain private exact-handle transports on the authenticated Session route.',
    SESSION_SERVER_REQUIRED_SCOPE,
  ),
  ...serverRequiredRows(VOICE_CLIENT_CREDENTIAL_METHODS, 'auth', 'Voice client credential materialization and authorization expose or mutate credential access state and stay on the authenticated server route.'),
  ...serverRequiredRows(SESSION_USAGE_LIMIT_RECOVERY_CREDIT_METHODS, 'billing', 'Session usage-limit reset-credit consumption spends quota recovery state and stays server-routed.', SESSION_SERVER_REQUIRED_SCOPE),
  ...serverRequiredRows(
    [
      SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1,
      SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1,
    ],
    'pending_queue',
    'Verdict-free Pending wake capability discovery and publication stay on the authenticated exact-session route; they neither decide eligibility nor create a machine-direct authority path.',
    SESSION_SERVER_REQUIRED_SCOPE,
  ),
  serverRequired(RPC_METHODS.SESSION_AGENT_TRANSITION, 'durable_session_write', 'Same-Session Agent transition stops the exact source runtime, commits a sealed current view, appends a transcript divider, and re-admits one input; it depends on server-authoritative session write access and stays server-routed.', SESSION_SERVER_REQUIRED_SCOPE),
  serverRequired(RPC_METHODS.SESSION_CONTINUATION_INSPECT, 'ambiguous', 'Live continuation eligibility reads decrypted owner Session metadata and grants no authority; it stays on the authenticated server route because its answer depends on server-authoritative session access.', SESSION_SERVER_REQUIRED_SCOPE),
  serverRequired(RPC_METHODS.SESSION_AGENT_TRANSITION_BRIEF_PREVIEW, 'ambiguous', 'Rebuilding the handoff a transcript divider stands for reads decrypted owner Session metadata and transcript rows and grants no authority; it is classified with the continuation READ it mirrors, not with the transition mutation it describes, and stays server-routed because its answer depends on server-authoritative session access.', SESSION_SERVER_REQUIRED_SCOPE),
  serverRequired(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART, 'durable_session_write', 'Per-session runner restart depends on server-authoritative session write access and stays server-routed.', SESSION_SERVER_REQUIRED_SCOPE),
  serverRequired(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2, 'durable_session_write', 'Process-attested Provider recovery restart depends on server-authoritative session write access and stays server-routed.', SESSION_SERVER_REQUIRED_SCOPE),
  ...serverRequiredRows(SESSION_DURABLE_METHODS, 'durable_session_write', 'Session and execution-run lifecycle/state methods remain server-required because they can assign sequence, write durable session state, or fan out across devices.', SESSION_SERVER_REQUIRED_SCOPE),
  ...serverRequiredRows(TRANSFER_CONTROL_METHODS, 'server_persistence', 'Transfer control-plane RPC remains server-required; PMS bounded-transfer flows own direct byte movement and durable token/control reconciliation.'),
  ...serverRequiredRows(LOCAL_MUTATION_METHODS, 'destructive_or_recovery_mutation', 'Daemon-local or repository mutation is not low-risk direct RPC without a later ActionSpec command-receipt packet.'),
  ...serverRequiredRows(AMBIGUOUS_READ_OR_EXTERNAL_METHODS, 'ambiguous', 'Read or external-service behavior has privacy, access-policy, transcript, or side-effect ambiguity and must stay on the server route until proven safe.'),
  ...serverRequiredRows(SERVER_PERSISTENCE_METHODS, 'server_persistence', 'Server persistence or external provider state remains server-authoritative for this RPC family.'),
  ...serverRequiredRows(AUTOMATION_METHODS, 'automation', 'Automation and invocation surfaces stay server-required until separate policy and command-receipt semantics are accepted.'),
  ...serverRequiredRows(ACCOUNT_QUOTA_RECOVERY_METHODS, 'billing', 'Connected-service quota recovery credit consumption mutates account quota/recovery state and stays server-routed.'),
  serverRequired(RPC_METHODS.KILL_SESSION, 'durable_session_write', 'Session kill is a durable/destructive lifecycle mutation and must stay server-routed.', SESSION_SERVER_REQUIRED_SCOPE),
  serverRequired(RPC_METHODS.BASH, 'ambiguous', 'Shell execution has broad side-effect and access-policy ambiguity and must stay server-routed.'),
] satisfies readonly MachineRpcRoutePolicyV1[]);

const POLICY_BY_METHOD = new Map<string, MachineRpcRoutePolicyV1>();
for (const policy of MACHINE_RPC_ROUTE_POLICIES) {
  if (!POLICY_BY_METHOD.has(policy.method)) {
    POLICY_BY_METHOD.set(policy.method, policy);
  }
}

function createPolicyMap(
  policies: readonly MachineRpcRoutePolicyV1[],
): Map<string, MachineRpcRoutePolicyV1> {
  const policyMap = new Map<string, MachineRpcRoutePolicyV1>();
  for (const policy of policies) {
    if (!policyMap.has(policy.method)) {
      policyMap.set(policy.method, policy);
    }
  }
  return policyMap;
}

function collectRegisteredMachineRpcMethods(): readonly string[] {
  return Object.freeze([
    ...Object.values(RPC_METHODS),
    ...Object.values(SESSION_RPC_METHODS),
    HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
  ]);
}

export function resolveMachineRpcRoutePolicy(method: string): MachineRpcRoutePolicyV1 {
  return POLICY_BY_METHOD.get(method) ?? {
    method,
    routeClass: 'server_required',
    rationale: 'No deployed PMS-5 route policy row exists for this method; deny direct by default.',
    ownerPacket: 'PMS-5',
    rpcClassification: 'advisory_unclassified',
    commandReceiptRequired: false,
    scope: SERVER_REQUIRED_SCOPE,
    serverRequiredReason: 'unclassified',
  };
}

export function isMachineRpcDirectRoutePolicy(policy: Pick<MachineRpcRoutePolicyV1, 'routeClass'>): boolean {
  return policy.routeClass === 'direct_ephemeral' || policy.routeClass === 'direct_medium_risk_receipted';
}

export function resolveMachineRpcRelayFallbackDecision(input: Readonly<{
  policy: Pick<MachineRpcRoutePolicyV1, 'relayFallback'>;
  deploymentKind: MachineRpcRelayFallbackDeploymentKind;
  relayEnabled?: boolean;
  caps?: unknown;
}>): MachineRpcRelayFallbackDecision {
  const relayFallback = input.policy.relayFallback;
  if (!relayFallback) {
    return { ok: false, routeKind: 'server_relay', reasonCode: 'relay_fallback_not_supported' };
  }
  if (!input.relayEnabled) {
    return { ok: false, routeKind: 'server_relay', reasonCode: 'relay_disabled_by_policy' };
  }
  if (!input.caps) {
    return { ok: false, routeKind: 'server_relay', reasonCode: 'relay_caps_required' };
  }
  const caps = MachineLiveStreamRelayCapsV1Schema.safeParse(input.caps);
  if (!caps.success) {
    return { ok: false, routeKind: 'server_relay', reasonCode: 'invalid_relay_caps' };
  }
  return { ok: true, routeKind: 'server_relay', caps: caps.data, policy: relayFallback };
}

function isValidRelayFallbackPolicy(policy: MachineRpcRoutePolicyV1): boolean {
  const relayFallback = policy.relayFallback;
  if (!relayFallback) return true;
  return DAEMON_VOICE_AUDIO_DIRECT_METHOD_SET.has(policy.method)
    && policy.routeClass === 'direct_medium_risk_receipted'
    && policy.commandReceiptRequired
    && relayFallback.flowKind === 'daemon_voice_audio'
    && relayFallback.defaultSharedServerMode === 'disabled'
    && relayFallback.authorizationRequired === true
    && relayFallback.relayCapsRequired === true
    && relayFallback.meteringRequired === true
    && relayFallback.lifecycleReceiptRequired === true
    && relayFallback.capProfile === DAEMON_VOICE_AUDIO_RELAY_CAP_PROFILE_ID;
}

export function validateMachineRpcRoutePolicies(
  policies: readonly MachineRpcRoutePolicyV1[] = MACHINE_RPC_ROUTE_POLICIES,
): MachineRpcRoutePolicyValidationResult {
  const registeredMethods = new Set(collectRegisteredMachineRpcMethods());
  const seen = new Set<string>();
  const duplicateMethods = new Set<string>();
  const unknownMethods = new Set<string>();
  const invalidMethods = new Set<string>();

  for (const policy of policies) {
    if (seen.has(policy.method)) {
      duplicateMethods.add(policy.method);
    }
    seen.add(policy.method);
    if (!registeredMethods.has(policy.method)) {
      unknownMethods.add(policy.method);
    }
    if (policy.ownerPacket !== 'PMS-5' || !policy.rationale.trim()) {
      invalidMethods.add(policy.method);
    }
    if (policy.routeClass === 'server_required' && !policy.serverRequiredReason) {
      invalidMethods.add(policy.method);
    }
    if (policy.routeClass !== 'server_required' && policy.serverRequiredReason) {
      invalidMethods.add(policy.method);
    }
    if (policy.routeClass === 'direct_medium_risk_receipted' && !policy.commandReceiptRequired) {
      invalidMethods.add(policy.method);
    }
    if (policy.routeClass === 'direct_ephemeral' && policy.commandReceiptRequired) {
      invalidMethods.add(policy.method);
    }
    if (isMachineRpcDirectRoutePolicy(policy) && policy.rpcClassification === 'advisory_unclassified') {
      invalidMethods.add(policy.method);
    }
    if (isMachineRpcDirectRoutePolicy(policy) && (!policy.scope.accountRequired || !policy.scope.machineRequired || policy.scope.serverRequired)) {
      invalidMethods.add(policy.method);
    }
    if (!isValidRelayFallbackPolicy(policy)) {
      invalidMethods.add(policy.method);
    }
  }

  const missingMethods = [...registeredMethods].filter((method) => !seen.has(method)).sort();
  return {
    ok: missingMethods.length === 0
      && unknownMethods.size === 0
      && duplicateMethods.size === 0
      && invalidMethods.size === 0,
    policies,
    missingMethods,
    unknownMethods: [...unknownMethods].sort(),
    duplicateMethods: [...duplicateMethods].sort(),
    invalidMethods: [...invalidMethods].sort(),
  };
}

export function validateMachineRpcGrantAllowedMethods(methods: readonly string[]): Readonly<
  | { ok: true }
  | { ok: false; reasonCode: 'machine_rpc_requires_pms5_classification' | 'machine_rpc_method_server_required'; method: string }
>;
export function validateMachineRpcGrantAllowedMethods(
  methods: readonly string[],
  policies: readonly MachineRpcRoutePolicyV1[],
): Readonly<
  | { ok: true }
  | { ok: false; reasonCode: 'machine_rpc_requires_pms5_classification' | 'machine_rpc_method_server_required'; method: string }
>;
export function validateMachineRpcGrantAllowedMethods(
  methods: readonly string[],
  policies?: readonly MachineRpcRoutePolicyV1[],
): Readonly<
  | { ok: true }
  | { ok: false; reasonCode: 'machine_rpc_requires_pms5_classification' | 'machine_rpc_method_server_required'; method: string }
> {
  const policyMap = policies ? createPolicyMap(policies) : POLICY_BY_METHOD;
  for (const method of methods) {
    const policy = policyMap.get(method) ?? resolveMachineRpcRoutePolicy(method);
    if (policy.serverRequiredReason === 'unclassified') {
      return { ok: false, reasonCode: 'machine_rpc_requires_pms5_classification', method };
    }
    if (isMachineRpcDirectRoutePolicy(policy) && policy.rpcClassification === 'advisory_unclassified') {
      return { ok: false, reasonCode: 'machine_rpc_requires_pms5_classification', method };
    }
    if (!isMachineRpcDirectRoutePolicy(policy)) {
      return { ok: false, reasonCode: 'machine_rpc_method_server_required', method };
    }
  }
  return { ok: true };
}
