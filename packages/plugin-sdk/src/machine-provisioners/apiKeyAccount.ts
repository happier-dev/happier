/** @moduleRealm any */
import { PluginError } from '../errors.js';
import type {
  ConnectedAccountAuthenticationContext, ConnectedAccountAuthCompletionResult,
  ConnectedAccountHealthResult, ConnectedAccountPortableReadContext, ConnectedAccountPortableRuntime,
  ConnectedAccountReadContext, ConnectedAccountRuntime,
} from '../connected-accounts/index.js';
import type { HttpMethod, HttpRequest } from '../http.js';
import { createMachineProvisionerFetch } from './http.js';

type ProbeResult = Extract<ConnectedAccountAuthCompletionResult, { status: 'connected' | 'rejected' | 'unavailable' }>;
type ProbeContext = Pick<ConnectedAccountAuthenticationContext, 'configuration'>;
type HeaderBinding = Readonly<{ origin: string; headerName: string; scheme: 'raw' | 'bearer' | ((token: string) => string) }>;
type ProbeRequest = Omit<HttpRequest, 'redirect'> & Partial<Pick<HttpRequest, 'redirect'>>;

/** Vendor facts only; the SDK owns verification, staging, health and materialization. */
export type MachineProvisionerApiKeyAccountDefinition = Readonly<{
  name: string;
  keyDescription: string;
  codePrefix: string;
  purpose: string;
  methods?: readonly HttpMethod[];
  headers: readonly HeaderBinding[];
  probe: Readonly<{
    request: ProbeRequest | ((context: ProbeContext) => ProbeRequest | Extract<ProbeResult, { status: 'rejected' }>);
    read: (value: unknown, context: ProbeContext) => ProbeResult | undefined;
    /** For documented vendor refusals such as Boat key permissions. Never echo response text. */
    rejection?: (status: number, value: unknown) => Extract<ProbeResult, { status: 'rejected' }> | undefined;
  }>;
}>;

const validToken = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/u.test(value);
const operationSignal = (context: { signal: AbortSignal }, signal?: AbortSignal) => signal ? AbortSignal.any([context.signal, signal]) : context.signal;
const authorization = (binding: HeaderBinding, token: string) => typeof binding.scheme === 'function'
  ? binding.scheme(token) : binding.scheme === 'bearer' ? `Bearer ${token}` : token;

/**
 * Verify and stage a manually supplied API key, and share that verification with health.
 * Vendor response bodies and transport errors never become public diagnostics.
 * Materialization uses the declared origins and formats without another probe.
 *
 * @example
 * const account = createMachineProvisionerApiKeyAccount({
 *   name: 'Example', keyDescription: 'an Example account API key', codePrefix: 'example',
 *   purpose: 'cloud-api',
 *   headers: [{ origin: 'https://api.example.com', headerName: 'x-api-key', scheme: 'raw' }],
 *   probe: {
 *     request: { url: 'https://api.example.com/sandboxes', method: 'GET' },
 *     read: value => Array.isArray(value) ? { status: 'connected', scopes: [] } : undefined,
 *   },
 * });
 */
