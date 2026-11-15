import { isRecord } from '../../common/records.js';
import { normalizeTelemetryDataKey } from '../../common/sensitiveKeys.js';
import { isForbiddenBrowserEgressKey } from '../diagnostics/egress/keyRejection.js';
import { stripUrlValuesInString } from '../diagnostics/egress/url.js';

// Presentation-only pointer label; full element metadata and executable locators stay separate.
export const BROWSER_AUTOMATION_TARGET_LABEL_MAX_LENGTH = 512;

export function redactBrowserAutomationTargetLabel(value: string): string | undefined {
  const label = stripUrlValuesInString(value).replace(/\s+/gu, ' ').trim()
    .slice(0, BROWSER_AUTOMATION_TARGET_LABEL_MAX_LENGTH);
  return label || undefined;
}

function compactKey(key: string): string {
  return normalizeTelemetryDataKey(key).replaceAll('-', '');
}

function lengthKeyFor(key: string): string | null {
  const compact = compactKey(key);
  if (compact === 'text' || compact === 'typedtext' || compact === 'value' || compact === 'expression') {
    return `${compact}Length`;
  }
  return null;
}

type BrowserAutomationDetailRedactionOptions = Readonly<{
  preserveLocatorValues: boolean;
}>;

function locatorNeedsRedaction(value: unknown): boolean {
  if (typeof value === 'string') return stripUrlValuesInString(value) !== value;
  if (Array.isArray(value)) return value.some(locatorNeedsRedaction);
  if (isRecord(value)) return Object.entries(value).some(([key, nested]) => isForbiddenBrowserEgressKey(key) || locatorNeedsRedaction(nested));
  return false;
}

function redactRecord(
  value: Record<string, unknown>,
  options: BrowserAutomationDetailRedactionOptions,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  let projectedTruncated = false;
  for (const [key, nested] of Object.entries(value)) {
    const compact = compactKey(key);
    if (isForbiddenBrowserEgressKey(key)) {
      continue;
    }

    if (compact === 'selector' || compact === 'locator' || compact === 'cssselector') {
      if (!options.preserveLocatorValues) {
        redacted[`${compact}Available`] = typeof nested === 'string' ? nested.length > 0 : isRecord(nested);
      } else if (locatorNeedsRedaction(nested)) {
        // A sanitized locator would select a different target. Omit it rather than lie about
        // executable data, while retaining the same URL/secret egress floor as every result.
        redacted[`${compact}Available`] = false;
        projectedTruncated = true;
      } else {
        redacted[key] = redactBrowserAutomationDetails(nested, options);
      }
      continue;
    }

    if (typeof nested === 'string') {
      const lengthKey = lengthKeyFor(key);
      if (lengthKey && !options.preserveLocatorValues) {
        redacted[lengthKey] = nested.length;
        continue;
      }
      // L2-3: URL redaction classifies by VALUE SHAPE — every string is inspected regardless of
      // its key, so a token URL under `href`/`src`/an arbitrary key never reaches the timeline.
      const safeValue = stripUrlValuesInString(nested);
      redacted[key] = safeValue;
      continue;
    }

    redacted[key] = redactBrowserAutomationDetails(nested, options);
  }
  if (projectedTruncated) redacted.truncated = true;
  return redacted;
}

function redactBrowserAutomationDetails(
  value: unknown,
  options: BrowserAutomationDetailRedactionOptions,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactBrowserAutomationDetails(item, options));
  }
  if (isRecord(value)) {
    return redactRecord(value, options);
  }
  if (typeof value === 'string') {
    return stripUrlValuesInString(value);
  }
  return value;
}

// Preserve the optional argument for existing callers without imposing a projection depth.
export function redactBrowserAutomationTimelineDetails(value: unknown, _depth = 0): unknown {
  return redactBrowserAutomationDetails(value, { preserveLocatorValues: false });
}

export function redactBrowserAutomationActionResultDetails(value: unknown): unknown {
  return redactBrowserAutomationDetails(value, { preserveLocatorValues: true });
}
