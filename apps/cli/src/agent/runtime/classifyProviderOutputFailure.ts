export type ProviderOutputFailureClassification = Readonly<{
  authenticationError: boolean;
  providerStatusFailure: boolean;
}>;

const STRONG_AUTH_ERROR_PATTERNS = [
  /\bunauthori[sz]ed\b/u,
  /\bunauthenticated\b/u,
  /\bauthentication[_\s-]+(?:failed|failure|error|required|invalid)\b/u,
  /\bauth[_\s-]+(?:failed|failure|error|required|invalid)\b/u,
  /\binvalid[_\s-]+authentication(?:[_\s-]+error)?\b/u,
  /\b(?:failed|failure)\s+to\s+authenticate\b/u,
  /\b(?:invalid|missing|no)\s+api[_\s-]*key\b/u,
  /\bapi[_\s-]*key\s+(?:is\s+)?(?:invalid|missing|not\s+set|expired|rejected|required)\b/u,
  /\bnot\s+logged\s+in\b/u,
  /\blogin\s+required\b/u,
  /\b(?:failed\s+to\s+refresh\s+token|token\s+refresh\s+failed)\b/u,
  /\b(?:oauth|access|refresh|authentication)\s+token(?:\s+(?:has|was|is))?\s+(?:invalid|invalidated|expired|revoked|rejected|missing)\b/u,
  /\b(?:invalid|invalidated|expired|revoked|rejected|missing)\s+(?:(?:oauth|access|refresh|authentication)\s+)?token\b/u,
  /\btoken\s+(?:is\s+)?(?:invalid|invalidated|expired|revoked|rejected|missing)\b/u,
  /\b(?:openai|anthropic|codex|gemini|google)_(?:api|access)_key\b/u,
] as const;

const EXPLICIT_PROVIDER_STATUS_PATTERNS = [
  /\bhttp(?:\/\d(?:\.\d)?)?(?:\s+status)?\s*(?:=|:|-)?\s*([45]\d{2})\b/gu,
  /\bstatus\s*(?:code)?\s*(?:=|:|-)?\s*([45]\d{2})\b/gu,
  /\b(?:api\s+error|error\s+code)\s*(?:=|:|-)\s*([45]\d{2})\b/gu,
] as const;

/**
 * Classifies unstructured provider output conservatively, one logical record at a time.
 * Numeric values are not evidence by themselves: a status code must be attached to
 * an explicit HTTP/API/status marker, while strong authentication phrases stand alone.
 */
export function classifyProviderOutputFailure(text: string): ProviderOutputFailureClassification {
  let authenticationError = false;
  let providerStatusFailure = false;

  for (const rawRecord of text.split(/\r?\n/u)) {
    const record = rawRecord.trim().toLowerCase();
    if (!record) continue;

    if (STRONG_AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(record))) {
      authenticationError = true;
    }

    for (const pattern of EXPLICIT_PROVIDER_STATUS_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of record.matchAll(pattern)) {
        const status = Number(match[1]);
        providerStatusFailure = true;
        if (status === 401 || status === 403) authenticationError = true;
      }
    }
  }

  return { authenticationError, providerStatusFailure };
}
