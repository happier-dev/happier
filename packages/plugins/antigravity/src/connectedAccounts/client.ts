// Cloud Code Assist entitlement endpoints identify the calling product by this
// user agent. It is a wire value that predates the native-only runtime, not a
// runtime selector: keep it until Google publishes a replacement for clients.
export const ANTIGRAVITY_CONTROL_PLANE_USER_AGENT = 'antigravity/acp/1.3.0 (aidev_client; host_path=happier; proxy_client=antigravity/sdk)';

export function readAntigravityProjectId(value: unknown): string | null {
  const id = value && typeof value === 'object' && !Array.isArray(value) ? Reflect.get(value, 'id') : value;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}
