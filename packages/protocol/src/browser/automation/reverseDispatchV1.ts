import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { ACTION_ID_FAMILIES_V1 } from '../../actions/actionIds.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { browserViewKey } from '../view/key.js';
import { BrowserViewV1Schema } from '../view/v1.js';
import { BrowserCommandDispatchResultV1Schema } from '../control/v1.js';
import { BrowserAutomationActionResultV1Schema, BrowserAutomationCancelActiveResultV1Schema, BrowserAutomationInterruptedResultV1Schema, BrowserAutomationTimelineV1Schema } from './v1.js';

/** A continuation of an already-admitted daemon Action, on the exact client-owned view. */
export const UiBrowserAutomationDispatchRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  sessionId: z.string().trim().min(1),
  actionId: z.enum([...ACTION_ID_FAMILIES_V1.browser_automation, 'browser.control.takeControl', 'browser.control.handBack']),
  input: z.unknown(),
  authority: z.enum(['present_user', 'account_automation']).optional(),
}).strict());
export type UiBrowserAutomationDispatchRequestV1 = z.infer<typeof UiBrowserAutomationDispatchRequestV1Schema>;

export const UiBrowserAutomationDispatchResultV1Schema = lazyZodSchema(() => z.union([
  BrowserCommandDispatchResultV1Schema,
  BrowserAutomationActionResultV1Schema,
  BrowserAutomationTimelineV1Schema,
  BrowserAutomationCancelActiveResultV1Schema,
  BrowserAutomationInterruptedResultV1Schema,
  z.object({ ok: z.literal(false), errorCode: z.string().min(1), error: z.string().min(1) }).strict(),
]));

/** The existing RPC room is view-addressed so another tab cannot answer for this view. */
export function uiBrowserAutomationDispatchMethod(view: Readonly<{ browserSessionId: string; viewId: string }>): string {
  return `${RPC_METHODS.UI_BROWSER_AUTOMATION_DISPATCH}.${encodeURIComponent(JSON.stringify(browserViewKey(view)))}`;
}

export function isUiBrowserAutomationDispatchMethod(method: string): boolean {
  const prefix = `${RPC_METHODS.UI_BROWSER_AUTOMATION_DISPATCH}.`;
  return method.startsWith(prefix) && method.length > prefix.length;
}

// Each UTF-16 unit needs at most nine URI characters after JSON escaping. Include both
// length prefixes and the encoded JSON quotes; the view identity schemas own the lengths.
const sessionIdMax = BrowserViewV1Schema.shape.browserSessionId.maxLength ?? 0;
const viewIdMax = BrowserViewV1Schema.shape.viewId.maxLength ?? 0;
export const UI_BROWSER_AUTOMATION_DISPATCH_KEY_MAX_LENGTH =
  9 * (sessionIdMax + viewIdMax + String(sessionIdMax).length + String(viewIdMax).length + 2) + 6;
