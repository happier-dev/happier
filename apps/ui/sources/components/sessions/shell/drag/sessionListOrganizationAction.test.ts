import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { Text } from 'react-native';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { EntityDropSettledFeedback } from '@/components/ui/treeDragDrop/ui/EntityDropSettledFeedback';
import { resolveSessionListEntityDrop } from './resolveSessionListEntityDrop';
import { describeSessionListDropReason } from '../dropPreview/sessionListDropPresentation';
import { projectActionOutcome } from '../dropPreview/sessionListActionOutcome';
import { ReorderSessionOrganizationRequestSchema } from '@happier-dev/protocol/sessions/organization/mutations';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { PINNED_GROUP_KEY_V1 } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { buildSessionOrganizationOrderScopeKey } from '@/sync/domains/session/organization/keys';
import { getStorage } from '@/sync/domains/state/storageStore';
import { writeSessionOrganizationGroupOrder, type SessionOrganizationMutationScope } from '@/sync/ops/sessionOrganization/sessionOrganizationMutationOwner';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { CommitSessionListDragIntentContext } from './commitSessionListDragIntent';
import { treeRowId } from '../drop-resolution/treeRowId';
import { createSessionListOrganizationActionAdapter, invokeSessionListOrganizationAction, registerMountedSessionListOrganizationAction } from './sessionListOrganizationAction';
import { buildSessionOrganizationListViewStateForServers } from '@/sync/domains/session/organization/viewState';
import { buildSessionOrganizationProjections } from '@/sync/domains/session/organization/projection';
import { readSessionOrganizationProjectionCached } from '@/sync/store/hooks';
import { computeVisibleSessionListIndex } from '@/sync/domains/session/listing/computeVisibleSessionListIndex';
import { normalizeSessionListGroupOrderV1ForIndexSource } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListTreeRows } from '../drop-resolution/buildSessionListTreeRows';
import { buildSessionListDragSource } from '../drop-resolution/buildSessionListDragSource';
import { resolveSessionListInstruction } from '../drop-resolution/resolveSessionListInstruction';
import { buildSessionListDragIntent } from './sessionListDragIntent';
import { SessionOrganizationMoveInputSchema, SessionOrganizationMoveOutputSchema } from '@happier-dev/protocol/actions/sessionOrganizationMoveAction';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());

