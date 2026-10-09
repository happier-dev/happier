export type OauthAuthorizationResponse =
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'rawAuthorizationCode'; code: string }>
  | Readonly<{ kind: 'codeState'; code: string; state: string }>
  | Readonly<{ kind: 'callback'; code?: string; state?: string; error?: string }>;

function parseUrl(value: string, base?: URL): URL | null {
  try { return base ? new URL(value, base) : new URL(value); } catch { return null; }
}

function isOpaqueAuthorizationCode(value: string): boolean {
  return !/^[\/\\]/.test(value) && !/[\s?#&=:]/.test(value);
}

function isLoopbackHostname(hostname: string): boolean {
  const raw = hostname.toLowerCase();
  const host = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0:0:0:0:0:0:0:1';
}

function callbackMatches(url: URL, redirect: URL): boolean {
  const port = (value: URL) => value.port || (value.protocol === 'https:' ? '443' : value.protocol === 'http:' ? '80' : '');
  const path = (value: URL) => value.pathname.length > 1 ? value.pathname.replace(/\/+$/, '') : value.pathname;
  const originMatches = url.origin === redirect.origin || (
    url.protocol === redirect.protocol && port(url) === port(redirect)
    && isLoopbackHostname(url.hostname) && isLoopbackHostname(redirect.hostname)
  );
  return originMatches && path(url) === path(redirect);
}

/** Shared interpretation only. Callers own provider admission, attempt state and PKCE. */
export function parseOauthAuthorizationResponse(params: Readonly<{
  input: string;
  redirectUri?: string;
  allowRawAuthorizationCode?: boolean;
  /** The CLI also accepts a copied query without a callback URL. */
  allowQueryString?: boolean;
}>): OauthAuthorizationResponse {
  const input = params.input.trim();
  if (!input) return { kind: 'invalid' };
  const redirect = params.redirectUri === undefined ? null : parseUrl(params.redirectUri.trim());
  if (params.redirectUri !== undefined && !redirect) return { kind: 'invalid' };

  const absoluteUrl = parseUrl(input);
  const embeddedUrl = input.match(/https?:\/\/\S+/i)?.[0];
  const extractedUrl = embeddedUrl ? parseUrl(embeddedUrl.replace(/[)\].,;:'"]+$/, '')) : null;
  let url = absoluteUrl ?? extractedUrl;
  if (!url) {
    // A code#state value is distinct from a URL and retains its actual returned state.
    const codeState = input.match(/^([^\s#]+)#([^\s#]+)$/);
    if (codeState && isOpaqueAuthorizationCode(codeState[1]!)) {
      return { kind: 'codeState', code: codeState[1]!, state: codeState[2]! };
    }
    // A manual code is opaque, but URL/query/fragment delimiters and pasted prose
    // must never turn a failed callback validation into a raw-code interpretation.
    if (params.allowRawAuthorizationCode === true && isOpaqueAuthorizationCode(input)) {
      return { kind: 'rawAuthorizationCode', code: input };
    }
    // A callback path containing a query is still a URL; do not reconstruct it
    // against the expected origin just because one of its parameters is code.
    if (params.allowQueryString && (input.startsWith('?') || /^[^/?#\\\s=]+=/.test(input))) {
      const query = input.startsWith('?') ? input : `?${input.replace(/^\?+/, '')}`;
      url = parseUrl(query, redirect ?? new URL('http://localhost/callback'));
    } else if (redirect) {
      url = parseUrl(input, redirect);
    }
  }
  if (!url || (redirect && !callbackMatches(url, redirect))) return { kind: 'invalid' };
  const fragment = url.hash.replace(/^#+/, '').replace(/^\?/, '');
  const hash = new URLSearchParams(fragment);
  const code = url.searchParams.get('code') || hash.get('code') || undefined;
  const state = url.searchParams.get('state') || hash.get('state') || undefined;
  const error = url.searchParams.get('error') || hash.get('error') || undefined;
  return { kind: 'callback', ...(code ? { code } : {}), ...(state ? { state } : {}), ...(error ? { error } : {}) };
}
