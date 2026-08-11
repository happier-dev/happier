import { trimUtf8TextToMaxBytes } from './utf8.js';

/**
 * # The invariant
 *
 * **This scrubber never emits `[REDACTED]` while any part of the credential it matched survives on
 * the same line.**
 *
 * A marker beside a live credential is worse than no marker at all: it defeats grep, it defeats
 * audit, and it makes every marker-presence gate pass on a leak. Over-redaction is always preferred
 * to a false marker.
 *
 * Three separate leaks in this file were one defect: a rule decided "a credential starts here" and
 * then delegated the *terminator* decision to a character class that knew nothing about quoting —
 * `[^"'\r\n]+` stopped at a quote that was not a terminator, `\S+` stopped at a space inside a
 * quoted passphrase. Patching the classes one shape at a time produced the next instance each time.
 *
 * So the terminator decision is no longer spelled per rule. It lives in the three scanners below —
 * {@link scanHeaderValueEnd}, {@link scanShellWordEnd}, {@link scanQuotedFieldValueEnd} — which
 * every value-consuming rule calls, and which are built so that the only ways to stop are ones that
 * cannot leave credential material behind: a closing quote that is a real argument boundary, an
 * unquoted separator, or end of line. `redaction.invariant.test.ts` generates the
 * (introducer, secret, trailing context) compositions and asserts the invariant over all of them; it
 * is the regression gate for the class, not for the shapes listed here.
 */
const REDACTED = '[REDACTED]';

const QUOTE_CHARACTERS = '"\'`';

/**
 * Characters that genuinely end a shell word. `)`/`]`/`}`/`,` are deliberately absent: a value may
 * contain them, and stopping there would leave the remainder of a credential in the text.
 */
const UNQUOTED_VALUE_TERMINATOR = /[\s;|&<>]/;

/** What may follow a closing quote for that quote to read as a real argument boundary. */
const ARGUMENT_BOUNDARY_AFTER_QUOTE = /[\s)\]},;|&<>]/;

const IDENTIFIER_CHARACTER = /[A-Za-z0-9_.-]/;

/**
 * A credential key name is short — `AWS_SECRET_ACCESS_KEY` is 21 characters. Bounding the expansion
 * keeps it linear (an unbroken identifier-ish run carrying many credential words would otherwise be
 * rescanned end to end per occurrence) and is also the right answer: a 300-character run that
 * happens to contain `token` is a payload, not a key name, so the occurrence is skipped rather than
 * truncated to a fake key.
 */
const MAX_CREDENTIAL_KEY_LENGTH = 64;

function isQuote(character: string): boolean {
  return character !== '' && QUOTE_CHARACTERS.includes(character);
}

function findLineEnd(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === '\n' || character === '\r') return index;
  }
  return text.length;
}

function findLineStart(text: string, from: number): number {
  for (let index = from - 1; index >= 0; index -= 1) {
    const character = text.charAt(index);
    if (character === '\n' || character === '\r') return index + 1;
  }
  return 0;
}

/**
 * The quote a value sits inside, inferred by replaying the quoting state of its own line.
 *
 * This is what keeps `curl -H "authorization: bearer …" https://host` from swallowing the URL: the
 * header value is inside a shell argument, so its closing `"` is a real terminator. The state is
 * *inferred*, so it is trusted only within the line — an apostrophe in ordinary prose ("can't")
 * would otherwise open a quote that never closes and blank the rest of a bug report.
 */
function enclosingQuoteAt(text: string, index: number): string | null {
  let open: string | null = null;
  for (let cursor = findLineStart(text, index); cursor < index; cursor += 1) {
    const character = text.charAt(cursor);
    if (open !== null) {
      if (character === open) open = null;
      continue;
    }
    if (isQuote(character)) open = character;
  }
  return open;
}

function skipBlanks(text: string, from: number): number {
  let index = from;
  while (index < text.length && (text.charAt(index) === ' ' || text.charAt(index) === '\t')) index += 1;
  return index;
}