describe('Project custom order through the mounted drop writer and list reader', () => {
    it('renders the acknowledged move and admits the reverse move instead of an invisible no-op', async () => {
        const serverId = 'custom-order-home';
        const scope = { serverId, accountId: 'account' };
        const workspace = { t: 'workspaceScope' as const, serverId, machineId: 'machine', rootPath: '/repo' };
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'project', title: 'Project', groupKey: 'project', workspaceKey: 'project', workspace, serverId },
            ...['first', 'moved'].map(sessionId => ({ type: 'session' as const, serverId, sessionId, groupKind: 'project' as const, groupKey: 'project', workspace, storageKind: 'persisted' as const })),
        ];
        const rows = Object.fromEntries(['first', 'moved'].map(id => [id, createSessionListRenderableSessionFixture({ id })]));
        const addresses = Object.fromEntries(['first', 'moved'].map(sessionId => [sessionAddressKey({ serverId, sessionId }), { itemKind: 'session' as const, serverId, sessionId }]));
        const readOrder = () => buildSessionOrganizationListViewStateForServers({ serverIds: [serverId],
            projectionsByServerId: buildSessionOrganizationProjections([serverId], id => readSessionOrganizationProjectionCached(getStorage().getState(), id)) }).sessionListGroupOrderV1;
        const readList = () => computeVisibleSessionListIndex({ source, resolveSessionRow: (_serverId, sessionId) => rows[sessionId] ?? null,
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListLayoutChoice: 'projects',
            sessionListGroupOrderV1: normalizeSessionListGroupOrderV1ForIndexSource({ source, pinnedSessionKeysV1: [], sessionListGroupOrderV1: readOrder() }),
            presentation: { enabled: false, presentation: 'flat-with-badge' } }) ?? [];
        const mutationScope: SessionOrganizationMutationScope = {
            serverId, serverUrl: 'https://custom-order.test', serverIdAliases: [], credentials: { token: 'token' },
            // HTTP is the only replacement boundary; the request/response schemas and store stay real.
            requestAtEndpoint: async (path, init) => {
                expect(path).toBe('/v2/session-organization/order');
                const request = ReorderSessionOrganizationRequestSchema.parse(JSON.parse(String(init?.body)));
                return Response.json({ orderEntries: request.entries.map(entry => ({ ...entry, scopeKind: request.scopeKind, scopeKey: request.scopeKey })) });
            },
        };
        const context = (): CommitSessionListDragIntentContext => ({ scope, latestItems: readList(),
            sessionListGroupOrderV1: readOrder(), sessionListLayoutV1: 'projects',
            setSessionFolderAssignment: async () => { throw new Error('Reorder must not move a session'); },
            setSessionListGroupOrderV1: next => writeSessionOrganizationGroupOrder({ scope: mutationScope, next, orderItemAddressByItemKey: addresses }),
        });
        const retire = registerMountedSessionListOrganizationAction(createSessionListOrganizationActionAdapter(context));
        try {
            const tree = buildSessionListTreeRows({ items: readList(), rowBoundsById: new Map([
                [treeRowId.workspaceRoot('project'), { x: 0, y: 0, width: 320, height: 40 }],
                [treeRowId.session(serverId, 'first'), { x: 0, y: 40, width: 320, height: 40 }],
                [treeRowId.session(serverId, 'moved'), { x: 0, y: 80, width: 320, height: 40 }],
            ]) });
            const dragSource = buildSessionListDragSource({ tree, sourceRowId: treeRowId.session(serverId, 'moved') });
            const result = resolveSessionListInstruction({ tree, source: dragSource, pointer: { x: 160, y: 42 }, foldersFeatureEnabled: false,
                canReorderSessionSiblings: true });
            expect(result.instruction.kind).toBe('reorder-before');
            const intent = buildSessionListDragIntent({ result, sourceRowId: dragSource.metadata.rowId, sourceKind: 'leaf', snapshotSignature: '', scope });
            const { sourceSnapshotSignature: _signature, ...semanticInput } = intent;
            const input = SessionOrganizationMoveInputSchema.parse(semanticInput);
            const runtime = createEntityDragDropRuntime();
            runtime.registerSource({ id: 'move', scope, isCurrent: () => true,
                getItem: () => ({ kind: 'session', scope, address: { serverId, sessionId: 'moved' } }) });
            runtime.registerTarget({ id: 'list', scope, acceptedKinds: ['session'], getBounds: () => ({ x: 0, y: 0, width: 320, height: 200 }),
                resolve: request => resolveSessionListEntityDrop({ item: request.item,
                    intent: { ...SessionOrganizationMoveInputSchema.parse(request.destination), sourceSnapshotSignature: '' }, context: context(),
                    preview: () => ({ verb: 'Move above First', target: 'First', consequence: 'Changes the order only' }), reason: describeSessionListDropReason }),
                execute: async effect => projectActionOutcome(effect.actionId, { ok: true,
                    result: SessionOrganizationMoveOutputSchema.parse(await invokeSessionListOrganizationAction({ input: effect.input, mutationScope })) }),
            });
            const renderRows = () => React.createElement(React.Fragment, null, readList().flatMap(item => item.type === 'session'
                ? [React.createElement(EntityDropSettledFeedback, { key: item.sessionId, runtime, testID: `row.${item.sessionId}`,
                    match: { item: carried => carried.kind === 'session' && carried.address.serverId === serverId && carried.address.sessionId === item.sessionId } },
                    React.createElement(Text, null, item.sessionId))] : []));
            const screen = await renderScreen(renderRows());
            try {
                await act(async () => {
                    const carry = runtime.begin('move', 'keyboard')!;
                    carry.choose('list', input);
                    expect(await carry.release()).toEqual({ status: 'applied' });
                    await screen.update(renderRows());
                });
                expect(screen.findAllByType(Text).map(node => node.props.children)).toEqual(['moved', 'first']);
                expect(screen.findHostByTestId('row.moved-landed')).not.toBeNull();
                expect(screen.findHostByTestId('row.first-landed')).toBeNull();
            } finally { await screen.unmount(); runtime.cancel(); }
            expect(readList().flatMap(item => item.type === 'session' ? [item.sessionId] : [])).toEqual(['moved', 'first']);
            expect(await invokeSessionListOrganizationAction({ mutationScope, input: { ...input, instructionKind: 'reorder-after', edge: 'bottom' } })).toEqual({ status: 'applied' });
            expect(readList().flatMap(item => item.type === 'session' ? [item.sessionId] : [])).toEqual(['first', 'moved']);
        } finally { retire(); getStorage().getState().clearSessionOrganizationForServer(serverId); }
    });
});

