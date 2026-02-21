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
  'social.friends': {
    description: 'Friends and related social feature availability.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'server',
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
  'files.syntaxHighlighting.advanced': {
    description: 'Advanced syntax highlighting engine selection (web/desktop).',
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
  'session.typeSelector': {
    description: 'Session type selector in session creation UX.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
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
  'messages.thinkingVisibility': {
    description: 'Thinking/status message visibility.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'codex.resume.mcp': {
    description: 'Codex MCP resume capability feature gate.',
    defaultFailMode: 'fail_closed',
    dependencies: [],
    representation: 'client',
  },
  'codex.resume.acp': {
    description: 'Codex ACP resume capability feature gate.',
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
