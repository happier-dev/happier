export const FEATURE_IDS = [
  'automations',
  'automations.existingSessionTarget',
  'execution.runs',
  'voice',
  'connected.services',
  'connected.services.quotas',
  'updates.ota',
  'social.friends',
  'auth.recovery.providerReset',
  'auth.ui.recoveryKeyReminder',
  'app.analytics',
  'app.ui.storeReviewPrompts',
  'app.ui.sessionGettingStartedGuidance',
  'app.ui.changelog',
  'bugReports',
  'scm.writeOperations',
  'files.reviewComments',
  'files.diffSyntaxHighlighting',
  'files.editor',
  'files.syntaxHighlighting.advanced',
  'session.typeSelector',
  'zen.navigation',
  'usage.reporting',
  'messages.thinkingVisibility',
  'codex.resume.mcp',
  'codex.resume.acp',
] as const;

export type FeatureId = (typeof FEATURE_IDS)[number];

const FEATURE_ID_SET: ReadonlySet<string> = new Set(FEATURE_IDS);

export function isFeatureId(value: unknown): value is FeatureId {
  return typeof value === 'string' && FEATURE_ID_SET.has(value);
}
