import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionsSettingsV1 } from '@happier-dev/protocol';

import type { RuntimeActionSettingsProvider } from './actionsSettingsProvider';

/**
 * Binds a restricted runtime to the policy reviewed for that exact launch.
 * It deliberately does not consult environment or Account settings and cannot
 * expose an Account settings reader to Action consumers.
 */
export function createScopedRuntimeActionSettingsProvider(
  reviewed: ActionsSettingsV1,
): RuntimeActionSettingsProvider {
  // Parse again at this custody boundary. Callers can construct a structurally
  // valid TypeScript value without Zod defaults, while runtime policy readers
  // consume the complete canonical shape. The clone also prevents later
  // caller mutation from retargeting the reviewed launch policy.
  const settings = ActionsSettingsV1Schema.parse(structuredClone(reviewed));
  return Object.freeze({
    getActionsSettings: () => structuredClone(settings),
  });
}
