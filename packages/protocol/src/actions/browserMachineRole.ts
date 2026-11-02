import type { BrowserAutomationActionRequestV1 } from '../browser/automation/v1.js';
import { BrowserHttpUrlV1Schema } from '../browser/url.js';
import type { MachineAccessRoleV1 } from '../machines/machineAccessV1.js';
import { isBrowserExtensionMutationActionIdV1 } from './actionIds.js';

/** Shared browser Action admission policy, consumed at server and Session ingress.
 * The server can decide Action-level custody without content. When navigation
 * content is available, the daemon also applies the privileged-URL requirement.
 * Input validation/defaults and Chromium's redirect policy retain their owners.
 */
export function requiredMachineRoleForBrowserAction(actionId: string, input?: unknown): MachineAccessRoleV1 {
  if (isBrowserExtensionMutationActionIdV1(actionId)) return 'manage';
  if (actionId !== 'browser.automation.navigate') return 'use';

  const url = (input as BrowserAutomationActionRequestV1 | undefined)?.payload?.url;
  if (typeof url !== 'string') return 'use';
  return BrowserHttpUrlV1Schema.safeParse(url).success || url.trim() === 'about:blank' ? 'use' : 'manage';
}
