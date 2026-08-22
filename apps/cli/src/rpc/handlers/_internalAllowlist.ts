import { RPC_METHODS } from '@happier-dev/protocol/rpc';

export type InternalOnlyRpcMethodEntry = Readonly<{
    method: string;
    rationale: string;
    ownerPacket: string;
    reviewNote?: string;
}>;

export type InternalOnlyRpcMethodValidationIssue = Readonly<{
    code:
        | 'missing-method'
        | 'missing-rationale'
        | 'missing-owner-packet'
        | 'duplicate-method';
    method?: string;
    message: string;
}>;

export type InternalOnlyRpcMethodValidationResult = Readonly<{
    ok: boolean;
    errors: readonly InternalOnlyRpcMethodValidationIssue[];
}>;

const PROMPT_TRANSFER_CONTROL_RATIONALE =
    'Prompt transfer control-plane transport uses session/chunk envelopes and remains internal transport, not an ActionSpec action surface.';
const VOICE_INFERENCE_MODEL_ADMIN_RATIONALE =
    'A.12 voice cleanup keeps daemon voice inference model install/remove/warm calls as bounded daemon-local admin RPC, not an ActionSpec action surface.';
const VOICE_INFERENCE_TRANSPORT_RATIONALE =
    'A.12 voice cleanup keeps daemon voice inference TTS/STT request, transfer, and cancellation calls as bounded internal transport, not an ActionSpec action surface.';
const VOICE_FOUNDATION_INTERNAL_METHODS = Object.freeze([
    RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG,
    RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_MATERIALIZE,
]);

