import React from 'react';
import { createHash } from 'node:crypto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedServiceIdSchema, decodeBase64, encodeBase64, openConnectedServiceCredentialCiphertext, sealBoxBundle } from '@happier-dev/protocol';
import { changeTextTestInstance, renderScreen } from '@/dev/testkit';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installConnectedServicesCommonModuleMocks } from './connectedServicesTestHelpers';

const alerts = vi.hoisted(() => vi.fn(async () => {}));
const secret = new Uint8Array(32).fill(3);
vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: { token: 'synthetic-account-token', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } }),
}));
installConnectedServicesCommonModuleMocks({ modal: async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ spies: { alert: alerts, alertAsync: vi.fn(async () => {}) } }).module;
} });

type HttpExchange = Readonly<{ publicKey: string; code: string; verifier: string; redirectUri: string; state: string }>;
let exchanges: HttpExchange[];
let storedRecords: unknown[];
let returnedService: string;
let exchangeFailure: boolean;

describe('Connected Service OAuth paste HTTP composition', () => {
  beforeEach(async () => {
    alerts.mockClear();
    exchanges = [];
    storedRecords = [];
    returnedService = 'antigravity';
    exchangeFailure = false;
    const { resetServerFeaturesClientForTests, getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    resetServerFeaturesClientForTests();
    const features = createRootLayoutFeaturesResponse({ capabilities: { connectedServices: {
      credentialDelete: { revisionGuard: true }, credentialWrite: { revisionGuard: false }, supportedServiceIds: [...ConnectedServiceIdSchema.options],
    } } });
    // HTTP is the boundary: PKCE, adapter, recipient keypair, bundle opening, record
    // normalization and account encryption all execute their real implementation.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
      if (path === '/v1/features') return json(features);
      if (path.endsWith('/oauth/exchange')) {
        const request = JSON.parse(String(init?.body)) as HttpExchange;
        exchanges.push(request);
        if (exchangeFailure) return json({ error: 'connect_oauth_invalid_grant' }, 400);
        const bundle = sealBoxBundle({
          plaintext: new TextEncoder().encode(JSON.stringify({ serviceId: returnedService, accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', providerEmail: 'selected@example.test', providerAccountId: 'selected-google-account', raw: { project_id: 'selected-project', client_secret: 'discard-me' } })),
          recipientPublicKey: decodeBase64(request.publicKey, 'base64url'),
          randomBytes: (length) => new Uint8Array(length).fill(7),
        });
        return json({ bundle: encodeBase64(bundle, 'base64url') });
      }
      if (path === '/v1/account/encryption') return json({ mode: 'e2ee', updatedAt: 1 });
      if (path.endsWith('/credential')) {
        if (init?.method !== 'POST') return json({ error: 'connect_credential_not_found' }, 404);
        const body = JSON.parse(String(init.body)) as { sealed: { ciphertext: string } };
        storedRecords.push(openConnectedServiceCredentialCiphertext({ material: { type: 'legacy', secret }, ciphertext: body.sealed.ciphertext })?.value);
        return json({ success: true, credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz' });
      }
      return json({ ok: true });
    }));
    await getServerFeaturesSnapshot({ force: true });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function paste(serviceId: string, input: (state: string, callback: string) => string) {
    const { ConnectedServiceOauthPasteView } = await import('./ConnectedServiceOauthPasteView');
    const onDone = vi.fn();
    const screen = await renderScreen(<ConnectedServiceOauthPasteView serviceId={serviceId} profileId="work" onDone={onDone} />);
    await act(async () => { await flushHookEffects({ cycles: 2, turns: 2 }); });
    const authorization = screen.tree.find((node) => typeof node.props.children === 'string' && node.props.children.startsWith('https://accounts.google.com/o/oauth2/') && node.props.selectable === true);
    const url = new URL(authorization.props.children);
    const field = screen.findByTestId('connectedServices.oauthPaste.redirectUrlInput');
    if (!field) throw new Error('Missing OAuth paste field');
    await act(async () => { changeTextTestInstance(field, input(url.searchParams.get('state')!, url.searchParams.get('redirect_uri')!)); });
    await screen.pressByTestIdAsync('connectedServices.oauthPaste.validateRedirectButton');
    // Every paste outcome (connected, rejected or failed exchange) ends in an alert. The
    // credential reads own their response bodies, so settle on that outcome, not a tick count.
    await vi.waitFor(() => expect(alerts).toHaveBeenCalled());
    await act(async () => { await flushHookEffects({ cycles: 2, turns: 2 }); });
    return { url, onDone, screen };
  }

  it('exchanges a raw AGY code with this authorization attempt PKCE and stores the selected normalized identity', async () => {
    const { url, onDone } = await paste('antigravity', () => '  synthetic-google-code/with+punctuation  ');
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]).toMatchObject({ code: 'synthetic-google-code/with+punctuation', redirectUri: 'https://antigravity.google/oauth-callback', state: url.searchParams.get('state') });
    expect(createHash('sha256').update(exchanges[0].verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect(storedRecords).toEqual([expect.objectContaining({ serviceId: 'antigravity', profileId: 'work', kind: 'oauth', oauth: expect.objectContaining({ providerEmail: 'selected@example.test', providerAccountId: 'selected-google-account', raw: { project_id: 'selected-project' } }) })]);
    expect(onDone).toHaveBeenCalled();
  });

  it.each([
    ['foreign callback URL', (state: string, _callback: string) => `https://foreign.example/oauth-callback?code=synthetic-code&state=${state}`],
    ['foreign relative callback with fragment', (state: string, _callback: string) => `//foreign.example/oauth-callback?code=synthetic-code#${state}`],
    ['wrong callback path', (state: string, _callback: string) => `https://antigravity.google/other?code=synthetic-code&state=${state}`],
    ['missing callback state', (_state: string, callback: string) => `${callback}?code=synthetic-code`],
    ['wrong callback state', (_state: string, callback: string) => `${callback}?code=synthetic-code&state=foreign-state`],
    ['wrong code#state', () => 'synthetic-code#foreign-state'],
    ['provider error with code', (state: string, callback: string) => `${callback}?error=access_denied&code=synthetic-code&state=${state}`],
  ] as const)('rejects %s before exchange or storage', async (_name, input) => {
    const { onDone } = await paste('antigravity', input);
    expect(exchanges).toEqual([]);
    expect(storedRecords).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
    expect(alerts).toHaveBeenCalled();
  });

  it('requires fresh authorization after the code exchange fails', async () => {
    exchangeFailure = true;
    const { url, screen } = await paste('antigravity', () => 'one-use-code');
    await act(async () => { await flushHookEffects({ cycles: 2, turns: 2 }); });
    const next = screen.tree.find((node) => typeof node.props.children === 'string' && node.props.children.startsWith('https://accounts.google.com/o/oauth2/') && node.props.selectable === true);
    const nextUrl = new URL(next.props.children);
    expect(nextUrl.searchParams.get('state')).not.toBe(url.searchParams.get('state'));
    expect(nextUrl.searchParams.get('code_challenge')).not.toBe(url.searchParams.get('code_challenge'));
    expect(screen.findByTestId('connectedServices.oauthPaste.redirectUrlInput')?.props.value).toBe('');
    expect(screen.findByTestId('connectedServices.oauthPaste.validateRedirectButton')?.props.disabled).toBe(true);
    expect(exchanges).toHaveLength(1);
    expect(storedRecords).toEqual([]);
  });

  it('retains the returned state when AGY supplies a matching callback URL', async () => {
    const { url } = await paste('antigravity', (state, callback) => `${callback}?code=synthetic-code&state=${state}`);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].state).toBe(url.searchParams.get('state'));
  });

  it('rejects a sealed exchange claiming another service before account storage', async () => {
    returnedService = 'gemini';
    const { onDone } = await paste('antigravity', () => 'synthetic-google-code');
    expect(exchanges).toHaveLength(1);
    expect(storedRecords).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
    expect(alerts).toHaveBeenCalled();
  });

  it('does not allow a raw code for the Gemini callback flow', async () => {
    await paste('gemini', () => 'synthetic-google-code');
    expect(exchanges).toEqual([]);
    expect(storedRecords).toEqual([]);
  });
});