describe('mounted Session organization rail projection', () => {
    it('keeps the rail projection answering after the ordinary list unmounts, without retargeting or losing other pins', async () => {
        const serverId = 'rail-home';
        const ids = ['first', 'list-only', 'last'];
        const key = (sessionId: string) => sessionAddressKey({ serverId, sessionId });
        const pinnedItems: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'pinned', title: 'Pinned', groupKey: PINNED_GROUP_KEY_V1, serverId },
            ...ids.map(sessionId => ({ type: 'session' as const, serverId, sessionId, groupKind: 'pinned' as const,
                groupKey: PINNED_GROUP_KEY_V1, pinned: true })),
        ];
        const persisted: string[][] = [];
        const mutationScope: SessionOrganizationMutationScope = {
            serverId, serverUrl: 'https://rail-home.test', serverIdAliases: [], credentials: { token: 'token', secret: 'secret' },
            requestAtEndpoint: async (path, init) => {
                expect(path).toBe('/v2/session-organization/order');
                const request = ReorderSessionOrganizationRequestSchema.parse(JSON.parse(String(init?.body)));
                expect(request.scopeKind).toBe('pinned');
                persisted.push(request.entries.map(entry => entry.itemKey));
                return Response.json({ orderEntries: request.entries.map(entry => ({ ...entry, scopeKind: request.scopeKind, scopeKey: request.scopeKey })) });
            },
        };
        const addresses = Object.fromEntries(ids.map(sessionId => [key(sessionId), { itemKind: 'session' as const, serverId, sessionId }]));
        const context: CommitSessionListDragIntentContext = {
            scope: { serverId, accountId: 'account' }, latestItems: [],
            pinnedOrganization: { items: pinnedItems, railSessionRowIds: [treeRowId.session(serverId, 'first'), treeRowId.session(serverId, 'last')] },
            sessionListGroupOrderV1: { [PINNED_GROUP_KEY_V1]: ids.map(key) },
            manualSessionOrderingEnabled: true, sessionListLayoutV1: 'projects',
            setSessionFolderAssignment: async () => { throw new Error('rail_must_not_assign_folders'); },
            setSessionListGroupOrderV1: async next => {
                await writeSessionOrganizationGroupOrder({ scope: mutationScope, next, orderItemAddressByItemKey: addresses });
            },
        };
        const adapter = createSessionListOrganizationActionAdapter(() => context);
        const retire = registerMountedSessionListOrganizationAction(adapter, 'rail');
        // The ordinary column can open and close while the shell's rail remains visible.
        const retireList = registerMountedSessionListOrganizationAction(async () => ({ status: 'unavailable' }));
        retireList();
        const input = { scope: context.scope, projection: 'rail', sourceKind: 'leaf', sourceRowId: treeRowId.session(serverId, 'last'),
            instructionKind: 'reorder-before', targetRowId: treeRowId.session(serverId, 'first'), containerId: PINNED_GROUP_KEY_V1,
            parentRowId: null, depth: 0, edge: 'top' };
        try {
            expect(await invokeSessionListOrganizationAction({ input, mutationScope })).toEqual({ status: 'applied' });
            expect(persisted).toEqual([['last', 'first', 'list-only']]);
            const scopeKey = buildSessionOrganizationOrderScopeKey({ serverId, scopeKind: 'pinned', scopeKey: 'pins' });
            expect(getStorage().getState().sessionOrganizationOrderEntriesByScopeKey[scopeKey]?.map(entry => entry.itemKey))
                .toEqual(['last', 'first', 'list-only']);
            expect(await invokeSessionListOrganizationAction({ input: { ...input, scope: { serverId, accountId: 'other' } }, mutationScope }))
                .toMatchObject({ status: 'refused' });
            expect(await invokeSessionListOrganizationAction({ input: { ...input, targetRowId: treeRowId.session(serverId, 'list-only') }, mutationScope }))
                .toMatchObject({ status: 'refused' });
            expect(persisted).toHaveLength(1);
        } finally { retire(); getStorage().getState().clearSessionOrganizationForServer(serverId); }
        expect(await invokeSessionListOrganizationAction({ input, mutationScope })).toEqual({ status: 'unavailable' });
    });
});
