const OUTPUT_PREVIEW_MAX_LENGTH = 500;
const SENSITIVE_KEY_NAME_PATTERN = String.raw`[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|AUTH|PRIVATE|CREDENTIAL|KEY)[A-Z0-9_]*`;
const SENSITIVE_JSON_PROPERTY_PATTERN = new RegExp(`(["'])(${SENSITIVE_KEY_NAME_PATTERN})(["']\\s*:\\s*)(["'])([^"']*)(["'])`, 'gi');
const SENSITIVE_LINE_ASSIGNMENT_PATTERN = new RegExp(`(^|[\\r\\n])([^\\r\\n]*?\\b)(${SENSITIVE_KEY_NAME_PATTERN})(\\s*[:=]\\s*)[^\\r\\n]*`, 'gi');

/**
 * @param {string} text
 * @param {number} startIndex
 * @returns {string | null}
 */
function extractBalancedJsonBlock(text, startIndex) {
  const opener = text[startIndex];
  const closer = opener === '{' ? '}' : opener === '[' ? ']' : '';
  if (!closer) return null;

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === opener) {
      depth += 1;
      continue;
    }
    if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

/**
 * @param {string} text
 * @param {(value: unknown) => number} scoreExpectedValue
 * @param {boolean} preferEarlierOnTie
 * @returns {{ candidate: string; parsed: unknown } | null}
 */
