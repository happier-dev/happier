import { FEATURE_IDS, isFeatureId } from './featureIds.js';
import type { FeatureCatalogEntry } from './catalogTypes.js';

const descriptions: Record<(typeof FEATURE_IDS)[number], string> = {
  automations: 'Automations feature surfaces and scheduling runtime.',
  'automations.existingSessionTarget': 'Automation target support for existing session execution.',
  'execution.runs': 'Execution runs / sub-agent orchestration surfaces and runtime.',
  voice: 'Happier voice assistant feature availability.',
  'connected.services': 'Connected services token sink and subscription/OAuth surfaces.',
  'connected.services.quotas': 'Connected services quota snapshots (informational usage meters) surfaces and runtime.',
  'updates.ota': 'Expo over-the-air update checks and apply flows.',
  'social.friends': 'Friends and related social feature availability.',
  'auth.recovery.providerReset': 'Auth provider reset support during recovery flows.',
  'auth.ui.recoveryKeyReminder': 'Recovery key reminder UI behavior.',
  'app.analytics': 'Anonymous analytics and instrumentation (PostHog).',
  'app.ui.storeReviewPrompts': 'In-app store review prompts (native App Store / Play Store review sheet).',
  'app.ui.sessionGettingStartedGuidance': 'Session getting-started guidance UI (includes CLI install instructions).',
  'app.ui.changelog': 'What’s New / changelog UI surfaces (banner, settings entry, changelog screen).',
  bugReports: 'Bug report submission and diagnostics capability.',
  'scm.writeOperations': 'Source-control write operations in UI/CLI.',
  'files.reviewComments': 'Inline review comments anchored to file/diff lines.',
  'files.diffSyntaxHighlighting': 'Syntax highlighting for file and diff code rendering.',
  'files.editor': 'Embedded file editor in the session file browser.',
  'files.syntaxHighlighting.advanced': 'Advanced syntax highlighting engine selection (web/desktop).',
  'memory.search': 'Local memory search UI entry and configuration surfaces.',
  'session.typeSelector': 'Session type selector in session creation UX.',
  'zen.navigation': 'Zen navigation entry and related UX.',
  'usage.reporting': 'Usage reporting surfaces and telemetry views.',
  'messages.thinkingVisibility': 'Thinking/status message visibility.',
  'codex.resume.mcp': 'Codex MCP resume capability feature gate.',
  'codex.resume.acp': 'Codex ACP resume capability feature gate.',
};

export const FEATURE_CATALOG: readonly FeatureCatalogEntry[] = Object.freeze(
  FEATURE_IDS.map((id) => ({
    id,
    description: descriptions[id],
    defaultFailMode: 'fail_closed' as const,
  })),
);

export { FEATURE_IDS, isFeatureId };
export type { FeatureId } from './featureIds.js';
export type { FeatureCatalogEntry, FeatureFailMode } from './catalogTypes.js';
