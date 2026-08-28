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
 *
 * Every retained provider string is read through `projectField`, which is what makes the
 * annotation rule cover the whole event rather than a corner of it. `_meta` consultation,
 * the redaction record and the `sensitivePaths` entry are produced by the one call that
 * produced the value, so a field cannot be added to the projection while being forgotten
 * by the disclosure — the exact way the exception message, the stack frames, the
 * breadcrumbs and the top-level strings once rendered a provider-scrubbed value in full
 * while tags and user honoured the same annotations.
 */

import {
  projectTriageDisplayTextV1,
  type TriageBoundedTextV1,
} from '@happier-dev/triage-protocol/v1';

import {
  SENTRY_DETAIL_BOUNDS_V1,
  type SentryDetailBoundsV1,
} from '../detail/detailProjection.js';
import {
  isSentryAllowedTagKey,
  isSentrySensitiveTagKey,
  type SentryTagKeyV1,
} from './sentryTagAllowList.js';

export type { SentryTagKeyV1 };

/** The published bounds one event projection is measured against. */
export type SentryEventBoundsV1 = SentryDetailBoundsV1;

/**
 * The ceilings a published event projection uses.
 *
 * Event strings use the shared detail/Triage semantic bounds. This is a direct
 * alias, not a second bounds ledger. Collection cardinality is decided only by
 * the canonical encoded Action response boundary after the complete projection
 * is assembled.
 */
export const SENTRY_EVENT_BOUNDS_V1: SentryEventBoundsV1 = SENTRY_DETAIL_BOUNDS_V1;

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
    redactions: number;
    sensitivePaths: number;
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
  /**
   * The provider's annotation root, carried here because every recorded decision
   * needs it: a `providerScrubbed` record cannot be produced without consulting the
   * same `_meta` the value was read against.
   */
  meta: unknown;
  redactions: SentryRedactionV1[];
  sensitivePaths: string[];
  truncated: boolean;
  omitted: {
    sections: number;
    frames: number;
    breadcrumbs: number;
    tags: number;
    redactions: number;
    sensitivePaths: number;
  };
};

/**
 * The segments of one value's path in the raw event body — and of its `_meta` mirror.
 *
 * They are the same walk, which is the point: the dotted path a redaction publishes and
 * the path the annotation parser follows are built from one array, so a disclosure can
 * never name a path the parser did not actually ask about.
 */
type SentryPathV1 = readonly (string | number)[];

function formatPath(segments: SentryPathV1): string {
  let formatted = '';
  for (const segment of segments) {
    if (typeof segment === 'number') formatted += `[${String(segment)}]`;
    else formatted += formatted === '' ? segment : `.${segment}`;
  }
  return formatted;
}

function record(ledger: Ledger, path: string, reason: SentryRedactionReasonV1): void {
  ledger.redactions.push(Object.freeze({ path, reason }));
}

