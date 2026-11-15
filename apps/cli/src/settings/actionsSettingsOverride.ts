import { tryNormalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionsSettingsV1 } from '@happier-dev/protocol';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';

const ENV_KEY = 'HAPPIER_ACTIONS_SETTINGS_V1';
export function readActionsSettingsOverrideFromEnv(): ActionsSettingsV1 | null {
  const env = sessionProcessEnvironment();
  const raw = typeof env[ENV_KEY] === 'string' ? String(env[ENV_KEY]).trim() : '';
  if (!raw) return null;

  let parsedJson: unknown = null;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return null;
  }

  return tryNormalizeActionsSettingsV1(parsedJson);
}
