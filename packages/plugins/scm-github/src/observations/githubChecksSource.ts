import { createHash } from 'node:crypto';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import { GITHUB_AUTOMATION_EVENT_LOCAL_IDS, normalizeGithubAutomationEvent, type GithubAutomationEventRepositoryV1, type GithubAutomationEventRefV1, type GithubAutomationEventPayloadV1 } from '../githubAutomationEvents.js';
import { GITHUB_CHECKS_SNAPSHOT_SCHEMA } from '../githubAutomationEvents.js';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import type { GithubChecksConditionSnapshotV1 } from '../triage/checksCondition.js';
import type { GithubChecksSurfaceV1 } from '../triage/checks.js';
import { readGithubCheckOutcomeV1 } from '../triage/checkOutcome.js';

export type GithubChecksEventObservationV1 = Readonly<{
  eventRef: GithubAutomationEventRefV1;
  payload: GithubAutomationEventPayloadV1;
  occurrenceId: string;
  providerOccurredAtMs: number | null;
  failedCheckNames: readonly string[];
}>;

/** One checks-event projection for Automation sources, scoped CI triggers and their checkpoint waiter. */
export function projectGithubChecksSourceEvents(repository: GithubAutomationEventRepositoryV1, surface: GithubChecksSurfaceV1): Readonly<{
  snapshot: GithubChecksConditionSnapshotV1;
  evidenceKey: string;
  events: readonly GithubChecksEventObservationV1[];
}> {
  const snapshot = surface.observation;
  if (!snapshot) throw new PluginError({ code: 'github_checks_source_invalid', message: 'GitHub checks observation is unavailable.' });
  const evidenceKey = createHash('sha256').update(JSON.stringify([snapshot, surface.observations])).digest('base64url');
  const occurrenceId = `${githubChecksSourceInstanceId(repository.repositoryId, snapshot)}:${evidenceKey}`;
  const events: GithubChecksEventObservationV1[] = [];
  const failedCheckNames: string[] = [];
  let providerOccurredAtMs: number | null = null;
  for (const check of surface.observations) {
    if (readGithubCheckOutcomeV1(check) === 'failed') failedCheckNames.push(check.name);
    const timestamp = check.completedAtMs ?? check.startedAtMs ?? check.checkSuiteCreatedAtMs;
    if (timestamp !== undefined && timestamp !== null) {
      providerOccurredAtMs = Math.max(providerOccurredAtMs ?? timestamp, timestamp);
    }
  }
  for (const kind of ['checksCompleted', 'checksFailed', 'checksPassed'] as const) {
    if (!githubChecksEventMatches(GITHUB_AUTOMATION_EVENT_LOCAL_IDS[kind], snapshot)) continue;
    events.push({ ...normalizeGithubAutomationEvent({ kind, repository, checks: snapshot }), occurrenceId, providerOccurredAtMs, failedCheckNames });
  }
  return { snapshot, evidenceKey, events };
}

export const GITHUB_CHECKS_SETUP_ACTION_ID = 'automation/setup-pull-request-checks-v1';
export const GITHUB_CHECKS_WAIT_ACTION_ID = 'wait/pull-request-checks-v1';
export const GITHUB_CHECKS_SOURCE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    pullRequestNumber: { type: 'integer', minimum: 1 },
    headSha: { type: 'string', pattern: '^[a-fA-F0-9]{40}$' },
    selection: { type: 'string', enum: ['all', 'required'] },
  }, required: ['pullRequestNumber', 'headSha', 'selection'],
} satisfies PluginJsonSchema;
export type GithubChecksSourceV1 = Readonly<{ pullRequestNumber: number; headSha: string; selection: 'all' | 'required' }>;
export function parseGithubChecksSource(value: unknown): GithubChecksSourceV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const input = value as Readonly<Record<string, unknown>>;
  if (Object.keys(input).length !== 3 || !Number.isSafeInteger(input.pullRequestNumber)
    || typeof input.pullRequestNumber !== 'number' || input.pullRequestNumber < 1
    || typeof input.headSha !== 'string' || !/^[a-fA-F0-9]{40}$/u.test(input.headSha)
    || (input.selection !== 'all' && input.selection !== 'required')) throw invalid();
  return { pullRequestNumber: input.pullRequestNumber, headSha: input.headSha.toLowerCase(), selection: input.selection };
}
function invalid() {
  return new PluginError({ code: 'github_checks_source_invalid', message: 'Choose an exact pull request, head SHA and checks selection.' });
}
export function githubChecksSourceInstanceId(repositoryId: string, checks: GithubChecksSourceV1): string {
  return `github:repository:${repositoryId}:pull-request:${checks.pullRequestNumber}:head:${checks.headSha}:checks:${checks.selection}`;
}
export function isGithubChecksEvent(localId: string): boolean {
  return localId === GITHUB_AUTOMATION_EVENT_LOCAL_IDS.checksCompleted
    || localId === GITHUB_AUTOMATION_EVENT_LOCAL_IDS.checksFailed
    || localId === GITHUB_AUTOMATION_EVENT_LOCAL_IDS.checksPassed;
}
export function githubChecksEventMatches(localId: string, snapshot: GithubChecksConditionSnapshotV1): boolean {
  if (snapshot.state === 'superseded' || snapshot.state === 'unknown' || snapshot.state === 'none') return false;
  return localId === GITHUB_AUTOMATION_EVENT_LOCAL_IDS.checksCompleted ? snapshot.complete
    : localId === GITHUB_AUTOMATION_EVENT_LOCAL_IDS.checksPassed ? snapshot.passed
      : localId === GITHUB_AUTOMATION_EVENT_LOCAL_IDS.checksFailed && snapshot.state === 'failed';
}

const validateSnapshot = compilePluginJsonSchema(GITHUB_CHECKS_SNAPSHOT_SCHEMA);
export function readGithubChecksSnapshot(value: unknown): GithubChecksConditionSnapshotV1 | null {
  if (!isValidPluginJsonSchemaValue(validateSnapshot, value)) return null;
  const snapshot = value as GithubChecksConditionSnapshotV1;
  if (snapshot.passed !== (snapshot.state === 'passed') || (snapshot.passed && !snapshot.complete)
    || (snapshot.failure !== undefined && snapshot.state !== 'unknown')
    || (['none', 'unknown', 'superseded', 'pending'].includes(snapshot.state) && snapshot.complete)
    || (snapshot.state !== 'unknown' && snapshot.state !== 'superseded' && snapshot.currentHeadSha !== snapshot.headSha)) return null;
  return snapshot;
}