// A.12.0 seeds only clearly internal lifecycle transport methods.
// Downstream A.12 domain packets append their own rows when a method is proven
// internal-only rather than action-backed.
export const INTERNAL_ONLY_RPC_METHODS = Object.freeze([
    ...VOICE_FOUNDATION_INTERNAL_METHODS.map((method) => ({
        method,
        rationale: 'Daemon-executed Voice operations are closed, machine-owned transport RPCs, not public ActionSpec action surfaces.',
        ownerPacket: 'A.12-voice-foundation',
    })),
    ...[
        RPC_METHODS.DAEMON_PROVIDERS_PROBE,
        RPC_METHODS.DAEMON_PROVIDERS_MODELS,
        RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD,
    ].map((method) => ({
        method,
        rationale: 'Provider connection probe, catalog, and explicit model-load operations are strict machine-owned identity transports; authorization, endpoints, credentials, and feature decisions stay daemon-side.',
        ownerPacket: 'providers-first-class-1.9',
    })),
    {
        method: RPC_METHODS.STOP_DAEMON,
        rationale: 'Daemon lifecycle shutdown transport; not a plugin-exposed action surface.',
        ownerPacket: 'A.12.0',
    },
    {
        method: RPC_METHODS.SPAWN_HAPPY_SESSION,
        rationale: 'Private machine Session lifecycle transport with daemon-owned spawn/resume request and response semantics; it is not the public V2 session.spawn_new Action surface.',
        ownerPacket: 'SESSION-COMPAT',
    },
    {
        method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
        rationale: 'Private Provider-safe machine Session lifecycle transport with daemon-owned spawn/resume request and response semantics; it is not the public V2 session.spawn_new Action surface.',
        ownerPacket: 'SESSION-COMPAT',
    },
    {
        method: RPC_METHODS.SESSION_AGENT_TRANSITION,
        rationale: 'Same-Session Agent transition is an owner-only machine lifecycle transport: it stops the exact source runtime, commits a sealed current view, and re-admits one already-authenticated input through the canonical message owner. It is not a plugin-exposed ActionSpec surface.',
        ownerPacket: 'same-session-cross-agent-continuation',
    },
    {
        method: RPC_METHODS.SESSION_CONTINUATION_INSPECT,
        rationale: 'Exact-machine read-only continuation eligibility projection over the incumbent Agent catalog and Session lifecycle checks; it grants no authority, persists nothing, and is not an ActionSpec action surface.',
        ownerPacket: 'same-session-cross-agent-continuation',
    },
    {
        method: RPC_METHODS.SESSION_AGENT_TRANSITION_BRIEF_PREVIEW,
        rationale: 'Exact-machine read-only rebuild of the activation brief a transition divider stands for; it runs the same bounded context pass, grants no authority, persists nothing, and is not an ActionSpec action surface.',
        ownerPacket: 'same-session-cross-agent-continuation',
    },
    {
        method: RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LIST,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL,
        rationale: VOICE_INFERENCE_MODEL_ADMIN_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LICENSE_ACCEPT,
        rationale: VOICE_INFERENCE_MODEL_ADMIN_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_REMOVE,
        rationale: VOICE_INFERENCE_MODEL_ADMIN_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM,
        rationale: VOICE_INFERENCE_MODEL_ADMIN_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_SYNTHESIZE,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CHUNK,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_FINALIZE,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_ABORT,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CANCEL,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_START,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_NEXT,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_ACK,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_CANCEL,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_STATUS,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_ABORT,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_CANCEL,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CANCEL,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_EXTENSIONS_RELOAD_STATUS,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_PLUGIN_INVOCATION_LOGS_READ,
        rationale: 'PEP-SDK exact-machine bounded structured plugin-log read through the canonical daemon logger; it creates no alternate sink, store, or server persistence.',
        ownerPacket: 'PEP-SDK',
    },
    {
        method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
        rationale: 'WS6.T2 thin UI transport into the canonical plugin action executor; it does not own dispatch or policy.',
        ownerPacket: 'WS6.T2',
    },
    {
        method: RPC_METHODS.DAEMON_PLUGIN_ACTION_FORM_CONNECTED_ACCOUNT_OPTIONS_RESOLVE,
        rationale: 'SDK-ACTION-FORM transient daemon form-option read derives one current Action-declared Connected Account selection purpose and returns only bounded labels with opaque qualified refs; it neither exposes account authority nor persists form state.',
        ownerPacket: 'SDK-ACTION-FORM',
    },
    {
        method: RPC_METHODS.DAEMON_PLUGIN_COMPOSER_REFERENCE_SEARCH,
        rationale: 'SDK-EU-19 bounded generation-leased picker search through the canonical registered composer-reference owner; it transports candidates only, not durable resolved context.',
        ownerPacket: 'SDK-EU-19',
    },
    {
        method: RPC_METHODS.DAEMON_PLUGIN_COMPOSER_ATTACHMENT_PREPARE,
        rationale: 'CEX-EU3 bounded pre-admission preparation through the canonical current-generation Composer attachment registry; it transports no durable admission, queue, or terminal Message identity.',
        ownerPacket: 'CEX-EU3',
    },
    {
        method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ,
        rationale: 'EU-4a generation-leased packaged plugin resource snapshot read for mounted plugin UI surfaces; remains internal transport over the canonical per-plugin resource service, not a public action surface.',
        ownerPacket: 'EU-4a',
    },
    {
        method: RPC_METHODS.DAEMON_PLUGIN_SETTINGS_WATCH,
        rationale: 'UIX-08 exact-daemon Settings parked invalidation transport; it carries only a revision/status through the canonical scoped Settings service and leaves record rereads to the existing UI projection owner.',
        ownerPacket: 'UIX-08',
    },
    ...[
        RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN,
        RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT,
        RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE,
    ].map((method) => ({
        method,
        rationale: 'EU-4b client-owned long-poll transport for live plugin resource invalidation; it carries a bounded signal over the canonical per-plugin resource service and no resource bytes, so it is internal transport rather than a public action surface.',
        ownerPacket: 'EU-4b',
    })),
    {
        method: RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ,
        rationale: 'A.16x.10 daemon-to-UI installed plugin UI artifact byte transfer; remains internal transport and verifies installed artifact integrity.',
        ownerPacket: 'A.16x.10',
    },
    {
        method: RPC_METHODS.DAEMON_PLUGIN_UI_REACT_NATIVE_CRASH_REPORT_SUBMIT,
        rationale: 'A.16x.10 UI-to-daemon React Native crash-disable report transport; remains internal daemon safety-state mutation, not a plugin-exposed action surface.',
        ownerPacket: 'A.16x.10',
    },
    {
        method: RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT,
        rationale: 'LSV-1/LSV-6 daemon-owned local-services inventory snapshot read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'LSV-1',
    },
    {
        method: RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH,
        rationale: 'LSV-1 daemon-owned local-services inventory refresh projection; remains internal transport and delegates refresh to the inventory owner.',
        ownerPacket: 'LSV-1',
    },
    {
        method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
        rationale: 'LSV-6 daemon-owned local-services launcher feed read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'LSV-6',
    },
    {
        method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START,
        rationale: 'LSV-6 daemon-owned local-services launcher start bridge; command-receipted machine RPC delegates only to daemon-authorized start targets.',
        ownerPacket: 'LSV-6',
    },
    {
        method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_OPEN_PREVIEW,
        rationale: 'LSV-1 daemon-owned launcher leaf bridge; resolves a launch target browser view for a safe "open in browser" and remains internal transport, not a public action surface.',
        ownerPacket: 'LSV-1',
    },
    {
        method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_REGISTER_PREVIEW,
        rationale: 'LSV-1 daemon-owned launcher leaf bridge; persists a loopback launch target as a private preview through the canonical preview owner and remains internal transport.',
        ownerPacket: 'LSV-1',
    },
    {
        method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_HISTORY_CLEAR,
        rationale: 'LSV-1 daemon-owned launcher leaf bridge; clears the daemon-owned launcher feed history and returns the refreshed snapshot; remains internal transport.',
        ownerPacket: 'LSV-1',
    },
    {
        method: RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE,
        rationale: 'LSV-5 daemon-owned local-service action bridge; validates typed runtime input before local-service route dispatch.',
        ownerPacket: 'LSV-5',
    },
    {
        method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT,
        rationale: 'LSV-3/RU-IMPL-021 daemon-owned local preview registry read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'LSV-3',
    },
    {
        method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE,
        rationale: 'PRV-2/F2-preview daemon-owned private-preview openOrCreate lifecycle bridge; mints the BrowserViewTarget-bearing snapshot row from a canonical inventory/managed/launch target (never a raw token).',
        ownerPacket: 'LSV-3',
    },
    {
        method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_REVOKE,
        rationale: 'PRV-2/F2-preview daemon-owned private-preview revoke lifecycle bridge; unregisters a machine-scoped preview and returns the refreshed snapshot.',
        ownerPacket: 'LSV-3',
    },
    {
        method: RPC_METHODS.DAEMON_LOCAL_SERVICES_MANAGED_SNAPSHOT,
        rationale: 'LSV-7 daemon-owned managed local-services runtime snapshot read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'LSV-7',
    },
    {
        method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS,
        rationale: 'LSV-7 daemon-owned public-preview status projection reads server-authorized exposure state without mutating public exposure.',
        ownerPacket: 'LSV-7',
    },
    {
        method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE,
        rationale: 'LSV-7 daemon-mediated public-preview create bridge validates typed runtime input and requires PMS command-receipt coverage.',
        ownerPacket: 'LSV-7',
    },
    {
        method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_REVOKE,
        rationale: 'LSV-7 daemon-mediated public-preview revoke bridge validates typed runtime input and requires PMS command-receipt coverage.',
        ownerPacket: 'LSV-7',
    },
    {
        method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_COPY_URL,
        rationale: 'LSV-7 daemon-owned public-preview copy URL read projection returns an already-active known exposure URL without creating exposure state.',
        ownerPacket: 'LSV-7',
    },
    {
        method: RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT,
        rationale: 'BRW-10 daemon-owned browser diagnostics read projection; remains internal transport with bounded redacted events, not a public action surface.',
        ownerPacket: 'BRW-10',
    },
    {
        method: RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH,
        rationale: 'BRW-2 daemon-owned browser control bridge; validates typed view-control actions before dispatching to the authoritative control broker.',
        ownerPacket: 'BRW-2',
    },
    {
        method: RPC_METHODS.DAEMON_BROWSER_CONTEXT_DISPATCH,
        rationale: 'BRW-11 daemon-owned browser context bridge; validates typed capture/attach/clear/annotate requests before context producer dispatch.',
        ownerPacket: 'BRW-11',
    },
    {
        method: RPC_METHODS.DAEMON_BROWSER_RECORDING_START,
        rationale: 'BRW-15 daemon-owned browser recording start bridge; validates typed runtime input before capture adapter dispatch.',
        ownerPacket: 'BRW-15',
    },
    {
        method: RPC_METHODS.DAEMON_BROWSER_RECORDING_STOP,
        rationale: 'BRW-15 daemon-owned browser recording stop bridge; finalizes by reference through session-media owners.',
        ownerPacket: 'BRW-15',
    },
    {
        method: RPC_METHODS.DAEMON_BROWSER_RECORDING_CANCEL,
        rationale: 'BRW-15 daemon-owned browser recording cancel bridge; records explicit lifecycle outcome and cleans temporary artifacts.',
        ownerPacket: 'BRW-15',
    },
    {
        method: RPC_METHODS.DAEMON_BROWSER_RECORDING_STATUS,
        rationale: 'BRW-15 daemon-owned browser recording status read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'BRW-15',
    },
    {
        method: RPC_METHODS.DAEMON_BROWSER_RECORDING_LIST,
        rationale: 'BRW-15 daemon-owned browser recording list projection for a view; remains internal transport, not a public action surface.',
        ownerPacket: 'BRW-15',
    },
    {
        method: RPC_METHODS.DAEMON_BROWSER_RECORDING_CLEANUP,
        rationale: 'BRW-15 daemon-owned browser recording retention cleanup trigger; remains internal transport and delegates durable discard to session-media owners.',
        ownerPacket: 'BRW-15',
    },
    {
        method: RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME,
        rationale: 'BRW-15 reverse daemon-to-UI frame capture bridge; requests one reference-only desktop WebView frame and returns only path/metadata, never inline bytes.',
        ownerPacket: 'BRW-15',
    },
    {
        method: RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_SNAPSHOT,
        rationale: 'SIM-4/SIM-5 daemon-owned simulator preview resource read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'SIM-4',
    },
    {
        method: RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_ACTION,
        rationale: 'SIM-4/SIM-5 daemon-owned simulator preview action bridge; validates typed actions before native adapter dispatch.',
        ownerPacket: 'SIM-4',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_ADAPTERS,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_SOURCES,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_GET,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET,
        rationale: 'PMS-5 direct-eligible daemon session-runner status read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET,
        rationale: 'PA-19.9 direct-eligible additive session-runner process-currentness read; remains internal transport, not a public action surface.',
        ownerPacket: 'PA-19.9',
    },
    {
        method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART,
        rationale: 'PMS-5 daemon session-runner restart bridge; command-receipted machine RPC delegates to local runtime supervision.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2,
        rationale: 'PA-19.9 recovery-only process-attested session-runner restart bridge; delegates to the canonical local runtime supervision owner.',
        ownerPacket: 'PA-19.9',
    },
    {
        method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL,
        rationale: 'PMS-5 daemon session-runner bulk restart bridge; command-receipted machine RPC delegates to local runtime supervision.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_CHUNK,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_FINALIZE,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_ABORT,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_INIT,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_CHUNK,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_FINALIZE,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_ABORT,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.SCM_BACKEND_DESCRIBE,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.CAPABILITIES_DESCRIBE,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
] satisfies readonly InternalOnlyRpcMethodEntry[]);

function normalizeMethod(value: string): string {
    return value.trim();
}

export function validateInternalOnlyRpcMethodEntries(
    entries: readonly InternalOnlyRpcMethodEntry[] = INTERNAL_ONLY_RPC_METHODS,
): InternalOnlyRpcMethodValidationResult {
    const seen = new Set<string>();
    const errors: InternalOnlyRpcMethodValidationIssue[] = [];

    for (const entry of entries) {
        const method = normalizeMethod(entry.method);
        if (!method) {
            errors.push({
                code: 'missing-method',
                message: 'Internal-only RPC entries must declare a non-empty method.',
            });
            continue;
        }

        if (seen.has(method)) {
            errors.push({
                code: 'duplicate-method',
                method,
                message: `Internal-only RPC method is declared more than once: ${method}`,
            });
        }
        seen.add(method);

        if (!entry.rationale.trim()) {
            errors.push({
                code: 'missing-rationale',
                method,
                message: `Internal-only RPC method requires a non-empty rationale: ${method}`,
            });
        }

        if (!entry.ownerPacket.trim()) {
            errors.push({
                code: 'missing-owner-packet',
                method,
                message: `Internal-only RPC method requires an owner packet: ${method}`,
            });
        }
    }

    return {
        ok: errors.length === 0,
        errors,
    };
}

export function getInternalOnlyRpcMethodEntry(
    method: string,
    entries: readonly InternalOnlyRpcMethodEntry[] = INTERNAL_ONLY_RPC_METHODS,
): InternalOnlyRpcMethodEntry | null {
    const normalized = normalizeMethod(method);
    return entries.find((entry) => normalizeMethod(entry.method) === normalized) ?? null;
}

export function isInternalOnlyRpcMethod(
    method: string,
    entries: readonly InternalOnlyRpcMethodEntry[] = INTERNAL_ONLY_RPC_METHODS,
): boolean {
    return getInternalOnlyRpcMethodEntry(method, entries) !== null;
}
