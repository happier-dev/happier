import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGY_OAUTH_CLIENT_ID, AGY_OAUTH_SCOPES } from '@happier-dev/agents';
import { buildConnectedAccountOauthCredentialRecord } from '@/daemon/connectedServices/descriptors/buildConnectedAccountCredentialRecord';
import { agyCloudConnect } from './connect';

const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

describe('Antigravity native credential import', () => {
  async function fixture(value: unknown) {
    const home = await mkdtemp(join(tmpdir(), 'agy-import-')); homes.push(home);
    vi.stubEnv('GEMINI_HOME', home); vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
    const file = join(home, 'antigravity-cli/antigravity-oauth-token');
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, JSON.stringify(value));
    return file;
  }

  function tokenInfo(scope = AGY_OAUTH_SCOPES.join(' ')) {
    return Response.json({ azp: AGY_OAUTH_CLIENT_ID, sub: 'selected-account', email: 'selected@example.test', scope, expires_in: '3600' });
  }

  it('imports an explicitly selected CLI credential file through the same verified OAuth path', async () => {
    await fixture({ auth_method: 'consumer', token: { access_token: 'file-access', refresh_token: 'file-refresh', expiry: new Date(Date.now() + 3600000).toISOString() } });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => tokenInfo()));
    await expect(agyCloudConnect.importCredentials!({ source: 'cli-file' })).resolves.toMatchObject({ access_token: 'file-access', refresh_token: 'file-refresh', scope: AGY_OAUTH_SCOPES.join(' ') });
  });

  it('imports a valid native CLI token without rotating or rewriting its grant', async () => {
    const file = await fixture({ auth_method: 'consumer', token: { access_token: 'native-access', refresh_token: 'native-refresh', expiry: new Date(Date.now() + 3600000).toISOString() } });
    const before = await readFile(file, 'utf8');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe('https://oauth2.googleapis.com/tokeninfo');
      expect(url.searchParams.get('access_token')).toBe('native-access');
      return tokenInfo();
    }));
    const payload = await agyCloudConnect.importCredentials!({ source: 'cli' });
    expect(buildConnectedAccountOauthCredentialRecord({ now: 1000, serviceId: 'antigravity', profileId: 'work', payload })).toMatchObject({
      expiresAt: 3601000, oauth: { accessToken: 'native-access', refreshToken: 'native-refresh', scope: AGY_OAUTH_SCOPES.join(' '), providerAccountId: 'selected-account', providerEmail: 'selected@example.test', raw: null },
    });
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('does not turn requested file scopes into grants or accept another issuer', async () => {
    await fixture({ auth_method: 'consumer', token: { access_token: 'native-access', refresh_token: 'native-refresh', expiry: new Date(Date.now() + 3600000).toISOString(), scopes: AGY_OAUTH_SCOPES } });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => tokenInfo('https://www.googleapis.com/auth/userinfo.email')));
    await expect(agyCloudConnect.importCredentials!({ source: 'cli' })).rejects.toMatchObject({ code: 'reauthorization_required' });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ azp: 'different-client', scope: AGY_OAUTH_SCOPES.join(' '), expires_in: '3600' })));
    await expect(agyCloudConnect.importCredentials!({ source: 'cli' })).rejects.toMatchObject({ code: 'reauthorization_required' });
  });

  it('keeps provider verification outages distinct from rejected native grants', async () => {
    await fixture({ auth_method: 'consumer', token: { access_token: 'native-access', refresh_token: 'native-refresh', expiry: new Date(Date.now() + 3600000).toISOString() } });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('provider-private-detail', { status: 503 })));
    await expect(agyCloudConnect.importCredentials!({ source: 'cli-file' })).rejects.toMatchObject({ code: 'provider_error' });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('provider-private-detail', { status: 400 })));
    await expect(agyCloudConnect.importCredentials!({ source: 'cli-file' })).rejects.toMatchObject({ code: 'reauthorization_required' });
  });

  it('rejects unsupported sources and canceled imports before credential or provider effects', async () => {
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
    await expect(agyCloudConnect.importCredentials!({ source: 'untrusted-path' })).rejects.toMatchObject({ code: 'unsupported_source' });
    // A released client may still offer the retired server's login as a source.
    await expect(agyCloudConnect.importCredentials!({ source: 'acp' })).rejects.toMatchObject({ code: 'unsupported_source' });
    const controller = new AbortController(); controller.abort();
    await expect(agyCloudConnect.importCredentials!({ source: 'cli', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
