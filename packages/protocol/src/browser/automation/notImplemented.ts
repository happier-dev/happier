import type { z } from 'zod';

import { BrowserAutomationActionKindV1Schema } from './v1.js';

/**
 * The automation verbs the product declares on the wire but does not execute.
 *
 * G19: the daemon refuses these up front (`daemon/browser/automation/service.ts`
 * `NOT_IMPLEMENTED_ACTIONS` -> `not_implemented`), and the server must therefore not advertise them
 * in `capabilities.browser.automation.supportedActions`. That was previously a hand-maintained
 * second copy of the list on the server, three files away from the daemon's, with no tie between
 * them: `as const satisfies readonly BrowserAutomationActionKindV1[]` rejects an *invalid* member
 * but is blind to an *omitted* one, so every verb added to the action union since silently stopped
 * being published.
 *
 * This is the single owner. Both the daemon's refusal and the server's published capability derive
 * from it, so a verb can never be refused-but-advertised or implemented-but-hidden.
 */
export const BROWSER_AUTOMATION_NOT_IMPLEMENTED_ACTION_KINDS = [
  'evaluate',
  'startElementPicker',
  'cancelElementPicker',
] as const;

/**
 * Every automation verb an agent can actually dispatch — the action union minus
 * {@link BROWSER_AUTOMATION_NOT_IMPLEMENTED_ACTION_KINDS}. Derived from the schema, so a verb added
 * to the union is published automatically and a verb removed from it stops being published.
 */
export const BrowserAutomationImplementedActionKindV1Schema =
  BrowserAutomationActionKindV1Schema.exclude(BROWSER_AUTOMATION_NOT_IMPLEMENTED_ACTION_KINDS);
export type BrowserAutomationImplementedActionKindV1 = z.infer<
  typeof BrowserAutomationImplementedActionKindV1Schema
>;
