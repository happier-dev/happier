import type { z } from 'zod';

import { isRecord } from '../../../common/records.js';
import {
  isUnsafeTelemetryDataKey,
  normalizeTelemetryDataKey,
} from '../../../common/sensitiveKeys.js';

/**
 * Canonical browser-egress key rejector (RU2 capstone L2-4).
 *
 * Root cause: three near-clone rejectors (`browser/diagnostics/redaction.ts`,
 * `browser/context/redaction.ts`, `browser/automation/redaction.ts`) had DIVERGENT forbidden-key
 * sets — automation rejected inline screenshots/DOM snapshots/storage dumps, the other two
 * accepted them. This module is the ONE owner with the SUPERSET list; the diagnostics, context,
 * and automation schemas all refine through it. Do not add a second rejector — extend
 * `isForbiddenBrowserEgressKey` here.
 */

// Bulk-payload key fragments (compact form: lowercased, separators removed) that must never
// appear in any agent/remote-bound browser payload, in addition to the shared unsafe-telemetry
// keys (bodies, cookies, tokens, storage values — see common/sensitiveKeys.ts).
const FORBIDDEN_EGRESS_KEY_FRAGMENTS = [
  'screenshotdatauri',
  'diagnosticsbundle',
  'domsnapshot',
  'localstorage',
  'sessionstorage',
] as const;

export function isForbiddenBrowserEgressKey(key: string): boolean {
  if (isUnsafeTelemetryDataKey(key)) return true;
  const compact = normalizeTelemetryDataKey(key).replaceAll('-', '');
  return FORBIDDEN_EGRESS_KEY_FRAGMENTS.some((fragment) => compact.includes(fragment));
}

const DEFAULT_REJECTION_MESSAGE =
  'Browser egress payloads must not contain inline screenshots, diagnostics bundles, DOM snapshots, bodies, payloads, cookies, tokens, or storage values.';

export type RejectUnsafeBrowserEgressKeysOptions = Readonly<{
  message?: string;
  path?: readonly (string | number)[];
}>;

/**
 * Recursively reject any record key that matches the forbidden superset. Used as a zod
 * `superRefine` walker by every browser payload schema that can reach an agent timeline,
 * an agent context, or a remote snapshot.
 */
export function rejectUnsafeBrowserEgressKeys(
  value: unknown,
  context: z.RefinementCtx,
  options: RejectUnsafeBrowserEgressKeysOptions = {},
): void {
  const path = options.path ?? [];
  const message = options.message ?? DEFAULT_REJECTION_MESSAGE;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectUnsafeBrowserEgressKeys(item, context, { message, path: [...path, index] }));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, nested] of Object.entries(value)) {
    if (isForbiddenBrowserEgressKey(key)) {
      context.addIssue({
        code: 'custom',
        path: [...path, key],
        message,
      });
      continue;
    }
    rejectUnsafeBrowserEgressKeys(nested, context, { message, path: [...path, key] });
  }
}
