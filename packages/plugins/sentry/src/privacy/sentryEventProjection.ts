/**
 * The Sentry event boundary projector — the redaction owner (`SENTRY.md` §8.3).
 *
 * An event body is the single largest PII surface this product can touch. `[SCHEMA]`
 * `entries` is `{"type":"array","items":{}}` and `contexts` is
 * `{"type":"object","additionalProperties":{}}` — completely untyped — and that is
 * where the stack trace, the breadcrumbs, the request interface and the frame locals
 * live. Tokens, session cookies, request bodies and local variable values all appear
 * there, on a shape no schema constrains.
 *
 * So this module is an **allow-list by construction**, not a redaction pass. It builds
 * its output from the fields named in the exported types below and passes no
 * unrecognized key through. That is what makes §8.5's rule enforceable rather than
 * aspirational: a `formatted` prose rendering, however it arrived, is dropped and
 * recorded rather than reaching a renderer as unclassified text — because a prose
 * rendering has no dotted paths, and every value withheld here can reappear inside it.
 *
 * There is one projector, no "raw JSON" escape hatch in the UI, and no renderer that
 * reads an API body directly. What a panel can render is exactly what this function
 * returned, which is why the disclosure in §8.4 can name real paths instead of guessing
 * from a boolean: `redactions` says what was withheld or already scrubbed, and
 * `sensitivePaths` says what sensitive data the projection still carries.
 *
 * The `_meta` parser is private and bounded by the closed output paths above, never by
 * provider-controlled annotation depth. An absent annotation on an allow-listed path is
 * only "no provider annotation observed" — it is never a clean-data claim.
 */

import {
  projectTriageDisplayTextV1,
  type TriageBoundedTextV1,
} from '@happier-dev/triage-protocol/v1';

import { SENTRY_DETAIL_BOUNDS_V1 } from '../detail/detailProjection.js';
import {
  isSentryAllowedTagKey,
  isSentrySensitiveTagKey,
  type SentryTagKeyV1,
} from './sentryTagAllowList.js';

export type { SentryTagKeyV1 };

/** The published bounds one event projection is measured against. */
export type SentryEventBoundsV1 = Readonly<{
  identifierUtf8Bytes: number;
  labelUtf8Bytes: number;
  textUtf8Bytes: number;
  locationUtf8Bytes: number;
  maxSections: number;
  maxFramesPerSection: number;
  maxBreadcrumbs: number;
  maxTags: number;
  maxRedactions: number;
  maxSensitivePaths: number;
}>;

/**
 * The ceilings a published event projection uses.
 *
 * They are derived from the one hard constraint that exists — the Action aggregate
 * rejects a result over one mebibyte outright, and a rejected result shows the reader
 * nothing at all — rather than from a guess about how deep a real stack is.
 * `sentryEventProjection.test.ts` saturates every one of them at once and measures the
 * encoded projection against that gate. The string bounds are the detail projector's,
 * because a Sentry exception message is exactly as much a display string as a title.
 */
export const SENTRY_EVENT_BOUNDS_V1: SentryEventBoundsV1 = Object.freeze({
  identifierUtf8Bytes: SENTRY_DETAIL_BOUNDS_V1.identifierUtf8Bytes,
  labelUtf8Bytes: SENTRY_DETAIL_BOUNDS_V1.labelUtf8Bytes,
  textUtf8Bytes: SENTRY_DETAIL_BOUNDS_V1.textUtf8Bytes,
  /** A file path is longer than a label and shorter than a message. */
  locationUtf8Bytes: 384,
  maxSections: 6,
  maxFramesPerSection: 40,
  maxBreadcrumbs: 32,
  maxTags: 24,
  maxRedactions: 384,
  maxSensitivePaths: 128,
});

export type SentryRedactionReasonV1 = 'providerScrubbed' | 'pluginWithheld';

export type SentryRedactionV1 = Readonly<{
  /** Dotted path within the raw event body. */
  path: string;
  reason: SentryRedactionReasonV1;
}>;

export type SentryFrameV1 = Readonly<{
  filename: string | null;
  function: string | null;
  lineNo: number | null;
  colNo: number | null;
  inApp: boolean;
  contextLine: string | null;
  /** Always empty in v1: frame locals are Tier C and are withheld. */
  vars: Readonly<Record<string, never>>;
}>;

