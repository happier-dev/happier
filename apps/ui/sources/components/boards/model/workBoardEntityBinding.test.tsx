import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { buildWorkBoardArtifactHeaderV1} from '@happier-dev/protocol/boards/workBoardArtifactV1';
import {
    buildWorkBoardItemKeyV1, createWorkBoardV1,
    type WorkBoardV1, type WorkBoardIntentV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { normalizeActionsSettingsV1} from '@happier-dev/protocol/actions/actionSettings';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { BoardScreen } from '../BoardScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { useWorkBoardEntityBinding } from './workBoardEntityBinding';
import { useAcknowledgedWorkBoard, useDispatchWorkBoardIntent, useWorkBoard, useWorkBoardReadState, useWorkBoardSaveQueue, useWorkBoardSaveState } from './useWorkBoards';
import { projectBoardMembership } from './boardMembership';
import type { Artifact, ArtifactCreateRequest, ArtifactUpdateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { buildAccountWidgetAddSections } from '@/components/widgets/add/accountWidgetAddSections';
import { WidgetSetupStep } from '@/components/widgets/add/WidgetSetupStep';
import type { WidgetSetupSubmitResult } from '@/components/widgets/add/widgetSetupModel';
import { selectBuiltinWidgetCandidates } from '@/components/widgets/widgetCatalog';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { AddToBoardPopover, type AddToBoardWidgets } from '@/components/boards/header/AddToBoardPopover';
import { runWidgetSetupCommand } from '@/components/widgets/surface/widgetSurfaceSetup';
import { BoardWidgetCard } from '../cards/BoardWidgetCard';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { WidgetSetupPopover } from '@/components/widgets/add/WidgetSetupPopover';
import { describeAuthoredWidgetDefinitionV1 } from '@/components/widgets/widgetCatalog';
import { Modal } from '@/modal';
import { projectArtifactStoredKind } from '@/dev/testkit/harness/artifactStoreBoundary';

// HTTP, device credential storage and native theme are system boundaries.
const runtimeFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetch(...args) }));
// Successful mutation scenarios consent at the physical dialog boundary; Action policy stays real.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Window measurement and the native portal are physical presentation boundaries.
vi.mock('@/components/ui/popover', async original =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(original));
vi.mock('react-native', async () => {
    const native = await import('@/dev/testkit/mocks/reactNative');
    // The platform list renders its items; retain the real Collection and widget body below it.
    const FlatList = React.forwardRef<unknown, { data: readonly unknown[];
        renderItem: (args: { item: unknown; index: number }) => React.ReactNode;
        keyExtractor: (item: unknown, index: number) => string }>((props, ref) => {
        React.useImperativeHandle(ref, () => ({ scrollToIndex() {}, scrollToOffset() {}, scrollToEnd() {}, getScrollResponder: () => ({ scrollTo() {} }) }));
        return React.createElement('FlatList', props, props.data.map((item, index) =>
            <React.Fragment key={props.keyExtractor(item, index)}>{props.renderItem({ item, index })}</React.Fragment>));
    });
    return native.createReactNativeWebMock({ FlatList });
});
vi.mock('@legendapp/list/react-native', async original => (await import('@/dev/testkit/mocks/legendList'))
    .createCapturingLegendListMock({ original: await original<Record<string, unknown>>() }).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
await import('@/sync/syncEngine');
const previousState = storage.getState();
const previousAppliedSnapshot = getAppliedActiveServerSnapshot();
const previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
afterEach(async () => { await standardCleanup();
    await (await import('@/sync/runtime/orchestration/connectionManager')).disconnectActiveServerConnection();
    retirePresentationNotice(); storage.setState(previousState); runtimeFetch.mockReset(); vi.restoreAllMocks();
    publishAppliedActiveServerSnapshot(previousAppliedSnapshot, previousRuntimeAvailable); });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

async function mountAccount(name: string, boards: readonly WorkBoardV1[], enabled = true) {
    const home = await upsertAndActivateServer({ serverUrl: `https://board-${name}.test` });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'board-account' })), 'base64url')}.signature`;
    const credentials = { token };
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(credentials);
    storage.setState({ profileScope: { serverId: home.id, accountId: 'board-account' }, settingsScope: { serverId: home.id, accountId: 'board-account' }, isDataReady: true,
        settings: { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
            actions: { 'boards.apply': { enabled } } }) } });
    const rows = new Map<string, Artifact>(boards.map(board => [board.id, { id: board.id, ownerAccountId: 'board-account', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent(buildWorkBoardArtifactHeaderV1(board)),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(board) }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }]));
    let offline = false;
    let loseWriteAck = false;
    let blockArtifactReads = false;
    let releaseWrite: (() => void) | null = null;
    let writeGate = Promise.resolve();
    runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (path === '/health' || path === '/v1/auth/ping') return json({});
        if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: { v: 1,
            minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            declarationTransport: 'http-header-and-socket-auth-v1' } } });
        if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v1/account/encryption/currentness') return json(createPlainAccountEncryptionCurrentnessFixture());
        if (path.startsWith('/v1/artifacts') && init?.method !== 'POST' && init?.method !== 'DELETE' && blockArtifactReads) throw new Error('Read-back unavailable');
        // The Artifact server selects by coarse kind and reports completeness; every row here is classified.
        if (path === '/v1/artifacts' && init?.method !== 'POST') return json(new URL(String(url)).searchParams.has('kind')
            ? { items: [...rows.values()], hasUnclassified: false } : [...rows.values()]);
        const id = path.split('/')[3];
        const row = rows.get(id!);
        if (path.endsWith('/access/grants') && row) return json({ artifactId: row.id, ownerAccountId: row.ownerAccountId, access: row.access, grants: [] });
        if (path.endsWith('/recipients') && row) return json({ artifactId: row.id, ownerAccountId: row.ownerAccountId, access: row.access,
            encryptionMode: row.encryptionMode, dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey,
            provenanceDataEncryptionKey: null, callerProvenanceDataEncryptionKey: null, recipients: [] });
        if (init?.method === 'POST' || init?.method === 'DELETE') {
            await writeGate;
            if (offline) throw new Error('Connection lost after dispatch');
            if (path === '/v1/artifacts') {
                const request = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                rows.set(request.id, { ...request, ...projectArtifactStoredKind(request.kind), ownerAccountId: 'board-account', access: 'owner', encryptionMode: 'plain', publicAudience: 'none', headerVersion: 1,
                    bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
                return json(rows.get(request.id));
            }
            if (!row) return json({ error: 'not_found' }, 404);
            if (init.method === 'DELETE') { rows.delete(row.id); return new Response(null, { status: 204 }); }
            const request = JSON.parse(String(init.body)) as ArtifactUpdateRequest;
            if (request.expectedHeaderVersion !== row.headerVersion || request.expectedBodyVersion !== row.bodyVersion) return json({ success: false, error: 'version-mismatch' });
            const next = { ...row, header: request.header!, body: request.body!, headerVersion: row.headerVersion + 1, bodyVersion: (row.bodyVersion ?? 0) + 1 };
            rows.set(row.id, next);
            if (loseWriteAck) { loseWriteAck = false; blockArtifactReads = true; throw new Error('Acknowledgement lost'); }
            return json({ success: true, headerVersion: next.headerVersion, bodyVersion: next.bodyVersion });
        }
        return row ? json(row) : json({ error: 'not_found' }, 404);
    });
    const wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
    return { home, rows, wrapper, offline(value: boolean) { offline = value; }, loseNextWriteAcknowledgement() {
        loseWriteAck = true;
        return () => { blockArtifactReads = false; };
    }, hold() {
        writeGate = new Promise<void>(resolve => { releaseWrite = resolve; }); return () => releaseWrite?.();
    } };
}

describe('mounted WorkBoard Action settlement', () => {
    it.each(['pending', 'applied', 'refused'] as const)('keeps %s custody through widget Edit inputs, Rename and the drop adapter', async disposition => {
        const instance = { v: 1 as const, id: 'copy', definition: { kind: 'inline' as const, definition: {
            v: 1 as const, id: 'checks', name: 'Checks', provenance: { source: { kind: 'authored' as const } },
            sizeDeclaration: { sizes: ['medium'] as ['medium'], defaultSize: 'medium' as const },
            inputs: { fields: [{ path: 'repo', title: 'Repository', widget: 'text' as const }] },
            inputSchema: { type: 'object' as const, properties: { repo: { type: 'string' as const } }, additionalProperties: false },
            body: { kind: 'declarative' as const, document: { version: 1 as const, root: { kind: 'text' as const, text: 'Checks' } } },
        } }, bindings: { repo: { kind: 'value' as const, value: 'main' } } };
        const boardId = `board-card-${disposition}`;
        const b = await mountAccount(`card-${disposition}`, []);
        const scope = { serverId: b.home.id, accountId: 'board-account', owner: { kind: 'workBoard' as const, boardId } };
        const placement = { kind: 'widget' as const, ref: { surface: scope, instanceId: instance.id }, instance, size: 'medium' as const };
        const board: WorkBoardV1 = { ...createWorkBoardV1({ id: boardId, name: 'Checks' }), widgets: [placement] };
        b.rows.set(boardId, { id: boardId, ownerAccountId: 'board-account', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent(buildWorkBoardArtifactHeaderV1(board)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(board) }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
            actions: { 'boards.apply': { enabled: disposition !== 'refused', ...(disposition === 'pending' ? { approvalRequiredSurfaces: ['ui'] } : {}) } } }) } });
        const binding = await renderHook(() => ({ board: useWorkBoard(boardId), binding: useWorkBoardEntityBinding({ board,
            membership: projectBoardMembership(board, { isHomeMounted: () => true, sections: {}, filtered: null }), isHomeMounted: () => true }) }), { wrapper: b.wrapper });
        function Card() {
            const dispatch = useDispatchWorkBoardIntent();
            return <BoardWidgetCard boardId={boardId} placement={placement} scope={scope} descriptor={describeAuthoredWidgetDefinitionV1(instance.definition.definition, instance.definition)}
                size="medium" index={0} count={1} dispatch={dispatch} active={false} testID="card" />;
        }
        const alert = vi.spyOn(Modal, 'alert');
        const screen = await renderScreen(<Card />, { wrapper: b.wrapper });
        const action = (id: string) => (screen.findByType(ItemRowActions).props.actions as ItemAction[]).find(item => item.id === id)!;
        await act(async () => { action('editInputs').onPress?.(); });
        const setup = screen.findByType(WidgetSetupPopover).props.setup();
        await act(async () => { expect.soft(await setup.submit({ bindings: { repo: { kind: 'value', value: 'release' } } }))
            .toMatchObject(disposition === 'pending' ? { ok: true, approvalPending: true } : { ok: disposition === 'applied' }); });
        await act(async () => { action('rename').onPress?.(); });
        await act(async () => { screen.findByTestId('card-title-input')!.props.onChangeText('Release checks'); });
        await act(async () => { screen.findByTestId('card-title-input')!.props.onSubmitEditing(); });
        await vi.waitFor(() => expect(screen.findByTestId('card-title-input')?.props.editable).not.toBe(false));
        expect.soft(alert.mock.calls.length).toBe(disposition === 'refused' ? 1 : 0);
        if (disposition === 'pending' || disposition === 'applied') expect.soft(screen.findByTestId('card-title-input')).toBeNull();
        let drop;
        await act(async () => { drop = await binding.getCurrent().binding!.execute({ actionId: 'boards.apply', input: { intent: { kind: 'add_items', boardId,
            refs: [{ kind: 'machine', qualifiedId: { serverId: b.home.id, id: 'machine' } }] } }, preview: { verb: 'Add', target: 'Checks' } }); });
        expect.soft(drop).toMatchObject({ status: disposition === 'pending' ? 'unknown' : disposition });
        const stored = binding.getCurrent().board!;
        expect(stored.widgets?.[0]?.instance).toMatchObject(disposition === 'applied'
            ? { displayName: 'Release checks', bindings: { repo: { kind: 'value', value: 'release' } } } : instance);
        if (disposition === 'pending') {
            expect(readPresentationNotice()).toMatchObject({ severity: 'info' });
            expect(b.rows.size).toBe(4); // Original board plus one approval for each intent.
        }
    });
    it('keeps the unknown outcome through the rendered Board add handler when read-back is unavailable', async () => {
        const board = createWorkBoardV1({ id: 'board-add-unknown-message', name: 'Pending add' });
        const b = await mountAccount('add-unknown-message', [board]);
        const screen = await renderScreen(<AppPaneProvider><BoardScreen boardId={board.id} /></AppPaneProvider>, { wrapper: b.wrapper });
        await vi.waitFor(() => expect(screen.findByTestId('board-header.add')).not.toBeNull());
        // Consume the real BoardScreen handler exposed to its Add surface; only
        // HTTP loses the acknowledgement and rejects the subsequent read-back.
        const surface = screen.findByType(AddToBoardPopover);
        const widgets = surface.props.widgets as AddToBoardWidgets;
        expect(widgets.scope).toMatchObject({ owner: { kind: 'workBoard', boardId: board.id } });
        const instance = { v: 1, id: 'unknown-message-copy', definition: { kind: 'builtin', id: 'machine_fleet' }, bindings: {} } as const;
        const restoreReads = b.loseNextWriteAcknowledgement();
        try {
            await act(async () => { expect(await runWidgetSetupCommand(() => widgets.addInstance(instance, { place: false }), 'widgetAdd.addFailed'))
                .toEqual({ ok: false, message: 'errors.scmOutcomeUnknown' }); });
            expect(b.rows.get(board.id)?.bodyVersion).toBe(2);
        } finally { restoreReads(); }
    });
    it('recovers the same uncertain add through the real Action ingress after read-back returns', async () => {
        const board = createWorkBoardV1({ id: 'board-add-retry', name: 'Retry' });
        const b = await mountAccount('add-retry', [board]);
        const hook = await renderHook(() => ({ dispatch: useDispatchWorkBoardIntent(), board: useWorkBoard(board.id), save: useWorkBoardSaveState() }), { wrapper: b.wrapper });
        await vi.waitFor(() => expect(hook.getCurrent().board?.id).toBe(board.id));
        const instance = { v: 1, id: 'uncertain-copy', definition: { kind: 'builtin', id: 'machine_fleet' }, bindings: {} } as const;
        const intent = { kind: 'widget_add', boardId: board.id, ref: {
            surface: { serverId: b.home.id, accountId: 'board-account', owner: { kind: 'workBoard', boardId: board.id } }, instanceId: instance.id,
        }, instance } as const;
        const restoreReads = b.loseNextWriteAcknowledgement();
        await act(async () => { expect(await hook.getCurrent().dispatch(intent)).toMatchObject({ status: 'unknown' }); });
        const committed = b.rows.get(board.id);
        expect(committed?.bodyVersion).toBe(2);
        restoreReads();
        await act(async () => { expect(await hook.getCurrent().dispatch(intent)).toMatchObject({ status: 'applied' }); });
        expect(b.rows.get(board.id)).toBe(committed);
        expect(hook.getCurrent().board?.widgets?.map(item => item.instance.id)).toEqual([instance.id]);
        expect(hook.getCurrent().save).toEqual({ pending: [], failure: null });
    });
    it('offers another copy after acknowledgement and blocks button or keyboard Add while the real Action awaits approval', async () => {
        const board = createWorkBoardV1({ id: 'board-add-pending', name: 'Add' });
        const b = await mountAccount('add-pending', [board]);
        const surface = { serverId: b.home.id, accountId: 'board-account', owner: { kind: 'workBoard', boardId: board.id } } as const;
        const candidate = selectBuiltinWidgetCandidates().find(row => row.definition?.kind === 'builtin' && row.definition.id === 'machine_fleet')!;
        const commandRef = { current: null as (() => void) | null };
        const receipt: { current: WidgetSetupSubmitResult | null } = { current: null };
        function AddStep() {
            const [chosen, setChosen] = React.useState(0);
            const dispatch = useDispatchWorkBoardIntent();
            const current = useWorkBoard(board.id);
            const sections = buildAccountWidgetAddSections({ candidates: [candidate], instances: current?.widgets?.map(item => item.instance) ?? [],
                scope: surface, labels: { count: count => `${count} here`, submit: 'Add to board' }, addInstance: async (instance, size) => {
                    const outcome = await dispatch({ kind: 'widget_add', boardId: board.id, ref: { surface, instanceId: instance.id }, instance, ...(size ? { size } : {}) });
                    if (outcome.status === 'pending') return { ok: true, approvalPending: true };
                    if (outcome.status !== 'applied') throw new Error(outcome.code);
                    return { ok: true };
                } });
            const setup = sections.flatMap(section => section.entries)[0]!.setup!();
            return <WidgetSetupStep key={chosen} setup={setup} phone={false} presentation="pane" commandRef={commandRef}
                onAddAnother={() => setChosen(count => count + 1)}
                onDone={result => { receipt.current = result; }} testID="board-add-step" />;
        }
        const screen = await renderScreen(<AddStep />, { wrapper: b.wrapper });
        await screen.pressByTestIdAsync('board-add-step.submit');
        // The button starts an async Action without returning its promise. Wait
        // inside act so the receipt's completion state commits before reading UI.
        await act(async () => { await vi.waitFor(() => expect(receipt.current).toEqual({ ok: true })); });
        expect(screen.findAllByType(RoundButton).find(node => node.props.testID === 'board-add-step.submit')!.props.title).toBe('widgetAdd.addAnother');
        const committed = b.rows.get(board.id);
        expect(committed?.bodyVersion).toBe(2);
        // The real Add surface returns to the picker before a deliberate new copy.
        await screen.pressByTestIdAsync('board-add-step.submit');
        expect(b.rows.get(board.id)).toBe(committed);
        await act(async () => { storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
            actions: { 'boards.apply': { approvalRequiredSurfaces: ['ui'] } } }) } }); });
        await screen.pressByTestIdAsync('board-add-step.submit');
        await act(async () => { await vi.waitFor(() => expect(receipt.current).toEqual({ ok: true, approvalPending: true })); });
        expect(screen.findByTestId('board-add-step.submit')!.props.disabled).toBe(true);
        expect(b.rows.get(board.id)).toBe(committed);
        const approvals = [...b.rows.values()].filter(row => row.id !== board.id);
        expect(approvals).toHaveLength(1);
        // Even if policy later permits direct writes, the existing request still
        // belongs to approval. Repeated controls cannot silently create another copy.
        await act(async () => { storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1 }) } }); });
        await act(async () => { commandRef.current?.(); });
        await screen.pressByTestIdAsync('board-add-step.submit');
        await vi.waitFor(() => expect(screen.findAllByType(RoundButton).find(node => node.props.testID === 'board-add-step.submit')!.props.loading).toBe(false));
        expect(receipt.current).toEqual({ ok: true, approvalPending: true });
        expect(b.rows.get(board.id)).toBe(committed);
        expect([...b.rows.values()].filter(row => row.id !== board.id)).toEqual(approvals);
    });
    it.each([false, true])('opens a fresh client before Account activation and renews after restoration (Session index ready: %s)', async isDataReady => {
        const board = createWorkBoardV1({ id: 'fresh-client', name: 'Fresh client Board' });
        const b = await mountAccount('fresh-client', [board]);
        const snapshot = getActiveServerSnapshot();
        publishAppliedActiveServerSnapshot(snapshot, false);
        storage.setState({ isDataReady });
        const hook = await renderHook(() => ({ board: useWorkBoard(board.id), read: useWorkBoardReadState() }), { wrapper: b.wrapper });
        expect(hook.getCurrent().board).toBeNull();
        await act(async () => { publishAppliedActiveServerSnapshot(snapshot); });
        await vi.waitFor(() => expect(hook.getCurrent().read.status).toBe('ready'));
        expect(storage.getState().isDataReady).toBe(isDataReady);
        expect(hook.getCurrent().board?.name).toBe(board.name);
        await act(async () => { publishAppliedActiveServerSnapshot(snapshot, false); });
        expect(hook.getCurrent().board).toBeNull();
        await act(async () => { publishAppliedActiveServerSnapshot(snapshot); });
        await vi.waitFor(() => expect(hook.getCurrent().board?.name).toBe(board.name));
    });

    it('edits a retained placement through admitted Actions while preserving its stored ref', async () => {
        const ref = { surface: { serverId: 'cli-profile', accountId: 'board-account', owner: { kind: 'workBoard' as const, boardId: 'retained-edit' } }, instanceId: 'copy' };
        const instance = { v: 1 as const, id: 'copy', definition: { kind: 'inline' as const, definition: {
            v: 1 as const, id: 'checks', name: 'Checks', provenance: { source: { kind: 'authored' as const } },
            sizeDeclaration: { sizes: ['medium', 'wide'] as ('medium' | 'wide')[], defaultSize: 'medium' as const },
            inputs: { fields: [] }, inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
            body: { kind: 'declarative' as const, document: { version: 1 as const, root: { kind: 'text' as const, text: 'Checks' } } },
        } }, bindings: {} };
        const board: WorkBoardV1 = { ...createWorkBoardV1({ id: 'retained-edit', name: 'Retained' }), widgets: [{ kind: 'widget', ref, instance, size: 'medium' }] };
        const b = await mountAccount('retained-edit', [board]);
        const hook = await renderHook(() => ({ dispatch: useDispatchWorkBoardIntent(), board: useWorkBoard(board.id) }), { wrapper: b.wrapper });
        await vi.waitFor(() => expect(hook.getCurrent().board?.widgets?.[0]?.size).toBe('medium'));
        await act(async () => { expect(await hook.getCurrent().dispatch({ kind: 'widget_size', boardId: board.id, ref, size: 'wide' })).toMatchObject({ status: 'applied' }); });
        await act(async () => { expect(await hook.getCurrent().dispatch({ kind: 'widget_rename', boardId: board.id, ref, displayName: 'Renamed' })).toMatchObject({ status: 'applied' }); });
        expect(hook.getCurrent().board?.widgets?.[0]).toMatchObject({ ref, size: 'wide', instance: { displayName: 'Renamed' } });
    });
    it('renders a retained CLI-created copy through the Board’s current runtime scope', async () => {
        const instance = { v: 1 as const, id: 'from-cli', definition: { kind: 'builtin' as const, id: 'session_summary' as const }, bindings: {} };
        const ref = { surface: { serverId: 'cli-profile', accountId: 'board-account', owner: { kind: 'workBoard' as const, boardId: 'retained' } }, instanceId: instance.id };
        const board: WorkBoardV1 = { ...createWorkBoardV1({ id: 'retained', name: 'Retained' }), mode: 'by_status',
            widgets: [{ kind: 'widget', ref, instance, size: 'medium' }] };
        const b = await mountAccount('retained', [board]);
        const screen = await renderScreen(<AppPaneProvider><BoardScreen boardId={board.id} /></AppPaneProvider>, { wrapper: b.wrapper });
        await vi.waitFor(() => expect({ ids: screen.tree.findAll(node => typeof node.props.testID === 'string').map(node => node.props.testID), text: screen.getTextContent() }).toMatchObject({
            ids: expect.arrayContaining(['board-widget:from-cli.widget-inputs-repair']),
        }));
        expect(b.rows.get(board.id)?.body).toBe(encodePlainArtifactStoredContent({ body: JSON.stringify(board) }));
    });
    it.each([true, false])('keeps truthful acknowledged size and reports pending approval without a failed save (approval: %s)', async approval => {
        const board = createWorkBoardV1({ id: 'board-size-pending', name: 'Size' });
        const b = await mountAccount('size-pending', [board]);
        const ref = { surface: { serverId: b.home.id, accountId: 'board-account', owner: { kind: 'workBoard' as const, boardId: board.id } }, instanceId: 'copy' };
        const instance = { v: 1 as const, id: 'copy', definition: { kind: 'inline' as const, definition: {
            v: 1 as const, id: 'checks', name: 'Checks', provenance: { source: { kind: 'authored' as const } },
            sizeDeclaration: { sizes: ['medium', 'wide'] as ('medium' | 'wide')[], defaultSize: 'medium' as const },
            inputs: { fields: [] }, inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
            body: { kind: 'declarative' as const, document: { version: 1 as const, root: { kind: 'text' as const, text: 'Checks' } } },
        } }, bindings: {} };
        const hook = await renderHook(() => ({ dispatch: useDispatchWorkBoardIntent(), board: useWorkBoard(board.id), save: useWorkBoardSaveState() }), { wrapper: b.wrapper });
        await act(async () => { expect(await hook.getCurrent().dispatch({ kind: 'widget_add', boardId: board.id, ref, instance })).toMatchObject({ status: 'applied' }); });
        storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
            actions: { 'widgets.item.size.set': { approvalRequiredSurfaces: approval ? ['ui'] : [] } } }) } });
        const before = b.rows.get(board.id);
        await act(async () => { expect(await hook.getCurrent().dispatch({ kind: 'widget_size', boardId: board.id, ref, size: 'wide' }))
            .toMatchObject({ status: approval ? 'pending' : 'applied' }); });
        if (approval) expect(b.rows.get(board.id)).toBe(before);
        else expect(b.rows.get(board.id)).not.toBe(before);
        expect(hook.getCurrent().board?.widgets?.[0]?.size).toBe(approval ? 'medium' : 'wide');
        expect(hook.getCurrent().save).toMatchObject({ pending: [], failure: null });
        if (approval) expect(readPresentationNotice()).toMatchObject({ severity: 'info' });
    });
    it('admits mounted size edits through the universal widget Action rather than bypassing its disabled policy', async () => {
        const board = createWorkBoardV1({ id: 'board-size', name: 'Size' });
        const b = await mountAccount('size-policy', [board]);
        storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
            actions: { 'boards.apply': { enabled: true }, 'widgets.item.size.set': { enabled: false } } }) } });
        const hook = await renderHook(() => ({ dispatch: useDispatchWorkBoardIntent(), save: useWorkBoardSaveState() }), { wrapper: b.wrapper });
        const before = b.rows.get(board.id);
        await act(async () => { expect(await hook.getCurrent().dispatch({ kind: 'widget_size', boardId: board.id,
            ref: { surface: { serverId: b.home.id, accountId: 'board-account', owner: { kind: 'workBoard', boardId: board.id } }, instanceId: 'copy' },
            size: 'wide' })).toMatchObject({ status: 'refused', code: 'action_disabled' }); });
        expect(b.rows.get(board.id)).toBe(before);
        expect(hook.getCurrent().save.failure?.intent.kind).toBe('widget_size');
    });
    it('creates through the shared ingress and refuses an invalid widget configuration before persistence', async () => {
        const b = await mountAccount('create-widget', []);
        const hook = await renderHook(() => ({ dispatch: useDispatchWorkBoardIntent(), board: useWorkBoard('22222222-2222-4222-8222-222222222224'), save: useWorkBoardSaveState() }), { wrapper: b.wrapper });
        await act(async () => { expect(await hook.getCurrent().dispatch({ kind: 'create', board: { id: '22222222-2222-4222-8222-222222222224', name: 'Created' } })).toMatchObject({ status: 'applied' }); });
        expect(hook.getCurrent().board?.name).toBe('Created');
        const before = b.rows.get('22222222-2222-4222-8222-222222222224');
        await act(async () => { expect(await hook.getCurrent().dispatch({ kind: 'widget_add', boardId: '22222222-2222-4222-8222-222222222224',
            ref: { surface: { serverId: b.home.id, accountId: 'board-account', owner: { kind: 'workBoard', boardId: '22222222-2222-4222-8222-222222222224' } }, instanceId: 'invalid' },
            instance: { v: 1, id: 'invalid', definition: { kind: 'builtin', id: 'changes' }, bindings: { session: { kind: 'value', value: 'invalid-session-address' } } },
        })).toMatchObject({ status: 'refused', code: 'widget_inputs_invalid',
            // The Home's own reason rides along, so the Add can say what is wrong instead of a general sentence.
            details: { fields: [expect.objectContaining({ path: 'session', status: 'invalid' })] } }); });
        expect(b.rows.get('22222222-2222-4222-8222-222222222224')).toBe(before);
        expect(hook.getCurrent().board?.widgets ?? []).toEqual([]);
        expect(hook.getCurrent().save.failure).toMatchObject({ reason: 'invalidValue', intent: { kind: 'widget_add' } });
    });

    it('refuses create, settings, delete, widget and drop at the same disabled UI Action ingress', async () => {
        const board = createWorkBoardV1({ id: 'board-a', name: 'Original' });
        const b = await mountAccount('disabled', [board], false);
        const hook = await renderHook(() => ({ dispatch: useDispatchWorkBoardIntent(), save: useWorkBoardSaveState(), binding: useWorkBoardEntityBinding({ board,
            membership: projectBoardMembership(board, { isHomeMounted: () => true, sections: {}, filtered: null }), isHomeMounted: () => true }) }), { wrapper: b.wrapper });
        const before = b.rows.get(board.id);
        const widgetRef = { surface: { serverId: b.home.id, accountId: 'board-account', owner: { kind: 'workBoard', boardId: board.id } }, instanceId: 'copy' } as const;
        for (const intent of [
            { kind: 'create', board: { id: '22222222-2222-4222-8222-222222222224', name: 'New' } },
            { kind: 'update', boardId: board.id, patch: { name: 'Changed' } },
            { kind: 'delete', boardId: board.id },
            { kind: 'widget_add', boardId: board.id, ref: widgetRef, instance: { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'changes' }, bindings: {} } },
        ] satisfies WorkBoardIntentV1[]) {
            let outcome;
            await act(async () => { outcome = await hook.getCurrent().dispatch(intent); });
            expect.soft(outcome).toMatchObject({ status: 'refused', code: 'action_disabled' });
            expect.soft(hook.getCurrent().save.failure?.intent).toEqual(intent);
        }
        let drop;
        await act(async () => { drop = await hook.getCurrent().binding!.execute({ actionId: 'boards.apply', input: { intent: { kind: 'add_items', boardId: board.id,
            refs: [{ kind: 'machine', qualifiedId: { serverId: b.home.id, id: 'm' } }] } }, preview: { verb: 'Add', target: 'Board' } }); });
        expect(drop).toMatchObject({ status: 'refused', reason: { code: 'action_disabled' } });
        expect(b.rows.size).toBe(1);
        expect(b.rows.get(board.id)).toBe(before);
        expect(hook.getCurrent().save.pending).toEqual([]);
        expect(hook.getCurrent().save.failure).not.toBeNull();
    });

    it('rechecks Action policy on save-failure retry and preserves acknowledged state', async () => {
        const board = createWorkBoardV1({ id: 'board-a', name: 'Original' });
        const b = await mountAccount('retry', [board]);
        const hook = await renderHook(() => ({ dispatch: useDispatchWorkBoardIntent(), queue: useWorkBoardSaveQueue(), board: useWorkBoard(board.id) }), { wrapper: b.wrapper });
        b.offline(true);
        await act(async () => { expect(await hook.getCurrent().dispatch({ kind: 'update', boardId: board.id, patch: { name: 'Retried' } })).toMatchObject({ status: 'unknown' }); });
        b.offline(false);
        await act(async () => { storage.setState({ settings: { ...storage.getState().settings,
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: { 'boards.apply': { enabled: false } } }) } }); });
        await act(async () => { expect(await hook.getCurrent().queue.retry()).toMatchObject({ status: 'refused', code: 'action_disabled' }); });
        expect(hook.getCurrent().board?.name).toBe('Original');
        await act(async () => { storage.setState({ settings: { ...storage.getState().settings,
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1 }) } }); });
        await act(async () => { expect(await hook.getCurrent().queue.retry()).toMatchObject({ status: 'applied' }); });
        expect(hook.getCurrent().board?.name).toBe('Retried');
    });

    it('commits only the exact Board consumers for pending edits, acknowledgements and deletion', async () => {
        const b = await mountAccount('exact', [createWorkBoardV1({ id: 'a', name: 'A' }), createWorkBoardV1({ id: 'b', name: 'B' })]);
        const commits = { a: 0, b: 0, acknowledgedB: 0 };
        const a = await renderHook(() => { const board = useWorkBoard('a'); React.useLayoutEffect(() => { commits.a++; }); return board; }, { wrapper: b.wrapper });
        const other = await renderHook(() => { const board = useWorkBoard('b'); React.useLayoutEffect(() => { commits.b++; }); return board; }, { wrapper: b.wrapper });
        const acknowledged = await renderHook(() => { const board = useAcknowledgedWorkBoard('b'); React.useLayoutEffect(() => { commits.acknowledgedB++; }); return board; }, { wrapper: b.wrapper });
        const dispatch = await renderHook(useDispatchWorkBoardIntent, { wrapper: b.wrapper });
        expect(a.getCurrent()?.name).toBe('A'); expect(other.getCurrent()?.name).toBe('B');
        const before = { ...commits };
        const release = b.hold();
        let saving!: ReturnType<ReturnType<typeof useDispatchWorkBoardIntent>>;
        await act(async () => { saving = dispatch.getCurrent()({ kind: 'update', boardId: 'a', patch: { name: 'Pending A' } }); });
        expect(a.getCurrent()?.name).toBe('Pending A');
        expect.soft(commits.b).toBe(before.b); expect.soft(commits.acknowledgedB).toBe(before.acknowledgedB);
        release(); await act(async () => { expect(await saving).toMatchObject({ status: 'applied' }); });
        await act(async () => { expect(await dispatch.getCurrent()({ kind: 'delete', boardId: 'a' })).toMatchObject({ status: 'applied' }); });
        expect(a.getCurrent()).toBeNull();
        expect.soft(commits.b).toBe(before.b); expect.soft(commits.acknowledgedB).toBe(before.acknowledgedB);
        await act(async () => { expect(await dispatch.getCurrent()({ kind: 'update', boardId: 'b', patch: { name: 'Changed B' } })).toMatchObject({ status: 'applied' }); });
        expect(other.getCurrent()?.name).toBe('Changed B'); expect(acknowledged.getCurrent()?.name).toBe('Changed B');
        expect(commits.b).toBeGreaterThan(before.b); expect(commits.acknowledgedB).toBeGreaterThan(before.acknowledgedB);
    });
    it.each(['unknown', 'refused'] as const)('preserves %s through the real queue and Action executor', async disposition => {
        const home = await upsertAndActivateServer({ serverUrl: `https://board-settlement-${disposition}.test` });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'board-account' })), 'base64url')}.signature`;
        const credentials = { token };
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(credentials);
        storage.setState({ profileScope: { serverId: home.id, accountId: 'board-account' }, settingsScope: { serverId: home.id, accountId: 'board-account' }, isDataReady: true });
        const ref = { kind: 'machine', qualifiedId: { serverId: home.id, id: 'machine-a' } } as const;
        const key = buildWorkBoardItemKeyV1(ref);
        const board = { ...createWorkBoardV1({ id: 'board-a', name: 'Board' }), source: { picked: [ref] }, positionsByItemRef: { [key]: { x: 24, y: 24 } } };
        const row = { id: board.id, ownerAccountId: 'board-account', access: 'owner', encryptionMode: 'plain', publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent(buildWorkBoardArtifactHeaderV1(board)), body: encodePlainArtifactStoredContent({ body: JSON.stringify(board) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: { v: 1,
                minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1' } } });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/artifacts') return json(new URL(String(url)).searchParams.has('kind') ? { items: [row], hasUnclassified: false } : [row]);
            if (path === `/v1/artifacts/${board.id}/access/grants`) return json({ artifactId: row.id, ownerAccountId: row.ownerAccountId, access: row.access, grants: [] });
            if (path === `/v1/artifacts/${board.id}` && init?.method === 'POST') {
                if (disposition === 'unknown') throw new Error('Connection lost after dispatch');
                return json({ error: 'not_found' }, 404);
            }
            if (path === `/v1/artifacts/${board.id}`) return disposition === 'refused' ? json({ error: 'not_found' }, 404) : json(row);
            throw new Error(`Unexpected route ${path}`);
        });
        const wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
        const hook = await renderHook(() => ({ binding: useWorkBoardEntityBinding({ board, membership: projectBoardMembership(board, {
            isHomeMounted: () => true, sections: {}, filtered: null }), isHomeMounted: () => true }), save: useWorkBoardSaveState() }), { wrapper });
        const binding = hook.getCurrent().binding;
        expect(binding?.isCurrent()).toBe(true);
        if (!binding) throw new Error('Expected mounted Board binding');
        let outcome;
        await act(async () => { outcome = await binding.execute({ actionId: 'boards.apply', input: { intent: { kind: 'set_positions', boardId: board.id,
            positionsByItemRef: { [key]: { x: 48, y: 24 } } } }, preview: { verb: 'Move', target: 'Board' } }); });
        expect(outcome).toMatchObject({ status: disposition });
        expect(hook.getCurrent().save.failure).not.toBeNull();
    });
});
