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
    representation: 'server',
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
  connectedServices: {
    description: 'Connected services token sink and subscription/OAuth surfaces.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'connectedServices.quotas': {
    description: 'Connected services quota snapshots (informational usage meters) surfaces and runtime.',
    defaultFailMode: 'fail_closed',
    dependencies: ['connectedServices'],
    representation: 'server',
  },
  'connectedServices.accountGroups': {
    description: 'Connected service account groups and member management APIs.',
    defaultFailMode: 'fail_closed',
    dependencies: ['connectedServices'],
    representation: 'server',
  },
  'connectedServices.accountFallback': {
    description: 'Connected service account group fallback and automatic active account switching APIs.',
    defaultFailMode: 'fail_closed',
    dependencies: ['connectedServices.accountGroups', 'sessions.usageLimitRecovery'],
    representation: 'server',
  },
  channelBridges: {
    description: 'Channel bridge integrations (Telegram/Discord/etc).',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
  },
  'channelBridges.telegram': {
    description: 'Telegram channel bridge provider.',
    defaultFailMode: 'fail_closed',
    dependencies: ['channelBridges'],
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
  'session.media.generated': {
    description: 'Generated/provider/tool session media output substrate.',
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
    description: 'Provider delivery-state materialization support for pending queue routes and fields.',
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
  'sessions.usageLimitRecovery': {
    description: 'Session usage-limit recovery, wait/resume intent, and retry metadata APIs.',
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
    description: 'Per-account session folder organization and assignment APIs.',
    defaultFailMode: 'fail_closed',
    dependencies: ['sessions'],
    representation: 'server',
  },
  'sessions.drafts': {
    description: 'Cross-device composer and new-session draft synchronization.',
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
    description: 'Curated release-notes story-deck modal (Notelet-style cards). Shares renderer with onboarding showcase.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'app.ui.onboardingShowcase': {
    description: 'First-launch onboarding story-deck modal (shares renderer with release notes).',
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
  // Generalized, provider-agnostic umbrella gate for agent session goals + work-state goal
  // projection. New capability-driven goal gating reads `agent.goals`; provider-specific goal
  // sub-gates (e.g. `providers.codex.appServer.goals`) remain as independent back-compat flags so
  // existing call sites and server configs keep working without forced reconfiguration. The
  // umbrella relationship is realized by downstream gating that ANDs `agent.goals` with the
  // provider-contributed goal capability, not by a catalog dependency edge — dependency wiring runs
  // through the shared `applyFeatureDependencies` engine, and this umbrella intentionally declares
  // no dependencies so enabling it never requires a provider sub-gate to be enabled first.
  'agent.goals': {
    description: 'Generalized agent session goal controls and work-state goal projection (umbrella over provider-specific goal sub-gates).',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'providers.codex.appServer.goals': {
    description: 'Codex app-server native session goal controls and work-state projection (provider-specific sub-gate under the generalized agent.goals umbrella).',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'providers.codex.appServer.plugins': {
    description: 'Codex app-server readonly vendor plugin catalog and structured mentions.',
    defaultFailMode: 'fail_closed',
    dependencies: ['sessions.direct', 'prompts.skills.registries'],
    representation: 'client',
  },
  'providers.codex.appServer.structuredInput': {
    description: 'Codex app-server structured turn inputs for text, images, skills, and vendor plugin mentions.',
    defaultFailMode: 'fail_closed',
    dependencies: ['sessions.direct', 'attachments.uploads'],
    representation: 'client',
  },
  'providers.codex.appServer.permissionProfiles': {
    description: 'Codex app-server permission profile transport.',
    defaultFailMode: 'fail_closed',
    dependencies: ['sessions.direct'],
    representation: 'client',
  },
  'providers.claude.unifiedTerminal': {
    description: 'Claude unified terminal runtime availability.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'providers.claude.unifiedTerminal.tuiRuntimeControl': {
    description: 'Claude unified terminal TUI runtime-control controller (live model/effort/permission-mode controls). Falls back to restart/unsupported outcomes when disabled.',
    defaultFailMode: 'fail_closed',
    dependencies: ['providers.claude.unifiedTerminal'],
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