export type SentryBreadcrumbV1 = Readonly<{
  timestampMs: number | null;
  category: string | null;
  level: string | null;
  message: string | null;
}>;

export type SentryEventSectionV1 =
  | Readonly<{ kind: 'exception'; type: string; value: string; frames: readonly SentryFrameV1[] }>
  | Readonly<{ kind: 'stacktrace'; frames: readonly SentryFrameV1[] }>
  | Readonly<{ kind: 'breadcrumbs'; entries: readonly SentryBreadcrumbV1[] }>
  | Readonly<{ kind: 'message'; formatted: string }>
  | Readonly<{ kind: 'unsupported'; entryType: string }>;

/**
 * One admitted event tag.
 *
 * `key` is typed as a plain string even though only `sentryTagAllowList` keys can ever
 * appear here, and deliberately so: this exact shape crosses the Action boundary and
 * comes back parsed, and a narrower in-process type than the wire type would force a
 * re-narrowing on the far side — a second place deciding which keys are admissible. The
 * allow-list stays the one classifier, at the one point where a key is admitted.
 */
export type SentryEventTagProjectionV1 = Readonly<{
  key: string;
  value: string;
}>;

export type SentryEventUserProjectionV1 = Readonly<{
  id: string | null;
  email: string | null;
  username: string | null;
  ipAddress: string | null;
  name: string | null;
}>;

export type SentryEventProjectionV1 = Readonly<{
  eventId: string;
  dateCreatedMs: number | null;
  title: string;
  message: string;
  location: string | null;
  culprit: string | null;
  platform: string | null;
  sections: readonly SentryEventSectionV1[];
  tags: readonly SentryEventTagProjectionV1[];
  user: SentryEventUserProjectionV1 | null;
  /** Every path this projection withheld or that `_meta` reported as scrubbed. */
  redactions: readonly SentryRedactionV1[];
  /** Paths whose values are present in this projection and are classified Tier B or C. */
  sensitivePaths: readonly string[];
  /** True when a valid provider string or collection was shortened or count-bounded. */
  projectionTruncated: boolean;
  /** Allow-listed items omitted only by a semantic collection bound. */
  omitted: Readonly<{
    sections: number;
    frames: number;
    breadcrumbs: number;
    tags: number;
  }>;
}>;

/* ------------------------------------------------------------------ primitives */

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function readTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // `[SCHEMA]` a breadcrumb timestamp may be epoch seconds rather than a string.
    return Math.trunc(value * 1_000);
  }
  const raw = readString(value);
  if (raw === null) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The collector every projected value passes through.
 *
 * It exists so the four outputs that describe a projection — its redactions, its
 * sensitive paths, its truncation flag and its omission counts — are produced by the
 * same walk that produces the values, rather than by a second pass that could disagree
 * with it.
 */
type Ledger = {
  redactions: SentryRedactionV1[];
  sensitivePaths: string[];
  truncated: boolean;
  omitted: { sections: number; frames: number; breadcrumbs: number; tags: number };
};

function record(ledger: Ledger, path: string, reason: SentryRedactionReasonV1): void {
  if (ledger.redactions.length >= SENTRY_EVENT_BOUNDS_V1.maxRedactions) return;
  ledger.redactions.push(Object.freeze({ path, reason }));
}

function markSensitive(ledger: Ledger, path: string): void {
  if (ledger.sensitivePaths.length >= SENTRY_EVENT_BOUNDS_V1.maxSensitivePaths) return;
  if (!ledger.sensitivePaths.includes(path)) ledger.sensitivePaths.push(path);
}

/**
 * Provider text becomes one bounded, single-line display value.
 *
 * The normalize-then-bound rule belongs to `@happier-dev/triage-protocol`. A Sentry
 * exception message routinely carries a newline, and restating the rule here would be a
 * second decision-maker for the shape every strict target admits.
 */
function bounded(value: string, maxUtf8Bytes: number, ledger: Ledger): TriageBoundedTextV1 {
  const projected = projectTriageDisplayTextV1(value, maxUtf8Bytes);
  if (projected.truncated) ledger.truncated = true;
  return projected;
}