export function createMachineProvisionerApiKeyAccount(definition: MachineProvisionerApiKeyAccountDefinition): Readonly<{
  runtime: ConnectedAccountRuntime;
  portableRuntime: ConnectedAccountPortableRuntime;
  nativeFetch: (context: Parameters<typeof createMachineProvisionerFetch>[0], credential?: string | Readonly<Record<string, string>>) => typeof fetch;
}> {
  const diagnostic = (suffix: string, message: string) => ({ code: `${definition.codePrefix}_${suffix}`, severity: 'error' as const, message });
  const refused = () => ({ status: 'rejected' as const,
    diagnostic: diagnostic('invalid_token', `${definition.name} refused this key. Use ${definition.keyDescription}. Check that it has access to this account or team.`) });
  const unavailable = () => ({ status: 'unavailable' as const,
    diagnostic: diagnostic('unavailable', `${definition.name} could not be reached or is temporarily unavailable. Try connecting again.`) });
  const unexpected = () => ({ status: 'unavailable' as const,
    diagnostic: diagnostic('invalid_response', `${definition.name} returned an unexpected response. Try connecting again; if it continues, check the provider's service status.`) });
  const storageUnavailable = () => ({ status: 'unavailable' as const,
    diagnostic: diagnostic('credential_storage_unavailable', `The ${definition.name} key could not be saved or read. Try connecting again.`) });

  async function probe(token: string, context: ConnectedAccountAuthenticationContext | ConnectedAccountReadContext, signal: AbortSignal): Promise<ProbeResult> {
    signal.throwIfAborted();
    const request = typeof definition.probe.request === 'function' ? definition.probe.request(context) : definition.probe.request;
    if ('status' in request) return request;
    const binding = definition.headers.find(header => header.origin === new URL(request.url).origin);
    if (!binding) return unexpected();
    let response;
    try {
      response = await context.services.http.request({ ...request, redirect: 'error',
        headers: { ...request.headers, [binding.headerName]: authorization(binding, token) } }, { signal });
      signal.throwIfAborted();
    } catch { signal.throwIfAborted(); return unavailable(); }
    if (response.finalUrl !== request.url || response.status >= 300 && response.status < 400) return unexpected();
    // A refusal needs no decodable body; a malformed 401 still says the key was refused.
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(response.body)); } catch { value = undefined; }
    const rejection = definition.probe.rejection?.(response.status, value);
    if (rejection) return rejection;
    if (response.status === 401 || response.status === 403) return refused();
    if (response.status === 429 || response.status >= 500) return unavailable();
    if (response.status !== 200 || value === undefined) return unexpected();
    return definition.probe.read(value, context) ?? unexpected();
  }

  async function health(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }): Promise<ConnectedAccountHealthResult> {
    const signal = operationSignal(context, options?.signal);
    signal.throwIfAborted();
    let token;
    try { token = await context.credentials.get('token', { signal }); }
    catch { signal.throwIfAborted(); return storageUnavailable(); }
    signal.throwIfAborted();
    if (!validToken(token)) return { ...refused(), status: 'reconnectRequired' };
    const result = await probe(token, context, signal);
    return result.status === 'rejected' ? { ...result, status: 'reconnectRequired' } : result;
  }

  const runtime: ConnectedAccountRuntime = {
    authentication: { modes: { token: { kind: 'manual', async complete(input, context, options) {
      const signal = operationSignal(context, options?.signal);
      signal.throwIfAborted();
      const supplied = input.fields.token;
      const token = supplied?.trim();
      if (typeof supplied !== 'string' || /[\r\n]/u.test(supplied) || !validToken(token)) return refused();
      const result = await probe(token, context, signal);
      if (result.status !== 'connected') return result;
      signal.throwIfAborted();
      try { await context.attemptCredentials.set('token', token, { signal }); }
      catch { signal.throwIfAborted(); return storageUnavailable(); }
      signal.throwIfAborted();
      return result;
    } } } },
    status: health,
    refresh: health,
    async revoke(context, options) {
      operationSignal(context, options?.signal).throwIfAborted();
      return { status: 'remoteUnsupported', diagnostic: diagnostic('manual_revoke_required', `Revoke this key in the ${definition.name} dashboard.`) };
    },
    async materialize(request, context: ConnectedAccountPortableReadContext, options) {
      const signal = operationSignal(context, options?.signal);
      signal.throwIfAborted();
      const binding = request.kind === 'httpHeaders' ? definition.headers.find(header => header.origin === request.origin) : undefined;
      if (request.kind !== 'httpHeaders' || !binding || request.headerNames.some(name => name.toLowerCase() !== binding.headerName.toLowerCase())) {
        throw new PluginError({ code: 'credential_unavailable' });
      }
      if (!request.headerNames.length) return { kind: 'httpHeaders', headers: {} };
      try {
        const token = await context.credentials.get('token', { signal });
        signal.throwIfAborted();
        if (!validToken(token)) throw new PluginError({ code: 'credential_unavailable' });
        return { kind: 'httpHeaders', headers: { [binding.headerName]: authorization(binding, token) } };
      } catch { signal.throwIfAborted(); throw new PluginError({ code: 'credential_unavailable' }); }
    },
  };
  return {
    runtime, portableRuntime: { authentication: runtime.authentication, materialize: runtime.materialize },
    nativeFetch: (context, credential) => async (input, init) => {
      const request = new Request(input, init);
      const binding = definition.headers.find(header => header.origin === new URL(request.url).origin);
      if (!binding) throw new PluginError({ code: 'credential_unavailable' });
      return createMachineProvisionerFetch(context, {
        purpose: definition.purpose, origins: [binding.origin], headerName: binding.headerName.toLowerCase(),
        methods: definition.methods,
        credential: typeof credential === 'string' ? { [binding.headerName]: authorization(binding, credential) } : credential,
      })(request);
    },
  };
}
