import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { ACTION_ID_FAMILIES_V1 } from '../../actions/actionIds.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { browserViewKey } from '../view/key.js';
import { BROWSER_VIEW_ID_MAX_LENGTH } from '../view/v1.js';
import { BrowserCommandDispatchResultV1Schema } from '../control/v1.js';
import { BrowserAutomationActionResultV1Schema, BrowserAutomationCancelActiveResultV1Schema, BrowserAutomationInterruptedResultV1Schema, BrowserAutomationTimelineV1Schema } from './v1.js';
import { BrowserDiagnosticsEvalResultV1Schema, BrowserDiagnosticsGetPropertiesResultV1Schema, BrowserDiagnosticsReleaseObjectGroupResultV1Schema, BrowserDiagnosticsElementPickerResultV1Schema } from '../diagnostics/v1.js';

/** Interactive verbs with an actual mounted injected-engine producer. */
export const MOUNTED_BROWSER_DIAGNOSTICS_ACTION_IDS = [
  'browser.diagnostics.eval', 'browser.diagnostics.getProperties', 'browser.diagnostics.releaseObjectGroup',
  'browser.diagnostics.elementPicker.start', 'browser.diagnostics.elementPicker.cancel',
] as const;

/** BrowserCommands addressing an existing view, whether daemon- or App-owned. */
export const EXISTING_VIEW_BROWSER_CONTROL_ACTION_IDS = [
  'browser.control.takeControl', 'browser.control.handBack', 'browser.view.close', 'browser.view.focus',
  'browser.view.setViewport',
  'browser.target.set', 'browser.navigate', 'browser.reload', 'browser.goBack', 'browser.goForward', 'browser.stop',
] as const;

/** A continuation of an already-admitted daemon Action, on the exact client-owned view. */
export const UiBrowserAutomationDispatchRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sessionId: z.string().check(z.trim(), z.minLength(1)),
  actionId: z.enum([...ACTION_ID_FAMILIES_V1.browser_automation, ...MOUNTED_BROWSER_DIAGNOSTICS_ACTION_IDS, ...EXISTING_VIEW_BROWSER_CONTROL_ACTION_IDS, 'browser.view.openExternal', 'browser.view.openDevtools']),
  input: z.unknown(),
  authority: z.optional(z.enum(['present_user', 'account_automation'])),
}));
export type UiBrowserAutomationDispatchRequestV1 = z.infer<typeof UiBrowserAutomationDispatchRequestV1Schema>;

export const UiBrowserAutomationDispatchResultV1Schema = lazyZodSchema(() => z.union([
  BrowserCommandDispatchResultV1Schema,
  BrowserAutomationActionResultV1Schema,
  BrowserAutomationTimelineV1Schema,
  BrowserAutomationCancelActiveResultV1Schema,
  BrowserAutomationInterruptedResultV1Schema,
  BrowserDiagnosticsEvalResultV1Schema,
  BrowserDiagnosticsGetPropertiesResultV1Schema,
  BrowserDiagnosticsReleaseObjectGroupResultV1Schema,
  BrowserDiagnosticsElementPickerResultV1Schema,
  z.strictObject({ ok: z.literal(false), errorCode: z.string().check(z.minLength(1)), error: z.string().check(z.minLength(1)) }),
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
export const UI_BROWSER_AUTOMATION_DISPATCH_KEY_MAX_LENGTH =
  9 * (2 * BROWSER_VIEW_ID_MAX_LENGTH + 2 * String(BROWSER_VIEW_ID_MAX_LENGTH).length + 2) + 6;