function markSensitive(ledger: Ledger, path: string): void {
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
function isProviderScrubbed(meta: unknown, segments: SentryPathV1): boolean {
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

/**
 * One allow-listed provider string becomes one bounded, disclosed display value.
 *
 * This is the only way a provider string enters the projection. It exists so the three
 * decisions that must agree about a field — did `_meta` say it was already scrubbed,
 * what does the redaction publish as its path, and does the surviving value belong in
 * `sensitivePaths` — are made once, at the point the value is read.
 *
 * `sensitiveAs` is passed rather than derived because a repeated field discloses its
 * *field*, not its element: forty frames of one stack carry one kind of sensitive
 * content, and repeating that path forty times would dilute the Tier-C user paths the
 * disclosure exists to name.
 *
 * `metaAlias` is a second `_meta` mirror consulted for the same value. `_meta` is
 * `additionalProperties:{}` `[SCHEMA]` and the nesting it uses under `entries` is
 * `[UNKNOWN]`, so where two shapes are both plausible this asks about both: an
 * annotation on either is a scrub, because §8.2's rule is that unknown provider
 * structure is never evidence a value is safe.
 */
function projectField(input: Readonly<{
  raw: unknown;
  path: SentryPathV1;
  metaAlias?: SentryPathV1;
  maxUtf8Bytes: number;
  sensitiveAs?: string;
  ledger: Ledger;
}>): string | null {
  const { ledger } = input;
  if (
    isProviderScrubbed(ledger.meta, input.path)
    || (input.metaAlias !== undefined && isProviderScrubbed(ledger.meta, input.metaAlias))
  ) {
    record(ledger, formatPath(input.path), 'providerScrubbed');
    return null;
  }
  const value = boundedOrNull(input.raw, input.maxUtf8Bytes, ledger);
  if (value !== null && input.sensitiveAs !== undefined) markSensitive(ledger, input.sensitiveAs);
  return value;
}

/* ------------------------------------------------------------------- frames */

/**
 * Where one frame collection lives, in the provider's body and in its annotations.
 *
 * Both are carried because they can differ: the redaction path names the shape §8.3
 * publishes, while `metaAlias` covers the second nesting Sentry can mirror the same
 * frames under.
 */
type SentryFramesLocationV1 = Readonly<{
  path: SentryPathV1;
  metaAlias: SentryPathV1 | null;
}>;

/**
 * `[SCHEMA]` a frame's `context` is a list of `[lineNo, source]` pairs. The one the
 * reader means by "the line" is the pair whose number is the frame's own.
 */
function readContextLineValue(raw: unknown, lineNo: number | null): unknown {
  if (!Array.isArray(raw)) return null;
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    if (readInteger(pair[0]) !== lineNo) continue;
    return pair[1];
  }
  return null;
}

function projectFrame(
  raw: unknown,
  index: number,
  frames: SentryFramesLocationV1,
  ledger: Ledger,
): SentryFrameV1 | null {
  if (!isRecord(raw)) return null;
  const lineNo = readInteger(raw['lineNo']);
  const sensitiveStem = `${formatPath(frames.path)}[]`;
  const field = (
    value: unknown,
    name: string,
    maxUtf8Bytes: number,
  ): string | null => projectField({
    raw: value,
    path: [...frames.path, index, name],
    ...(frames.metaAlias === null
      ? {}
      : { metaAlias: [...frames.metaAlias, index, name] }),
    maxUtf8Bytes,
    sensitiveAs: `${sensitiveStem}.${name}`,
    ledger,
  });
  // Local variables are the highest density of unclassifiable secrets in the whole
  // payload, and no triage decision in this product's core loop needs them. A frame
  // that carried none has nothing to withhold, so it records nothing.
  if (raw['vars'] !== undefined && raw['vars'] !== null) {
    record(ledger, formatPath([...frames.path, index, 'vars']), 'pluginWithheld');
  }
  return Object.freeze({
    filename: field(raw['filename'], 'filename', SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes),
    function: field(raw['function'], 'function', SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes),
    lineNo,
    colNo: readInteger(raw['colNo']),
    inApp: raw['inApp'] === true,
    // The context line's own annotation mirrors the `context` field it was read from;
    // the disclosure names it `contextLine`, which is what the reader sees.
    contextLine: projectField({
      raw: readContextLineValue(raw['context'], lineNo),
      path: [...frames.path, index, 'context'],
      ...(frames.metaAlias === null
        ? {}
        : { metaAlias: [...frames.metaAlias, index, 'context'] }),
      maxUtf8Bytes: SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes,
      sensitiveAs: `${sensitiveStem}.contextLine`,
      ledger,
    }),
    vars: Object.freeze({}),
  });
}

/**
 * One allow-listed frame collection. The Action owner later fits the complete
 * encoded projection, so this privacy owner does not invent a frame count.
 */
function projectFrames(
  raw: unknown,
  frames: SentryFramesLocationV1,
  ledger: Ledger,
): readonly SentryFrameV1[] {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const parsed: SentryFrameV1[] = [];
  for (const [index, candidate] of raw.entries()) {
    const frame = projectFrame(candidate, index, frames, ledger);
    if (frame !== null) parsed.push(frame);
  }
  return Object.freeze(parsed);
}

/* ----------------------------------------------------------------- sections */

function projectBreadcrumbs(
  raw: unknown,
  valuesPath: SentryPathV1,
  ledger: Ledger,
): readonly SentryBreadcrumbV1[] {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const parsed: SentryBreadcrumbV1[] = [];
  const sensitiveStem = `${formatPath(valuesPath)}[]`;
  for (const [index, candidate] of raw.entries()) {
    if (!isRecord(candidate)) continue;
    // A breadcrumb's own payload bag is the request/response content §8.1 withholds;
    // only the four stated scalars survive.
    if (candidate['data'] !== undefined && candidate['data'] !== null) {
      record(ledger, formatPath([...valuesPath, index, 'data']), 'pluginWithheld');
    }
    const field = (
      name: string,
      maxUtf8Bytes: number,
      sensitive: boolean,
    ): string | null => projectField({
      raw: candidate[name],
      path: [...valuesPath, index, name],
      maxUtf8Bytes,
      ...(sensitive ? { sensitiveAs: `${sensitiveStem}.${name}` } : {}),
      ledger,
    });
    parsed.push(Object.freeze({
      timestampMs: readTimestampMs(candidate['timestamp']),
      // A breadcrumb category is free-form provider text; its level is a fixed
      // vocabulary, and naming that in the disclosure would only dilute it.
      category: field('category', SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, true),
      level: field('level', SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, false),
      message: field('message', SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, true),
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
  entryPath: SentryPathV1,
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
        const valuePath: SentryPathV1 = [...entryPath, 'data', 'values', index, 'value'];
        const nestedFrames: SentryPathV1 = [
          ...entryPath, 'data', 'values', index, 'stacktrace', 'frames',
        ];
        // The redaction path names the provider's own shape, and Sentry nests the
        // frames of the `i`th exception under the entry's `data.frames` in the
        // single-value case its `_meta` mirrors.
        const single = values.length === 1;
        sections.push(Object.freeze({
          kind: 'exception' as const,
          // The exception type is the first half of the Tier-A `title` this projection
          // already carries, so it is not separately disclosed; the full `value` is
          // not — `title` truncates it — and is.
          type: projectField({
            raw: candidate['type'],
            path: [...entryPath, 'data', 'values', index, 'type'],
            maxUtf8Bytes: SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes,
            ledger,
          }) ?? '',
          value: projectField({
            raw: candidate['value'],
            path: valuePath,
            maxUtf8Bytes: SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes,
            sensitiveAs: formatPath(valuePath),
            ledger,
          }) ?? '',
          frames: projectFrames(
            stacktrace === null ? null : stacktrace['frames'],
            Object.freeze({
              path: single ? [...entryPath, 'data', 'frames'] : nestedFrames,
              metaAlias: single ? nestedFrames : null,
            }),
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
          Object.freeze({ path: [...entryPath, 'data', 'frames'], metaAlias: null }),
          ledger,
        ),
      })]);
    case 'breadcrumbs':
      return Object.freeze([Object.freeze({
        kind: 'breadcrumbs' as const,
        entries: projectBreadcrumbs(
          data === null ? null : data['values'],
          [...entryPath, 'data', 'values'],
          ledger,
        ),
      })]);
    case 'message': {
      // This `formatted` is the message interface's own rendered text, built by the
      // projection. It is not the API's top-level `formatted` (§8.5) and is not derived
      // from it.
      const messageText = (name: string): string | null => {
        const path: SentryPathV1 = [...entryPath, 'data', name];
        return projectField({
          raw: data === null ? null : data[name],
          path,
          maxUtf8Bytes: SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes,
          sensitiveAs: formatPath(path),
          ledger,
        });
      };
      const formatted = data === null
        ? null
        : messageText('formatted') ?? messageText('message');
      return formatted === null
        ? Object.freeze([])
        : Object.freeze([Object.freeze({ kind: 'message' as const, formatted })]);
    }
    default:
      return Object.freeze([Object.freeze({
        kind: 'unsupported' as const,
        entryType: bounded(entryType, SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, ledger).value,
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
    for (const section of projectSection(candidate, ['entries', index], ledger)) {
      sections.push(section);
    }
  }
  return Object.freeze(sections);
}

/* --------------------------------------------------------------- tags, user */

function projectTags(
  raw: unknown,
  ledger: Ledger,
): readonly SentryEventTagProjectionV1[] {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const tags: SentryEventTagProjectionV1[] = [];
  for (const [index, candidate] of raw.entries()) {
    if (!isRecord(candidate)) continue;
    const key = readString(candidate['key']);
    // A key nobody classified carries a value nobody classified. The withheld tag is
    // named so a reader is told the event had more, rather than shown a subset that
    // looks like the whole set.
    if (key === null || !isSentryAllowedTagKey(key)) {
      record(ledger, formatPath(['tags', index]), 'pluginWithheld');
      continue;
    }
    const value = projectField({
      raw: candidate['value'],
      path: ['tags', index, 'value'],
      maxUtf8Bytes: SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes,
      ledger,
    });
    if (value === null) continue;
    // A tag discloses its key, not its index: the same key repeated is one fact about
    // what this projection carries, and it is only claimed for a tag that survived.
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
  ledger: Ledger,
): SentryEventUserProjectionV1 | null {
  if (!isRecord(raw)) return null;
  for (const field of WITHHELD_USER_FIELDS) {
    if (raw[field] !== undefined && raw[field] !== null) {
      record(ledger, formatPath(['user', field]), 'pluginWithheld');
    }
  }
  const projected: Record<string, string | null> = {};
  for (const [name, rawName, maxUtf8Bytes] of USER_FIELDS) {
    // The redaction and the disclosure both name the projection's own field, while the
    // annotation is looked up under the provider's raw key.
    const projectedPath = formatPath(['user', name]);
    if (isProviderScrubbed(ledger.meta, ['user', rawName])) {
      record(ledger, projectedPath, 'providerScrubbed');
      projected[name] = null;
      continue;
    }
    const value = boundedOrNull(raw[rawName], maxUtf8Bytes, ledger);
    projected[name] = value;
    if (value !== null) markSensitive(ledger, projectedPath);
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

/**
 * The one path by which a Sentry event body becomes renderable, and the one place that
 * decides whether a body IS an event.
 *
 * `null` means unreadable, and the caller settles it as a refused read. It replaces an
 * empty projection, which was indistinguishable from an occurrence Sentry genuinely
 * recorded as empty and was published as a successful read: the reader saw a blank
 * Stack Trace where a stated failure belonged. A throw is still wrong for the reason it
 * always was — an unfamiliar body is not an outage — so the answer is a value, not an
 * exception.
 *
 * A body carrying no usable event id is unreadable for the same reason rather than by a
 * second rule. `projectSentryEventRows` already omits a list row without one, and
 * §8.4a's exact-dispatch reread addresses by that id, so a projection whose id is empty
 * names no occurrence anything could return to.
 */
export function projectSentryEventForDisplay(
  rawEventBody: unknown,
): SentryEventProjectionV1 | null {
  if (!isRecord(rawEventBody)) return null;
  const body = rawEventBody;
  const ledger: Ledger = {
    meta: body['_meta'],
    redactions: [],
    sensitivePaths: [],
    truncated: false,
    omitted: {
      sections: 0,
      frames: 0,
      breadcrumbs: 0,
      tags: 0,
      redactions: 0,
      sensitivePaths: 0,
    },
  };

  for (const key of WITHHELD_TOP_LEVEL) {
    if (body[key] !== undefined && body[key] !== null) record(ledger, key, 'pluginWithheld');
  }

  // The event id is addressing, not content: it is what §8.4a's exact dispatch reread
  // proves it is rereading the same event, and a provider does not scrub the key it
  // hands the value back under. It is read plainly, and it is not disclosed as
  // sensitive for the same reason.
  const eventId = boundedOrNull(
    body['eventID'] ?? body['id'],
    SENTRY_EVENT_BOUNDS_V1.identifierUtf8Bytes,
    ledger,
  );
  if (eventId === null || eventId.trim() === '') return null;
  const topLevel = (
    name: string,
    maxUtf8Bytes: number,
    sensitive: boolean,
  ): string | null => projectField({
    raw: body[name],
    path: [name],
    maxUtf8Bytes,
    ...(sensitive ? { sensitiveAs: name } : {}),
    ledger,
  });

  // `title` and `culprit` are the Tier-A list row (§8.1): this projection is not where
  // they first become visible, so naming them again in the disclosure would describe the
  // row rather than the evidence. `message` and `location` are not on that row.
  const title = topLevel('title', SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, false);
  const message = topLevel('message', SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, true);
  const sections = projectSections(body['entries'], ledger);
  const tags = projectTags(body['tags'], ledger);
  const user = projectUser(body['user'], ledger);

  return Object.freeze({
    eventId,
    dateCreatedMs: readTimestampMs(body['dateCreated']),
    title: title ?? message ?? '',
    message: message ?? '',
    location: topLevel('location', SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, true),
    culprit: topLevel('culprit', SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, false),
    platform: topLevel('platform', SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, false),
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
