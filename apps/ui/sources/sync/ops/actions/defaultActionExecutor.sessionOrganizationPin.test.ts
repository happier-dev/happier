import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsV2GetResponseSchema, CurrentCursorResponseSchema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { SetSessionPinRequestSchema } from '@happier-dev/protocol/sessions/organization/mutations';

import { createPlainAccountEncryptionCurrentnessFixture, createSessionListRenderableSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { storage } from '@/sync/domains/state/storage';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

// Keep the Action catalog/admission, captured Account and organization writer
// real. The external HTTP/socket and native adapters are the only substitutions.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

installDisconnectedServerSocketBoundary(socket => {
    socket.connected = true;
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async () => { throw new Error('Unexpected Machine RPC from personal organization Action'); });
});

const features = FeaturesResponseSchema.parse({ features: {}, capabilities: {} });
const initialPin = { sessionId: 'bot', sortKey: 'a', pinnedAt: 1, listPinned: true, railPinned: false };
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let restoreActionLoader: (() => void) | undefined;
let writes: unknown[] = [];

describe('default UI session.organization.pin.set transport', () => {
    beforeAll(loadSyncSingletonForTests);
    beforeEach(async () => {
        writes = [];
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://pin-action.example.test', serverIdentityId: 'srv_pin-action-home', accountId: 'account-a',
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (init?.method && init.method !== 'GET') {
                    if (path !== '/v2/session-organization/pins/bot' || init.method !== 'PUT') throw new Error('Unexpected organization write target');
                    const request = SetSessionPinRequestSchema.parse(JSON.parse(String(init.body)));
                    writes.push(request);
                    return Response.json({ pin: { ...initialPin, railPinned: request.pinned } });
                }
                if (path === '/health') return Response.json({ status: 'ok' });
                if (path === '/v1/features') return Response.json(features);
                if (path === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v2/account/settings') return Response.json(AccountSettingsV2GetResponseSchema.parse({
                    content: { t: 'plain', v: {} }, version: 1,
                }));
                return new Response('{}', { status: 404 });
            },
        });
        storage.getState().applyServerScopedSessionListRows(connection.home.id, [
            createSessionListRenderableSessionFixture({ id: 'bot', metadata: { path: '/project', bot: { kind: 'bot' } } }),
            createSessionListRenderableSessionFixture({ id: 'ordinary', metadata: { path: '/project' } }),
        ], { source: 'ordinary', mode: 'replace' });
        const initialRecord = storage.getState().setSessionPinOptimistic(resolveServerProfileScopeIdForIdentifier(connection.home.id), initialPin.sessionId, initialPin);
        storage.getState().commitSessionOrganizationOptimistic(initialRecord);
    });
    afterEach(async () => {
        await standardCleanup();
        await connection?.dispose();
        connection = undefined;
        restoreActionLoader?.();
        restoreActionLoader = undefined;
    });

    it('uses the real Account pin writer for rail membership and refuses an ordinary Session before writing', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const serverId = connection!.home.id;
        const organizationServerId = resolveServerProfileScopeIdForIdentifier(serverId);
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, serverId };
        const ordinary = await executor.execute('session.organization.pin.set', { sessionId: 'ordinary', surface: 'rail', pinned: true }, context);
        expect(ordinary, JSON.stringify(ordinary)).toMatchObject({ ok: false, errorCode: 'session_not_bot' });
        expect(writes).toEqual([]);

        const result = await executor.execute('session.organization.pin.set', { sessionId: 'bot', surface: 'rail', pinned: true }, context);
        const pin = { ...initialPin, railPinned: true };
        expect(result, JSON.stringify(result)).toEqual({ ok: true, result: { pin } });
        expect(writes).toEqual([{ pinned: true, surface: 'rail' }]);
        expect(storage.getState().sessionOrganizationPinsBySessionKey[buildSessionOrganizationSessionKey(organizationServerId, 'bot')]).toEqual(pin);
    });

    it('executes rail SessionActions through the same Account front door and can clear a demoted retained choice', async () => {
        const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
        const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
        const { useSessionRowActionMenu } = await import('@/components/sessions/shell/row/actionMenu/useSessionRowActionMenu');
        const serverId = connection!.home.id;
        const organizationServerId = resolveServerProfileScopeIdForIdentifier(serverId);
        const bot = createSessionListRenderableSessionFixture({ id: 'bot', metadata: { path: '/project', bot: { kind: 'bot' } } });
        const rowMenu = await renderHook(() => useSessionRowActionMenu({
            target: createSessionActionTarget({ session: bot, serverId }), sessionName: 'Bot', hideInactiveSessions: false,
            iconColor: '#000', activeTags: [], knownTags: [], tagsEnabled: false, isNativeMobile: false,
            setContextMenuOpen() {}, openTagsMenuFromContext() {},
        }));
        const outcome = await rowMenu.getCurrent().handleMoreMenuSelect('ui.session.rail.pin')
            .then(() => ({ ok: true }), error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        expect(outcome, JSON.stringify({ outcome, writes })).toEqual({ ok: true });
        expect(storage.getState().sessionOrganizationPinsBySessionKey[buildSessionOrganizationSessionKey(organizationServerId, 'bot')], JSON.stringify({ writes }))
            .toEqual({ ...initialPin, railPinned: true });

        const demoted = createSessionListRenderableSessionFixture({ id: 'bot', metadata: { path: '/project' } });
        storage.getState().applyServerScopedSessionListRows(serverId, [demoted], { source: 'ordinary', mode: 'replace' });
        await executeSessionAction({ actionId: 'ui.session.rail.unpin',
            target: createSessionActionTarget({ session: demoted, serverId, isRailPinned: true }) });
        expect(writes).toEqual([{ pinned: true, surface: 'rail' }, { pinned: false, surface: 'rail' }]);
        expect(storage.getState().sessionOrganizationPinsBySessionKey[buildSessionOrganizationSessionKey(organizationServerId, 'bot')]).toEqual(initialPin);
    });
});
