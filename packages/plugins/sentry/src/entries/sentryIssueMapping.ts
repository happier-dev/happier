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
 *    is semantically truncated with `projectionTruncated`; every available fact
 *    is preserved. That is distinct from malformed-row omission,
 *    which is the only thing that contributes to scan `omittedItemCount`.
 */

import {
  MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  projectTriageDisplayTextV1,
} from '@happier-dev/triage-protocol/v1';

import {
  isSentryNumericId,
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
  /** Resolved once by the request owner through resolveSentryInvokedScope. */
  collisionScope: string;
  organizationSlug: string | null;
}>;

export type SentryIssueMappingResultV1 =
  | Readonly<{ ok: true; snapshot: SentryIssueSnapshotV1 }>
  | Readonly<{ ok: false; reason: 'malformed-row' }>;

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

function textFact(value: string | null): SentryFactValueV1 | null {
  return value === null ? null : { kind: 'text', text: value };
}

function readAssignee(value: unknown): SentryFactValueV1 | null {
  if (!isRecord(value)) return null;
  const displayName = readString(value.name) ?? readString(value.id);
  if (displayName === null) return null;
  const actorKind = value.type === 'team' ? 'team' : 'user';
  return { kind: 'actor', displayName, actorKind };
}

/** Every displayed fact uses the published semantic bound, including exact-count text. */
function projectFactValue(value: SentryFactValueV1): Readonly<{
  value: SentryFactValueV1 | null;
  truncated: boolean;
}> {
  if (value.kind === 'timestamp' || value.kind === 'detailOnly') return { value, truncated: false };
  const raw = value.kind === 'text' ? value.text
    : value.kind === 'status' ? value.label
      : value.kind === 'actor' ? value.displayName : value.value;
  const bounded = projectTriageDisplayTextV1(raw, MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1);
  if (bounded.value.length === 0) return { value: null, truncated: false };
  switch (value.kind) {
    case 'text': return { value: { ...value, text: bounded.value }, truncated: bounded.truncated };
    case 'status': return { value: { ...value, label: bounded.value }, truncated: bounded.truncated };
    case 'actor': return { value: { ...value, displayName: bounded.value }, truncated: bounded.truncated };
    case 'number': return {
      // A shortened count is display text, never an invented smaller numeric count.
      value: bounded.truncated ? { kind: 'text', text: bounded.value } : value,
      truncated: bounded.truncated,
    };
  }
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

/**
 * Which issue a 200 issue response is actually about (`SENTRY.md` §4.1).
 *
 * `[SOURCE]` `src/sentry/issues/endpoints/bases/group.py` resolves a
 * `GroupRedirect` and **discards** the `redirected` flag, so a `GET` on a
 * merged-away id answers `200` with the SURVIVING issue's body — no `3xx`, no
 * header, no field announcing it. Comparing the returned `id` against the
 * requested one is the only detection any client has, which is why it belongs
 * to one owner rather than to whichever read remembered to do it: `get` reports
 * the successor as `merged`, while a detail read has no merge arm and must
 * refuse instead of rendering issue B beneath issue A's still-mounted identity.
 */
export type SentryIssueResponseIdentityV1 =
  | Readonly<{ kind: 'requested' }>
  | Readonly<{ kind: 'superseded'; returnedEntryId: string }>
  /** No usable `id`: the body is not an issue this source can characterize. */
  | Readonly<{ kind: 'unreadable' }>;

const IDENTITY_REQUESTED: SentryIssueResponseIdentityV1 = Object.freeze({
  kind: 'requested' as const,
});
const IDENTITY_UNREADABLE: SentryIssueResponseIdentityV1 = Object.freeze({
  kind: 'unreadable' as const,
});

export function admitSentryIssueResponseIdentity(
  body: unknown,
  requestedEntryId: string,
): SentryIssueResponseIdentityV1 {
  if (!isRecord(body)) return IDENTITY_UNREADABLE;
  const returnedEntryId = readString(body.id);
  if (returnedEntryId === null) return IDENTITY_UNREADABLE;
  return returnedEntryId === requestedEntryId
    ? IDENTITY_REQUESTED
    : Object.freeze({ kind: 'superseded' as const, returnedEntryId });
}

export function mapSentryIssueForInvokedInstance(
  input: SentryIssueMappingInputV1,
): SentryIssueMappingResultV1 {
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
  const projectId = project === null ? null : readString(project.id);
  const projectSlug = project === null ? null : readString(project.slug);
  const projectName = project === null ? null : readString(project.name);

  const culprit = textFact(readString(raw.culprit));
  const issueCategory = textFact(readString(raw.issueCategory));
  const issueType = textFact(readString(raw.issueType));
  const projectFact = textFact(projectSlug);

  const level = readString(raw.level);
  const priority = readString(raw.priority);
  const lastSeenMs = parseTimestampMs(raw.lastSeen);
  const firstSeenMs = parseTimestampMs(raw.firstSeen);
  const eventCount = readLifetimeCount(raw, 'count', 'count');
  const userCount = readLifetimeCount(raw, 'userCount', 'userCount');

  // Keep every available fact in the source's stable priority order.
  const candidates: readonly FactCandidate[] = [
    { id: 'issue-category', importance: 'primary', value: issueCategory },
    { id: 'issue-type', importance: 'secondary', value: issueType },
    {
      id: 'level',
      importance: 'primary',
      value: level === null
        ? null
        : { kind: 'status', label: level, tone: LEVEL_TONES[level] ?? 'neutral' },
    },
    { id: 'culprit', importance: 'primary', value: culprit },
    {
      id: 'unhandled',
      importance: 'primary',
      value: raw.isUnhandled === true
        ? { kind: 'status', label: 'Unhandled', tone: 'warning' }
        : null,
    },
    { id: 'project', importance: 'secondary', value: projectFact },
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

  const facts: SentryRowFactV1[] = [];
  for (const candidate of candidates) {
    if (candidate.value === null) continue;
    const projected = projectFactValue(candidate.value);
    truncated ||= projected.truncated;
    if (projected.value === null) continue;
    facts.push(Object.freeze({
      id: candidate.id,
      importance: candidate.importance,
      value: Object.freeze(projected.value),
    }));
  }

  const scopeLabel = projectTriageDisplayTextV1(
    projectName ?? projectSlug ?? input.organizationSlug ?? input.configured.organizationId,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  );
  truncated ||= scopeLabel.truncated;

  // The short id as Sentry writes it, one bounded display line; presentation only, never identity.
  const shortId = readString(raw.shortId);
  const designation = shortId === null ? null : projectTriageDisplayTextV1(shortId, MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
  truncated ||= designation?.truncated === true;

  const locator = buildSentryLocator({
    permalink: readString(raw.permalink),
    organizationSlug: input.organizationSlug,
    projectSlug,
    shortId,
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
        collisionScope: input.collisionScope,
        entryId,
      }),
      title: title.value.length === 0 ? entryId : title.value,
      scopeLabel: scopeLabel.value.length === 0 ? input.configured.organizationId : scopeLabel.value,
      ...(projectId !== null && isSentryNumericId(projectId)
        && encoder.encode(projectId).byteLength <= MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1
        ? { projectId } : {}),
      ...(designation === null || designation.value.length === 0 ? {} : { designation: designation.value }),
      state: mapSentryIssueState(raw.status, raw.substatus),
      locator,
      facts: Object.freeze(facts),
      sourceUpdatedAtMs: lastSeenMs,
      projectionTruncated: truncated,
    }),
  });
}
