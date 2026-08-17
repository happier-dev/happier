import type { FeatureCatalogDefinitionEntry, FeatureFailMode, FeatureRepresentation } from './catalogTypes.js';

type FeatureCatalogDefinitionEntryBase = Omit<FeatureCatalogDefinitionEntry, 'dependencies'>;

function defineFeatureCatalog<
  const T extends Record<string, FeatureCatalogDefinitionEntryBase & Readonly<{ dependencies: readonly (keyof T)[] }>>,
>(catalog: T): T {
  return catalog;
}

const FEATURE_CATALOG_DEFINITION = {
  automations: {
    description: 'Automations feature surfaces and scheduling runtime.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'execution.runs': {
    description: 'Execution runs / sub-agent orchestration surfaces and runtime.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'pets.companion': {
    description: 'Happier pet companion surfaces and local package selection.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'pets.sync': {
    description: 'Synced account pet library and cross-device pet package references.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  voice: {
    description: 'Happier voice assistant feature availability.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'voice.happierVoice': {
    description: 'Happier-hosted voice backend availability (server-configured voice).',
    defaultFailMode: 'fail_closed',
    dependencies: ['voice'],
    representation: 'server',
  },
  'voice.agent': {
    description: 'Daemon-backed voice agent surfaces (requires execution runs substrate).',
    defaultFailMode: 'fail_closed',
    dependencies: ['voice', 'execution.runs'],
    representation: 'client',
  },
  'voice.daemonInference': {
    description: 'Daemon-local voice inference surfaces (requires voice.agent substrate).',
    defaultFailMode: 'fail_closed',
    dependencies: ['voice.agent'],
    representation: 'client',
  },
  'connectedServices.quotas': {
    description: 'Connected services quota snapshots (informational usage meters) surfaces and runtime.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'connectedServices.accountGroups': {
    description: 'Connected service account groups and member management APIs.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'connectedServices.accountFallback': {
    description: 'Connected service account group fallback and automatic active account switching APIs.',
    defaultFailMode: 'fail_closed',
    dependencies: ['connectedServices.accountGroups', 'sessions.usageLimitRecovery'],
    representation: 'server',
  },
  'updates.ota': {
    description: 'Expo over-the-air update checks and apply flows.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'attachments.uploads': {
    description: 'Client attachment uploads (files/images) sent to session runners for LLM access.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'sharing.session': {
    description: 'Session sharing capability (share session with other users/devices).',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'sharing.public': {
    description: 'Public sharing link support for session content.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'sharing.contentKeys': {
    description: 'Sharing content-key exchange support (E2EE sharing).',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'sharing.pendingQueueV2': {
    description: 'Pending queue v2 sharing/bridging surfaces and runtime.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'sharing.pendingDeliveryState': {
    description: 'Durable provider-delivery state for pending queue v2.',
    defaultFailMode: 'fail_closed',
    dependencies: ['sharing.pendingQueueV2'],
    representation: 'server',
  },
  sessions: {
    description: 'Session-level product surfaces and control-plane capabilities.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'sessions.handoff': {
    description: 'Session handoff between machines.',
    defaultFailMode: 'fail_closed',
    dependencies: ['sessions'],
    representation: 'server',
  },
  'sessions.agentSwitching': {
    description: 'Continue one Session in place with another coding Agent, and create configurable Sessions from a typed source-context recipe.',
    defaultFailMode: 'fail_closed',
    dependencies: ['sessions'],
    representation: 'server',
  },
  'sessions.folders': {
    description: 'Organize synced sessions into user-defined folders.',
    defaultFailMode: 'fail_closed',
    dependencies: ['sessions'],
    representation: 'server',
  },
  'sessions.usageLimitRecovery': {
    description: 'Session usage-limit recovery, wait/resume intents, and usage-limit retry controls.',
    defaultFailMode: 'fail_closed',
    dependencies: ['sessions'],
    representation: 'server',
  },
  machines: {
    description: 'Machine control-plane transport capabilities.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'machines.transfer': {
    description: 'Same-account machine transfer control plane.',
    defaultFailMode: 'fail_closed',
    dependencies: ['machines'],
    representation: 'client',
  },
  'machines.transfer.directPeer': {
    description: 'Direct peer machine transfer capability.',
    defaultFailMode: 'fail_closed',
    dependencies: ['machines.transfer'],
    representation: 'server',
  },
  'machines.transfer.serverRouted': {
    description: 'Server-routed machine transfer fallback capability.',
    defaultFailMode: 'fail_closed',
    dependencies: ['machines.transfer'],
    representation: 'server',
  },
  'machines.peerMediation': {
    description: 'Peer mediation substrate for machine tunnels, live streams, grants, and relay-owned flows.',
    defaultFailMode: 'fail_closed',
    dependencies: ['machines'],
    representation: 'client',
  },
  'machines.peerMediation.observability': {
    description: 'Scoped peer mediation flow observability for tunnels, streams, preview requests, and relay diagnostics.',
    defaultFailMode: 'fail_closed',
    dependencies: ['machines.peerMediation'],
    representation: 'server',
  },
  'machines.tunnel': {
    description: 'Machine TCP tunnel control plane.',
    defaultFailMode: 'fail_closed',
    dependencies: ['machines'],
    representation: 'client',
  },
  'machines.tunnel.directPeer': {
    description: 'Direct peer machine TCP tunnel capability.',
    defaultFailMode: 'fail_closed',
    dependencies: ['machines.tunnel'],
    representation: 'server',
  },
  'machines.tunnel.serverRouted': {
    description: 'Server-routed machine TCP tunnel fallback capability.',
    defaultFailMode: 'fail_closed',
    dependencies: ['machines.tunnel'],
    representation: 'server',
  },
  'machines.liveStream': {
    description: 'Machine live stream control plane.',
    defaultFailMode: 'fail_closed',
    dependencies: ['machines'],
    representation: 'client',
  },
  'machines.liveStream.directPeer': {
    description: 'Direct peer machine live stream capability.',
    defaultFailMode: 'fail_closed',
    dependencies: ['machines.liveStream'],
    representation: 'server',
  },
  'machines.liveStream.serverRouted': {
    description: 'Server-routed machine live stream fallback capability.',
    defaultFailMode: 'fail_closed',
    dependencies: ['machines.liveStream'],
    representation: 'server',
  },
  'machines.rpc': {
    description: 'Machine RPC direct-route control plane.',
    defaultFailMode: 'fail_closed',
    dependencies: ['machines'],
    representation: 'client',
  },
  'machines.rpc.directPeer': {
    description: 'Direct peer machine RPC capability.',
    defaultFailMode: 'fail_closed',
    dependencies: ['machines.rpc'],
    representation: 'server',
  },
  // Core local-services product gates are server-represented + default-allow (see
  // localServicesFeature.ts). The server can disable the product for its users; the daemon
  // stops scanning and the UI hides accordingly. Private `preview` (loopback-only, the user's
  // own dev server) is also default-on (PRV-1, readFeatureEnv.ts); only `publicPreview` (real
  // internet exposure) stays server-represented + fail-closed default-off below.
  localServices: {
    description: 'Local service inventory, preview, and exposure product surfaces.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'localServices.inventory': {
    description: 'Passive local service inventory and machine-scoped port provenance.',
    defaultFailMode: 'fail_closed',
    dependencies: ['localServices'],
    representation: 'server',
  },
  'localServices.managed': {
    description: 'Managed local service launch, naming, health, and lifecycle surfaces.',
    defaultFailMode: 'fail_closed',
    dependencies: ['localServices.inventory'],
    representation: 'server',
  },
  'localServices.launcher': {
    description: 'Local service launchpad suggestions and preview discovery surfaces.',
    defaultFailMode: 'fail_closed',
    dependencies: ['localServices.inventory', 'browser.viewTargets'],
    representation: 'server',
  },
  'localServices.actions': {
    description: 'Governed local service actions for copy, preview, forget, and managed controls.',
    defaultFailMode: 'fail_closed',
    dependencies: ['localServices.inventory'],
    representation: 'server',
  },
  'localServices.actions.terminate': {
    description: 'Dangerous terminate action for eligible detected local service processes.',
    defaultFailMode: 'fail_closed',
    dependencies: ['localServices.actions'],
    representation: 'server',
  },
  'localServices.preview': {
    description: 'Private session-scoped local service preview resources and UI surfaces.',
    defaultFailMode: 'fail_closed',
    dependencies: ['localServices.inventory'],
    representation: 'server',
  },
  'localServices.publicPreview': {
    description: 'Explicit public exposure for selected local service previews.',
    defaultFailMode: 'fail_closed',
    dependencies: ['localServices.preview'],
    representation: 'server',
  },
  // Core browser product gates are server-represented + default-allow (see browserFeature.ts):
  // on by default, the server can disable browser surfaces for its users.
  browser: {
    description: 'Browser view vocabulary, target dispatch, and browser-adjacent UI surfaces.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'browser.viewTargets': {
    description: 'Host-owned browser view target dispatch for previews, hosted UI, and external URLs.',
    defaultFailMode: 'fail_closed',
    dependencies: ['browser'],
    representation: 'server',
  },
  'browser.internal': {
    description: 'Internal browser session/profile/view surfaces.',
    defaultFailMode: 'fail_closed',
    dependencies: ['browser.viewTargets'],
    representation: 'server',
  },
  // Browser capability tiers are server-represented. The server default owner enables the managed
  // Chromium sidecar now that it is source-backed; dangerous agent-initiated exercise remains
  // approval-gated (FINALIZATION-PLAN §4.1/§13.4; see readFeatureEnv.ts).
  'browser.sidecar': {
    description: 'Managed sidecar browser host capability for automation-heavy browser sessions.',
    defaultFailMode: 'fail_closed',
    dependencies: ['browser.internal'],
    representation: 'server',
  },
  'browser.diagnostics': {
    description: 'Browser diagnostics and devtools event surfaces with adapter fidelity metadata.',
    defaultFailMode: 'fail_closed',
    dependencies: ['browser.internal'],
    representation: 'server',
  },
  'browser.context': {
    description: 'Explicit browser context capture and composer/agent attachment surfaces.',
    defaultFailMode: 'fail_closed',
    dependencies: ['browser.internal'],
    representation: 'server',
  },
  'browser.automation': {
    description: 'Host-owned browser automation control and action timeline surfaces.',
    defaultFailMode: 'fail_closed',
    dependencies: ['browser.internal'],
    // Server-represented + default-ALLOW: the automation *capability* is on by default now that the
    // ActionExecutor front door + surface-keyed approval defaults have landed; dangerous
    // agent-initiated exercise stays approval-gated, and a server admin can still disable agent
    // automation independently of human browsing/devtools. The finer injectedPage/eval tiers below
    // stay client + fail-closed (operator opt-in on top of this gate).
    representation: 'server',
  },
  'browser.automation.injectedPage': {
    description: 'Centralized injected-page browser automation runtime when adapter policy allows it.',
    defaultFailMode: 'fail_closed',
    dependencies: ['browser.automation'],
    representation: 'client',
  },
  'browser.automation.eval': {
    description: 'Policy-bound browser automation eval capability layered on diagnostics.',
    defaultFailMode: 'fail_closed',
    dependencies: ['browser.automation', 'browser.diagnostics'],
    representation: 'client',
  },
  'browser.recording': {
    description: 'Browser recording evidence artifact lifecycle and reference metadata.',
    defaultFailMode: 'fail_closed',
    dependencies: ['browser.internal'],
    representation: 'server',
  },
  'browser.recording.attachments': {
    description: 'Attach finalized browser recording evidence references to composer/session media flows.',
    defaultFailMode: 'fail_closed',
    dependencies: ['browser.recording', 'attachments.uploads', 'browser.context'],
    representation: 'client',
  },
  // Core plugin platform + UI projection gates are server-represented + default-allow (see
  // pluginsFeature.ts): on by default, the server can disable the plugin surface for its users.
  // The plugin UI tiers below are ALSO server-represented + default-ALLOW server/build kill-switches
  // (§4.1/§12.5/§13.5.3): install+enable+trust+runtime derives actual per-plugin availability at the
  // daemon UI projection (5.1/5.2 trust derivation). The server bit is only a coarse kill-switch.
  plugins: {
    description: 'Plugin platform surfaces and contribution projection.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'plugins.webhooks': {
    description: 'Durable public webhook ingress for plugin-contributed Actions.',
    defaultFailMode: 'fail_closed',
    dependencies: ['plugins'],
    representation: 'server',
  },
  'plugins.ui': {
    description: 'Plugin UI descriptor and executable UI tier projection.',
    defaultFailMode: 'fail_closed',
    dependencies: ['plugins'],
    representation: 'server',
  },
  'plugins.ui.hostedWeb': {
    description: 'Hosted web plugin UI surfaces embedded through host-owned preview frames and bridges.',
    defaultFailMode: 'fail_closed',
    dependencies: ['plugins.ui'],
    representation: 'server',
  },
  'plugins.ui.reactNativeBundles': {
    description: 'Trusted React Native plugin UI bundle execution with compatibility and fallback policy.',
    defaultFailMode: 'fail_closed',
    dependencies: ['plugins.ui'],
    representation: 'server',
  },
  'plugins.ui.reactNativeBundles.devHotReload': {
    description: 'Development hot reload for React Native plugin UI bundles.',
    defaultFailMode: 'fail_closed',
    dependencies: ['plugins.ui.reactNativeBundles'],
    representation: 'client',
  },
  devices: {
    description: 'Device and simulator preview/control surfaces.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  // Server-represented + default-ALLOW (§4.1): viewing your own simulator is core dev UX. The
  // server/build can disable it; the live-stream + browser.viewTargets dependency closure still
  // gates actual availability. (Unblocks the Phase-8 simulator surface.)
  'devices.simulatorPreview': {
    description: 'Simulator and emulator preview panes over the live-stream substrate.',
    defaultFailMode: 'fail_closed',
    dependencies: ['devices', 'machines.liveStream', 'browser.viewTargets'],
    representation: 'server',
  },
  'setup.relay.allowRelaySelection': {
    description: 'Build-time policy gate: whether relay selection surfaces are allowed at all.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'setup.relay.allowHappierCloud': {
    description: 'Build-time policy gate: whether Happier Cloud (https://api.happier.dev) is allowed as a relay option.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'setup.relay.allowCustomRelayUrl': {
    description: 'Build-time policy gate: whether custom/manual relay URL entry is allowed.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'setup.relay.allowLocalRelayHost': {
    description: 'Build-time policy gate: whether local relay hosting/setup surfaces are allowed.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'setup.relay.allowRemoteSshRelayHost': {
    description: 'Build-time policy gate: whether remote SSH relay hosting/setup surfaces are allowed.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'setup.relayAccess.allowTailscale': {
    description: 'Build-time policy gate: whether Tailscale relay access setup surfaces are allowed.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'setup.relayAccess.allowCloudflareTunnel': {
    description: 'Build-time policy gate: whether Cloudflare tunnel relay access setup surfaces are allowed.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'setup.machine.allowLocalMachineSetup': {
    description: 'Build-time policy gate: whether local machine setup surfaces are allowed.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'setup.machine.allowRemoteSshMachineSetup': {
    description: 'Build-time policy gate: whether remote SSH machine setup surfaces are allowed.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'setup.ssh.nativeTransport': {
    description: 'Build-time policy gate: whether the optional native SSH transport substrate is available.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'setup.providers.allowProviderSetup': {
    description: 'Build-time policy gate: whether provider onboarding/setup surfaces are allowed.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'social.friends': {
    description: 'Friends and related social feature availability.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'inbox.global': {
    description: 'Global inbox aggregation surfaces (approvals, permissions, social, updates).',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'actions.approvals': {
    description: 'ActionSpec-driven approval request queue and inbox UI surfaces.',
    defaultFailMode: 'fail_closed',
    dependencies: ['inbox.global'],
    representation: 'client',
  },
  'prompts.library': {
    description: 'Prompt library (docs + skills bundles) stored as artifacts.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'prompts.assets.external': {
    description: 'External prompt assets import/export surfaces and daemon adapters.',
    defaultFailMode: 'fail_closed',
    dependencies: ['prompts.library'],
    representation: 'client',
  },
  'prompts.skills.registries': {
    description: 'Prompt/skills registries and marketplace integrations (registry-of-registries).',
    defaultFailMode: 'fail_closed',
    dependencies: ['prompts.library', 'prompts.assets.external'],
    representation: 'client',
  },
  'auth.recovery.providerReset': {
    description: 'Auth provider reset support during recovery flows.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'auth.login.keyChallenge': {
    description: 'Key-challenge login route availability (POST /v1/auth).',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'auth.mtls': {
    description: 'mTLS client certificate authentication support.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'auth.ui.recoveryKeyReminder': {
    description: 'Recovery key reminder UI behavior.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'auth.pairing.desktopQrMobileScan': {
    description: 'Pairing session support for desktop/web QR → logged-out mobile scan sign-in.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'encryption.plaintextStorage': {
    description: 'Plaintext session storage support (no E2EE at rest).',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'encryption.accountOptOut': {
    description: 'Per-account encryption opt-out toggle support.',
    defaultFailMode: 'fail_closed',
    dependencies: ['encryption.plaintextStorage'],
    representation: 'server',
  },
  'remoteHosts.management': {
    description: 'Remote SSH host profile persistence and management surfaces.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'remoteHosts.secretMaterial': {
    description: 'Remote host secret material persistence (passwords/private keys) for saved SSH profiles.',
    defaultFailMode: 'fail_closed',
    dependencies: ['remoteHosts.management'],
    representation: 'server',
  },
  'e2ee.keylessAccounts': {
    description: 'Keyless account support (accounts may omit E2EE signing keys).',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'app.analytics': {
    description: 'Anonymous analytics and instrumentation (PostHog).',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'app.crashReports': {
    description: 'Crash reports and error telemetry (Sentry).',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'app.ui.storeReviewPrompts': {
    description: 'In-app store review prompts (native App Store / Play Store review sheet).',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'app.ui.sessionGettingStartedGuidance': {
    description: 'Session getting-started guidance UI (includes CLI install instructions).',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'app.ui.changelog': {
    description: 'What’s New / changelog UI surfaces (banner, settings entry, changelog screen).',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'app.ui.releaseNotes': {
    description: 'Curated release-notes story-deck modal (Notelet-style cards).',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'app.ui.onboardingShowcase': {
    description: 'Deprecated first-launch onboarding story-deck modal flag; retained fail-closed for compatibility.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'app.ui.onboardingTour': {
    description: 'Unified onboarding tour and demo-mode journey surfaces.',
    defaultFailMode: 'fail_closed',
    dependencies: ['app.ui.sessionGettingStartedGuidance'],
    representation: 'client',
  },
  'app.ui.liveActivities': {
    description: 'iOS Live Activities and Dynamic Island UI surfaces.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'app.ui.homeScreenWidgets': {
    description: 'iOS home screen widget UI surfaces.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  bugReports: {
    description: 'Bug report submission and diagnostics capability.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'scm.writeOperations': {
    description: 'Source-control write operations in UI/CLI.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'files.reviewComments': {
    description: 'Inline review comments anchored to file/diff lines.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'files.diffSyntaxHighlighting': {
    description: 'Syntax highlighting for file and diff code rendering.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'files.editor': {
    description: 'Embedded file editor in the session file browser.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'files.markdownRichEditor': {
    description: 'Rich (WYSIWYG) markdown editor surface in the embedded file editor.',
    defaultFailMode: 'fail_closed',
    dependencies: ['files.editor'],
    representation: 'client',
  },
  'files.syntaxHighlighting.advanced': {
    description: 'Advanced syntax highlighting engine selection (web/desktop).',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'terminal.embeddedPty': {
    description: 'Embedded terminal (PTY) surfaces backed by the daemon.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'terminal.transport.byteStream': {
    description: 'Byte-stream terminal transport using bounded base64 frames over machine RPC.',
    defaultFailMode: 'fail_closed',
    dependencies: ['terminal.embeddedPty'],
    representation: 'server',
  },
  'terminal.renderer.native': {
    description: 'Optional native terminal renderer experiments gated behind the byte-stream terminal foundation.',
    defaultFailMode: 'fail_closed',
    dependencies: ['terminal.transport.byteStream'],
    representation: 'client',
  },
  'terminal.renderer.iosGhostty': {
    description: 'Optional iOS Ghostty-based native terminal renderer experiment.',
    defaultFailMode: 'fail_closed',
    dependencies: ['terminal.renderer.native'],
    representation: 'client',
  },
  'terminal.renderer.androidTermux': {
    description: 'Optional Android Termux terminal-view native renderer experiment.',
    defaultFailMode: 'fail_closed',
    dependencies: ['terminal.renderer.native'],
    representation: 'client',
  },
  'mcp.servers': {
    description: 'MCP servers management and injection support.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'memory.search': {
    description: 'Local memory search UI entry and configuration surfaces.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'sessions.direct': {
    description: 'Direct sessions (provider-backed transcript).',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  providers: {
    description: 'First-class model-provider connections, catalogs, and agent bindings.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'providers.localDiscovery': {
    description: 'Machine-local provider discovery through the local-services listener inventory.',
    defaultFailMode: 'fail_closed',
    dependencies: ['providers', 'localServices.inventory'],
    representation: 'server',
  },
  'providers.localModelManagement': {
    description: 'Explicit, bounded local model-management actions for trusted provider contributions.',
    defaultFailMode: 'fail_closed',
    dependencies: ['providers'],
    representation: 'server',
  },
  'agents.claude.unifiedTerminal': {
    description: 'Claude unified terminal runtime capability.',
    defaultFailMode: 'fail_closed',
    dependencies: ['sessions.direct'],
    representation: 'client',
  },
  'agents.claude.unifiedTerminal.tuiRuntimeControl': {
    description: 'Claude unified terminal TUI runtime-control controller (live model/effort/permission-mode controls). Falls back to restart/unsupported outcomes when disabled.',
    defaultFailMode: 'fail_closed',
    dependencies: ['agents.claude.unifiedTerminal'],
    representation: 'client',
  },
  // Generalized, provider-agnostic umbrella gate for agent session goals + work-state goal
  // projection. Capability-driven goal gating reads `agents.goals`; provider-specific goal sub-gates
  // (e.g. `agents.codex.appServer.goals`) remain as independent back-compat flags so existing
  // call sites and server configs keep working. The umbrella declares NO dependencies so enabling it
  // never requires a provider sub-gate first — downstream gating ANDs `agents.goals` with the
  // provider-contributed goal capability rather than relying on a catalog dependency edge.
  'agents.goals': {
    description: 'Generalized agent session goal controls and work-state goal projection (umbrella over provider-specific goal sub-gates).',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'agents.codex.appServer.goals': {
    description: 'Codex app-server native session goal controls and work-state projection (provider-specific sub-gate under the generalized agents.goals umbrella).',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'agents.codex.appServer.plugins': {
    description: 'Codex app-server readonly vendor plugin catalog and structured mentions.',
    defaultFailMode: 'fail_closed',
    dependencies: ['sessions.direct', 'prompts.skills.registries'],
    representation: 'client',
  },
  'agents.codex.appServer.structuredInput': {
    description: 'Codex app-server structured turn inputs for text, images, skills, and vendor plugin mentions.',
    defaultFailMode: 'fail_closed',
    dependencies: ['sessions.direct', 'attachments.uploads'],
    representation: 'client',
  },
  'agents.codex.appServer.permissionProfiles': {
    description: 'Codex app-server native permission profiles and runtime policy edits.',
    defaultFailMode: 'fail_closed',
    dependencies: ['sessions.direct'],
    representation: 'client',
  },
  'zen.navigation': {
    description: 'Zen navigation entry and related UX.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'usage.reporting': {
    description: 'Usage reporting surfaces and telemetry views.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
} as const;

export const FEATURE_CATALOG = defineFeatureCatalog(FEATURE_CATALOG_DEFINITION);

export type FeatureId = keyof typeof FEATURE_CATALOG;

export const FEATURE_IDS: readonly FeatureId[] = Object.freeze(Object.keys(FEATURE_CATALOG) as FeatureId[]);

export const FEATURE_ID_ENUM: readonly [FeatureId, ...FeatureId[]] = (() => {
  if (FEATURE_IDS.length === 0) {
    throw new Error('FEATURE_CATALOG must not be empty');
  }
  return [FEATURE_IDS[0], ...FEATURE_IDS.slice(1)] as [FeatureId, ...FeatureId[]];
})();

const FEATURE_ID_SET: ReadonlySet<string> = new Set(FEATURE_IDS);

export function isFeatureId(value: unknown): value is FeatureId {
  return typeof value === 'string' && FEATURE_ID_SET.has(value);
}

export function getFeatureDefinition(featureId: FeatureId): (typeof FEATURE_CATALOG)[FeatureId] {
  return FEATURE_CATALOG[featureId];
}

export function getFeatureDependencies(featureId: FeatureId): readonly FeatureId[] {
  return FEATURE_CATALOG[featureId].dependencies;
}

export function getFeatureRepresentation(featureId: FeatureId): FeatureRepresentation {
  return FEATURE_CATALOG[featureId].representation;
}

export function isFeatureServerRepresented(featureId: FeatureId): boolean {
  return FEATURE_CATALOG[featureId].representation === 'server';
}

const REQUIRES_SERVER_SNAPSHOT_MEMO = new Map<FeatureId, boolean>();

export function featureRequiresServerSnapshot(featureId: FeatureId): boolean {
  const cached = REQUIRES_SERVER_SNAPSHOT_MEMO.get(featureId);
  if (cached !== undefined) return cached;

  if (isFeatureServerRepresented(featureId)) {
    REQUIRES_SERVER_SNAPSHOT_MEMO.set(featureId, true);
    return true;
  }

  for (const dep of getFeatureDependencies(featureId)) {
    if (featureRequiresServerSnapshot(dep)) {
      REQUIRES_SERVER_SNAPSHOT_MEMO.set(featureId, true);
      return true;
    }
  }

  REQUIRES_SERVER_SNAPSHOT_MEMO.set(featureId, false);
  return false;
}

export type { FeatureCatalogDefinitionEntry, FeatureFailMode, FeatureRepresentation } from './catalogTypes.js';
