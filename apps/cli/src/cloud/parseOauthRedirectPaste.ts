import { parseOauthAuthorizationResponse } from '@happier-dev/protocol';

export type ParseOauthRedirectPasteResult =
  | Readonly<{ ok: true; code: string; state: string; rawAuthorizationCode?: false }>
  | Readonly<{ ok: true; code: string; state?: never; rawAuthorizationCode: true }>
  | Readonly<{ ok: false; error: 'invalid_url' | 'missing_code' | 'missing_state' }>;

/** Terminal-facing error contract over the shared OAuth response interpreter. */
export function parseOauthRedirectPaste(params: Readonly<{
  pasted: string;
  redirectUri?: string;
  allowRawAuthorizationCode?: boolean;
}>): ParseOauthRedirectPasteResult {
  const parsed = parseOauthAuthorizationResponse({
    input: params.pasted,
    redirectUri: params.redirectUri,
    allowRawAuthorizationCode: params.allowRawAuthorizationCode,
    allowQueryString: true,
  });
  if (parsed.kind === 'invalid') return { ok: false, error: 'invalid_url' };
  if (parsed.kind === 'callback' && parsed.error) return { ok: false, error: 'invalid_url' };
  if (parsed.kind === 'rawAuthorizationCode') {
    return { ok: true, code: parsed.code, rawAuthorizationCode: true };
  }
  if (!parsed.code) return { ok: false, error: 'missing_code' };
  if (!parsed.state) return { ok: false, error: 'missing_state' };
  return { ok: true, code: parsed.code, state: parsed.state };
}
