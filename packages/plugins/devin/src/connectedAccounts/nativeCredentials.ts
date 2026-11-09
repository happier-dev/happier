/** Devin 3000.12.32 CredentialsFile; confirmed with its unauthenticated TOML loader. */
export const DEVIN_NATIVE_GENERATION = 'devin-credentials-toml-v1';
export const DEVIN_NATIVE_FILE = 'devin/credentials.toml';
export const DEVIN_SESSION_PREFIX = 'devin-session-token$';
export const DEVIN_DEFAULT_API_SERVER = 'https://server.codeium.com';
export const DEVIN_SESSION_METADATA = { devin_webapp_host: 'app.devin.ai', devin_api_url: 'https://api.devin.ai' } as const;
export type DevinNativeMetadata = Readonly<{
  devin_webapp_host?: string;
  devin_api_url?: string;
  dangerously_skip_plugin_authentication?: boolean;
}>;
export type DevinNativeCredential = Readonly<{
  generation: typeof DEVIN_NATIVE_GENERATION;
  mode: 'session' | 'enterprise';
  token: string;
  apiServerUrl: string;
  metadata: DevinNativeMetadata;
}>;
export function devinApiBase(value: unknown): string | null {
  try {
    const url = new URL(typeof value === 'string' ? value.trim() : '');
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      ? url.href.replace(/\/$/u, '') : null;
  } catch { return null; }
}
const fields = ['windsurf_api_key', 'api_server_url', 'devin_webapp_host', 'devin_api_url', 'dangerously_skip_plugin_authentication'] as const;

/** Unknown fields/generations stop import rather than silently losing native auth semantics. */
export function parseDevinNativeCredentials(value: unknown): DevinNativeCredential | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !fields.some(field => field === key))) return null;
  const token = typeof row.windsurf_api_key === 'string' ? row.windsurf_api_key.trim() : '';
  const base = row.api_server_url === undefined ? DEVIN_DEFAULT_API_SERVER : devinApiBase(row.api_server_url);
  if (!token || !base || (token === DEVIN_SESSION_PREFIX)) return null;
  if (row.devin_webapp_host !== undefined && (typeof row.devin_webapp_host !== 'string'
    || !row.devin_webapp_host || devinApiBase(`https://${row.devin_webapp_host}`) !== `https://${row.devin_webapp_host}`)) return null;
  if (row.devin_api_url !== undefined && !devinApiBase(row.devin_api_url)) return null;
  if (row.dangerously_skip_plugin_authentication !== undefined && typeof row.dangerously_skip_plugin_authentication !== 'boolean') return null;
  return { generation: DEVIN_NATIVE_GENERATION, token, apiServerUrl: base,
    mode: token.startsWith(DEVIN_SESSION_PREFIX) ? 'session' : 'enterprise',
    metadata: {
      ...(typeof row.devin_webapp_host === 'string' ? { devin_webapp_host: row.devin_webapp_host } : {}),
      ...(typeof row.devin_api_url === 'string' ? { devin_api_url: row.devin_api_url } : {}),
      ...(typeof row.dangerously_skip_plugin_authentication === 'boolean' ? { dangerously_skip_plugin_authentication: row.dangerously_skip_plugin_authentication } : {}),
    } };
}

/** One pure codec; the existing native-home owner writes and cleans the returned bytes. */
export function serializeDevinSelectedCredentials(credential: DevinNativeCredential): Uint8Array {
  const record = { windsurf_api_key: credential.token, api_server_url: credential.apiServerUrl, ...credential.metadata };
  return new TextEncoder().encode(Object.entries(record).map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`).join(''));
}
