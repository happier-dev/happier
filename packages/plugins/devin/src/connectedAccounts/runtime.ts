import type { ConnectedAccountAuthenticationContext, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { DEVIN_DEFAULT_API_SERVER, DEVIN_NATIVE_FILE, DEVIN_NATIVE_GENERATION, DEVIN_SESSION_METADATA, DEVIN_SESSION_PREFIX, devinApiBase as apiBase, parseDevinNativeCredentials, serializeDevinSelectedCredentials } from './nativeCredentials.js';

type ReadContext = Parameters<ConnectedAccountRuntime['status']>[0];
const sessionPrefix = DEVIN_SESSION_PREFIX;
function diagnostic(code: string, message: string) { return { code, message, severity: 'error' as const }; }
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function object(body: Uint8Array): Record<string, unknown> | null {
  try { const value: unknown = JSON.parse(new TextDecoder().decode(body));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function normalizeSession(value: unknown): string | null {
  const token = text(value);
  if (token.startsWith(sessionPrefix) && token.length > sessionPrefix.length) return token;
  return token.startsWith('eyJ') && token.split('.').length === 3 ? sessionPrefix + token : null;
}
async function save(context: ConnectedAccountAuthenticationContext, values: Readonly<Record<string, string>>, signal: AbortSignal) {
  for (const [key, value] of Object.entries(values)) await context.attemptCredentials.set(key, value, { signal });
}
async function localHealth(context: ReadContext, options?: { signal?: AbortSignal }) {
  const mode = await context.credentials.get('credentialMode', options);
  if (mode !== 'session' && mode !== 'enterprise') return {
    status: 'unavailable' as const, diagnostic: diagnostic('credentials_unavailable', 'The selected Devin credential mode is unsupported.'),
  };
  const token = await context.credentials.get(mode === 'session' ? 'sessionToken' : 'seatToken', options);
  return token ? { status: 'connected' as const, credentialKind: mode === 'session' ? 'oauth' as const : 'token' as const, scopes: [] } : {
    status: 'unavailable' as const, diagnostic: diagnostic('credentials_unavailable', 'The selected Devin credential is unavailable.'),
  };
}

/** Devin's exchange adapter; attempts, PKCE/state validation and settlement remain host-owned. */
export function createDevinConnectedAccountRuntime(): ConnectedAccountRuntime {
  return {
    authentication: { modes: {
      'browser-session': {
        kind: 'oauthAuthorizationCode',
        async begin(input) {
          const query = new URLSearchParams({ prompt: 'select_account', code_challenge: input.pkce.challenge, code_challenge_method: input.pkce.method });
          if (input.callbackUrl) query.set('redirect_uri', input.callbackUrl);
          else query.set('cli_pkce_marker', '1');
          if (input.state) query.set('state', input.state);
          return { status: 'awaitingOAuthRedirect', authorizationUrl: `https://app.devin.ai/auth/cli/continue?${query}` };
        },
        async complete(input, context, options) {
          const signal = options?.signal ?? context.signal;
          let response: Awaited<ReturnType<typeof context.services.http.request>>;
          try {
            response = await context.services.http.request({ url: 'https://api.devin.ai/auth/cli/token', method: 'POST', redirect: 'error',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: new TextEncoder().encode(JSON.stringify({ code: input.code, code_verifier: input.pkceVerifier })),
            }, { signal });
          } catch (error) {
            if (signal.aborted) throw error;
            return { status: 'outcomeUnknown', diagnostic: diagnostic('exchange_unavailable', 'Devin token exchange did not return a response.') };
          }
          const body = object(response.body);
          if (response.status < 200 || response.status >= 300) {
            // No documented Devin rejection shape establishes a terminal grant failure.
            return { status: 'outcomeUnknown', diagnostic: diagnostic('exchange_unavailable', `Devin token exchange returned HTTP ${response.status}.`) };
          }
          const token = normalizeSession(body?.token);
          if (!token) return { status: 'outcomeUnknown', diagnostic: diagnostic('unsupported_session', 'Devin returned an unsupported session representation.') };
          let profile: Record<string, unknown> | null = null;
          try {
            const result = await context.services.http.request({ url: 'https://api.devin.ai/v3/self', redirect: 'error',
              headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            }, { signal });
            if (result.status >= 200 && result.status < 300) profile = object(result.body);
          } catch (error) { if (signal.aborted) throw error; }
          await save(context, { sessionToken: token, credentialMode: 'session', apiServerUrl: DEVIN_DEFAULT_API_SERVER, nativeGeneration: DEVIN_NATIVE_GENERATION, nativeMetadata: JSON.stringify(DEVIN_SESSION_METADATA) }, signal);
          const accountId = text(profile?.user_id), organizationId = text(profile?.org_id);
          return { status: 'connected', credentialKind: 'oauth', displayName: text(profile?.user_name) || 'Devin', scopes: [],
            ...(accountId ? { accountId, providerIdentity: { accountId, ...(organizationId ? { organizationId } : {}) } } : {}),
          };
        },
        async cancel() {},
      },
      'enterprise-seat': {
        kind: 'manual',
        async complete(input, context, options) {
          const token = text(input.fields.seatToken), base = apiBase(input.fields.apiServerUrl);
          if (!token || token.startsWith(sessionPrefix) || !base) return {
            status: 'rejected', diagnostic: diagnostic('invalid_manual_input', 'Provide a native enterprise seat credential and its HTTPS API server URL.'),
          };
          await save(context, { seatToken: token, credentialMode: 'enterprise', apiServerUrl: base, nativeGeneration: DEVIN_NATIVE_GENERATION, nativeMetadata: '{}' }, options?.signal ?? context.signal);
          return { status: 'connected', credentialKind: 'token', displayName: 'Devin enterprise', scopes: [] };
        },
      },
    } },
    async status(context, options) { return localHealth(context, options); },
    async refresh(context, options) {
      return { ...await localHealth(context, options), status: 'unavailable',
        diagnostic: diagnostic('refresh_unsupported', 'Devin has no characterized refresh grant. Reconnect if the credential is rejected.') };
    },
    async revoke() { return { status: 'remoteUnsupported' }; },
    async materialize(request, context, options) {
      if (request.kind === 'environment' || (request.kind === 'files' && request.fileIds.some(id => id !== DEVIN_NATIVE_FILE))) {
        throw new PluginError({ code: 'unsupported', message: 'The requested Devin credential destination is unsupported.' });
      }
      const mode = await context.credentials.get('credentialMode', options);
      const base = apiBase(await context.credentials.get('apiServerUrl', options));
      if ((mode !== 'session' && mode !== 'enterprise') || !base) throw new PluginError({ code: 'unsupported', message: 'The selected Devin credential mode or API server is unsupported.' });
      if (request.kind === 'httpHeaders' && (request.origin !== new URL(base).origin || request.headerNames.some(name => name !== 'authorization'))) {
        throw new PluginError({ code: 'unsupported', message: 'The selected Devin API server does not match this gateway delivery target. Use its native route.' });
      }
      const token = await context.credentials.get(mode === 'session' ? 'sessionToken' : 'seatToken', options);
      if (!token) throw new PluginError({ code: 'credentials_unavailable', message: 'The selected Devin credential is unavailable.' });
      if (request.kind === 'files') {
        if (await context.credentials.get('nativeGeneration', options) !== DEVIN_NATIVE_GENERATION) {
          throw new PluginError({ code: 'unsupported', message: 'The selected Devin native credential generation is unsupported. Reconnect or import it again.' });
        }
        let metadata: unknown;
        try { metadata = JSON.parse(await context.credentials.get('nativeMetadata', options) ?? '{}'); } catch {}
        const native = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
          ? parseDevinNativeCredentials({ ...metadata, windsurf_api_key: token, api_server_url: base }) : null;
        if (!native || native.mode !== mode) throw new PluginError({ code: 'unsupported', message: 'The selected Devin native credential mode is unsupported.' });
        return { kind: 'files', files: { [DEVIN_NATIVE_FILE]: serializeDevinSelectedCredentials(native) } };
      }
      // Pinned executor PrepareRequest uses this exact wire form; it is not RFC Basic base64.
      return { kind: 'httpHeaders', headers: { authorization: `Basic ${token}-${token}` },
        facts: { base_url: base, device_seed: context.account.accountId } };
    },
  };
}
export const devinConnectedAccountRuntime = createDevinConnectedAccountRuntime();
