import { beforeEach, describe, expect, it, vi } from 'vitest';
import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { encodeV2SessionListCursorV1, SessionAwarenessListResultV1Schema } from '@happier-dev/protocol';
import {
    createPlainSessionOwnerMetadataEnvelopeV1,
    SessionOwnerMetadataV1Schema,
    SessionSharedMetadataV1Schema,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { renderScreen, flushHookEffects, createSessionAccessFixture, createDeferred, installTimerCensus, standardCleanup } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

let contributedAgentId: string | null = null;
let fail = false;
let sessionIds = ['own'];
let requests = 0;
let paged = false;
let layoutOne = false;
let continuationRequested = false;
let firstPageIds = ['other'];
let extraEmptyPage = false;
let continuationIds = ['by-checkout', 'by-path'];
let continuationGate: ReturnType<typeof createDeferred<void>> | null = null;
const continuationCursor = encodeV2SessionListCursorV1('other');
const finalCursor = encodeV2SessionListCursorV1('other-next');
const sessionRecord = (id: string) => V2SessionRecordSchema.parse({
        id, seq: 1, createdAt: 1, updatedAt: 2, active: false, activeAt: 2,
        encryptionMode: 'plain', dataEncryptionKey: null,
        ...(layoutOne ? {
            metadataLayoutVersion: 1,
            metadata: JSON.stringify(SessionSharedMetadataV1Schema.parse({ v: 1 })),
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({ v: 1, workspace: {
                path: id.startsWith('other') ? '/other' : '/repo', machineId: 'machine',
                ...(id === 'by-checkout' ? { workspaceId: 'checkout' }
                    : id === 'by-path' ? {} : { projectId: id.startsWith('other') ? 'other-project' : 'anchor' }),
            } })),
        } : {
            metadataLayoutVersion: 0,
            metadata: JSON.stringify({ path: id.startsWith('other') ? '/other' : '/repo', machineId: 'machine', projectId: id.startsWith('other') ? 'other-project' : 'anchor', ...(contributedAgentId ? { runtimeDescriptorV1: { v: 1, agentId: contributedAgentId, agent: {}, provider: {} } } : {}) }),
        }),
        metadataVersion: 1, agentState: null, agentStateVersion: 1, share: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities },
        responsibleAccountId: null, responsibleAccount: null,
    viewer: {
        latestFailureSeq: null,
        readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
        relevance: { relevant: true, reasons: ['owned_by_me'] },
        attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
        follow: { follows: false, notificationLevel: null }, notification: { level: 'important', source: 'owner' },
    } });
const runtime = installSessionPaneRuntimeTestHarness({
    features: () => createRootLayoutFeaturesResponse({ features: { sessions: { filteredListing: { enabled: true } } } }),
    configureSocket: socket => {
        vi.spyOn(socket, 'emit').mockReturnValue(socket);
        vi.mocked(socket.connect).mockImplementation(() => {
            socket.connected = true;
            for (const listener of socket.listeners('connect')) listener();
            return socket;
        });
}, request: async (url, init) => {
    const address = new URL(String(url));
    const path = address.pathname;
    const id = path.startsWith('/v2/sessions/') ? decodeURIComponent(path.slice('/v2/sessions/'.length)) : null;
    const admittedIds = paged ? [...firstPageIds, ...continuationIds, ...(extraEmptyPage ? ['other-next'] : [])] : sessionIds;
    if (id && admittedIds.includes(id)) return Response.json({ session: sessionRecord(id) });
    if (path !== '/v2/sessions' && path !== '/v1/sessions' && path !== '/v2/sessions/query') return null;
    requests += 1;
    if (fail) return new Response('{}', { status: 503 });
    const cursor = path === '/v2/sessions/query' && typeof init?.body === 'string'
        ? SessionListQueryV1Schema.parse(JSON.parse(init.body)).cursor
        : address.searchParams.get('cursor');
    if (paged && cursor === continuationCursor) continuationRequested = true;
    if (paged && cursor) await continuationGate?.promise;
    const intermediate = extraEmptyPage && cursor === continuationCursor;
    const ids = paged ? intermediate ? ['other-next'] : cursor ? continuationIds : firstPageIds : sessionIds;
    const more = paged && (!cursor || intermediate);
    const page = { sessions: ids.map(sessionRecord), nextCursor: more ? intermediate ? finalCursor : continuationCursor : null, hasNext: more, attentionNextCursor: null, attentionHasNext: false };
    return Response.json(createSessionListSourceFixture(page));
} });

const { ProjectSessionsWidgetBody } = await import('./ProjectSessionsWidgetBody');
const { storage } = await import('@/sync/domains/state/storageStore');
const { listSessionsForVoiceTool } = await import('@/voice/tools/actionImpl/sessionList');

