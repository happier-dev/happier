import { trimUtf8TextHeadToMaxBytes, trimUtf8TextToMaxBytes } from './utf8.js';
import { redactPublicShareCapabilityUrl } from '../../crypto/publicShareCapabilityUrl.js';
import {
  isBaseCredentialDiagnosticKey,
  splitSensitiveDiagnosticKeySegments,
} from '../../common/sensitiveKeys.js';
import {
  ACCOUNT_API_TOKEN_BEARER_V1_SOURCE,
  ACCOUNT_API_TOKEN_CREDENTIAL_V1_PREFIX,
} from '../../auth/accountApiTokenFormatV1.js';

// A provider transcript carries a tool result JSON-escaped, so a secret, or the
// label naming one, that starts a line follows the literal `\n`, `\t` or `\r`,
// whose letter denies `\b`. This is the one start-of-secret boundary every
// prefix and label rule below uses; it also admits a preceding escape.
const SECRET_TEXT_BOUNDARY = String.raw`(?:\b|(?<=\\[nrt]))`;
function secretTextPattern(source: string, flags: string): RegExp {
  return new RegExp(`${SECRET_TEXT_BOUNDARY}${source}`, flags);
}
// The same boundary for a scanner that finds its candidate by hand.
const SECRET_TEXT_START = new RegExp(SECRET_TEXT_BOUNDARY, 'y');
function startsSecretText(text: string, index: number): boolean {
  SECRET_TEXT_START.lastIndex = index;
  return SECRET_TEXT_START.test(text);
}

// Happier's own Account API tokens have a fixed minted shape, so like the vendor
// prefixes below they need no label: in a JSON-escaped tool result neither the
// quoted-field nor the `token:` rule can reach them.
const ACCOUNT_API_TOKEN_BEARER_V1_TEXT_PATTERN = secretTextPattern(ACCOUNT_API_TOKEN_BEARER_V1_SOURCE, 'g');
const ACCOUNT_API_TOKEN_CREDENTIAL_V1_TEXT_PATTERN = secretTextPattern(`${ACCOUNT_API_TOKEN_CREDENTIAL_V1_PREFIX}[A-Za-z0-9_-]+`, 'g');

// The labels the label rules below name. A quoted value under one of them is
// redacted by the assignment scanner too, because a quote, escaped or not,
// stands between such a label and its `:` or `=` in JSON.
const LABELLED_SECRET_KEY_SOURCE = String.raw`api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|jwt|session(?:id)?|passphrase|private[_-]?key`;
const NPMRC_SECRET_KEY_SOURCE = String.raw`_(?:authToken|auth|password)`;
const AWS_SECRET_KEY_SOURCE = String.raw`aws[_-]?(?:secret[_-]?access[_-]?key|session[_-]?token)`;
const SECRET_WORD_KEY_SOURCE = String.raw`password|passphrase|private[_-]?key|token|secret`;
const LABELLED_SECRET_KEY = new RegExp(
  `^(?:${[LABELLED_SECRET_KEY_SOURCE, NPMRC_SECRET_KEY_SOURCE, AWS_SECRET_KEY_SOURCE, SECRET_WORD_KEY_SOURCE].join('|')})$`,
  'i',
);