function boundedOrNull(
  value: unknown,
  maxUtf8Bytes: number,
  ledger: Ledger,
): string | null {
  const raw = readString(value);
  if (raw === null) return null;
  const projected = bounded(raw, maxUtf8Bytes, ledger);
  return projected.value === '' ? null : projected.value;
}

/* ----------------------------------------------------------------- `_meta` */

/**
 * Whether the provider already scrubbed the value at one exact allow-listed path.
 *
 * Sentry stores annotations recursively beside the event shape and puts a path's leaf
 * annotation under the empty key. `[SOURCE]` `static/app/components/events/meta/…`: the
 * leaf carries `rem`, `err` and `chunks`, whose `type: 'redaction'` entries identify the
 * scrubbed chunks.
 *
 * Recursion is bounded by the caller's closed path segments, never by the provider's
 * annotation depth, and nothing is returned but the decision: the raw node, its chunk
 * text, its rule id and its provider reason are never read out, rendered, logged or
 * persisted. V1 does not promise to reproduce Sentry's own rule text.
 *
 * A node that exists but is malformed, or uses an annotation shape this parser does not
 * recognize, is conservatively a scrub. Unknown provider structure is never evidence
 * that a value is safe.
 */
function isProviderScrubbed(meta: unknown, segments: readonly (string | number)[]): boolean {
  let node: unknown = meta;
  for (const segment of segments) {
    if (node === undefined || node === null) return false;
    if (!isRecord(node)) return true;
    node = node[typeof segment === 'number' ? String(segment) : segment];
  }
  if (node === undefined || node === null) return false;
  if (!isRecord(node)) return true;
  const leaf = node[''];
  if (leaf === undefined || leaf === null) return false;
  if (!isRecord(leaf)) return true;

  const { rem, err, chunks } = leaf;
  if (rem !== undefined) return Array.isArray(rem) ? rem.length > 0 : true;
  if (err !== undefined) return Array.isArray(err) ? err.length > 0 : true;
  if (chunks !== undefined) {
    if (!Array.isArray(chunks)) return true;
    return chunks.some((chunk) => !isRecord(chunk) || chunk['type'] === 'redaction');
  }
  // A leaf with none of the three recognized keys is an annotation shape this build
  // does not understand, and an unrecognized annotation is not a clean-data claim.
  return true;
}

/* ------------------------------------------------------------------- frames */

/**
 * `[SCHEMA]` a frame's `context` is a list of `[lineNo, source]` pairs. The one the
 * reader means by "the line" is the pair whose number is the frame's own.
 */
function readContextLine(
  raw: unknown,
  lineNo: number | null,
  ledger: Ledger,
): string | null {
  if (!Array.isArray(raw)) return null;
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    if (readInteger(pair[0]) !== lineNo) continue;
    return boundedOrNull(pair[1], SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, ledger);
  }
  return null;
}

function projectFrame(
  raw: unknown,
  framePath: string,
  ledger: Ledger,
): SentryFrameV1 | null {
  if (!isRecord(raw)) return null;
  const lineNo = readInteger(raw['lineNo']);
  // Local variables are the highest density of unclassifiable secrets in the whole
  // payload, and no triage decision in this product's core loop needs them. A frame
  // that carried none has nothing to withhold, so it records nothing.
  if (raw['vars'] !== undefined && raw['vars'] !== null) {
    record(ledger, `${framePath}.vars`, 'pluginWithheld');
  }
  return Object.freeze({
    filename: boundedOrNull(raw['filename'], SENTRY_EVENT_BOUNDS_V1.locationUtf8Bytes, ledger),
    function: boundedOrNull(raw['function'], SENTRY_EVENT_BOUNDS_V1.labelUtf8Bytes, ledger),
    lineNo,
    colNo: readInteger(raw['colNo']),
    inApp: raw['inApp'] === true,
    contextLine: readContextLine(raw['context'], lineNo, ledger),
    vars: Object.freeze({}),
  });
}