function isArgumentBoundary(text: string, index: number): boolean {
  if (index >= text.length) return true;
  return ARGUMENT_BOUNDARY_AFTER_QUOTE.test(text.charAt(index));
}

/**
 * End of the quoted run that begins at `start` (exclusive of nothing — the closing quote is part of
 * it), or `-1` when no closing quote on the way ever lands on an argument boundary.
 *
 * A closing quote glued to more material does not terminate anything: `"abc"def` is one shell token
 * and `"Bearer abc"def"` is one credential, so stopping at the first quote is what printed the
 * marker beside the surviving half. Escapes are honoured so a JSON `"a\"b"` closes where JSON says
 * it does, and the scan crosses newlines because an observed opening quote means the value really
 * does continue.
 */
function findQuotedRunEnd(text: string, start: number): number {
  const quote = text.charAt(start);
  let cursor = start + 1;
  while (cursor < text.length) {
    const character = text.charAt(cursor);
    if (character === '\\') {
      cursor += 2;
      continue;
    }
    if (character === quote && isArgumentBoundary(text, cursor + 1)) return cursor + 1;
    cursor += 1;
  }
  return -1;
}

/** Index of the first closing quote of the run beginning at `start`, or `-1`. */
function findFirstQuoteClose(text: string, start: number): number {
  const quote = text.charAt(start);
  for (let cursor = start + 1; cursor < text.length; cursor += 1) {
    const character = text.charAt(cursor);
    if (character === '\\') {
      cursor += 1;
      continue;
    }
    if (character === quote) return cursor;
  }
  return -1;
}

/**
 * How far a HEADER value extends: to end of line, unless a quote gives a terminator that provably
 * cannot leave part of the value behind.
 *
 * End of line is the default because a header value in a log line runs to the newline — that is
 * what makes `Authorization: Bearer abc"tail"` fully redactable, where a `[^"'\r\n]+` class printed
 * the marker and kept `"tail"`.
 */
function scanHeaderValueEnd(text: string, valueStart: number): number {
  const lineEnd = findLineEnd(text, valueStart);
  if (valueStart >= lineEnd) return valueStart;

  if (isQuote(text.charAt(valueStart))) {
    // Both quotes belong to the value and go with it — leaving the closing one behind produces an
    // orphan quote that the next pass then reads as the opening of a new value.
    const quotedEnd = findQuotedRunEnd(text, valueStart);
    if (quotedEnd !== -1) return quotedEnd;
    // No closing quote ever lands on a boundary (a truncated log, or stray quotes after a properly
    // closed value). The value still reaches at least the end of the line its first closing quote
    // is on, which is what keeps a credential written across a newline from surviving the marker.
    const firstClose = findFirstQuoteClose(text, valueStart);
    return findLineEnd(text, firstClose === -1 ? valueStart : firstClose);
  }

  // An enclosing quote belongs to the argument around the value, not to the value, so it stays.
  const enclosing = enclosingQuoteAt(text, valueStart);
  if (enclosing !== null) {
    const close = text.indexOf(enclosing, valueStart);
    if (close !== -1 && close < lineEnd && isArgumentBoundary(text, close + 1)) return close;
  }
  return lineEnd;
}

/**
 * How far a SHELL WORD value extends: to the first unquoted separator, with quoted sections carried
 * through whitespace — and through newlines — to their closing quote.
 *
 * `--password "correct horse battery staple"` is one value, `--password "a"b` is one value, and
 * `--password "first\nsecond"` is one value. An opening quote with no closing quote anywhere is a
 * truncated log rather than a multi-line argument, so it stops at end of line instead of eating the
 * remainder of the text.
 */