const UNQUOTED_CREDENTIAL_VALUE = /(?:bearer|basic)\s+[^\s&]+|[^\s"'&]+/iuy;

const DIAGNOSTIC_URL_PATTERN = secretTextPattern(String.raw`[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>]+`, 'giu');
const DIAGNOSTIC_URL_CREDENTIAL_SUFFIXES = new Set([
  'auth',
  'authentication',
  'credential',
  'credentials',
  'key',
  'secret',
  'session',
  'token',
]);

function isSensitiveDiagnosticUrlQueryKey(key: string): boolean {
  if (isBaseCredentialDiagnosticKey(key)) return true;
  const segments = splitSensitiveDiagnosticKeySegments(key);
  return DIAGNOSTIC_URL_CREDENTIAL_SUFFIXES.has(segments.at(-1) ?? '');
}

function redactSensitiveDiagnosticUrls(input: string): string {
  return input.replace(DIAGNOSTIC_URL_PATTERN, (rawUrl) => {
    try {
      const capabilitySafeUrl = redactPublicShareCapabilityUrl(rawUrl);
      const url = new URL(capabilitySafeUrl);
      let redacted = capabilitySafeUrl !== rawUrl;
      if (url.username || url.password) {
        url.username = '[REDACTED]';
        url.password = '';
        redacted = true;
      }
      for (const key of new Set(url.searchParams.keys())) {
        if (!isSensitiveDiagnosticUrlQueryKey(key)) continue;
        url.searchParams.set(key, '[REDACTED]');
        redacted = true;
      }
      if (!redacted) return rawUrl;
      return url.toString().replace(/%5bredacted%5d/giu, '[REDACTED]');
    } catch {
      return rawUrl;
    }
  });
}

/**
 * The one reading of a quote in diagnostic text. A transcript JSON-escapes the
 * text it carries, once or more, so the quote around a key or value arrives as
 * `"`, `\"` or `\\\"`: a run of backslashes and then the quote character.
 * Returns that quote when its backslash run starts at `index`.
 */
function readQuote(text: string, index: number): { token: string; quote: string; depth: number } | undefined {
  let cursor = index;
  while (text.charCodeAt(cursor) === 92) cursor += 1;
  const quote = text[cursor];
  if (quote !== '"' && quote !== "'") return undefined;
  return { token: text.slice(index, cursor + 1), quote, depth: cursor - index };
}

/**
 * Where a quoted value opened by `open` ends: the offset after its closing quote,
 * or the end of the text when it never closes, so a truncated value surrenders
 * nothing. Inside the value one more escaping level applies, so a quote preceded
 * by `depth` backslashes, plus any whole number of escaped backslash pairs at that
 * level (`2 * depth + 2` each), closes it; any other run escapes the quote into
 * the value. Every character is visited once, so an unterminated run of escapes
 * stays linear, and the value has no length bound: a bound only decides how
 * long a secret must be before it is emitted verbatim.
 */
function findQuotedValueEnd(text: string, from: number, open: { quote: string; depth: number }): number {
  let cursor = from;
  while (cursor < text.length) {
    const run = cursor;
    while (text.charCodeAt(cursor) === 92) cursor += 1;
    if (cursor >= text.length) return text.length;
    if (text[cursor] === open.quote && (cursor - run) % (2 * open.depth + 2) === open.depth) return cursor + 1;
    cursor += 1;
  }
  return text.length;
}

function isKeyCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_-]/.test(character);
}

// A key is a maximal run of key characters, so it starts at the shared
// start-of-secret boundary except after a hyphen, which belongs to the run.
function startsCredentialKey(text: string, index: number): boolean {
  return /[A-Za-z_]/.test(text[index] ?? '') && text[index - 1] !== '-' && startsSecretText(text, index);
}

/**
 * Redacts the value of a credential assignment: a key, optionally quoted, then
 * `:` or `=`, then a quoted or unquoted value. The key only marks the candidate;
 * whether it names a credential is decided by the shared segment-aware
 * classifier, so `tokenCount` and `secretary` remain ordinary fields. A quoted
 * value is also redacted under any label a label rule below names.
 *
 * A non-credential key gives up its value to the scan, so `failed: secretKey=…`
 * still reaches `secretKey`. After a JSON line escape the boundary holds at the
 * escape letter and after it; the letter's reading is tried first, the escaped
 * one next.
 */
