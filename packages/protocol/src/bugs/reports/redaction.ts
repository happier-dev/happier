import { trimUtf8TextHeadToMaxBytes, trimUtf8TextToMaxBytes } from './utf8.js';
import {
  isBaseCredentialDiagnosticKey,
  splitSensitiveDiagnosticKeySegments,
} from '../../common/sensitiveKeys.js';

/**
 * Arbitrary agent, plugin and provider text reaches this redactor, so the value
 * scan must stay linear on input that opens a quoted secret and never closes it.
 * The two value branches are disjoint — an escape pair always starts with a
 * backslash and the ordinary branch excludes one — so each position has exactly
 * one viable parse instead of the two that made an unterminated run of escapes
 * explode combinatorially. Disjointness alone buys that linearity: giving up on
 * an unterminated value costs one constant-work step per position either way.
 * The repetition therefore stays unbounded, because a bound only decides how
 * long a secret has to be before it is emitted verbatim. The trailing `\\?`
 * preserves the previous lenient reading of a malformed final escape.
 */
const QUOTED_SECRET_FIELD_PATTERN =
  /(["'])(authorization|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|jwt|session(?:id)?|password|cookie|passphrase|private[_-]?key|token|secret)\1\s*:\s*(["'])(?:\\.|(?!\3)[^\\\r\n])*\\?\3/gi;

// This only recognizes an assignment's syntactic key. Whether that key is a
// credential is decided by the shared segment-aware classifier below, so
// `tokenCount` and `secretary` remain ordinary diagnostic fields.
const DIAGNOSTIC_UNQUOTED_ASSIGNMENT_PATTERN =
  /(^|[^A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_-]{0,127})(\s*[:=]\s*)((?:bearer|basic)\s+[^\s&]+|[^\s"'&]+)/giu;

const DIAGNOSTIC_URL_PATTERN = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>]+/giu;
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
      const url = new URL(rawUrl);
      let redacted = false;
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

function redactSegmentAwareCredentialAssignments(input: string): string {
  return input.replace(
    DIAGNOSTIC_UNQUOTED_ASSIGNMENT_PATTERN,
    (match, prefix: string, key: string, separator: string) => (
      isBaseCredentialDiagnosticKey(key) && !match.endsWith('[REDACTED]')
        ? `${prefix}${key}${separator}[REDACTED]`
        : match
    ),
  );
}

function redactQuotedCredentialAssignments(input: string): string {
  if (!input.includes('=') && !input.includes(':')) return input;
  const isKeyStart = (character: string): boolean => {
    const code = character.charCodeAt(0);
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  };
  const isKeyCharacter = (character: string): boolean => {
    const code = character.charCodeAt(0);
    return isKeyStart(character) || (code >= 48 && code <= 57) || code === 45 || code === 95;
  };
  const isSpacing = (character: string): boolean => {
    const code = character.charCodeAt(0);
    return code === 32 || (code >= 9 && code <= 13);
  };
  let output = '';
  let copyFrom = 0;
  let index = 0;

  while (index < input.length) {
    const previous = index === 0 ? '' : input[index - 1]!;
    if (
      !isKeyStart(input[index]!)
      || (previous.length > 0 && isKeyCharacter(previous))
    ) {
      index += 1;
      continue;
    }

    let keyEnd = index + 1;
    while (keyEnd < input.length && isKeyCharacter(input[keyEnd]!)) keyEnd += 1;
    const key = input.slice(index, keyEnd);
    if (key.length > 128) {
      index = keyEnd;
      continue;
    }

    let separator = keyEnd;
    while (separator < input.length && isSpacing(input[separator]!)) separator += 1;
    if (input[separator] !== ':' && input[separator] !== '=') {
      index = keyEnd;
      continue;
    }
    let quoteAt = separator + 1;
    while (quoteAt < input.length && isSpacing(input[quoteAt]!)) quoteAt += 1;
    const quote = input[quoteAt];
    if (quote !== '"' && quote !== "'") {
      index = keyEnd;
      continue;
    }
    if (!isBaseCredentialDiagnosticKey(key)) {
      index = keyEnd;
      continue;
    }

    let valueEnd = quoteAt + 1;
    while (valueEnd < input.length) {
      if (input[valueEnd] === '\\') {
        valueEnd = Math.min(input.length, valueEnd + 2);
        continue;
      }
      if (input[valueEnd] === quote) break;
      valueEnd += 1;
    }

    output += `${input.slice(copyFrom, quoteAt + 1)}[REDACTED]${quote}`;
    copyFrom = valueEnd < input.length ? valueEnd + 1 : input.length;
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
const JSON_WEB_TOKEN_RUN_PATTERN = /([^A-Za-z0-9._-]|^)([A-Za-z0-9._-]{35,})/g;

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
 * A candidate starts a segment only where the previous character is a dot, a
 * hyphen, or the run boundary itself; anywhere else `eyJ` is interior to a
 * base64url segment. That is exactly the word boundary the previous pattern
 * required, expressed without looking behind, because this redactor is reachable
 * from Hermes.
 *
 * The redaction runs to the end of the run rather than to the last word
 * character, so a token whose signature ends in `-` or `.` no longer leaves that
 * tail visible. Everything the pattern removed is still removed.
 */
function redactJsonWebTokensInBase64UrlRun(run: string): string {
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
    const previous = start === 0 ? '' : run.charAt(start - 1);
    if (previous !== '' && previous !== '.' && previous !== '-') continue;
    if (headerEnd - (start + 3) < JSON_WEB_TOKEN_SEGMENT_MINIMUM_LENGTH) continue;
    if (signatureDot - headerEnd - 1 < JSON_WEB_TOKEN_SEGMENT_MINIMUM_LENGTH) continue;
    return `${run.slice(0, start)}[REDACTED]`;
  }
}

function redactKnownSensitiveText(input: string): string {
  return redactSegmentAwareCredentialAssignments(
    redactQuotedCredentialAssignments(redactSensitiveDiagnosticUrls(input))
      .replace(/\bauthorization\s*:\s*bearer\s+[^\r\n]+/gi, 'authorization: bearer [REDACTED]')
      .replace(/\bauthorization\s*:\s*basic\s+[^\r\n]+/gi, 'authorization: basic [REDACTED]'),
  )
    .replace(
      QUOTED_SECRET_FIELD_PATTERN,
      (_match, keyQuote: string, key: string, valueQuote: string) =>
        `${keyQuote}${key}${keyQuote}: ${valueQuote}[REDACTED]${valueQuote}`,
    )
    .replace(/\b(cookie|set-cookie)\s*:\s*[^\r\n]+/gi, (_match, key: string) => `${key.toLowerCase()}: [REDACTED]`)
    .replace(/\bx-api-key\s*:\s*[^\r\n]+/gi, 'x-api-key: [REDACTED]')
    .replace(/\b(api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|jwt|session(?:id)?|passphrase|private[_-]?key)\s*[:=]\s*[^\s&]+/gi, (_match, key: string) => `${key}: [REDACTED]`)
    // Legacy npmrc credentials carry no value prefix of their own, and the leading
    // underscore keeps the generic `password`/`token` rules from ever reaching them.
    .replace(/\b(_(?:authToken|auth|password))\s*=\s*\S+/gi, (_match, key: string) => `${key}=[REDACTED]`)
    // `scheme://user:secret@host` puts a live credential in an otherwise ordinary
    // clone/fetch/registry failure. Only the userinfo component is replaced, so the
    // host and path that make the failure diagnosable survive. The scheme length is
    // bounded so a long delimiter-free input cannot be rescanned from every offset.
    // The userinfo run stops only at a path separator or whitespace, so a password
    // containing its own `@` is redacted whole instead of leaking its tail; each
    // scan is bounded by the next `/`, which is also what separates two schemes.
    .replace(
      /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/]+@/gi,
      (match) => `${match.slice(0, match.indexOf('://') + 3)}[REDACTED]@`,
    )
    .replace(
      /\b(aws[_-]?(?:secret[_-]?access[_-]?key|session[_-]?token))\s*[:=]\s*[^\s&]+/gi,
      (_match, key: string) => `${key}: [REDACTED]`,
    )
    .replace(
      JSON_WEB_TOKEN_RUN_PATTERN,
      (_match, delimiter: string, run: string) => `${delimiter}${redactJsonWebTokensInBase64UrlRun(run)}`,
    )
    .replace(/\b(A3T[A-Z0-9]{16}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]')
    // GitLab is GitHub's peer here and its token was reaching reports whole: the
    // clone-URL rule only covers `https://oauth2:glpat-…@`, and the generic
    // `token` rule needs a word boundary that `GITLAB_TOKEN=` denies it, so a
    // bare token or an environment dump published the credential verbatim.
    // The body run ends the match rather than `\b`, because `-` and `_` are both
    // token characters and a trailing one would otherwise be left visible.
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g, '[REDACTED]')
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    // A registry or model-hub credential in install output has the same standing
    // as the npm one above it. `hf_` is already one of the families the local
    // inventory advertises as redacted through `redactsProcessArgs`, so leaving
    // it here disclosed in a report what the process projection removes.
    .replace(/\bdckr_pat_[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g, '[REDACTED]')
    .replace(/\bhf_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
    // Slack issues app-level tokens under `xapp-`, which the bot/user `xox…`
    // prefix cannot match; both bodies are the same hyphenated alphabet.
    .replace(/\b(?:xox[a-z]|xapp)-[A-Za-z0-9-]{10,}/g, '[REDACTED]')
    .replace(
      /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gi,
      'https://hooks.slack.com/services/[REDACTED]',
    )
    // `pk_` is Stripe's publishable identifier and stays readable; only the secret
    // and restricted key prefixes name a credential.
    .replace(/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, '[REDACTED]')
    .replace(/\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, '[REDACTED]')
    // Google's second credential prefix: an OAuth access token, which `AIza`
    // above cannot match. A dot is a token character here, so the body run
    // carries it and the match ends where the run does.
    .replace(/\bya29\.[A-Za-z0-9._-]{20,}(?![A-Za-z0-9._-])/g, '[REDACTED]')
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
    .replace(/\b(password|passphrase|private[_-]?key|token|secret)\s*[:=]\s*[^\s&]+/gi, (_match, key: string) => `${key}: [REDACTED]`);
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