function scanShellWordEnd(text: string, valueStart: number): number {
  let cursor = valueStart;
  while (cursor < text.length) {
    const character = text.charAt(cursor);
    if (isQuote(character)) {
      const close = text.indexOf(character, cursor + 1);
      if (close === -1) return findLineEnd(text, cursor);
      cursor = close + 1;
      continue;
    }
    if (UNQUOTED_VALUE_TERMINATOR.test(character)) return cursor;
    cursor += 1;
  }
  return text.length;
}

/**
 * Does the scanned span carry anything a marker could be lying about? An empty header, a
 * whitespace-only one and `""` all reach the rules; printing `[REDACTED]` for them is the same lie
 * in the other direction and trains readers to distrust the marker.
 */
function carriesCredentialMaterial(value: string): boolean {
  if (!/[^\s"'`]/.test(value)) return false;
  // Already redacted: the marker replaced the credential and whatever follows it was never part of
  // the value. Re-running a rule here would keep eating the rest of the line on every pass, so the
  // scrubber would not be a fixed point — and a scrubber applied twice must not destroy more.
  return !/^\[REDACTED\](?:[\s"'`)\]},;|&<>]|$)/.test(value);
}

function unquote(value: string): string {
  const first = value.charAt(0);
  if (!isQuote(first)) return value;
  const end = value.endsWith(first) && value.length > 1 ? value.length - 1 : value.length;
  return value.slice(1, end);
}

const NAMED_TOKEN_PREFIX_PATTERN = /^(?:gh[pousr]_|github_pat_|glpat-|xox[baprse]-|sk-|AKIA|ASIA|A3T)/;

/**
 * Is this run a credential rather than an English word? Used only where the *key* is ambiguous
 * about whether a value follows — a URL username, and a compound key separated from its value by a
 * space — so a false negative costs a missed redaction on those two shapes and a false positive
 * costs a blanked word. Requiring a non-letter is what keeps ordinary prose ("expired",
 * "authentication") out while admitting real tokens, which always carry digits or separators.
 */
function looksLikeOpaqueCredential(value: string): boolean {
  if (NAMED_TOKEN_PREFIX_PATTERN.test(value)) return true;
  return value.length >= 12 && /[^A-Za-z]/.test(value);
}

type ValueScanner = (text: string, valueStart: number) => number;

/**
 * Replace the value that follows each match of `keyPattern`, where the match ends exactly where the
 * value begins. Returning `null` from `buildReplacement` leaves the occurrence untouched — a rule
 * that declines never emits a marker.
 */
function redactValuesAfterKey(
  input: string,
  keyPattern: RegExp,
  scanValueEnd: ValueScanner,
  buildReplacement: (match: RegExpExecArray, value: string) => string | null,
): string {
  const pattern = new RegExp(keyPattern.source, keyPattern.flags.includes('g') ? keyPattern.flags : `${keyPattern.flags}g`);
  let output = '';
  let cursor = 0;
  let match = pattern.exec(input);
  while (match !== null) {
    const valueStart = match.index + match[0].length;
    const valueEnd = scanValueEnd(input, valueStart);
    const value = input.slice(valueStart, valueEnd);
    const replacement = carriesCredentialMaterial(value) ? buildReplacement(match, value) : null;
    if (replacement === null) {
      pattern.lastIndex = Math.max(match.index + 1, valueStart);
    } else if (match.index >= cursor) {
      output += input.slice(cursor, match.index) + replacement;
      cursor = valueEnd;
      pattern.lastIndex = valueEnd;
    } else {
      pattern.lastIndex = Math.max(match.index + 1, valueStart);
    }
    match = pattern.exec(input);
  }
  return output + input.slice(cursor);
}

// `authorization` belongs here as well as in the header rule below: serialized request headers are
// a real artifact shape (`serializeAxiosErrorForLog`), and `"Authorization": "Bearer …"` can never
// reach the header rule because the quote between the key and the colon breaks `authorization\s*:`.
// The key alternation is the compound form so that `"AWS_SECRET_ACCESS_KEY": "…"` is covered too.
/**
 * A folded header or wrapped config value: one line break followed by indentation, which is the
 * only shape RFC 7230 obs-fold and every log serializer that wraps a long header produce. Written
 * here rather than as a bare `\s*` because `\s*` also swallows an UNindented next line, so
 * `Authorization:` at the end of a paragraph would redact the sentence after it.
 */
const OPTIONAL_VALUE_FOLD = String.raw`(?:\r?\n[ \t]+)?`;

const QUOTED_SECRET_FIELD_PATTERN = new RegExp(
  String.raw`(["'])([A-Za-z0-9_.-]*(?:client[_-]?secret|secret|password|passwd|access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|apikey|credentials?)[A-Za-z0-9_.-]*|authorization|jwt|session(?:id)?)\1[ \t]*:[ \t]*${OPTIONAL_VALUE_FOLD}[ \t]*`,
  'gi',
);

/**
 * A quoted field value, ending at the closing quote that is a real boundary. `-1` from the run
 * scanner means the quoting never resolves (a truncated artifact), and the rule then declines
 * rather than guessing: declining leaks nothing new, while guessing prints a marker.
 */
function scanQuotedFieldValueEnd(text: string, valueStart: number): number {
  if (!isQuote(text.charAt(valueStart))) return valueStart;
  const quotedEnd = findQuotedRunEnd(text, valueStart);
  return quotedEnd === -1 ? valueStart : quotedEnd;
}

// `[:=]` rather than `:` alone: PowerShell writes headers as `@{Authorization="Bearer …"}`, and
// Windows is a first-class platform here. The scheme is consumed by the key rather than left to the
// value so that `Bearer "<credential>"` starts the value AT the quote, which is what lets the
// scanner follow the quote instead of stopping at the first newline inside it.
const AUTHORIZATION_HEADER_PATTERN = new RegExp(
  String.raw`\bauthorization[ \t]*[:=][ \t]*${OPTIONAL_VALUE_FOLD}[ \t]*(bearer[ \t]+)?`,
  'gi',
);
const COOKIE_HEADER_PATTERN = new RegExp(
  String.raw`\b(cookie|set-cookie)[ \t]*[:=][ \t]*${OPTIONAL_VALUE_FOLD}[ \t]*`,
  'gi',
);
const API_KEY_HEADER_PATTERN = new RegExp(String.raw`\bx-api-key[ \t]*[:=][ \t]*${OPTIONAL_VALUE_FOLD}[ \t]*`, 'gi');
const BEARER_SCHEME_PATTERN = /^["'`]?[ \t]*bearer\b/i;

// `--token x` is the same secret as `--token=x` in the shape a shell actually uses. The flag names
// are the unambiguous ones only — a bare `--key` is as often a sort key as a credential — and
// `(?!-)` keeps the rule from swallowing the next flag when a value was omitted.
const CREDENTIAL_FLAG_PATTERN =
  /(^|[\s"'`])(-{1,2}[A-Za-z0-9-]*(?:token|password|passwd|secret|api[-_]?key|credentials?)[A-Za-z0-9-]*)[ \t]+(?!-)/gi;

/**
 * The credential words that make a key name a credential key. Matched on its own and then expanded
 * over the surrounding identifier characters, rather than written as
 * `[A-Za-z0-9_.-]*(?:secret|…)[A-Za-z0-9_.-]*`, because that shape backtracks quadratically across
 * the long opaque runs a bug report is full of.
 */
const CREDENTIAL_KEYWORD_PATTERN = /secrets?|passwords?|passwd|tokens?|api[_-]?keys?|apikeys?|credentials?|jwt|session(?:id)?/gi;

/**
 * Keywords too generic to carry a compound key name. `session` as a word is a credential-ish key;
 * `session_started_at` is not, and widening it would blank ordinary diagnostics.
 */
const EXACT_ONLY_CREDENTIAL_KEYWORDS = new Set(['jwt', 'session', 'sessionid']);

/**
 * `AWS_SECRET_ACCESS_KEY=…`, `GITHUB_TOKEN=…`, `db.password: …`, `--token=…`, and the
 * `aws configure set aws_secret_access_key <value>` form.
 *
 * One scanner rather than the three overlapping regexes this replaced: a `\b` before `secret` can
 * never match inside `AWS_SECRET_ACCESS_KEY` (an underscore is a word character), which is why the
 * top-five real-world credential export was invisible to every rule here.
 */
type CredentialAssignment = { readonly identifier: string; readonly start: number; readonly valueEnd: number };

function resolveCredentialAssignment(input: string, keywordStart: number, keyword: string): CredentialAssignment | null {
  const leftLimit = Math.max(0, keywordStart - MAX_CREDENTIAL_KEY_LENGTH);
  const rightLimit = Math.min(input.length, keywordStart + keyword.length + MAX_CREDENTIAL_KEY_LENGTH);
  let start = keywordStart;
  while (start > leftLimit && IDENTIFIER_CHARACTER.test(input.charAt(start - 1))) start -= 1;
  let end = keywordStart + keyword.length;
  while (end < rightLimit && IDENTIFIER_CHARACTER.test(input.charAt(end))) end += 1;
  // The identifier ran into the length bound: this is a payload that happens to contain the word,
  // not a key name.
  if (start > 0 && IDENTIFIER_CHARACTER.test(input.charAt(start - 1))) return null;
  if (end < input.length && IDENTIFIER_CHARACTER.test(input.charAt(end))) return null;

  const identifier = input.slice(start, end);
  const isBareKeyword = identifier.toLowerCase() === keyword.toLowerCase();
  if (EXACT_ONLY_CREDENTIAL_KEYWORDS.has(keyword.toLowerCase()) && !isBareKeyword) return null;

  let scan = skipBlanks(input, end);
  const separator = input.charAt(scan);
  let requireCredentialShape = false;
  if (separator === ':' || separator === '=') {
    scan = skipBlanks(input, scan + 1);
    // A wrapped value (`password:` then an indented next line) was reachable through the `\s*` these
    // rules used to spell, and dropping it would leak a credential the previous build removed.
    const fold = /^\r?\n[ \t]+/.exec(input.slice(scan));
    if (fold !== null) scan = skipBlanks(input, scan + fold[0].length);
  } else if (scan > end && /[_.-]/.test(identifier) && !identifier.startsWith('-')) {
    // A compound key separated from its value by a space (`aws configure set
    // aws_secret_access_key …`). Flags are left to the flag rule, and the value must look like a
    // credential rather than the next English word, or "access_token expired" would lose its verb.
    requireCredentialShape = true;
  } else {
    return null;
  }

  const valueEnd = scanShellWordEnd(input, scan);
  const value = input.slice(scan, valueEnd);
  // A compound key with an all-digit value is a count, not a credential: `max_tokens=1000`,
  // `input_tokens: 512`. Every shipped credential shape carries letters, and this is the one place
  // the compound widening would otherwise blank numbers that a bug report is read for. The bare
  // keys (`password`, `token`, `secret`) are unambiguous and keep redacting whatever follows.
  if (!isBareKeyword && /^["'`]?\d+["'`]?$/.test(value)) return null;
  if (!carriesCredentialMaterial(value)) return null;
  if (requireCredentialShape && !looksLikeOpaqueCredential(unquote(value))) return null;
  return { identifier, start, valueEnd };
}

function redactCredentialAssignments(input: string): string {
  const pattern = new RegExp(CREDENTIAL_KEYWORD_PATTERN.source, 'gi');
  let output = '';
  let cursor = 0;
  for (let match = pattern.exec(input); match !== null; match = pattern.exec(input)) {
    const resolved = resolveCredentialAssignment(input, match.index, match[0]);
    if (resolved === null || resolved.start < cursor) {
      pattern.lastIndex = match.index + Math.max(1, match[0].length);
      continue;
    }
    output += input.slice(cursor, resolved.start) + `${resolved.identifier}: ${REDACTED}`;
    cursor = resolved.valueEnd;
    pattern.lastIndex = resolved.valueEnd;
  }
  return output + input.slice(cursor);
}

/**
 * `git clone https://<user>:<token>@host` and `postgres://svc:<pw>@host`, plus the shape GitHub
 * documents for fine-grained PATs — the token as the URL *username* with no password at all.
 * Excluding `/` from the userinfo run keeps `https://host:8443/path` intact, and requiring a
 * credential shape when there is no `:` keeps `ssh://git@host` and `https://alice@host` readable.
 */
// The scheme length is bounded because the alternative is quadratic: case-insensitively, `[a-z…]*`
// starts a scan at EVERY character of a long opaque run and backtracks the whole way looking for
// `://`, which cost ~1.8s on a single 60 kB run. Registered URI schemes are a few characters.
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]{0,30}:\/\/)([^\s/@]*)@/gi;

export function redactBugReportSensitiveText(input: string): string {
  const text = String(input ?? '');

  const withQuotedFields = redactValuesAfterKey(
    text,
    QUOTED_SECRET_FIELD_PATTERN,
    scanQuotedFieldValueEnd,
    (match, value) => {
      const valueQuote = value.charAt(0);
      return `${match[1]}${match[2]}${match[1]}: ${valueQuote}${REDACTED}${valueQuote}`;
    },
  );

  const withAuthorization = redactValuesAfterKey(
    withQuotedFields,
    AUTHORIZATION_HEADER_PATTERN,
    scanHeaderValueEnd,
    (match, value) =>
      `authorization: ${match[1] !== undefined || BEARER_SCHEME_PATTERN.test(value) ? 'bearer ' : ''}${REDACTED}`,
  );

  const withCookies = redactValuesAfterKey(
    withAuthorization,
    COOKIE_HEADER_PATTERN,
    scanHeaderValueEnd,
    (match) => `${match[1].toLowerCase()}: ${REDACTED}`,
  );

  const withApiKeyHeader = redactValuesAfterKey(
    withCookies,
    API_KEY_HEADER_PATTERN,
    scanHeaderValueEnd,
    () => `x-api-key: ${REDACTED}`,
  );

  const withUrlUserinfo = withApiKeyHeader.replace(
    URL_USERINFO_PATTERN,
    (match: string, scheme: string, userinfo: string) =>
      userinfo.includes(':') || looksLikeOpaqueCredential(userinfo) ? `${scheme}${REDACTED}@` : match,
  );

  const withAssignments = redactCredentialAssignments(withUrlUserinfo);

  const withFlagArguments = redactValuesAfterKey(
    withAssignments,
    CREDENTIAL_FLAG_PATTERN,
    scanShellWordEnd,
    (match) => `${match[1]}${match[2]} ${REDACTED}`,
  );

  return (
    withFlagArguments
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g, REDACTED)
      // AWS access key ids are 20 characters for every prefix; `A3T[A-Z0-9]{16}` is 19, so the
      // trailing boundary landed inside a real key and the alternative could only ever match a
      // string no real key has.
      .replace(/\b(A3T[A-Z0-9]{17}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})\b/g, REDACTED)
      .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED)
      // `gh[pousr]_` cannot match `github_pat_` — `gh` is followed by `i`, and the body carries `_`.
      // Fine-grained PATs are what GitHub issues by default.
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED)
      .replace(/\bglpat-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g, REDACTED)
      .replace(/\bxox[baprse]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g, REDACTED)
      // Separators are part of the shipped key bodies (`sk-ant-api03-…`, `sk-proj_…`); a body class
      // of `[A-Za-z0-9]` alone stops at the first one and leaves the key in the text.
      .replace(/\bsk-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g, REDACTED)
  );
}

export function trimBugReportTextToMaxBytes(input: string, maxBytes: number): string {
  return trimUtf8TextToMaxBytes(input, maxBytes);
}
