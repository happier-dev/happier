/** Sealed xAI credential content. Native identity/configuration never becomes Account metadata. */
export type XaiCredential = Readonly<{
  mode: 'subscription' | 'api-key';
  accessToken: string;
  refreshToken?: string;
  expiresAtMs?: number;
  tokenType?: string;
  scope?: string;
  issuer?: string;
  tokenEndpoint?: string;
  clientId?: string;
  subject?: string;
  email?: string;
  native?: Readonly<Record<string, unknown>>;
}>;

export function readXaiCredential(content: string | null): XaiCredential {
  let value: unknown = null;
  if (content !== null) {
    try { value = JSON.parse(content); }
    catch { throw new Error('xAI credential unavailable'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('xAI credential unavailable');
  const row = value as Record<string, unknown>;
  if ((row.mode !== 'subscription' && row.mode !== 'api-key') || typeof row.accessToken !== 'string' || !row.accessToken.trim()) {
    throw new Error('xAI credential mode or access material unavailable');
  }
  for (const field of ['refreshToken', 'tokenType', 'scope', 'issuer', 'tokenEndpoint', 'clientId', 'subject', 'email']) {
    if (row[field] !== undefined && typeof row[field] !== 'string') throw new Error('Invalid xAI credential field');
  }
  if (row.expiresAtMs !== undefined && (typeof row.expiresAtMs !== 'number' || !Number.isFinite(row.expiresAtMs))) throw new Error('Invalid xAI credential expiry');
  if (row.native !== undefined && (!row.native || typeof row.native !== 'object' || Array.isArray(row.native))) throw new Error('Invalid xAI native credential facts');
  // Parsed at the sealed-storage boundary; all fields above are validated here.
  return row as XaiCredential;
}
