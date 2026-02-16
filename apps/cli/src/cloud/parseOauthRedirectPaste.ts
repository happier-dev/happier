/**
 * OAuth redirect paste parser
 *
 * Implements the "headless OAuth" UX where a user completes the browser login on another machine and
 * pastes the final redirected callback URL into the terminal. We only extract `code` + `state`.
 */

export type ParseOauthRedirectPasteResult =
  | Readonly<{ ok: true; code: string; state: string }>
  | Readonly<{ ok: false; error: 'invalid_url' | 'missing_code' | 'missing_state' }>;

export function parseOauthRedirectPaste(params: Readonly<{ pasted: string }>): ParseOauthRedirectPasteResult {
  const raw = params.pasted.trim();
  if (!raw) return { ok: false, error: 'invalid_url' };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }

  const code = url.searchParams.get('code');
  if (!code) return { ok: false, error: 'missing_code' };

  const state = url.searchParams.get('state');
  if (!state) return { ok: false, error: 'missing_state' };

  return { ok: true, code, state };
}

