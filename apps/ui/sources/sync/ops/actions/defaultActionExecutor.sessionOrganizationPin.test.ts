import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { AccountSettingsV2GetResponseSchema} from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { CurrentCursorResponseSchema} from '@happier-dev/protocol/changes';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { SetSessionPinRequestSchema } from '@happier-dev/protocol/sessions/organization/mutations';

import { createDeferred, createPlainAccountEncryptionCurrentnessFixture, createSessionListRenderableSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
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
    configureConnectedServerSocketBoundary(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async () => { throw new Error('Unexpected Machine RPC from personal organization Action'); });
});

const features = FeaturesResponseSchema.parse({ features: {}, capabilities: {} });
const initialPin = { sessionId: 'bot', sortKey: 'a', pinnedAt: 1, listPinned: true, railPinned: false };
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let restoreActionLoader: (() => void) | undefined;
let writes: unknown[] = [];
let answerWrite: ((path: string, init: RequestInit) => Promise<Response>) | undefined;

describe('default UI session.organization.pin.set transport', () => {
    beforeAll(loadSyncSingletonForTests);
    beforeEach(async () => {
        writes = [];
        answerWrite = undefined;
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://pin-action.example.test', serverIdentityId: 'srv_pin-action-home', accountId: 'account-a',
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (init?.method && init.method !== 'GET' && path.startsWith('/v2/session-organization/')) {
                    if (answerWrite) return answerWrite(path, init);
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

    it('settles same-page tag assignment through the real UI Action and scoped store', async () => {
        const serverId = connection!.home.id;
        answerWrite = async (path, init) => {
            expect(path).toBe('/v2/session-organization/tag-assignments/bot');
            const { SetSessionTagAssignmentsRequestSchema, SetSessionTagAssignmentsResponseSchema } = await import('@happier-dev/protocol/sessions/organization/mutations');
            const body = SetSessionTagAssignmentsRequestSchema.parse(JSON.parse(String(init.body)));
            writes.push(body);
            return Response.json(SetSessionTagAssignmentsResponseSchema.parse({ sessionId: 'bot', tagIds: body.tagIds }));
        };
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('session.tags.set', { sessionId: 'bot', tagIds: ['tag'] }, {
            surface: 'ui', serverId,
        })).toEqual({ ok: true, result: { sessionId: 'bot', tagIds: ['tag'] } });
        const key = buildSessionOrganizationSessionKey(resolveServerProfileScopeIdForIdentifier(serverId), 'bot');
        expect(storage.getState().sessionOrganizationTagAssignmentsBySessionKey[key]).toEqual({ sessionId: 'bot', tagIds: ['tag'] });
        expect(writes).toEqual([{ tagIds: ['tag'] }]);
    });

    it('sets and resets personal Session and Project-group colors through the saved display owners', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const { buildSessionOrganizationLabelKey } = await import('@/sync/domains/session/organization/keys');
        const serverId = connection!.home.id;
        const organizationServerId = resolveServerProfileScopeIdForIdentifier(serverId);
        const color = { kind: 'custom', hex: '#123456' } as const;
        storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'session.organization.appearance.set': { approvalRequiredSurfaces: [] },
            'projects.organization.color.set': { approvalRequiredSurfaces: [] },
        } }) });
        const value = { label: 'Personal title', future: { retained: true } };
        const record = storage.getState().upsertSessionOrganizationLabelOptimistic(organizationServerId, {
            labelKind: 'workspace', scopeKey: 'project-group', display: { t: 'plain', v: value },
            displayState: { status: 'available', value }, archivedAt: null, createdAt: 1, updatedAt: 1,
        });
        storage.getState().commitSessionOrganizationOptimistic(record);
        answerWrite = async (path, init) => {
            const body = JSON.parse(String(init.body));
            writes.push({ path, body });
            if (path === '/v2/session-organization/appearances/bot') return Response.json({
                appearance: body.display ? { sessionId: 'bot', display: body.display, updatedAt: 2 } : null,
            });
            if (path === '/v2/session-organization/labels') return Response.json({
                label: { ...body, archivedAt: null, createdAt: 1, updatedAt: 2 },
            });
            throw new Error(`Unexpected organization write ${path}`);
        };
        const executor = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, authority: 'account_automation' as const, serverId };
        for (const nextColor of [color, null]) {
            expect(await executor.execute('session.organization.appearance.set', { sessionId: 'bot', color: nextColor }, context))
                .toEqual({ ok: true, result: { status: 'applied' } });
            expect(await executor.execute('projects.organization.color.set', { workspaceKey: 'project-group', color: nextColor }, context))
                .toEqual({ ok: true, result: { status: 'applied' } });
            const key = buildSessionOrganizationLabelKey({ serverId: organizationServerId, labelKind: 'workspace', scopeKey: 'project-group' });
            expect(storage.getState().sessionOrganizationLabelsByLabelKey[key]?.display).toEqual({ t: 'plain', v: {
                ...value, ...(nextColor ? { color: nextColor } : {}),
            } });
        }
        expect(writes).toHaveLength(4);
        expect(storage.getState().sessionOrganizationAppearancesBySessionKey[buildSessionOrganizationSessionKey(organizationServerId, 'bot')]).toBeUndefined();
        const denied = await executor.execute('projects.organization.color.set', { workspaceKey: 'project-group', color, serverId: 'foreign-home' }, context);
        expect(denied).toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
        expect(writes).toHaveLength(4);
    });

    it.each([
        { actionId: 'session.organization.pin.set', input: { sessionId: 'bot', surface: 'rail', pinned: true },
            path: '/v2/session-organization/pins/bot', reply: { pin: { ...initialPin, railPinned: true } },
            result: { pin: { ...initialPin, railPinned: true } }, field: 'sessionOrganizationPinsBySessionKey',
            stored: { ...initialPin, railPinned: true }, disposition: 'committed' },
        { actionId: 'session.organization.pin.set', input: { sessionId: 'bot', surface: 'rail', pinned: true },
            path: '/v2/session-organization/pins/bot', reply: { error: 'session-pin-limit-exceeded' },
            result: null, field: 'sessionOrganizationPinsBySessionKey', stored: initialPin, disposition: 'refused' },
        { actionId: 'session.attention.set', input: { sessionId: 'bot', standing: true },
            path: '/v2/session-organization/attention-standings/bot',
            reply: { standing: { sessionId: 'bot', standing: true, updatedAt: 2 } },
            result: { standing: { sessionId: 'bot', standing: true, updatedAt: 2 } },
            field: 'sessionOrganizationAttentionStandingsBySessionKey', stored: { sessionId: 'bot', standing: true, updatedAt: 2 }, disposition: 'committed' },
        { actionId: 'session.section.set', input: { sessionId: 'bot', sectionId: 'section' },
            path: '/v2/session-organization/folder-assignments/bot', reply: { sessionId: 'bot', folderId: 'section' },
            result: { sessionId: 'bot', sectionId: 'section', previousSectionId: 'previous-section' },
            field: 'sessionOrganizationFolderAssignmentsBySessionKey', stored: { sessionId: 'bot', folderId: 'section' }, disposition: 'committed' },
        { actionId: 'session.tags.set', input: { sessionId: 'bot', tagIds: [] },
            path: '/v2/session-organization/tag-assignments/bot', reply: { sessionId: 'bot', tagIds: [] },
            result: { sessionId: 'bot', tagIds: [] }, field: 'sessionOrganizationTagAssignmentsBySessionKey',
            stored: { sessionId: 'bot', tagIds: [] }, disposition: 'committed' },
    ] as const)('settles mounted $actionId truthfully after navigating away ($disposition)', async testCase => {
        const issued = createDeferred<AbortSignal | null | undefined>();
        const response = createDeferred<Response>();
        answerWrite = async (path, init) => {
            expect(path).toBe(testCase.path);
            writes.push(JSON.parse(String(init.body)));
            issued.resolve(init.signal);
            const reply = await response.promise;
            // Fetch can reject after the server committed if its caller aborts before receiving the reply.
            init.signal?.throwIfAborted();
            return reply;
        };
        const serverId = connection!.home.id;
        const organizationServerId = resolveServerProfileScopeIdForIdentifier(serverId);
        storage.getState().applySessionFolderAssignments(organizationServerId, [{ sessionId: 'bot', folderId: 'previous-section' }]);
        const mounted = await renderHook(() => useMountedActionExecution(serverId));
        await vi.waitFor(() => expect(mounted.getCurrent().ready).toBe(true));
        const author = mounted.getCurrent();
        const pending = author.execute(testCase.actionId, testCase.input);
        try {
            const signal = await Promise.race([issued.promise, pending.then(result => {
                throw new Error(`Action settled before its write: ${JSON.stringify(result)}`);
            })]);
            await mounted.unmount();
            const abortedOnNavigation = signal?.aborted;
            response.resolve(Response.json(testCase.reply, { status: testCase.disposition === 'refused' ? 409 : 200 }));
            const result = await pending;
            expect({ abortedOnNavigation, result }).toMatchObject({ abortedOnNavigation: false,
                result: testCase.disposition === 'committed' ? { ok: true, result: testCase.result }
                    : { ok: false, errorCode: 'action_failed' } });
            const key = buildSessionOrganizationSessionKey(organizationServerId, 'bot');
            expect(storage.getState()[testCase.field][key]).toEqual(testCase.stored);
            expect(await author.execute('session.organization.pin.set', { sessionId: 'bot', surface: 'rail', pinned: false }))
                .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
            expect(writes).toHaveLength(1);
        } finally {
            response.resolve(Response.json({ pin: initialPin }));
            await pending;
        }
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
            iconColor: '#000', activeTags: [], knownTags: [], tagsEnabled: false, touchPrimaryPointer: false,
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
