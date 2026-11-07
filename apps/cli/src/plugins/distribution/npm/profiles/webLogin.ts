import { setTimeout as delay } from 'node:timers/promises';
import type { NpmRegistryHttpsClient } from '../httpsClient';
import { assertSafeNpmHttpsUrl } from '../networkPolicy';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** npm-profile 13.0.1 (67b32d049d41dac10b8ccba96208af522d1c8f40), web auth only. */
export async function startNpmWebLogin(client: NpmRegistryHttpsClient, registryOrigin: string): Promise<Readonly<{ loginUrl: string; doneUrl: string }>> {
  const response = await client.requestJsonResponse({ url: `${registryOrigin}/-/v1/login`, method: 'POST', body: {}, headers: { accept: 'application/json' } });
  if (!record(response.body) || typeof response.body.loginUrl !== 'string' || typeof response.body.doneUrl !== 'string') throw new Error('npm_web_login_invalid_response');
  const login = assertSafeNpmHttpsUrl(response.body.loginUrl);
  const done = assertSafeNpmHttpsUrl(response.body.doneUrl);
  // npm's canonical completion URL must follow the selected mirror's login session.
  if (done.hostname === 'registry.npmjs.org') done.host = new URL(registryOrigin).host;
  if (done.origin !== registryOrigin) throw new Error('npm_web_login_invalid_response');
  return { loginUrl: login.href, doneUrl: done.href };
}

export async function completeNpmWebLogin(client: NpmRegistryHttpsClient, doneUrl: string, signal: AbortSignal): Promise<string> {
  for (;;) {
    signal.throwIfAborted();
    const response = await client.requestJsonResponse({ url: doneUrl, method: 'GET', headers: { accept: 'application/json', 'cache-control': 'no-cache' }, signal });
    if (response.statusCode === 200 && record(response.body) && typeof response.body.token === 'string' && response.body.token) return `Bearer ${response.body.token}`;
    if (response.statusCode !== 202) throw new Error('npm_web_login_invalid_response');
    const retryMs = Number(response.headers['retry-after']) * 1000;
    if (retryMs > 0) await delay(retryMs, undefined, { signal });
  }
}
