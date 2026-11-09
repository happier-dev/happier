import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicProfileOwnerReadV1Schema, PublicProfileViewV1Schema, DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { PublicProfilePreviewResultV1Schema } from '@happier-dev/protocol/account/publicProfileIntents';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PublicProfilePolicyV1Schema } from '@happier-dev/protocol/account/publicProfile';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { ATMOSPHERE_PICTURES } from '@happier-dev/brand/atmosphere';
import { DEFAULT_HOME_ATMOSPHERE } from '@happier-dev/protocol/account/settings/accountSettings';
import { PublicProfileUpdateBodyV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { preparePublicProfileAtmosphere } from '@/components/atmosphere/preparePublicProfileAtmosphere';
import type { PictureStore } from '@/components/atmosphere/pictureStore.types';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { standardCleanup } from '@/dev/testkit';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createDefaultActionExecutor } from './defaultActionExecutor';

const machineRpc = vi.hoisted(() => vi.fn());
// The Machine RPC is the external boundary; preparation and Action admission stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { machineRpc.mockReset(); standardCleanup(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; });

describe('public-profile UI captured Account binding', () => {
  it('sends only the retained selected picture through Apply, without acquiring Usage or writing Home settings', async () => {
    const owner = PublicProfileOwnerReadV1Schema.parse({ kind: 'ready', context: { handle: 'ada', identity: {}, service: null, urls: null },
      record: { state: 'published', policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, projectSelections: [],
        query: normalizeUsageQuery({}), snapshot: null, layout: { v: 1, items: [] },
        appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, updatedAtMs: 1, publishedAtMs: 1, restriction: null } });
    const picture = structuredClone(ATMOSPHERE_PICTURES[0]!);
    const presentation = { ...DEFAULT_HOME_ATMOSPHERE, source: 'picture' as const,
      picture: { ref: { kind: 'builtin' as const, id: picture.id }, layout: 'wallpaper' as const },
      looks: { [picture.id]: { look: 'mosaic' as const, strength: 0.37, dissolve: 'rows' as const } } };
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
    // Persistence and image encoding are device boundaries; selection, Look, Action and HTTP owners remain real.
    const store = {
      get: async (localId: string) => ({ localId, kind: 'builtin' as const, createdAtMs: 1, size: 1,
        data: new Blob(['device source'], { type: 'image/webp' }), source: picture.src }),
      prepare: async () => `data:image/png;base64,${png}`,
    } satisfies Pick<PictureStore, 'get' | 'prepare'>;
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://profile-home.test', accountId: 'account-a' }],
      route: request => {
        if (request.path === '/v1/account/public-profile' && request.method === 'GET') {
          // The private candidate moves after review; dispatch must not re-resolve it.
          presentation.looks[picture.id]!.strength = 0.9;
          picture.look = { effect: 'original' };
          return Response.json(owner);
        }
        if (request.path === '/v1/account/public-profile/policy' && request.method === 'PUT') {
          return Response.json({ kind: 'updated', record: owner.kind === 'ready' ? owner.record : null });
        }
        return undefined;
      } });
    const retained = await preparePublicProfileAtmosphere({ presentation, pictures: [picture], store, isCurrent: () => true });
    if (retained.status !== 'ready') throw new Error('Expected reviewed local copy');
    const appearance = { atmosphere: retained.value, theme: 'auto' as const };
    const reviewed = structuredClone(appearance);
    expect(home.requests.filter(request => request.path.startsWith('/v1/account/public-profile') || request.method !== 'GET')).toEqual([]);
    const focused = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
    await expect(createDefaultActionExecutor().execute('account.public_profile.update', { appearance }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: focused.id, expectedAccountId: 'account-a',
    })).resolves.toMatchObject({ ok: true, result: { kind: 'updated' } });
    const writes = home.requests.filter(request => request.path.startsWith('/v1/account/public-profile') && request.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'PUT', path: '/v1/account/public-profile/policy' });
    expect(PublicProfileUpdateBodyV1Schema.parse(writes[0]!.body)).toEqual({ appearance: reviewed });
    expect(reviewed.atmosphere).toMatchObject({ source: 'picture', picture: {
      content: { mimeType: 'image/png', base64: png }, descriptor: { adaptiveHaze: false, look: {
        effect: 'mosaic', strength: 0.37, dissolve: { style: 'rows' },
      } },
    } });
    expect(home.requests.some(request => request.path === '/v2/usage/query')).toBe(false);
    expect(home.requests.some(request => request.path === '/v1/account/settings' && request.method !== 'GET')).toBe(false);
  });
  it.each([
    { source: 'planet', missing: null }, { source: 'picture', missing: null },
    { source: 'planet', missing: 'report' }, { source: 'picture', missing: 'ingress' },
  ] as const)('previews real admitted Usage and the exact $source without uploading (missing: $missing)', async ({ source, missing }) => {
    const startMs = Date.parse('2026-10-20T00:00:00Z');
    const endMs = startMs + 86_400_000;
    const policy = PublicProfilePolicyV1Schema.parse({ indexable: false, fields: Object.fromEntries(
      Object.keys(DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields).map(field => [field, ['tokens', 'activeDays', 'calendar', 'agentMix', 'sourceSplit', 'agentTime'].includes(field)])) });
    const owner = PublicProfileOwnerReadV1Schema.parse({ kind: 'absent', context: { handle: 'ada', identity: {},
      service: missing === 'ingress' ? null : { displayName: 'Home', publicBaseUrl: 'https://profile-home.test' }, urls: missing ? null : {
        page: 'https://profile-home.test/@ada', json: 'https://profile-home.test/@ada/json',
        badgeBase: 'https://profile-home.test/@ada/badge', card: 'https://profile-home.test/@ada/card.svg',
        og: 'https://profile-home.test/@ada/og.png', report: 'mailto:operator@profile-home.test',
      } } });
    const tokens = { input: 8, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 };
    const cost = { reportedUsd: 87654, estimatedUsd: 98765, currency: 'USD' };
    const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 2, tokens, cost },
      contributions: [{ id: 'private-request-id', observedAtMs: startMs + 100, sessionId: 'private-session', turnId: 'private-turn',
        agentId: 'codex', modelId: 'private-model', machineId: 'private-machine', projectKey: 'private-project', workspaceId: null,
        source: 'private-source', sourceContext: { path: 'runtime', execution: 'happier' }, eventCount: 2, tokens, cost }],
      activity: { calendarDays: [{ date: '2026-10-20', eventCount: 2 }] }, coverage: { status: 'partial', reasons: ['incomplete_history'],
        missingDimensions: [], ranked: [], range: { startMs, endMs, complete: false }, sources: [{ source: 'private-source', path: 'runtime',
          status: 'available', eventCount: 2, asOfMs: endMs, historyComplete: false }] },
    });
    const picture = structuredClone(ATMOSPHERE_PICTURES[0]!);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
    const retained = source === 'picture' ? await preparePublicProfileAtmosphere({
      presentation: { ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', picture: { ref: { kind: 'builtin', id: picture.id }, layout: 'horizon' },
        looks: { [picture.id]: { look: 'mosaic', strength: .37, dissolve: 'rows' } } }, pictures: [picture],
      store: { get: async localId => ({ localId, kind: 'builtin' as const, createdAtMs: 1, size: 1,
        data: new Blob(['local source'], { type: 'image/webp' }), source: picture.src }), prepare: async () => `data:image/png;base64,${png}` },
      isCurrent: () => true,
    }) : { status: 'ready' as const, value: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1.atmosphere };
    if (retained.status !== 'ready') throw new Error('Expected local prepared atmosphere');
    const appearance = { atmosphere: retained.value, theme: 'auto' as const };
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://profile-home.test', accountId: 'account-a' }],
      route: request => {
        if (request.path === '/v1/account/public-profile') return Response.json(owner);
        if (request.path === '/v2/usage/query') return Response.json(accounting);
        if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
        if (request.path === '/v2/sessions/read-batch') return Response.json({ results: [{ sessionId: 'private-session',
          detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id: 'private-session',
            metadata: { machineId: 'private-machine', path: '/workspace/private-project', host: 'private-host' } }) } },
          turns: { status: 200, body: { v: 1, sessionId: 'private-session', updatedAt: endMs, turns: [{ turnId: 'private-turn',
            agentId: 'codex', status: 'completed', startedAt: startMs + 100, terminalAt: startMs + 600, updatedAt: startMs + 600 }] } },
        }] });
        return undefined;
      } });
    const focused = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
    const result = await createDefaultActionExecutor().execute('account.public_profile.preview', { policy, metadataSelection: {},
      query: normalizeUsageQuery({ period: { startMs, endMs }, includeSessionEvidence: false, includeTranscriptEvidence: false,
        includeWorkEvidence: false, includeQuotaHistory: false, includeActivity: true }), layout: { v: 1, items: [] },
      appearance,
    }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: focused.id, expectedAccountId: 'account-a' });
    expect(result).toMatchObject({ ok: true, result: { kind: 'ready', view: { snapshot: { facts: { tokens: 10, activeDays: 1, agentTimeMs: 500,
      calendar: [{ date: '2026-10-20', level: 4 }], agentMix: [{ agentId: 'codex', share: 1 }],
    } } } } });
    expect(JSON.stringify(result)).not.toMatch(/private-request|private-session|private-turn|private-model|private-machine|private-project|private-source|87654|98765/);
    expect(home.requests.some(request => request.path === '/v2/usage/query')).toBe(true);
    expect(home.requests.some(request => request.path === '/v2/sessions/read-batch')).toBe(true);
    expect(result).toMatchObject({ ok: true, result: { kind: 'ready', view: { appearance } } });
    if (!result.ok) throw new Error('Expected local preview');
    const preview = PublicProfilePreviewResultV1Schema.parse(result.result);
    if (preview.kind !== 'ready') throw new Error('Expected local preview');
    expect(preview.view.service).toEqual(owner.context.service);
    expect(preview.view.urls).toEqual(owner.context.urls);
    expect(PublicProfileViewV1Schema.safeParse(preview.view).success).toBe(source !== 'picture' && !missing);
    expect(JSON.stringify(home.requests)).not.toContain(png);
    expect(home.requests.filter(request => request.path.startsWith('/v1/account/public-profile') && request.method !== 'GET')).toEqual([]);
  });

  it.each([
    ['off', true, false], ['default', false, false], ['default', true, false], ['default', true, true],
  ] as const)('honors SCM Action %s while preparing selected public projects (native signal: %s, cancelled: %s)', async (setting, native, cancelled) => {
    const policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, projects: true } };
    const owner = PublicProfileOwnerReadV1Schema.parse({ kind: 'ready', context: { handle: 'ada', identity: {}, service: null, urls: null },
      record: { state: 'published', policy, metadata: {}, projectSelections: [], query: normalizeUsageQuery({}), snapshot: null,
        layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
        updatedAtMs: 1, publishedAtMs: 1, restriction: null } });
    const controller = new AbortController();
    if (native) Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined });
    machineRpc.mockImplementation(async () => {
      if (cancelled) controller.abort();
      return { success: true, kind: 'public', repository: { label: 'team/repo', url: 'https://forge.test/team/repo' } };
    });
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://profile-home.test', accountId: 'account-a',
      settings: { actionsSettingsV1: { v: 1, actions: setting === 'off'
        ? { 'scm.hostingRepository.get': { disabledSurfaces: ['ui'] } } : {} } } }],
      route: request => {
        if (request.path === '/v1/account/public-profile' && request.method === 'GET') return Response.json(owner);
        if (request.path === '/v1/account/public-profile/policy' && request.method === 'PUT') {
          return Response.json({ kind: 'updated', record: owner.kind === 'ready' ? owner.record : null });
        }
        return undefined;
      } });
    const focused = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
    const { storage } = await import('@/sync/domains/state/storage');
    // Connection restoration starts Settings sync; invoke only after the fixture's policy is loaded.
    await waitForHomeGovernance(() => {
      expect(storage.getState().settingsScope).toEqual({ serverId: focused.id, accountId: 'account-a' });
      if (setting === 'off') expect(storage.getState().settings.actionsSettingsV1.actions['scm.hostingRepository.get'])
        .toMatchObject({ disabledSurfaces: ['ui'] });
    });
    const execution = createDefaultActionExecutor().execute('account.public_profile.update', { metadataSelection: {
      projectSelections: [{ provider: { id: 'example/forge', kind: 'custom', displayName: 'Forge', baseUrl: 'https://forge.test' },
        repository: { nameWithOwner: 'team/repo' }, protocol: 'https' }],
    } }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: focused.id,
      expectedAccountId: 'account-a', defaultSessionMachineId: 'machine', signal: controller.signal });
    if (cancelled) {
      await expect(execution).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
      expect(machineRpc).toHaveBeenCalled();
      expect(home.requests.some(request => request.path === '/v1/account/public-profile/policy' && request.method === 'PUT')).toBe(false);
      return;
    }
    const result = await execution;
    const write = home.requests.find(request => request.path === '/v1/account/public-profile/policy' && request.method === 'PUT');
    expect(result.ok || result.errorCode !== 'action_failed', result.ok ? undefined : result.error).toBe(true);
    if (setting === 'off') {
      expect(result).toMatchObject({ ok: false, errorCode: 'public_profile_preparation_unavailable' });
      expect(machineRpc).not.toHaveBeenCalled();
      expect(write).toBeUndefined();
    } else {
      expect(result.ok, result.ok ? undefined : JSON.stringify({ errorCode: result.errorCode, error: result.error, details: result.details })).toBe(true);
      expect(result).toMatchObject({ ok: true, result: { kind: 'updated' } });
      expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine', serverId: focused.id, accountId: 'account-a',
        method: 'scm.hostingRepository.get' }));
      expect(write?.body).toMatchObject({ metadata: { projects: [{ label: 'team/repo', url: 'https://forge.test/team/repo' }] } });
    }
  });
  it('uses the shared layout-only preparer and keeps private Usage unread', async () => {
    const layout = { v: 1, items: [] } as const;
    const owner = PublicProfileOwnerReadV1Schema.parse({ kind: 'ready', context: { handle: 'ada', identity: {},
      service: null, urls: null }, record: { state: 'published', policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      metadata: {}, projectSelections: [], query: normalizeUsageQuery({}), snapshot: null, layout,
      appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, updatedAtMs: 1, publishedAtMs: 1, restriction: null,
    } });
    const applied: unknown[] = [];
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://profile-home.test', accountId: 'account-a' }],
      route: request => {
        if (request.path === '/v1/account/public-profile' && request.method === 'GET') return Response.json(owner);
        if (request.path === '/v1/account/public-profile/policy' && request.method === 'PUT') {
          applied.push(request.body);
          return Response.json({ kind: 'updated', record: owner.kind === 'ready' ? owner.record : null });
        }
        return undefined;
      } });
    const focused = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
    await expect(createDefaultActionExecutor().execute('account.public_profile.update', { layout }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: focused.id, expectedAccountId: 'account-a',
    })).resolves.toMatchObject({ ok: true, result: { kind: 'updated' } });
    expect(applied).toEqual([{ layout }]);
    expect(home.requests.some(request => request.path === '/v2/usage/query')).toBe(false);
  });
});
