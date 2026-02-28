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
  const rawInput = params.pasted.trim();
  if (!rawInput) return { ok: false, error: 'invalid_url' };

  const tryParseCodeStatePaste = (text: string): { code: string; state: string } | null => {
    if (text.includes('://')) return null;
    const trimmed = text.trim();
    const match = trimmed.match(/^([^\s#]+)#([^\s#]+)$/);
    if (!match) return null;
    const code = match[1] ?? '';
    const state = match[2] ?? '';
    if (!code || !state) return null;
    return { code, state };
  };

  const codeState = tryParseCodeStatePaste(rawInput);
  if (codeState) {
    return { ok: true, code: codeState.code, state: codeState.state };
  }

  const tryParseUrl = (candidate: string): URL | null => {
    try {
      return new URL(candidate);
    } catch {
      return null;
    }
  };

  const tryExtractUrlFromText = (text: string): URL | null => {
    const match = text.match(/https?:\/\/\S+/i);
    if (!match?.[0]) return null;
    const cleaned = match[0].replace(/[)\].,;:'"]+$/, '');
    return tryParseUrl(cleaned);
  };

  const tryParseQuerystring = (text: string): URL | null => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (!trimmed.startsWith('?') && !trimmed.includes('code=') && !trimmed.includes('state=')) return null;
    const qs = trimmed.startsWith('?') ? trimmed : `?${trimmed.replace(/^\?+/, '')}`;
    try {
      return new URL(`http://localhost/callback${qs}`);
    } catch {
      return null;
    }
  };

  const url = tryParseUrl(rawInput) ?? tryExtractUrlFromText(rawInput) ?? tryParseQuerystring(rawInput);
  if (!url) return { ok: false, error: 'invalid_url' };

  const hashParams = (() => {
    const rawHash = url.hash ? url.hash.replace(/^#+/, '') : '';
    if (!rawHash) return new URLSearchParams();
    const normalized = rawHash.startsWith('?') ? rawHash.slice(1) : rawHash;
    try {
      return new URLSearchParams(normalized);
    } catch {
      return new URLSearchParams();
    }
  })();

  const code = url.searchParams.get('code') ?? hashParams.get('code');
  if (!code) return { ok: false, error: 'missing_code' };

  const state = url.searchParams.get('state') ?? hashParams.get('state');
  if (!state) return { ok: false, error: 'missing_state' };

  return { ok: true, code, state };
}
