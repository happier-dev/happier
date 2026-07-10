import { isRecord } from '../../common/records.js';
import { normalizeTelemetryDataKey } from '../../common/sensitiveKeys.js';
import { isForbiddenBrowserEgressKey } from '../diagnostics/egress/keyRejection.js';
import { stripUrlValuesInString } from '../diagnostics/egress/url.js';

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

function redactRecord(
  value: Record<string, unknown>,
  depth: number,
  options: BrowserAutomationDetailRedactionOptions,
): Record<string, unknown> {
  if (depth > 8) {
    return { truncated: true };
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const compact = compactKey(key);
    if (isForbiddenBrowserEgressKey(key)) {
      continue;
    }

    if (typeof nested === 'string') {
      const lengthKey = lengthKeyFor(key);
      if (lengthKey) {
        redacted[lengthKey] = nested.length;
        continue;
      }
      if (compact === 'selector' || compact === 'locator' || compact === 'cssselector') {
        if (options.preserveLocatorValues) {
          redacted[key] = nested.slice(0, 256);
          continue;
        }
        redacted[`${compact}Available`] = nested.length > 0;
        continue;
      }
      // L2-3: URL redaction classifies by VALUE SHAPE — every string is inspected regardless of
      // its key, so a token URL under `href`/`src`/an arbitrary key never reaches the timeline.
      redacted[key] = stripUrlValuesInString(nested).slice(0, 256);
      continue;
    }

    redacted[key] = redactBrowserAutomationDetails(nested, depth + 1, options);
  }
  return redacted;
}

function redactBrowserAutomationDetails(
  value: unknown,
  depth: number,
  options: BrowserAutomationDetailRedactionOptions,
): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => redactBrowserAutomationDetails(item, depth + 1, options));
  }
  if (isRecord(value)) {
    return redactRecord(value, depth, options);
  }
  if (typeof value === 'string') {
    return stripUrlValuesInString(value).slice(0, 256);
  }
  return value;
}

export function redactBrowserAutomationTimelineDetails(value: unknown, depth = 0): unknown {
  return redactBrowserAutomationDetails(value, depth, { preserveLocatorValues: false });
}

export function redactBrowserAutomationActionResultDetails(value: unknown): unknown {
  return redactBrowserAutomationDetails(value, 0, { preserveLocatorValues: true });
}
