import { isOpenCodeSupportedAuthServiceId } from './selection.js';

export const OPENCODE_RESTART_REMATERIALIZE_REQUIRED_REASON =
  'opencode_restart_rematerialize_required';

export function shouldOpenCodeRestartForServiceSwitch(serviceId: unknown): boolean {
  return isOpenCodeSupportedAuthServiceId(serviceId);
}