function redactCredentialAssignments(input: string): string {
  if (!input.includes('=') && !input.includes(':')) return input;
  const isSpacing = (character: string | undefined): boolean => {
    const code = character === undefined ? -1 : character.charCodeAt(0);
    return code === 32 || (code >= 9 && code <= 13);
  };
  // The classifier costs about a microsecond per key and a log repeats its keys,
  // so each distinct key is judged once per text.
  const verdicts = new Map<string, boolean>();
  const isCredentialKey = (key: string): boolean => {
    let verdict = verdicts.get(key);
    if (verdict === undefined) {
      verdict = isBaseCredentialDiagnosticKey(key);
      verdicts.set(key, verdict);
    }
    return verdict;
  };
  let output = '';
  let copyFrom = 0;
  let index = 0;

  while (index < input.length) {
    if (!startsCredentialKey(input, index)) {
      index += 1;
      while (isKeyCharacter(input[index]) && !startsCredentialKey(input, index)) index += 1;
      continue;
    }

    let keyEnd = index + 1;
    while (isKeyCharacter(input[keyEnd])) keyEnd += 1;
    const key = input.slice(index, keyEnd);
    const next = startsCredentialKey(input, index + 1) ? index + 1 : keyEnd;
    if (key.length > 128) {
      index = next;
      continue;
    }

    let separator = readQuote(input, keyEnd)?.token.length ?? 0;
    separator += keyEnd;
    while (isSpacing(input[separator])) separator += 1;
    if (input[separator] !== ':' && input[separator] !== '=') {
      index = next;
      continue;
    }
    let valueStart = separator + 1;
    while (isSpacing(input[valueStart])) valueStart += 1;
    const open = readQuote(input, valueStart);

    if (open) {
      if (!isCredentialKey(key) && !LABELLED_SECRET_KEY.test(key)) {
        index = next;
        continue;
      }
      const valueFrom = valueStart + open.token.length;
      output += `${input.slice(copyFrom, valueFrom)}[REDACTED]${open.token}`;
      copyFrom = findQuotedValueEnd(input, valueFrom, open);
      index = copyFrom;
      continue;
    }

    // Classify before reading the value: an unquoted value can run to the end of
    // the text, and reading it for every ordinary key would rescan that text.
    if (!isCredentialKey(key)) {
      index = next;
      continue;
    }
    UNQUOTED_CREDENTIAL_VALUE.lastIndex = valueStart;
    const value = UNQUOTED_CREDENTIAL_VALUE.exec(input)?.[0];
    if (!value || value.endsWith('[REDACTED]')) {
      index = next;
      continue;
    }
    output += `${input.slice(copyFrom, valueStart)}[REDACTED]`;
    copyFrom = valueStart + value.length;
    index = copyFrom;
  }

  return `${output}${input.slice(copyFrom)}`;
}

const SENSITIVE_DIAGNOSTIC_VALUES_REGISTRY_KEY = Symbol.for(
  'happier.protocol.sensitiveDiagnosticValues.v2',
);

type SensitiveDiagnosticValuesController = Readonly<{
  register: (values: readonly string[]) => (() => void);
  redact: (input: string) => string;
}>;

function isSensitiveDiagnosticValuesController(value: unknown): value is SensitiveDiagnosticValuesController {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record.register === 'function' && typeof record.redact === 'function';
}

function createSensitiveDiagnosticValuesController(): SensitiveDiagnosticValuesController {
  const activeValues = new Map<string, number>();
  return Object.freeze({
    register: (values: readonly string[]) => {
      for (const value of values) {
        activeValues.set(value, (activeValues.get(value) ?? 0) + 1);
      }
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        for (const value of values) {
          const count = activeValues.get(value);
          if (count === undefined || count <= 1) {
            activeValues.delete(value);
          } else {
            activeValues.set(value, count - 1);
          }
        }
      };
    },
    redact: (input: string) => {
      const values = [...activeValues.keys()].sort((left, right) => right.length - left.length);
      let output = input;
      for (const value of values) {
        output = output.split(value).join('[REDACTED]');
      }
      return output;
    },
  });
}

function readSensitiveDiagnosticValuesController(): SensitiveDiagnosticValuesController {
  const existing = Reflect.get(globalThis, SENSITIVE_DIAGNOSTIC_VALUES_REGISTRY_KEY) as unknown;
  if (isSensitiveDiagnosticValuesController(existing)) return existing;
  const created = createSensitiveDiagnosticValuesController();
  Object.defineProperty(globalThis, SENSITIVE_DIAGNOSTIC_VALUES_REGISTRY_KEY, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: created,
  });
  return created;
}

export type SensitiveDiagnosticValuesLease = Readonly<{
  close: () => void;
}>;

export type SensitiveDiagnosticTextRedactor = Readonly<{
  register(values: readonly string[]): SensitiveDiagnosticValuesLease;
  redact(input: string): string;
}>;

function expandSensitiveDiagnosticValueVariants(value: string): readonly string[] {
  const variants = new Set<string>([value, JSON.stringify(value).slice(1, -1)]);
  try {
    variants.add(encodeURIComponent(value));
    variants.add(new URLSearchParams({ value }).toString().slice('value='.length));
  } catch {
    // A malformed lone surrogate still remains protected in its raw and JSON-escaped forms.
  }
  return [...variants].filter((variant) => variant.length > 0);
}

function registerSensitiveValuesOnController(
  controller: SensitiveDiagnosticValuesController,
  values: readonly string[],
): SensitiveDiagnosticValuesLease {
  if (values.some((value) => value.length === 0)) {
    throw new TypeError('Sensitive diagnostic values cannot contain an empty value');
  }
  const uniqueValues = [...new Set(values.flatMap(expandSensitiveDiagnosticValueVariants))];
  const close = controller.register(uniqueValues);
  return Object.freeze({ close });
}

