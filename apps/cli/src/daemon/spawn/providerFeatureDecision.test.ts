import { afterEach, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { ApiClient } from '@/api/api';
import { createServerUrlServerFeaturesSnapshotStore } from '@/features/serverFeaturesSnapshotStore';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { resolveDaemonProvidersFeatureEnabled } from './providerFeatureDecision';

afterEach(() => { vi.unstubAllGlobals(); resetServerFeaturesClientForTests(); });

it('reads the daemon feature publication without repeating Home requests for Provider admissions', async () => {
  let enabled = true;
  const requests: string[] = [];
  // HTTP is the only substituted boundary; feature parsing, publication, Api
  // access and dependency decisions stay real.
  vi.stubGlobal('fetch', async (url: string | URL | Request) => {
    requests.push(new URL(String(url)).pathname);
    return Response.json(FeaturesResponseSchema.parse({ features: { providers: { enabled } } }));
  });
  const store = createServerUrlServerFeaturesSnapshotStore({ serverUrl: 'https://provider-home.test', token: 'fixture-token' });
  const api = await ApiClient.create({ token: 'fixture-token', encryption: null });
  api.setServerFeaturesSnapshotProvider(store.getSnapshot, store.refresh);
  const decide = () => resolveDaemonProvidersFeatureEnabled({ api, env: {}, resolveServerFeaturesSnapshot: store.refresh });
  await store.refresh();
  requests.length = 0;
  expect(await decide()).toBe(true);
  expect(await decide()).toBe(true);
  expect(requests).toEqual([]);

  enabled = false;
  await store.refresh();
  requests.length = 0;
  expect(await decide()).toBe(false);
  expect(requests).toEqual([]);
});

it('warms a missing publication once and fails closed when the Home disables Providers', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (url: string | URL | Request) => {
    requests.push(new URL(String(url)).pathname);
    return Response.json(FeaturesResponseSchema.parse({ features: { providers: { enabled: false } } }));
  });
  const store = createServerUrlServerFeaturesSnapshotStore({ serverUrl: 'https://cold-provider-home.test', token: 'fixture-token' });
  const api = await ApiClient.create({ token: 'fixture-token', encryption: null });
  api.setServerFeaturesSnapshotProvider(store.getSnapshot, store.refresh);
  const decide = () => resolveDaemonProvidersFeatureEnabled({ api, env: {}, resolveServerFeaturesSnapshot: store.refresh });
  expect(await decide()).toBe(false);
  expect(await decide()).toBe(false);
  expect(requests).toEqual(['/v1/features/authenticated']);
});

it('allows the existing refresh owner to recover an unavailable publication on the next admission', async () => {
  let reachable = false;
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (url: string | URL | Request) => {
    requests.push(new URL(String(url)).pathname);
    if (!reachable) return new Response('', { status: 503 });
    return Response.json(FeaturesResponseSchema.parse({ features: { providers: { enabled: true } } }));
  });
  const store = createServerUrlServerFeaturesSnapshotStore({ serverUrl: 'https://recovering-provider-home.test', token: 'fixture-token' });
  const api = await ApiClient.create({ token: 'fixture-token', encryption: null });
  api.setServerFeaturesSnapshotProvider(store.getSnapshot, store.refresh);
  const decide = () => resolveDaemonProvidersFeatureEnabled({ api, env: {}, resolveServerFeaturesSnapshot: store.refresh });
  expect(await decide()).toBe(false);
  reachable = true;
  expect(await decide()).toBe(true);
  requests.length = 0;
  expect(await decide()).toBe(true);
  expect(requests).toEqual([]);
});