function extractAuthoritativeJsonBlock(text, scoreExpectedValue, preferEarlierOnTie) {
  /** @type {{ candidate: string; parsed: unknown; score: number; startIndex: number; endIndex: number; trailingNonWhitespaceLength: number } | null} */
  let best = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '{' && char !== '[') continue;

    const candidate = extractBalancedJsonBlock(text, index);
    if (!candidate) continue;

    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const score = scoreExpectedValue(parsed);
    if (score <= 0) continue;

    const endIndex = index + candidate.length;
    const trailingNonWhitespaceLength = text.slice(endIndex).trim().length;
    if (
      !best
      || score > best.score
      || (
        score === best.score
        && (
          preferEarlierOnTie
            ? (
              index < best.startIndex
              || (index === best.startIndex && endIndex > best.endIndex)
            )
            : (
              trailingNonWhitespaceLength < best.trailingNonWhitespaceLength
              || (
                trailingNonWhitespaceLength === best.trailingNonWhitespaceLength
                && (
                  endIndex > best.endIndex
                  || (endIndex === best.endIndex && index < best.startIndex)
                )
              )
            )
        )
      )
    ) {
      best = { candidate, parsed, score, startIndex: index, endIndex, trailingNonWhitespaceLength };
    }
  }

  return best ? { candidate: best.candidate, parsed: best.parsed } : null;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isAnyJsonValue(value) {
  return value !== undefined;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isExpoFingerprintValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = /** @type {{ hash?: unknown; fingerprintHash?: unknown; sources?: unknown }} */ (value);
  const hash = String(record.hash ?? record.fingerprintHash ?? '').trim();
  return hash.length > 0 && Array.isArray(record.sources);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isEasBuildValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = /** @type {{ id?: unknown; buildId?: unknown; status?: unknown; platform?: unknown; createdAt?: unknown; buildDetailsPageUrl?: unknown; artifacts?: unknown; fingerprint?: unknown }} */ (value);
  const id = String(record.id ?? record.buildId ?? '').trim();
  if (!id) return false;
  return (
    String(record.status ?? '').trim().length > 0
    || String(record.platform ?? '').trim().length > 0
    || String(record.createdAt ?? '').trim().length > 0
    || String(record.buildDetailsPageUrl ?? '').trim().length > 0
    || (record.artifacts !== null && typeof record.artifacts === 'object')
    || (record.fingerprint !== null && typeof record.fingerprint === 'object')
  );
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function scoreEasBuildsValue(value) {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(isEasBuildValue) ? 2 : 0;
  }
  return isEasBuildValue(value) ? 2 : 0;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function scoreEasBuildListValue(value) {
  if (!Array.isArray(value) || !value.every(isEasBuildValue)) return 0;
  return 3;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function scoreEasBuildValue(value) {
  if (Array.isArray(value)) {
    return value.length === 1 && isEasBuildValue(value[0]) ? 2 : 0;
  }
  return isEasBuildValue(value) ? 2 : 0;
}

/**
 * @param {string} text
 * @returns {string}
 */
function formatSafeOutputPreview(text) {
  const redacted = String(text ?? '')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '<redacted>')
    .replace(SENSITIVE_JSON_PROPERTY_PATTERN, '$1$2$3$4<redacted>$6')
    .replace(SENSITIVE_LINE_ASSIGNMENT_PATTERN, '$1$2$3$4<redacted>')
  if (redacted.length <= OUTPUT_PREVIEW_MAX_LENGTH) return redacted;
  return `${redacted.slice(0, OUTPUT_PREVIEW_MAX_LENGTH)}... <truncated ${redacted.length - OUTPUT_PREVIEW_MAX_LENGTH} chars>`;
}

/**
 * Parse JSON from CLI output that may contain extra leading/trailing non-JSON lines.
 *
 * @param {string} raw
 * @param {string} label
 * @param {{ isExpectedValue?: (value: unknown) => boolean; scoreExpectedValue?: (value: unknown) => number; preferEarlierOnTie?: boolean }} [options]
 * @returns {any}
 */
export function parseJsonFromCommandOutput(raw, label, options = {}) {
  const text = String(raw ?? '').trim();
  if (!text) {
    throw new SyntaxError(`Expected JSON from ${label}, received empty output.`);
  }
  const scoreExpectedValue =
    options.scoreExpectedValue ??
    ((value) => (options.isExpectedValue ?? isAnyJsonValue)(value) ? 1 : 0);

  try {
    const parsed = JSON.parse(text);
    if (scoreExpectedValue(parsed) > 0) return parsed;
  } catch {
    // Fall through to mixed-output recovery below.
  }
  const candidate = extractAuthoritativeJsonBlock(text, scoreExpectedValue, options.preferEarlierOnTie === true);
  if (candidate) return candidate.parsed;

  throw new SyntaxError(`Expected JSON from ${label}, received: ${formatSafeOutputPreview(text)}`);
}

/**
 * Parse EAS fingerprint JSON from CLI output that may contain extra diagnostic JSON fragments.
 *
 * @param {string} raw
 * @param {string} label
 * @returns {{ hash?: string; fingerprintHash?: string; sources?: unknown[] }}
 */
export function parseExpoFingerprintFromCommandOutput(raw, label) {
  return parseJsonFromCommandOutput(raw, label, {
    isExpectedValue: isExpoFingerprintValue,
  });
}

/**
 * Parse EAS build/build:list/build:view JSON from CLI output that may contain diagnostic JSON fragments.
 *
 * @param {string} raw
 * @param {string} label
 * @returns {any[] | any}
 */
export function parseEasBuildsFromCommandOutput(raw, label) {
  return parseJsonFromCommandOutput(raw, label, {
    scoreExpectedValue: scoreEasBuildsValue,
    preferEarlierOnTie: true,
  });
}

/**
 * Parse EAS build:list JSON from CLI output that may contain diagnostic JSON fragments.
 *
 * @param {string} raw
 * @param {string} label
 * @returns {any[]}
 */
export function parseEasBuildListFromCommandOutput(raw, label) {
  return parseJsonFromCommandOutput(raw, label, {
    scoreExpectedValue: scoreEasBuildListValue,
    preferEarlierOnTie: true,
  });
}

/**
 * Parse EAS build:view JSON from CLI output that may contain diagnostic JSON fragments.
 *
 * @param {string} raw
 * @param {string} label
 * @returns {any}
 */
export function parseEasBuildFromCommandOutput(raw, label) {
  return parseJsonFromCommandOutput(raw, label, {
    scoreExpectedValue: scoreEasBuildValue,
    preferEarlierOnTie: true,
  });
}