/**
 * One bounded frame collection.
 *
 * Sentry returns a stack oldest-first, so the crash site is the **last** frame. A stack
 * past the ceiling therefore keeps its tail: dropping it would remove the only frame
 * most readers opened the trace for, while dropping leading frames costs the callers
 * furthest from the failure. The dropped count is reported either way, and the raw index
 * is what a redaction path names, so a `vars` path still addresses the provider's body.
 */
function projectFrames(
  raw: unknown,
  framesPath: string,
  ledger: Ledger,
): readonly SentryFrameV1[] {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const parsed: SentryFrameV1[] = [];
  const start = Math.max(0, raw.length - SENTRY_EVENT_BOUNDS_V1.maxFramesPerSection);
  for (const [index, candidate] of raw.entries()) {
    if (index < start) {
      ledger.omitted.frames += 1;
      ledger.truncated = true;
      continue;
    }
    const frame = projectFrame(candidate, `${framesPath}[${String(index)}]`, ledger);
    if (frame !== null) parsed.push(frame);
  }
  return Object.freeze(parsed);
}

/* ----------------------------------------------------------------- sections */

function projectBreadcrumbs(
  raw: unknown,
  valuesPath: string,
  ledger: Ledger,
): readonly SentryBreadcrumbV1[] {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const parsed: SentryBreadcrumbV1[] = [];
  for (const [index, candidate] of raw.entries()) {
    if (!isRecord(candidate)) continue;
    if (parsed.length >= SENTRY_EVENT_BOUNDS_V1.maxBreadcrumbs) {
      ledger.omitted.breadcrumbs += 1;
      ledger.truncated = true;
      continue;
    }
    // A breadcrumb's own payload bag is the request/response content §8.1 withholds;
    // only the four stated scalars survive.
    if (candidate['data'] !== undefined && candidate['data'] !== null) {
      record(ledger, `${valuesPath}[${String(index)}].data`, 'pluginWithheld');
    }
    const message = boundedOrNull(
      candidate['message'],
      SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes,
      ledger,
    );
    if (message !== null) markSensitive(ledger, `${valuesPath}[${String(index)}].message`);
    parsed.push(Object.freeze({
      timestampMs: readTimestampMs(candidate['timestamp']),
      category: boundedOrNull(candidate['category'], SENTRY_EVENT_BOUNDS_V1.labelUtf8Bytes, ledger),
      level: boundedOrNull(candidate['level'], SENTRY_EVENT_BOUNDS_V1.labelUtf8Bytes, ledger),
      message,
    }));
  }
  return Object.freeze(parsed);
}

/**
 * One `entries` element, discriminated by its own `type`.
 *
 * An entry type this build does not project becomes `unsupported` rather than being
 * dropped silently or rendered raw: a reader is told the event carried a section this
 * build does not show, which is a different fact from the event not having one. There
 * is no schema contract to validate `entries` against, so every branch parses
 * defensively.
 */
function projectSection(
  raw: unknown,
  entryPath: string,
  ledger: Ledger,
): readonly SentryEventSectionV1[] {
  if (!isRecord(raw)) return Object.freeze([]);
  const entryType = readString(raw['type']);
  if (entryType === null) return Object.freeze([]);
  const data = isRecord(raw['data']) ? raw['data'] : null;

  switch (entryType) {
    case 'exception': {
      const values = data === null ? null : data['values'];
      if (!Array.isArray(values)) return Object.freeze([]);
      const sections: SentryEventSectionV1[] = [];
      for (const [index, candidate] of values.entries()) {
        if (!isRecord(candidate)) continue;
        const stacktrace = isRecord(candidate['stacktrace']) ? candidate['stacktrace'] : null;
        const value = boundedOrNull(
          candidate['value'],
          SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes,
          ledger,
        );
        sections.push(Object.freeze({
          kind: 'exception' as const,
          type: boundedOrNull(candidate['type'], SENTRY_EVENT_BOUNDS_V1.labelUtf8Bytes, ledger)
            ?? '',
          value: value ?? '',
          // The redaction path names the provider's own shape, and Sentry nests the
          // frames of the `i`th exception under the entry's `data.frames` in the
          // single-value case its `_meta` mirrors.
          frames: projectFrames(
            stacktrace === null ? null : stacktrace['frames'],
            values.length === 1
              ? `${entryPath}.data.frames`
              : `${entryPath}.data.values[${String(index)}].stacktrace.frames`,
            ledger,
          ),
        }));
      }
      return Object.freeze(sections);
    }
    case 'stacktrace':
      return Object.freeze([Object.freeze({
        kind: 'stacktrace' as const,
        frames: projectFrames(
          data === null ? null : data['frames'],
          `${entryPath}.data.frames`,
          ledger,
        ),
      })]);
    case 'breadcrumbs':
      return Object.freeze([Object.freeze({
        kind: 'breadcrumbs' as const,
        entries: projectBreadcrumbs(
          data === null ? null : data['values'],
          `${entryPath}.data.values`,
          ledger,
        ),
      })]);
    case 'message': {
      // This `formatted` is the message interface's own rendered text, built by the
      // projection. It is not the API's top-level `formatted` (§8.5) and is not derived
      // from it.
      const formatted = data === null
        ? null
        : boundedOrNull(data['formatted'], SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, ledger)
          ?? boundedOrNull(data['message'], SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, ledger);
      return formatted === null
        ? Object.freeze([])
        : Object.freeze([Object.freeze({ kind: 'message' as const, formatted })]);
    }
    default:
      return Object.freeze([Object.freeze({
        kind: 'unsupported' as const,
        entryType: bounded(entryType, SENTRY_EVENT_BOUNDS_V1.labelUtf8Bytes, ledger).value,
      })]);
  }
}

