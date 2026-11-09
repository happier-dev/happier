import { describe, expect, it } from 'vitest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { HttpRequest, HttpResponse } from '@happier-dev/plugin-sdk/http';
import { ACCOUNT_PURPOSE, nativeFetch, readAccountScope } from './credentials.js';

const privateToken = 'private-vercel-token';
const scope = { teamId: 'team-selected', projectId: 'prj-selected' };

// Only selected-account materialization and vendor HTTP are substituted.
function fixture(options: { status?: number; configuration?: Record<string, string>; finalUrl?: string; failure?: Error } = {}) {
  const controller = new AbortController();
  const requests: HttpRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const materializations: { purpose: string; request: unknown }[] = [];
  let credentialAvailable = true;
  const values = options.configuration ?? scope;
  const services = {
    connectedAccounts: { async materialize(purpose: string, request: { kind: string }) {
      materializations.push({ purpose, request });
      return request.kind === 'environment'
        ? { kind: 'environment', env: { VERCEL_TEAM_ID: values.teamId, VERCEL_PROJECT_ID: values.projectId } }
        : { kind: 'httpHeaders', headers: credentialAvailable ? { Authorization: `Bearer ${privateToken}` } : {} };
    } },
    http: { async request(request: HttpRequest, cancellation?: { signal?: AbortSignal }): Promise<HttpResponse> {
      requests.push(request);
      signals.push(cancellation?.signal);
      if (options.failure) throw options.failure;
      return { status: options.status ?? 200, finalUrl: options.finalUrl ?? request.url, headers: {},
        body: new TextEncoder().encode('{}') };
    } },
  };
  // The host context fixture supplies only the consumed boundary services.
  const action = { signal: controller.signal, services } as unknown as PluginInvocationContext;
  return { action, requests, signals, materializations, controller,
    setCredentialAvailable(value: boolean) { credentialAvailable = value; } };
}

describe('Vercel sandbox credentials', () => {
  it('requires team and project from the selected account rather than launch input', async () => {
    const host = fixture();
    expect(await readAccountScope(host.action)).toEqual(scope);
    expect(host.materializations).toEqual([{ purpose: ACCOUNT_PURPOSE,
      request: { kind: 'environment', keys: ['VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID'] } }]);
    expect(host.requests).toEqual([]);
    await expect(readAccountScope(fixture({ configuration: { teamId: scope.teamId } }).action))
      .rejects.toThrow('credential_unavailable');
  });

  it('captures authorization once per role invocation and preserves binary and text bodies', async () => {
    const host = fixture();
    const fetcher = nativeFetch(host.action);
    const bytes = new Uint8Array([0, 255, 128, 42]);
    await Promise.all([
      fetcher('https://api.vercel.com/v3/sandboxes', { method: 'POST', body: bytes,
        headers: { Authorization: 'caller-token', 'content-type': 'application/octet-stream' } }),
      fetcher('https://api.vercel.com/v2/sandboxes/one', { method: 'PATCH', body: '{"timeout":1}' }),
    ]);
    expect(host.requests[0]?.body).toEqual(bytes);
    expect(new TextDecoder().decode(host.requests[1]?.body)).toBe('{"timeout":1}');
    expect(host.requests.every(request => request.redirect === 'error' && request.headers?.authorization === `Bearer ${privateToken}`)).toBe(true);
    expect(host.materializations).toHaveLength(1);
    host.setCredentialAvailable(false);
    // Admitted fragments use their captured token; a new role observes withdrawal
    // at the next credential acquisition instead of re-authorizing each fragment.
    await fetcher('https://api.vercel.com/v2/sandboxes/one');
    await expect(nativeFetch(host.action)('https://api.vercel.com/v2/sandboxes/one'))
      .rejects.toThrow('credential_unavailable');
    expect(host.materializations).toHaveLength(2);
    expect(host.requests).toHaveLength(3);
  });

  it('refuses foreign origins, URL credentials, unsupported methods and redirected responses', async () => {
    const host = fixture();
    const fetcher = nativeFetch(host.action);
    await expect(fetcher('https://example.com')).rejects.toThrow('provider_unavailable');
    await expect(fetcher('https://user:secret@api.vercel.com/v2/sandboxes')).rejects.toThrow('provider_unavailable');
    await expect(fetcher('https://api.vercel.com/v2/sandboxes', { method: 'PUT' })).rejects.toThrow('invalid_request');
    expect(host.requests).toEqual([]);
    const redirect = fixture({ status: 302, finalUrl: 'https://example.com' });
    await expect(nativeFetch(redirect.action)('https://api.vercel.com/v2/sandboxes')).rejects.toThrow('provider_unavailable');
    const sameOriginRedirect = fixture({ status: 307 });
    await expect(nativeFetch(sameOriginRedirect.action)('https://api.vercel.com/v2/sandboxes')).rejects.toThrow('provider_unavailable');
    const failed = fixture({ failure: new Error(`HTTP failure with ${privateToken}`) });
    await expect(nativeFetch(failed.action)('https://api.vercel.com/v2/sandboxes')).rejects.toThrow('provider_unavailable');
  });

  it('preserves invocation cancellation even when the caller supplies another signal', async () => {
    const host = fixture();
    await nativeFetch(host.action)('https://api.vercel.com/v2/sandboxes', { signal: new AbortController().signal });
    expect(host.signals[0]?.aborted).toBe(false);
    host.controller.abort();
    expect(host.signals[0]?.aborted).toBe(true);
    await expect(nativeFetch(host.action)('https://api.vercel.com/v2/sandboxes')).rejects.toThrow();
    expect(host.requests).toHaveLength(1);
  });
});