describe('Project Sessions widget body', () => {
    beforeEach(() => {
        contributedAgentId = null;
        fail = false;
        paged = false;
        layoutOne = false;
        continuationRequested = false;
        firstPageIds = ['other'];
        extraEmptyPage = false;
        continuationIds = ['by-checkout', 'by-path'];
        continuationGate = null;
    });
    it.each([false, true])('owns a relative-time wake only for rendered Sessions (populated: %s)', async populated => {
        sessionIds = populated ? ['own'] : [];
        const checkout = { id: 'checkout', serverId: runtime.serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout] });
        const timers = installTimerCensus(stack => stack.includes('sessionListRuntimeClock') ? 'session-list-clock' : null);
        try {
            const screen = await renderScreen(<runtime.Wrapper><ProjectSessionsWidgetBody checkout={checkout} testID="clock-widget" /></runtime.Wrapper>);
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(screen.findHostByTestId(populated ? 'clock-widget.session:own' : 'clock-widget.empty')).not.toBeNull();
            });
            expect(timers.read().filter(timer => timer.consumer === 'session-list-clock')).toHaveLength(populated ? 1 : 0);
        } finally {
            standardCleanup();
            timers.stop();
        }
    });
    it('lists only this Project\'s Sessions as rows', async () => {
        fail = false;
        sessionIds = ['own', 'other'];
        paged = true;
        firstPageIds = sessionIds;
        requests = 0;
        const checkout = { id: 'checkout', serverId: runtime.serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout] });
        const screen = await renderScreen(<runtime.Wrapper><ProjectSessionsWidgetBody checkout={checkout} testID="w" /></runtime.Wrapper>);
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findHostByTestId('w.session:own')).not.toBeNull();
        });
        expect(screen.findByTestId('w.session:other')).toBeNull();
        expect(screen.findByTestId('w.empty')).toBeNull();
        expect(screen.findHostByTestId('w.more')).not.toBeNull();
        expect(continuationRequested).toBe(false);
    });

    it('keeps a contributed Agent mark through the real compact Project roster', async () => {
        contributedAgentId = 'acme.agent';
        sessionIds = ['contributed'];
        const { SessionAgentCatalogIdentityIcon } = await import('@/components/sessions/presentation/SessionAgentCatalogIdentityIcon');
        const checkout = { id: 'checkout', serverId: runtime.serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout] });
        const screen = await renderScreen(<runtime.Wrapper><ProjectSessionsWidgetBody checkout={checkout} testID="agent-widget" /></runtime.Wrapper>);
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findHostByTestId('agent-widget.session:contributed')).not.toBeNull();
        });
        expect(screen.tree.root.findAllByType(SessionAgentCatalogIdentityIcon).map(node => node.props.agentId)).toContain('acme.agent');
    });

    it('automatically renders owner rows past a page with no Project matches', async () => {
        paged = true;
        layoutOne = true;
        extraEmptyPage = true;
        const gate = createDeferred<void>();
        continuationGate = gate;
        const checkout = { id: 'checkout', serverId: runtime.serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout] });
        const screen = await renderScreen(<runtime.Wrapper><ProjectSessionsWidgetBody checkout={checkout} testID="w" /></runtime.Wrapper>);
        try {
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(continuationRequested).toBe(true);
                expect(screen.findHostByTestId('w-state')).not.toBeNull();
                expect(screen.findByTestId('w.more')).toBeNull();
                expect(screen.findByTestId('w.empty')).toBeNull();
            });
        } finally {
            gate.resolve();
        }
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect({
                continuationRequested,
                refs: storage.getState().projectAccountRows?.workspaceRefs.map(ref => ref.id),
                row: storage.getState().sessionListRowsByServerId[runtime.serverId]?.['by-checkout'],
            }).toMatchObject({ continuationRequested: true, refs: ['checkout'], row: {
                metadata: { path: '/repo', machineId: 'machine', workspaceId: 'checkout' },
                metadataUnavailable: false,
            } });
            expect(screen.findHostByTestId('w.session:by-checkout')).not.toBeNull();
            expect(screen.findHostByTestId('w.session:by-path')).not.toBeNull();
        });
        expect(continuationRequested).toBe(true);
        expect(screen.findByTestId('w.session:other')).toBeNull();
        expect(screen.findByTestId('w.empty')).toBeNull();
        expect(screen.findByTestId('w.more')).toBeNull();
    });

    it('says the Project has no Sessions only once the roster answered complete', async () => {
        fail = false;
        paged = true;
        continuationIds = ['other'];
        const checkout = { id: 'checkout', serverId: runtime.serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout,
            { ...checkout, id: 'other-checkout', rootPath: '/other', projectKey: 'other-project' }] });
        const screen = await renderScreen(<runtime.Wrapper><ProjectSessionsWidgetBody checkout={checkout} testID="w" /></runtime.Wrapper>);
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findByTestId('w.empty')).not.toBeNull();
        });
        expect(continuationRequested).toBe(true);
        expect(screen.findByTestId('w.session:other')).toBeNull();
        expect(screen.findByTestId('w.more')).toBeNull();
    });

    it.each([true, false])('keeps the Project Action on the real page/hydration path (match: %s)', async match => {
        paged = true;
        layoutOne = true;
        continuationIds = match ? ['by-checkout', 'by-path'] : ['other'];
        const checkout = { id: 'checkout', serverId: runtime.serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout] });
        // Mount the admitted binder to establish the same authenticated Home as the widget.
        await renderScreen(<runtime.Wrapper><ProjectSessionsWidgetBody checkout={checkout} testID="w" /></runtime.Wrapper>);
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(storage.getState().sessionListRowsByServerId[runtime.serverId]?.other).toBeDefined();
        });
        continuationRequested = false;
        const result = await listSessionsForVoiceTool({ project: { serverId: runtime.serverId, projectKey: 'anchor' }, view: 'awareness' });
        expect(SessionAwarenessListResultV1Schema.parse(result).sessions.map(session => session.sessionId))
            .toEqual(match ? ['by-checkout', 'by-path'] : []);
        expect(result).toMatchObject({ nextCursor: null, hasNext: false });
        expect(continuationRequested).toBe(true);
    });
});