/**
 * Registers exact sensitive values for diagnostic redaction during a bounded runtime lifetime.
 * The registry intentionally exposes no read surface; callers retain and close only their lease.
 */
export function registerSensitiveDiagnosticValues(values: readonly string[]): SensitiveDiagnosticValuesLease {
  return registerSensitiveValuesOnController(readSensitiveDiagnosticValuesController(), values);
}

function redactRegisteredSensitiveDiagnosticValues(input: string): string {
  return readSensitiveDiagnosticValuesController().redact(input);
}

const JSON_WEB_TOKEN_SEGMENT_MINIMUM_LENGTH = 10;

/**
 * Every character of a JSON Web Token — all three base64url segments and the two
 * dots joining them — belongs to one maximal run of this alphabet, so the run is
 * the smallest unit that can contain a whole token and the largest unit a single
 * token can span.
 *
 * Selecting the run first is what makes the rule linear. Expressed as one
 * pattern (`\beyJ…\.…\.…\b`) the header scan restarts at every interior `eyJ`,
 * because `-` is simultaneously a segment character and a word boundary: in
 * `-eyJ…` the word boundary admits a new candidate while the run it belongs to
 * has not ended, so each candidate re-scans the whole remainder. That is
 * quadratic on ordinary agent output and was measured at over four seconds for
 * 350 KB. A run is consumed once and every candidate inside it is then judged
 * against facts computed once for that run.
 *
 * The shortest possible token is `eyJ` plus a ten-character header remainder,
 * two dots and two ten-character segments — thirty-five characters — so a
 * shorter run cannot contain one. The leading delimiter is captured rather than
 * looked behind for, which is also what keeps a run shorter than that from being
 * re-measured from each of its own offsets: without it, a text made of many
 * short runs pays a quadratic cost inside every one of them.
 */
// Keep the minimum fixed and consume the rest with `*`: V8's open-ended
// counted repetition overflows its stack on a valid artifact-sized run.
const JSON_WEB_TOKEN_RUN_PATTERN = /([^A-Za-z0-9._-]|^)([A-Za-z0-9._-]{35}[A-Za-z0-9._-]*)/g;

/**
 * Judges one maximal base64url run in a single left-to-right pass.
 *
 * The signature segment is greedy and the payload segment is greedy before it,
 * so the payload/signature dot a match settles on is always the rightmost dot
 * that still leaves a whole signature behind it. That position depends only on
 * the run, so it is computed once. The header segment cannot contain a dot, so
 * its end is the first dot after the candidate — shared by every candidate in
 * the same dot-free stretch and only ever moving right, which is why one cursor
 * serves the whole run.
 *
 * A candidate starts a token only at the shared start-of-secret boundary: inside
 * a run that is a preceding dot, hyphen or run edge, or a JSON line escape
 * (`\n`, `\t`, `\r`) whose letter opens the run; anywhere else `eyJ` is interior
 * to a base64url segment. `runStart` is the run's offset in `text`, so the
 * boundary sees the characters before the run.
 *
 * The redaction runs to the end of the run rather than to the last word
 * character, so a token whose signature ends in `-` or `.` no longer leaves that
 * tail visible. Everything the pattern removed is still removed.
 */
function redactJsonWebTokensInBase64UrlRun(run: string, text: string, runStart: number): string {
  const signatureDot = run.lastIndexOf('.', run.length - JSON_WEB_TOKEN_SEGMENT_MINIMUM_LENGTH - 1);
  if (signatureDot < 0) return run;

  let searchFrom = 0;
  let headerEnd = -1;
  for (;;) {
    const start = run.indexOf('eyJ', searchFrom);
    if (start < 0) return run;
    searchFrom = start + 1;
    if (headerEnd < start + 3) {
      headerEnd = run.indexOf('.', start + 3);
      if (headerEnd < 0) return run;
    }
    if (!startsSecretText(text, runStart + start)) continue;
    if (headerEnd - (start + 3) < JSON_WEB_TOKEN_SEGMENT_MINIMUM_LENGTH) continue;
    if (signatureDot - headerEnd - 1 < JSON_WEB_TOKEN_SEGMENT_MINIMUM_LENGTH) continue;
    return `${run.slice(0, start)}[REDACTED]`;
  }
}

