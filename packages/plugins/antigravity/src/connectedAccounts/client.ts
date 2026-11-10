import { ANTIGRAVITY_ACP_SERVER_VERSION } from '../agent/install/cliRuntime.js';

// ACP's product identity is required by Cloud Code Assist entitlement endpoints.
export const ANTIGRAVITY_CONTROL_PLANE_USER_AGENT = `antigravity/acp/${ANTIGRAVITY_ACP_SERVER_VERSION} (aidev_client; host_path=happier; proxy_client=antigravity/sdk)`;

export function readAntigravityProjectId(value: unknown): string | null {
  const id = value && typeof value === 'object' && !Array.isArray(value) ? Reflect.get(value, 'id') : value;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}
