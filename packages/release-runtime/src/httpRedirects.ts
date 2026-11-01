/** Each hop is inspected before credentials or a secret body can be forwarded. */
// Axios/follow-redirects' existing default budget; fetch inspects each manual response.
export const CREDENTIAL_REQUEST_REDIRECT_POLICY = Object.freeze({ maxRedirects: 21, redirect: 'manual' } as const);

export class CredentialRequestRedirectError extends Error {
  readonly code = 'credential_request_redirect_refused';
  readonly retryable = false;
  readonly response: Readonly<{ status: number }>;

  constructor(readonly status: number) {
    super('The HTTP redirect cannot safely forward this request.');
    this.name = 'CredentialRequestRedirectError';
    // Never retain a response, request config, Location, headers, or transport cause.
    this.response = Object.freeze({ status });
  }
}

export function assertCredentialRequestRedirectAllowed(status: number, responseType?: string): void {
  // Conditional reads may legitimately return 304 without redirecting.
  if ((status >= 300 && status < 400 && status !== 304) || responseType === 'opaqueredirect') {
    throw new CredentialRequestRedirectError(status);
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'cookie2']);
const BODY_HEADERS = new Set(['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length', 'transfer-encoding']);

export function isCredentialRequestHeader(name: string, privateNames?: ReadonlySet<string>): boolean {
  const normalized = name.trim().toLowerCase();
  return CREDENTIAL_HEADERS.has(normalized) || privateNames?.has(normalized) === true;
}

/** Shared decision for fetch, Axios and plugin transports; no request data enters errors. */
export function resolveCredentialRequestRedirect(params: Readonly<{
  status: number;
  requestUrl: string;
  location: string | null;
  method: string;
  headers: Readonly<Record<string, string>>;
  hasSecretBody: boolean;
  privateCredentialHeaderNames?: ReadonlySet<string>;
  containsRegisteredSecret?(value: string): boolean;
}>): Readonly<{ url: string; method: string; headers: Record<string, string>; dropBody: boolean; crossOrigin: boolean }> | undefined {
  if (!REDIRECT_STATUSES.has(params.status) || params.location === null) return;
  let destination: URL;
  let source: URL;
  try {
    source = new URL(params.requestUrl);
    destination = new URL(params.location, source);
    if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) {
      throw new Error('Invalid redirect destination');
    }
    if (!params.location.includes('#')) destination.hash = source.hash;
  } catch {
    throw new CredentialRequestRedirectError(params.status);
  }
  const crossOrigin = source.origin !== destination.origin;
  const method = params.method.toUpperCase();
  const dropBody = ((params.status === 301 || params.status === 302) && method === 'POST')
    || (params.status === 303 && method !== 'GET' && method !== 'HEAD');
  if (crossOrigin && !dropBody && params.hasSecretBody) {
    throw new CredentialRequestRedirectError(params.status);
  }
  const headers = Object.fromEntries(Object.entries(params.headers).filter(([name, value]) => {
    const normalized = name.toLowerCase();
    return !(dropBody && BODY_HEADERS.has(normalized))
      && !(crossOrigin && (normalized === 'host' || isCredentialRequestHeader(normalized, params.privateCredentialHeaderNames)
        || params.containsRegisteredSecret?.(value) === true));
  }));
  return { url: destination.href, method: dropBody ? 'GET' : method, headers, dropBody, crossOrigin };
}

export async function fetchWithCredentialRedirectRefusal(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
  privateCredentialHeaderNames?: ReadonlySet<string>,
): Promise<Response> {
  let currentInput = input;
  let currentInit = { ...init, redirect: CREDENTIAL_REQUEST_REDIRECT_POLICY.redirect };
  // A Request may own a one-shot stream. Retain a clone for a permitted same-origin replay.
  let template = typeof Request !== 'undefined' && input instanceof Request ? new Request(input, currentInit)
    : typeof ReadableStream !== 'undefined' && init?.body instanceof ReadableStream
      ? new Request(input, { ...currentInit, ...{ duplex: 'half' } }) : null;
  try {
    for (let redirects = 0; ; redirects++) {
      const response = template
        ? await fetchImpl(template.clone(), { redirect: 'manual' })
        : await fetchImpl(currentInput, currentInit);
      try {
        // Browser Fetch hides every manual redirect's destination. The owner-approved
        // browser exception retains this closed refusal; native transports inspect each hop.
        if (response.type === 'opaqueredirect') throw new CredentialRequestRedirectError(response.status);
        if (!REDIRECT_STATUSES.has(response.status)) return response;
        const headers = Object.fromEntries(new Headers(template?.headers ?? currentInit.headers));
        const next = resolveCredentialRequestRedirect({ status: response.status,
          requestUrl: template?.url ?? String(currentInput), location: response.headers.get('location'),
          method: template?.method ?? currentInit.method ?? 'GET', headers,
          privateCredentialHeaderNames,
          hasSecretBody: template ? template.body !== null : currentInit.body != null });
        if (!next) return response;
        // Fetch Standard §4.5 uses a 20-hop redirect budget.
        if (redirects === 20) throw new CredentialRequestRedirectError(response.status);
        void response.body?.cancel().catch(() => undefined);
        const credentials = next.crossOrigin ? 'omit' as const : template?.credentials ?? currentInit.credentials;
        currentInit = { ...currentInit, method: next.method, headers: next.headers, credentials,
          ...(next.dropBody ? { body: undefined } : {}) };
        currentInput = next.url;
        if (template) {
          const previous = template;
          const replayInit = { ...currentInit,
            ...(next.dropBody ? {} : { body: previous.body, duplex: 'half' as const }),
            signal: previous.signal, cache: previous.cache, mode: previous.mode,
            referrer: previous.referrer, referrerPolicy: previous.referrerPolicy, integrity: previous.integrity,
            keepalive: previous.keepalive };
          template = new Request(next.url, replayInit);
        }
      } catch (error) {
        void response.body?.cancel().catch(() => undefined);
        throw error;
      }
    }
  } finally {
    void template?.body?.cancel().catch(() => undefined);
  }
}