function projectSections(
  raw: unknown,
  ledger: Ledger,
): readonly SentryEventSectionV1[] {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const sections: SentryEventSectionV1[] = [];
  for (const [index, candidate] of raw.entries()) {
    for (const section of projectSection(candidate, `entries[${String(index)}]`, ledger)) {
      if (sections.length >= SENTRY_EVENT_BOUNDS_V1.maxSections) {
        ledger.omitted.sections += 1;
        ledger.truncated = true;
        continue;
      }
      sections.push(section);
    }
  }
  return Object.freeze(sections);
}

/* --------------------------------------------------------------- tags, user */

function projectTags(
  raw: unknown,
  meta: unknown,
  ledger: Ledger,
): readonly SentryEventTagProjectionV1[] {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const tags: SentryEventTagProjectionV1[] = [];
  for (const [index, candidate] of raw.entries()) {
    const path = `tags[${String(index)}]`;
    if (!isRecord(candidate)) continue;
    const key = readString(candidate['key']);
    // A key nobody classified carries a value nobody classified. The withheld tag is
    // named so a reader is told the event had more, rather than shown a subset that
    // looks like the whole set.
    if (key === null || !isSentryAllowedTagKey(key)) {
      record(ledger, path, 'pluginWithheld');
      continue;
    }
    if (isProviderScrubbed(meta, ['tags', index, 'value'])) {
      record(ledger, `${path}.value`, 'providerScrubbed');
      continue;
    }
    if (tags.length >= SENTRY_EVENT_BOUNDS_V1.maxTags) {
      ledger.omitted.tags += 1;
      ledger.truncated = true;
      continue;
    }
    const value = boundedOrNull(candidate['value'], SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, ledger);
    if (value === null) continue;
    if (isSentrySensitiveTagKey(key)) markSensitive(ledger, `tags.${key}`);
    tags.push(Object.freeze({ key, value }));
  }
  return Object.freeze(tags);
}

/** The five allow-listed user fields, and their raw names on the provider's object. */
const USER_FIELDS = Object.freeze([
  ['id', 'id', SENTRY_EVENT_BOUNDS_V1.identifierUtf8Bytes],
  ['email', 'email', SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes],
  ['username', 'username', SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes],
  ['ipAddress', 'ip_address', SENTRY_EVENT_BOUNDS_V1.identifierUtf8Bytes],
  ['name', 'name', SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes],
] as const);

/** Fields on the user object that are withheld outright rather than tiered. */
const WITHHELD_USER_FIELDS = Object.freeze(['geo', 'data'] as const);