function redactKnownSensitiveText(input: string): string {
  return redactCredentialAssignments(
    redactSensitiveDiagnosticUrls(input)
      .replace(secretTextPattern(String.raw`authorization\s*:\s*bearer\s+[^\r\n]+`, 'gi'), 'authorization: bearer [REDACTED]')
      .replace(secretTextPattern(String.raw`authorization\s*:\s*basic\s+[^\r\n]+`, 'gi'), 'authorization: basic [REDACTED]'),
  )
    .replace(secretTextPattern(String.raw`bearer\s+[A-Za-z0-9._~+/=-]+`, 'gi'), 'Bearer [REDACTED]')
    .replace(secretTextPattern(String.raw`(cookie|set-cookie)\s*:\s*[^\r\n]+`, 'gi'), (_match, key: string) => `${key.toLowerCase()}: [REDACTED]`)
    .replace(secretTextPattern(String.raw`x-api-key\s*:\s*[^\r\n]+`, 'gi'), 'x-api-key: [REDACTED]')
    .replace(secretTextPattern(String.raw`(${LABELLED_SECRET_KEY_SOURCE})\s*[:=]\s*[^\s&]+`, 'gi'), (_match, key: string) => `${key}: [REDACTED]`)
    // Legacy npmrc credentials carry no value prefix of their own, and the leading
    // underscore keeps the generic `password`/`token` rules from ever reaching them.
    .replace(secretTextPattern(String.raw`(${NPMRC_SECRET_KEY_SOURCE})\s*=\s*\S+`, 'gi'), (_match, key: string) => `${key}=[REDACTED]`)
    // `scheme://user:secret@host` puts a live credential in an otherwise ordinary
    // clone/fetch/registry failure. Only the userinfo component is replaced, so the
    // host and path that make the failure diagnosable survive. The scheme length is
    // bounded so a long delimiter-free input cannot be rescanned from every offset.
    // The userinfo run stops only at a path separator or whitespace, so a password
    // containing its own `@` is redacted whole instead of leaking its tail; each
    // scan is bounded by the next `/`, which is also what separates two schemes.
    .replace(
      secretTextPattern(String.raw`[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/]+@`, 'gi'),
      (match) => `${match.slice(0, match.indexOf('://') + 3)}[REDACTED]@`,
    )
    .replace(
      secretTextPattern(String.raw`(${AWS_SECRET_KEY_SOURCE})\s*[:=]\s*[^\s&]+`, 'gi'),
      (_match, key: string) => `${key}: [REDACTED]`,
    )
    .replace(
      JSON_WEB_TOKEN_RUN_PATTERN,
      (_match, delimiter: string, run: string, offset: number, text: string) =>
        `${delimiter}${redactJsonWebTokensInBase64UrlRun(run, text, offset + delimiter.length)}`,
    )
    .replace(ACCOUNT_API_TOKEN_BEARER_V1_TEXT_PATTERN, '[REDACTED]')
    .replace(ACCOUNT_API_TOKEN_CREDENTIAL_V1_TEXT_PATTERN, '[REDACTED]')
    .replace(secretTextPattern(String.raw`(A3T[A-Z0-9]{16}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})\b`, 'g'), '[REDACTED]')
    .replace(secretTextPattern(String.raw`gh[pousr]_[A-Za-z0-9]{20}[A-Za-z0-9]*\b`, 'g'), '[REDACTED]')
    .replace(secretTextPattern(String.raw`github_pat_[A-Za-z0-9_]{20}[A-Za-z0-9_]*\b`, 'g'), '[REDACTED]')
    // GitLab is GitHub's peer here and its token was reaching reports whole: the
    // clone-URL rule only covers `https://oauth2:glpat-…@`, and the generic
    // `token` rule needs a word boundary that `GITLAB_TOKEN=` denies it, so a
    // bare token or an environment dump published the credential verbatim.
    // The body run ends the match rather than `\b`, because `-` and `_` are both
    // token characters and a trailing one would otherwise be left visible.
    .replace(secretTextPattern(String.raw`glpat-[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*(?![A-Za-z0-9_-])`, 'g'), '[REDACTED]')
    .replace(secretTextPattern(String.raw`npm_[A-Za-z0-9]{20}[A-Za-z0-9]*\b`, 'g'), '[REDACTED]')
    // A registry or model-hub credential in install output has the same standing
    // as the npm one above it. `hf_` is already one of the families the local
    // inventory advertises as redacted through `redactsProcessArgs`, so leaving
    // it here disclosed in a report what the process projection removes.
    .replace(secretTextPattern(String.raw`dckr_pat_[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*(?![A-Za-z0-9_-])`, 'g'), '[REDACTED]')
    .replace(secretTextPattern(String.raw`hf_[A-Za-z0-9]{20}[A-Za-z0-9]*\b`, 'g'), '[REDACTED]')
    .replace(secretTextPattern(String.raw`sk-[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*\b`, 'g'), '[REDACTED]')
    // Slack issues app-level tokens under `xapp-`, which the bot/user `xox…`
    // prefix cannot match; both bodies are the same hyphenated alphabet.
    .replace(secretTextPattern(String.raw`(?:xox[a-z]|xapp)-[A-Za-z0-9-]{10}[A-Za-z0-9-]*`, 'g'), '[REDACTED]')
    .replace(
      secretTextPattern(String.raw`https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+`, 'gi'),
      'https://hooks.slack.com/services/[REDACTED]',
    )
    // `pk_` is Stripe's publishable identifier and stays readable; only the secret
    // and restricted key prefixes name a credential.
    .replace(secretTextPattern(String.raw`[sr]k_(?:live|test)_[A-Za-z0-9]{16}[A-Za-z0-9]*\b`, 'g'), '[REDACTED]')
    .replace(secretTextPattern(String.raw`AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])`, 'g'), '[REDACTED]')
    // Google's second credential prefix: an OAuth access token, which `AIza`
    // above cannot match. A dot is a token character here, so the body run
    // carries it and the match ends where the run does.
    .replace(secretTextPattern(String.raw`ya29\.[A-Za-z0-9._-]{20}[A-Za-z0-9._-]*(?![A-Za-z0-9._-])`, 'g'), '[REDACTED]')
    // A private key body is the one payload worth losing entirely from a report.
    // The body scan is lazy against an end marker and also closes at end of
    // input, so a log truncated mid-key surrenders nothing. That end-of-input
    // alternative is what keeps the scan linear: it always succeeds, so a start
    // marker can never fail and hand the next start the same remaining input to
    // rescan. Bounding the body instead made every unterminated start pay the
    // whole bound before failing, and silently released any body longer than it.
    // The `CERTIFICATE` blocks that surround it in the same files are public.
    .replace(
      /(-----BEGIN [A-Z0-9 ]{0,32}?PRIVATE KEY-----)[\s\S]*?(?=-----END|$)/g,
      '$1\n[REDACTED]\n',
    )
    // Every rule above names its value: by prefix, by label, or by envelope. A
    // bare AWS secret access key carries none of those, and the only shape it
    // has is a 40-character mixed-alphabet run — which this repository's own
    // `…V1`/`…Schema` naming convention produces by the hundred. Judging that
    // shape destroyed 216 distinct real first-party identifiers across 1,350
    // tracked source lines, including the file and type names a compile failure
    // must be able to state, so the shape is not evidence and no guard makes it
    // evidence. A labelled `aws_secret_access_key=` value stays redacted by the
    // rule above; a label-free one is now reported verbatim.
    // A Saved Secret reference (`happier:shared-secret:v1:<resource>`) names stored
    // material; it is not the material, and rewriting it breaks every reuse.
    .replace(secretTextPattern(String.raw`(?<!happier:shared-)(${SECRET_WORD_KEY_SOURCE})\s*[:=]\s*[^\s&]+`, 'gi'), (_match, key: string) => `${key}: [REDACTED]`);
}

/**
 * Creates an exact-value redactor whose leases are isolated from process-global
 * support diagnostics. The caller owns every lease and the redactor lifetime.
 */
export function createSensitiveDiagnosticTextRedactor(): SensitiveDiagnosticTextRedactor {
  const controller = createSensitiveDiagnosticValuesController();
  return Object.freeze({
    register: (values) => registerSensitiveValuesOnController(controller, values),
    redact: (input) => redactKnownSensitiveText(controller.redact(String(input ?? ''))),
  });
}

export function redactBugReportSensitiveText(input: string): string {
  return redactKnownSensitiveText(
    redactRegisteredSensitiveDiagnosticValues(String(input ?? '')),
  );
}

export function trimBugReportTextToMaxBytes(input: string, maxBytes: number): string {
  return trimUtf8TextToMaxBytes(input, maxBytes);
}

/**
 * The head-keeping bound for redacted diagnostic text whose leading words name
 * the failure — a thrown message rather than a captured log tail.
 */
export function trimBugReportTextHeadToMaxBytes(input: string, maxBytes: number): string {
  return trimUtf8TextHeadToMaxBytes(input, maxBytes);
}
