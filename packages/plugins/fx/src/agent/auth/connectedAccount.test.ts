import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV, type ConnectedServiceCredentialRecordV1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION } from '@happier-dev/protocol/connect/connected-account-request-auth';

import { FX_TERMINAL_CONTRIBUTION } from '../terminal/contribution.js';
import { FX_NATIVE_AUTH_CODEC } from './connectedAccount.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture(expiresAt: number | null = Date.now() + 3_600_000) {
  const home = await mkdtemp(join(tmpdir(), 'fx-connected-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const requests: unknown[] = [];
  // The daemon's private HTTP transport is the system boundary; the real SDK
  // capability reader, request encoder and response decoder run beneath it.
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, value: {
      accessToken: 'fixture-access', requiredHeaders: { 'chatgpt-account-id': 'fixture-account' },
      ...(expiresAt === null ? {} : { expiresAt }),
      credentialContext: { account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'fixture-profile' }, credentialRevision: `csr_${'a'.repeat(22)}` },
    } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture_address_missing');
  const capability = join(home, 'capability.json');
  await writeFile(capability, JSON.stringify({ v: CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION, materializationId: 'fx-fixture', subjectScopeDigest: 'd'.repeat(64), capability: 'c'.repeat(43), httpPort: address.port }));
  return { home, requests, expiresAt, launchEnvironment: { values: { HOME: home, [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]: capability }, unset: [] } };
}

describe('FX connected-account native launch', () => {
  it('launches terminal FX with qualified access-only auth in its prepared home', async () => {
    const input = await fixture();
    await mkdir(join(input.home, '.fx'), { mode: 0o755 });
    const plan = await FX_TERMINAL_CONTRIBUTION.resolveLaunch({ sessionId: 'session', cwd: '/workspace', metadata: {}, modelSelection: null, launchEnvironment: input.launchEnvironment });
    const auth = JSON.parse(await readFile(join(input.home, '.fx/chatgpt-auth.json'), 'utf8'));
    expect(auth).toEqual({ version: 1, access_token: 'fixture-access', refresh_token: 'happier-host-managed-no-refresh', account_id: 'fixture-account', expires_at_ms: input.expiresAt });
    if (process.platform !== 'win32') expect((await stat(join(input.home, '.fx'))).mode & 0o777).toBe(0o700);
    expect(plan.environment?.values).toMatchObject({ FX_PROVIDER: 'codex', FX_AUTH_MODE: 'local' });
    expect(input.requests).toEqual([expect.objectContaining({ purpose: { consumer: { pluginId: 'happier.agent.fx', localId: 'fx' }, purpose: 'openai-codex' } })]);
  });

  it('refuses a native launch when the lease cannot establish its expiry', async () => {
    const input = await fixture(null);
    await expect(FX_TERMINAL_CONTRIBUTION.resolveLaunch({ sessionId: 'session', cwd: '/workspace', metadata: {}, modelSelection: null, launchEnvironment: input.launchEnvironment })).rejects.toMatchObject({ code: 'fx_connected_account_expiry_unavailable' });
    await expect(readFile(join(input.home, '.fx/chatgpt-auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not verify a matching token inside a file rejected by the native schema', () => {
    const credential = { v: 1, kind: 'oauth', serviceId: 'openai-codex', profileId: 'fixture-profile', createdAt: 0, updatedAt: 0, expiresAt: Date.now() + 3_600_000,
      oauth: { accessToken: 'fixture-access', refreshToken: 'real-owner-refresh-never-exported', providerAccountId: 'fixture-account', providerEmail: null, idToken: null, scope: null, tokenType: null } } satisfies ConnectedServiceCredentialRecordV1;
    const files = { '.fx/chatgpt-auth.json': new TextEncoder().encode(JSON.stringify({ version: 2, access_token: 'fixture-access', account_id: 'fixture-account' })) };
    expect(FX_NATIVE_AUTH_CODEC.inspect({ selection: {}, credential, files })).toMatchObject({ status: 'mismatch' });
  });
});
