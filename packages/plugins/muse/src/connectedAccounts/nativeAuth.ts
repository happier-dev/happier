export type MuseNativeMetaAuth = Readonly<{
  access_token: string; api_key: string; api_base_url: string; obtained_via: string;
  mechanism?: string; expires_at?: number; subs_active?: boolean;
  user_email?: string | null; user_full_name?: string | null;
}>;
export type MuseNativeAuth = Readonly<{ schema_version: 1; providers: Readonly<{ meta: MuseNativeMetaAuth }> }>;
export type MuseNativeAuthResult =
  | Readonly<{ status: 'supported'; auth: MuseNativeAuth; mode: 'accountLogin' | 'apiKey' }>
  | Readonly<{ status: 'invalid' | 'unsupported' }>;
export function museRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonBlank(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

/** Muse 1.4.14 native parser evidence: schema/source are required, mechanism controls mode. */
export function parseMuseNativeAuth(value: unknown): MuseNativeAuthResult {
  const root = museRecord(value);
  if (!root || root.schema_version === undefined) return { status: 'invalid' };
  if (root.schema_version !== 1) return { status: 'unsupported' };
  const meta = museRecord(museRecord(root.providers)?.meta);
  if (!meta || !nonBlank(meta.access_token) || !nonBlank(meta.api_key)
    || !nonBlank(meta.api_base_url) || !nonBlank(meta.obtained_via)
    || (meta.mechanism !== undefined && typeof meta.mechanism !== 'string')
    || (meta.expires_at !== undefined && (typeof meta.expires_at !== 'number' || !Number.isFinite(meta.expires_at)))
    || (meta.subs_active !== undefined && typeof meta.subs_active !== 'boolean')
    || (meta.user_email !== undefined && meta.user_email !== null && typeof meta.user_email !== 'string')
    || (meta.user_full_name !== undefined && meta.user_full_name !== null && typeof meta.user_full_name !== 'string')) return { status: 'invalid' };
  const auth = buildMuseNativeAuth({
    access_token: meta.access_token, api_key: meta.api_key, api_base_url: meta.api_base_url, obtained_via: meta.obtained_via,
    ...(typeof meta.mechanism === 'string' ? { mechanism: meta.mechanism } : {}),
    ...(typeof meta.expires_at === 'number' ? { expires_at: meta.expires_at } : {}),
    ...(typeof meta.subs_active === 'boolean' ? { subs_active: meta.subs_active } : {}),
    ...(meta.user_email === null || typeof meta.user_email === 'string' ? { user_email: meta.user_email } : {}),
    ...(meta.user_full_name === null || typeof meta.user_full_name === 'string' ? { user_full_name: meta.user_full_name } : {}),
  });
  return { status: 'supported', auth, mode: meta.mechanism === 'oauth' ? 'accountLogin' : 'apiKey' };
}
export function buildMuseNativeAuth(meta: MuseNativeMetaAuth): MuseNativeAuth { return { schema_version: 1, providers: { meta } }; }