function projectUser(
  raw: unknown,
  meta: unknown,
  ledger: Ledger,
): SentryEventUserProjectionV1 | null {
  if (!isRecord(raw)) return null;
  for (const field of WITHHELD_USER_FIELDS) {
    if (raw[field] !== undefined && raw[field] !== null) {
      record(ledger, `user.${field}`, 'pluginWithheld');
    }
  }
  const projected: Record<string, string | null> = {};
  for (const [name, rawName, maxUtf8Bytes] of USER_FIELDS) {
    if (isProviderScrubbed(meta, ['user', rawName])) {
      record(ledger, `user.${name}`, 'providerScrubbed');
      projected[name] = null;
      continue;
    }
    const value = boundedOrNull(raw[rawName], maxUtf8Bytes, ledger);
    projected[name] = value;
    if (value !== null) markSensitive(ledger, `user.${name}`);
  }
  return Object.freeze(projected) as SentryEventUserProjectionV1;
}

/* ---------------------------------------------------------------- projector */

/**
 * Top-level keys that carry event content this build never projects.
 *
 * Naming them is what keeps the disclosure enumerable: an unrecognized key is dropped by
 * construction, but a *known* unprojected surface is dropped **and reported**, so a
 * reader is not told the event carried nothing where it carried something withheld.
 */
const WITHHELD_TOP_LEVEL = Object.freeze([
  'contexts',
  'userReport',
  'formatted',
  'sdk',
  'packages',
  'context',
] as const);

const EMPTY_PROJECTION: SentryEventProjectionV1 = Object.freeze({
  eventId: '',
  dateCreatedMs: null,
  title: '',
  message: '',
  location: null,
  culprit: null,
  platform: null,
  sections: Object.freeze([]),
  tags: Object.freeze([]),
  user: null,
  redactions: Object.freeze([]),
  sensitivePaths: Object.freeze([]),
  projectionTruncated: false,
  omitted: Object.freeze({ sections: 0, frames: 0, breadcrumbs: 0, tags: 0 }),
});

/**
 * The one path by which a Sentry event body becomes renderable.
 *
 * A body this source cannot read at all is an empty projection rather than a throw: the
 * caller already distinguishes a failed read from a settled one, and turning an
 * unreadable body into an exception would make an unfamiliar shape look like an outage.
 */
export function projectSentryEventForDisplay(rawEventBody: unknown): SentryEventProjectionV1 {
  if (!isRecord(rawEventBody)) return EMPTY_PROJECTION;
  const body = rawEventBody;
  const ledger: Ledger = {
    redactions: [],
    sensitivePaths: [],
    truncated: false,
    omitted: { sections: 0, frames: 0, breadcrumbs: 0, tags: 0 },
  };

  for (const key of WITHHELD_TOP_LEVEL) {
    if (body[key] !== undefined && body[key] !== null) record(ledger, key, 'pluginWithheld');
  }

  const meta = body['_meta'];
  const eventId = boundedOrNull(
    body['eventID'] ?? body['id'],
    SENTRY_EVENT_BOUNDS_V1.identifierUtf8Bytes,
    ledger,
  );
  const title = boundedOrNull(body['title'], SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, ledger);
  const message = boundedOrNull(body['message'], SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, ledger);
  const sections = projectSections(body['entries'], ledger);
  const tags = projectTags(body['tags'], meta, ledger);
  const user = projectUser(body['user'], meta, ledger);

  return Object.freeze({
    eventId: eventId ?? '',
    dateCreatedMs: readTimestampMs(body['dateCreated']),
    title: title ?? message ?? '',
    message: message ?? '',
    location: boundedOrNull(body['location'], SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, ledger),
    culprit: boundedOrNull(body['culprit'], SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, ledger),
    platform: boundedOrNull(body['platform'], SENTRY_EVENT_BOUNDS_V1.labelUtf8Bytes, ledger),
    sections,
    tags,
    user,
    redactions: Object.freeze(ledger.redactions),
    sensitivePaths: Object.freeze(ledger.sensitivePaths),
    projectionTruncated: ledger.truncated,
    omitted: Object.freeze({ ...ledger.omitted }),
  });
}

/** True when a projection carries a trace worth giving its own surface (`§7.4a`). */
export function sentryProjectionHasTrace(projection: SentryEventProjectionV1): boolean {
  return projection.sections.some(
    (section) => section.kind === 'exception' || section.kind === 'stacktrace',
  );
}
