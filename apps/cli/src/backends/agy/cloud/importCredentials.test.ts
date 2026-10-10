import { normalizeConnectedServiceOauthCredentialRawMetadata } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AGY_OAUTH_CLIENT_ID, AGY_OAUTH_SCOPES } from '@happier-dev/agents';
import { agyCloudConnect } from './connect';
import { buildConnectedAccountOauthCredentialRecord } from '@/daemon/connectedServices/descriptors/buildConnectedAccountCredentialRecord';
import { requireAgySessionCredential } from '../connectedServices/materializeAgyConnectedServiceAuth';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('Antigravity machine login import', () => {
  it.each([false, true])('keeps the native login intact and reports whether its grant can launch ACP (coding scopes: %s)', async (codingScopes) => {
    const home = await mkdtemp(join(tmpdir(), 'agy-import-'));
    vi.stubEnv('GEMINI_HOME', home);
    await mkdir(join(home, 'antigravity-cli'));
    const file = join(home, 'antigravity-cli/antigravity-oauth-token');
    const original = JSON.stringify({ token: { refresh_token: 'legacy-refresh', project_id: 'saved-project', expiry: '2026-10-07T12:00:00Z' } });
    await writeFile(file, original);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes('/token')) {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get('client_id')).toBe(AGY_OAUTH_CLIENT_ID);
        expect(body.has('scope')).toBe(false);
        return Response.json({ access_token: 'fresh', expires_in: 3600, scope: (codingScopes ? AGY_OAUTH_SCOPES : AGY_OAUTH_SCOPES.filter(scope => !scope.endsWith('/aicode'))).join(' ') });
      }
      if (String(url).includes('userinfo')) return Response.json({ sub: 'legacy-account', email: 'a@example.test', email_verified: true });
      expect(String(url)).toContain('loadCodeAssist');
      expect(JSON.parse(String(init?.body)).cloudaicompanionProject).toBe('saved-project');
      return Response.json({ currentTier: { id: 'tier' }, cloudaicompanionProject: 'verified-project' });
    }));
    try {
      const imported = await agyCloudConnect.importCredentials!({ source: 'cli' });
      expect(imported.requiresBrowserReauthorization).toBe(!codingScopes);
      const payload = imported.oauth;
      const record = buildConnectedAccountOauthCredentialRecord({ now: 10, serviceId: 'antigravity', profileId: 'legacy', payload });
      if (record.kind !== 'oauth') throw new Error('Expected OAuth record');
      expect(record.oauth.providerAccountId).toBe('legacy-account');
      expect(normalizeConnectedServiceOauthCredentialRawMetadata(record.oauth.raw)?.antigravity?.projectId).toBe('verified-project');
      if (codingScopes) expect(requireAgySessionCredential(record)).toBe(record);
      else expect(() => requireAgySessionCredential(record)).toThrow(/browser reauthorization/);
      const { readFile } = await import('node:fs/promises');
      expect(await readFile(file, 'utf8')).toBe(original);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
