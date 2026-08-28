/**
 * The sole Sentry owner of row → snapshot projection (`SENTRY.md` §6).
 *
 * Two rules dominate this file:
 *
 * 1. **`status` and `substatus` are never collapsed.** `escalating` and
 *    `regressed` are `unresolved` states that change without human action, and
 *    they are exactly what a triage product exists to surface. The presentation
 *    enum is a deliberately lossy projection; `nativeLabel` keeps the provider's
 *    own word beside it. The transient statuses map to `unknown` rather than
 *    being skipped, so an entry the provider is actively changing does not
 *    silently disappear and reappear.
 * 2. **A contract-valid issue is never dropped for being large.** Oversized text
 *    is semantically truncated and the excess fact tail is omitted, both of which
 *    set `projectionTruncated`. That is distinct from malformed-row omission,
 *    which is the only thing that contributes to scan `omittedItemCount`.
 */

import {
  MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  MAX_TRIAGE_ROW_FACTS_V1,
  MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  projectTriageDisplayTextV1,
} from '@happier-dev/triage-protocol/v1';

import type { SentryFailureV1 } from '../sentryContracts.js';

import {
  resolveSentryInvokedScope,
  type SentryInvokedInstanceV1,
} from '../instances/sentryCollisionScope.js';
import { buildSentryLocator } from '../instances/sentryLocator.js';
import type {
  SentryFactImportanceV1,
  SentryFactValueV1,
  SentryEntryStateV1,
  SentryIssueSnapshotV1,
  SentryRowFactV1,
  SentryStatusToneV1,
} from './sentryIssueTypes.js';

export type SentryIssueMappingInputV1 = Readonly<{
  raw: unknown;
  configured: SentryInvokedInstanceV1;
  /** The route actually invoked, revalidated before an observation is emitted. */
  requestUrl: string;
  organizationSlug: string | null;
}>;

export type SentryIssueMappingResultV1 =
  | Readonly<{ ok: true; snapshot: SentryIssueSnapshotV1 }>
  | Readonly<{ ok: false; reason: 'malformed-row' }>
  | Readonly<{ ok: false; reason: 'scope-mismatch'; failure: SentryFailureV1 }>;

