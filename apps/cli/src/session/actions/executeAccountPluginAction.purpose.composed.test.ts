import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import * as undici from 'undici';
import { afterEach, expect, it, vi } from 'vitest';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliActionExecutor } from './createCliActionExecutor';

// Provider HTTP uses the real runtime's Undici transport, independently of feature discovery.
vi.mock('undici', async importOriginal => ({ ...await importOriginal<typeof import('undici')>(), fetch: vi.fn() }));
afterEach(() => { vi.mocked(undici.fetch).mockReset(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

it('uses its containing Account purpose runtime through real CLI ingress without a daemon and refuses an absent recorded credential', async () => {
  const home = await mkdtemp(join(tmpdir(), 'account-purpose-ingress-'));
  const app = fastify();
  const serverHttpBaseUrl = 'http://account-purpose-ingress.test';
  const accountId = 'account-purpose-requester';
  const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
  const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
  const authored = await registerAuthoredAccountActionRelease(app, accountId);
  const service = { pluginId: authored.pluginId, localId: 'platform' };
  const recorded = { service, accountId: 'recorded-linker' };
  const sentinel = 'recorded-credential-custody-sentinel';
  const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
  let available = true;
  const requestedAccounts: string[] = [];
  const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: recorded, status: 'connected',
    authenticationModeId: 'token', revisionSemantics: 'revisioned', credentialRevision: revision,
    configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null,
    displayName: 'Recorded linker', scopes: [] });
  const credential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: recorded,
    authenticationModeId: 'token', revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision: null,
    content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
      payload: { v: 1, values: { token: sentinel } }, randomBytes: length => new Uint8Array(length) }), metadata: { scopes: [] } });
  app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
  app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1, settingsVersion: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
  app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
  app.get('/v4/connect/qualified/accounts', async request => {
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    return { service, accounts: available ? [profile] : [] };
  });
  app.get('/v4/connect/qualified/credential', async (request, reply) => {
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    const ref = JSON.parse(new URL(request.url, serverHttpBaseUrl).searchParams.get('ref') ?? 'null');
    requestedAccounts.push(ref?.accountId);
    return available && ref?.accountId === recorded.accountId ? credential : reply.code(404).send({ error: 'not_found' });
  });
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
  const sends: string[] = [];
  vi.mocked(undici.fetch).mockImplementation(async (url, init) => {
      expect(String(url).startsWith('https://purpose-provider.example')).toBe(true);
      sends.push(new Headers(init?.headers).get('authorization') ?? '');
      return new undici.Response(`provider echoed ${sentinel}`, { headers: { 'x-echo': sentinel } });
  });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ features: { connectedServices: { enabled: true } },
      capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } } })));
  try {
    const cli = createCliActionExecutor({ token, credentials, happyHomeDir: home, sessionId: 'cli-global', mode: 'plain', ctx: null,
      serverId: 'account-purpose-home', serverHttpBaseUrl, runtimeActionMachineId: 'purpose-controller' });
    const invoke = (account = recorded) => cli.execute('action.invoke', { action: { pluginId: authored.pluginId, localId: 'purpose-request' },
      input: { link: { credentialRef: account }, key: 'inspect' } }, { surface: 'cli' });
    expect(sends).toEqual([]);
    const result = await invoke();
    expect(result, result.ok ? undefined : result.errorCode).toMatchObject({ ok: true, result: { status: 200 } });
    expect(sends).toEqual([`Bearer ${sentinel}`]);
    expect(requestedAccounts.length).toBeGreaterThan(0);
    expect(requestedAccounts.every(id => id === recorded.accountId)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(await invoke({ service, accountId: 'invoker-personal' })).toMatchObject({ ok: false });
    available = false;
    expect(await invoke()).toMatchObject({ ok: false });
    expect(sends).toHaveLength(1);
  } finally { restore(); await app.close(); await rm(home, { recursive: true, force: true }); }
});
