/**
 * The one Sentry tag-key allow-list (`SENTRY.md` §7.3a, §8.3).
 *
 * A Sentry tag key space is open: anything the customer's SDK sets becomes a tag,
 * and the values ride along on every event body. An event tag is therefore a value
 * on a key nobody classified — exactly the kind of unclassifiable secret
 * (`auth_token`, `session`, a raw request id) that §8.1 calls this source's largest
 * PII surface.
 *
 * So this module names the keys Sentry itself documents and promotes, and it
 * governs the *event* projection and only that. A tag whose key is not one of them
 * is withheld from the event projection and recorded as a redaction, which keeps
 * the disclosure in §8.4 enumerable: a reader is told the event carried tags this
 * build does not publish, rather than being shown a bounded subset that looks
 * complete.
 *
 * The issue tag distribution is deliberately not filtered through this list, and
 * the reason is not that it renders only the key the customer chose to index by —
 * it renders the VALUE, in each row's subtitle and again in the drill-down, gated
 * only by `isSentryRoutableTagKey`, which is a path-segment safety test rather than
 * a classification. Every customer-defined key reaches the reader there. That is
 * the product decision (§7.3a): applying this list to that plane would delete the
 * custom-tag distribution teams triage by, and removing a user-facing capability is
 * not an acceptable way to satisfy a document. What makes those unclassified values
 * honest is the disclosure the plane itself carries (`ui/renderSurface.tsx`), not a
 * second use of this list.
 *
 * `[SOURCE]` Sentry's own promoted/default tag set, as it appears on an event's
 * `tags` collection. Keys are compared verbatim, including the `sentry:` prefix
 * Sentry uses for its own reserved keys.
 *
 * The list is deliberately not configurable. A per-deployment allow-list would be
 * a second decision-maker for what may leave this source, and the one thing that
 * must not vary by deployment is which values are safe to render.
 */

const SENTRY_ALLOWED_TAG_KEYS = Object.freeze([
  'app.device',
  'browser',
  'browser.name',
  'client_os',
  'client_os.name',
  'device',
  'device.family',
  'dist',
  'environment',
  'gpu',
  'gpu.name',
  'handled',
  'level',
  'logger',
  'main_thread',
  'mechanism',
  'os',
  'os.name',
  'os.rooted',
  'platform',
  'release',
  'runtime',
  'runtime.name',
  'sdk',
  'sdk.name',
  'sentry:dist',
  'sentry:release',
  'sentry:user',
  'server_name',
  'trace',
  'transaction',
  'unreal.crash_type',
  'url',
  'user',
] as const);

/** The exact key type the event projection may carry. */
export type SentryTagKeyV1 = (typeof SENTRY_ALLOWED_TAG_KEYS)[number];

const ALLOWED: ReadonlySet<string> = new Set<string>(SENTRY_ALLOWED_TAG_KEYS);

/**
 * `true` when this key may appear in an event projection.
 *
 * The narrowing is what makes the caller's output type honest: a projected tag's
 * key is one of the names above, never provider-controlled text.
 */
export function isSentryAllowedTagKey(key: string): key is SentryTagKeyV1 {
  return ALLOWED.has(key);
}

/**
 * The keys whose *values* are personal or environmental identity rather than
 * build metadata.
 *
 * They are still projected — a triage reader needs to know which user or URL an
 * error happened to — but each present one is recorded in `sensitivePaths`, so a
 * disclosure names the real paths it is about to hand over instead of guessing
 * from a boolean (`SENTRY.md` §8.4).
 */
const SENTRY_SENSITIVE_TAG_KEYS: ReadonlySet<string> = new Set<string>([
  'client_os',
  'device',
  'sentry:user',
  'server_name',
  'trace',
  'url',
  'user',
]);

export function isSentrySensitiveTagKey(key: SentryTagKeyV1): boolean {
  return SENTRY_SENSITIVE_TAG_KEYS.has(key);
}