const MALFORMED = Object.freeze({ ok: false as const, reason: 'malformed-row' as const });

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function parseTimestampMs(value: unknown): number | null {
  const raw = readString(value);
  if (raw === null) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `[SCHEMA]` `count` is typed **string**, not integer, because it can exceed a
 * JS-safe integer. It is kept as a string and never used in arithmetic.
 */
function readCountValue(value: unknown): string | null {
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

type SentryStateTable = Readonly<Record<string, SentryEntryStateV1 | undefined>>;

const STATE_BY_SUBSTATUS: Readonly<Record<string, SentryStateTable | undefined>> = {
  unresolved: {
    new: { presentation: 'active', nativeLabel: 'New' },
    ongoing: { presentation: 'active', nativeLabel: 'Ongoing' },
    escalating: { presentation: 'active', nativeLabel: 'Escalating' },
    regressed: { presentation: 'active', nativeLabel: 'Regressed' },
  },
  ignored: {
    archived_forever: { presentation: 'suppressed', nativeLabel: 'Archived forever' },
    archived_until_escalating: {
      presentation: 'suppressed',
      nativeLabel: 'Archived until escalating',
    },
    archived_until_condition_met: {
      presentation: 'suppressed',
      nativeLabel: 'Archived until condition met',
    },
  },
};

const STATE_BY_STATUS: SentryStateTable = {
  unresolved: { presentation: 'active', nativeLabel: 'Unresolved' },
  ignored: { presentation: 'suppressed', nativeLabel: 'Archived' },
  resolved: { presentation: 'resolved', nativeLabel: 'Resolved' },
  pending_deletion: { presentation: 'unknown', nativeLabel: 'Pending deletion' },
  pending_merge: { presentation: 'unknown', nativeLabel: 'Pending merge' },
  reprocessing: { presentation: 'unknown', nativeLabel: 'Reprocessing' },
};

export function mapSentryIssueState(status: unknown, substatus: unknown): SentryEntryStateV1 {
  const statusText = typeof status === 'string' ? status : '';
  const substatusText = typeof substatus === 'string' ? substatus : '';
  const bySubstatus = STATE_BY_SUBSTATUS[statusText]?.[substatusText];
  if (bySubstatus !== undefined) return Object.freeze({ ...bySubstatus });
  const byStatus = STATE_BY_STATUS[statusText];
  if (byStatus !== undefined) return Object.freeze({ ...byStatus });
  return Object.freeze({ presentation: 'unknown' as const, nativeLabel: statusText });
}

const LEVEL_TONES: Readonly<Record<string, SentryStatusToneV1>> = Object.freeze({
  fatal: 'danger',
  error: 'danger',
  warning: 'warning',
  info: 'info',
});

const PRIORITY_TONES: Readonly<Record<string, SentryStatusToneV1>> = Object.freeze({
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
});

type FactCandidate = Readonly<{
  id: string;
  importance: SentryFactImportanceV1;
  value: SentryFactValueV1 | null;
}>;

function textFact(value: string | null): Readonly<{
  value: SentryFactValueV1 | null;
  truncated: boolean;
}> {
  if (value === null) return { value: null, truncated: false };
  const bounded = projectTriageDisplayTextV1(value, MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1);
  if (bounded.value.length === 0) return { value: null, truncated: false };
  return { value: { kind: 'text', text: bounded.value }, truncated: bounded.truncated };
}

function readAssignee(value: unknown): SentryFactValueV1 | null {
  if (!isRecord(value)) return null;
  const displayName = readString(value.name) ?? readString(value.id);
  if (displayName === null) return null;
  const actorKind = value.type === 'team' ? 'team' : 'user';
  const bounded = projectTriageDisplayTextV1(displayName, MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1);
  if (bounded.value.length === 0) return null;
  return { kind: 'actor', displayName: bounded.value, actorKind };
}

function readLifetimeCount(
  raw: Readonly<Record<string, unknown>>,
  lifetimeKey: 'count' | 'userCount',
  topLevelKey: 'count' | 'userCount',
): string | null {
  // The current schema exposes `lifetime`; an older self-hosted response may omit
  // it or supply an unparseable value, so the fallback is field-by-field.
  const lifetime = isRecord(raw.lifetime) ? readCountValue(raw.lifetime[lifetimeKey]) : null;
  return lifetime ?? readCountValue(raw[topLevelKey]);
}

export function mapSentryIssueForInvokedInstance(
  input: SentryIssueMappingInputV1,
): SentryIssueMappingResultV1 {
  const scope = resolveSentryInvokedScope({
    configured: input.configured,
    requestUrl: input.requestUrl,
  });
  if (!scope.ok) {
    return Object.freeze({
      ok: false as const,
      reason: 'scope-mismatch' as const,
      failure: scope.failure,
    });
  }

  const raw = input.raw;
  if (!isRecord(raw)) return MALFORMED;

  const entryId = readString(raw.id);
  if (
    entryId === null
    || encoder.encode(entryId).byteLength > MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1
  ) {
    return MALFORMED;
  }

  let truncated = false;
  // A Sentry exception message routinely carries a newline. Every V1 string is
  // single-line and the target rejects a control-bearing result ATOMICALLY, so the
  // shared owner normalizes before this projection measures anything. The short id
  // is the fallback when nothing survives — the issue stays visible either way.
  const title = projectTriageDisplayTextV1(
    readString(raw.title) ?? entryId,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  );
  truncated ||= title.truncated;

  const project = isRecord(raw.project) ? raw.project : null;
  const projectSlug = project === null ? null : readString(project.slug);
  const projectName = project === null ? null : readString(project.name);

  const culprit = textFact(readString(raw.culprit));
  truncated ||= culprit.truncated;
  const issueCategory = textFact(readString(raw.issueCategory));
  truncated ||= issueCategory.truncated;
  const issueType = textFact(readString(raw.issueType));
  truncated ||= issueType.truncated;
  const projectFact = textFact(projectSlug);
  truncated ||= projectFact.truncated;

  const level = readString(raw.level);
  const priority = readString(raw.priority);
  const lastSeenMs = parseTimestampMs(raw.lastSeen);
  const firstSeenMs = parseTimestampMs(raw.firstSeen);
  const eventCount = readLifetimeCount(raw, 'count', 'count');
  const userCount = readLifetimeCount(raw, 'userCount', 'userCount');

  // The stable priority order: the lower-priority tail is what a fact-count
  // overflow omits.
  const candidates: readonly FactCandidate[] = [
    { id: 'issue-category', importance: 'primary', value: issueCategory.value },
    { id: 'issue-type', importance: 'secondary', value: issueType.value },
    {
      id: 'level',
      importance: 'primary',
      value: level === null
        ? null
        : { kind: 'status', label: level, tone: LEVEL_TONES[level] ?? 'neutral' },
    },
    { id: 'culprit', importance: 'primary', value: culprit.value },
    {
      id: 'unhandled',
      importance: 'primary',
      value: raw.isUnhandled === true
        ? { kind: 'status', label: 'Unhandled', tone: 'warning' }
        : null,
    },
    { id: 'project', importance: 'secondary', value: projectFact.value },
    {
      id: 'events',
      importance: 'secondary',
      value: eventCount === null
        ? null
        : { kind: 'number', value: eventCount, format: 'compact', approximate: true },
    },
    {
      id: 'users',
      importance: 'secondary',
      value: userCount === null
        ? null
        : { kind: 'number', value: userCount, format: 'compact', approximate: true },
    },
    {
      id: 'last-seen',
      importance: 'secondary',
      value: lastSeenMs === null
        ? null
        : { kind: 'timestamp', atMs: lastSeenMs, format: 'relative' },
    },
    {
      id: 'first-seen',
      importance: 'supplementary',
      value: firstSeenMs === null
        ? null
        : { kind: 'timestamp', atMs: firstSeenMs, format: 'relative' },
    },
    { id: 'assignee', importance: 'secondary', value: readAssignee(raw.assignedTo) },
    {
      id: 'priority',
      importance: 'secondary',
      value: priority === null
        ? null
        : { kind: 'status', label: priority, tone: PRIORITY_TONES[priority] ?? 'neutral' },
    },
    // `lastRelease` exists only on the detail response, so the row states that
    // deliberately rather than pretending the fact is unavailable.
    { id: 'last-release', importance: 'supplementary', value: { kind: 'detailOnly' } },
  ];

  const present = candidates.filter((candidate): candidate is FactCandidate & {
    value: SentryFactValueV1;
  } => candidate.value !== null);
  const facts: readonly SentryRowFactV1[] = Object.freeze(
    present.slice(0, MAX_TRIAGE_ROW_FACTS_V1).map((candidate) => Object.freeze({
      id: candidate.id,
      importance: candidate.importance,
      value: Object.freeze(candidate.value),
    })),
  );
  truncated ||= present.length > MAX_TRIAGE_ROW_FACTS_V1;

  const scopeLabel = projectTriageDisplayTextV1(
    projectName ?? projectSlug ?? input.organizationSlug ?? input.configured.organizationId,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  );
  truncated ||= scopeLabel.truncated;

  const locator = buildSentryLocator({
    permalink: readString(raw.permalink),
    organizationSlug: input.organizationSlug,
    projectSlug,
    shortId: readString(raw.shortId),
    deploymentOrigin: input.configured.deploymentOrigin,
    organizationId: input.configured.organizationId,
    entryId,
  });
  truncated ||= locator.truncated;

  return Object.freeze({
    ok: true as const,
    snapshot: Object.freeze({
      kindId: 'error-issue' as const,
      localRef: Object.freeze({
        kindId: 'error-issue' as const,
        collisionScope: scope.collisionScope,
        entryId,
      }),
      title: title.value.length === 0 ? entryId : title.value,
      scopeLabel: scopeLabel.value.length === 0 ? input.configured.organizationId : scopeLabel.value,
      state: mapSentryIssueState(raw.status, raw.substatus),
      locator,
      facts,
      sourceUpdatedAtMs: lastSeenMs,
      projectionTruncated: truncated,
    }),
  });
}
