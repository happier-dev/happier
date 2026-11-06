/** @moduleRealm any */
import type { PluginAccountActionContext } from '../actions/index.js';
import type { HttpMethod, HttpRequest, HttpService } from '../http.js';

type HttpContext = Readonly<{
  signal: AbortSignal;
  services: Readonly<{ http: Pick<HttpService, 'request'> }>;
}>;
type MaterializationContext = HttpContext & Readonly<{
  services: Readonly<{
    connectedAccounts: Pick<PluginAccountActionContext['services']['connectedAccounts'], 'materialize'>;
  }>;
}>;

function failure(code: 'credential_unavailable' | 'provider_unavailable' | 'invalid_request') {
  return Object.assign(new Error(code), { code });
}

async function send(
  context: HttpContext,
  request: Request,
  headers: Headers,
  signal: AbortSignal,
  credentialBinding?: HttpRequest['credentialBinding'],
): Promise<Response> {
  const body = request.body === null ? undefined : new Uint8Array(await request.arrayBuffer());
  signal.throwIfAborted();
  const response = await context.services.http.request({
    url: request.url, method: request.method as HttpMethod,
    headers: Object.fromEntries(headers.entries()), redirect: 'error',
    ...(credentialBinding === undefined ? {} : { credentialBinding }),
    ...(body === undefined ? {} : { body }),
  }, { signal });
  signal.throwIfAborted();
  if (response.finalUrl !== request.url || response.status >= 300 && response.status < 400) {
    throw failure('provider_unavailable');
  }
  return new Response(response.status === 204 || response.status === 205 ? null : new Uint8Array(response.body),
    { status: response.status, headers: response.headers });
}

/** Bridge a native client to host HTTP using its captured purpose, or explicit
 * authentication-attempt headers. Vendor token formatting stays in the leaf. */
export function createMachineProvisionerFetch(context: HttpContext, options: Readonly<{
  purpose: string;
  origins: readonly string[];
  headerName: string;
  credential?: Readonly<Record<string, string>>;
  methods?: readonly HttpMethod[];
}>): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!options.origins.includes(url.origin) || url.username || url.password) throw failure('credential_unavailable');
    if (options.methods && !options.methods.includes(request.method as HttpMethod)) throw failure('invalid_request');
    const signal = AbortSignal.any([context.signal, request.signal]);
    signal.throwIfAborted();
    const headers = new Headers(request.headers);
    headers.delete(options.headerName);
    if (options.credential !== undefined) new Headers(options.credential).forEach((value, name) => headers.set(name, value));
    return send(context, request, headers, signal, options.credential === undefined ? {
      kind: 'connectedAccountPurpose', purpose: options.purpose, origin: url.origin,
      method: request.method as HttpMethod, headerNames: [options.headerName],
    } : undefined);
  };
}

/** One admitted role materializes once. API credentials are removed from guest
 * requests; each guest's short-lived credentials remain native-client facts. */
export function createMachineProvisionerMaterializedFetch(context: MaterializationContext, options: Readonly<{
  purpose: string;
  origin: string;
  headerName: string;
  methods: readonly HttpMethod[];
  isGuestUrl?: (url: URL) => boolean;
}>): typeof fetch {
  let authorization: Promise<string> | undefined;
  async function acquireAuthorization() {
    const material = await context.services.connectedAccounts.materialize(options.purpose,
      { kind: 'httpHeaders', origin: options.origin, headerNames: [options.headerName] }, { signal: context.signal });
    context.signal.throwIfAborted();
    const value = material.kind === 'httpHeaders' ? new Headers(material.headers).get(options.headerName) : null;
    if (!value) throw failure('credential_unavailable');
    return value;
  }
  return async (input, init) => {
    context.signal.throwIfAborted();
    let url: URL;
    try { url = new URL(input instanceof Request ? input.url : String(input)); }
    catch { throw failure('provider_unavailable'); }
    if ((url.origin !== options.origin && !options.isGuestUrl?.(url)) || url.username || url.password) throw failure('provider_unavailable');
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (!options.methods.includes(method as HttpMethod)) throw failure('invalid_request');
    let request: Request;
    try { request = new Request(input, init); }
    catch { throw failure('invalid_request'); }
    const signal = AbortSignal.any([context.signal, request.signal]);
    signal.throwIfAborted();
    let admittedAuthorization: string;
    try {
      admittedAuthorization = url.origin === options.origin ? await (authorization ??= acquireAuthorization()) : '';
    } catch {
      signal.throwIfAborted();
      throw failure('credential_unavailable');
    }
    signal.throwIfAborted();
    const headers = new Headers(request.headers);
    headers.delete(options.headerName);
    if (url.origin === options.origin) headers.set(options.headerName, admittedAuthorization);
    try { return await send(context, request, headers, signal); }
    catch {
      signal.throwIfAborted();
      throw failure('provider_unavailable');
    }
  };
}
