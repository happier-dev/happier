import { afterEach, expect, it, vi } from 'vitest';
import { openQualifiedConnectedAccountContentEnvelope, parseQualifiedConnectedAccountCredentialPlaintextV1 } from '@happier-dev/protocol';
import { createBuiltInQualifiedRefreshHarness } from './ConnectedServiceRefreshCoordinator.qualifiedRefresh.testkit';

// Genuine HTTP boundary; retain the real coordinator, dispatcher, plugin and settlement.
vi.mock('undici', async importOriginal => {
  const runtime = await importOriginal<typeof import('undici')>();
  return { ...runtime, fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args) };
});

afterEach(() => { vi.unstubAllGlobals(); });

it('settles the rotating refresh when its Account executor cancels after the callback', async () => {
  const controller = new AbortController();
  const fetchBoundary = vi.fn(async () => new Response(JSON.stringify({
    access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600,
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchBoundary);
  const harness = await createBuiltInQualifiedRefreshHarness({
    async runAccountOperation(operation) {
      const result = await operation();
      if (fetchBoundary.mock.calls.length > 0) controller.abort();
      return result;
    },
  });
  try {
    await expect(harness.coordinator.refreshQualifiedConnectedAccountCredentialForRequestAuth({
      account: harness.account, expectedCredentialRevision: harness.firstRevision, signal: controller.signal,
    })).resolves.toBe(true);
    expect(controller.signal.aborted).toBe(true);
    const persisted = await harness.readCredential();
    expect(persisted.credentialRevision).toBe(harness.secondRevision);
    if (persisted.authenticationModeId === null) throw new Error('Refreshed credential has no authentication mode');
    expect(parseQualifiedConnectedAccountCredentialPlaintextV1({
      ref: persisted.ref, authenticationModeId: persisted.authenticationModeId,
      metadata: persisted.metadata, plaintext: openQualifiedConnectedAccountContentEnvelope({
        kind: 'credential', accountMode: 'plain', envelope: persisted.content,
      }),
    }).values).toMatchObject({ accessToken: 'access-new', refreshToken: 'refresh-new' });
    expect(fetchBoundary).toHaveBeenCalledOnce();
    expect(harness.mutateCredential).toHaveBeenCalledOnce();
    expect(harness.mutateCredentialHealth).toHaveBeenCalledOnce();
  } finally {
    await harness.dispose();
  }
});
