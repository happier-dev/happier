import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReducer } from '@happier-dev/session-core/reducer';
import type { Message, ToolCallMessage, ToolCall } from '@happier-dev/session-core/messages';
import { act, createSessionFixture, createMachineFixture, createToolCallMessageFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { useSessionLiveFileWrites } from './useSessionLiveFileWrites';
import { useWorkspaceLiveFileWrites } from './useWorkspaceLiveFileWrites';
import { useWorkspaceFileWriteSettlements } from './useWorkspaceFileWriteSettlements';
import { useWorkspaceFileWriteTabPresentation } from '@/components/workspaces/files/useWorkspaceFileWriteTabPresentation';
import { forwardCodeIntelligenceSettlements } from '@/sync/domains/workspaces/languageIntelligence/codeIntelligenceSettlements';
import { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } from '@/sync/domains/session/attention/runtimePresentation';

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'home-a', serverUrl: 'https://example.com', generation: 1 }),
}));

const scope = { serverId: 'home-a', machineId: 'machine-1', rootPath: '/repo' };
const original = storage.getState();
type SessionMessages = ReturnType<typeof storage.getState>['sessionMessages'][string];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function call(id: string, path: string, state: ToolCall['state'] = 'running'): ToolCallMessage {
    return createToolCallMessageFixture({ id, createdAt: 10, tool: {
        id, name: 'Write', input: { file_path: path, content: 'hello' }, state,
        createdAt: 10, startedAt: 12, completedAt: state === 'running' ? null : 15, description: null,
    } });
}

function transcript(messages: Message[], version = 1, isLoaded = true): SessionMessages {
    const messagesById = Object.fromEntries(messages.map(message => [message.id, message]));
    return { messageIdsOldestFirst: messages.map(message => message.id), messagesById, messagesMap: messagesById,
        reducerState: createReducer(), messagesVersion: version, isLoaded,
        latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null };
}

function session(id = 'session-1', overrides: Parameters<typeof createSessionFixture>[0] = {}) {
    return createSessionFixture({ id, serverId: 'home-a', active: true, activeAt: Date.now(),
        thinking: true, thinkingAt: Date.now(), latestTurnStatus: 'in_progress',
        metadata: { path: '/repo', host: 'test', machineId: 'machine-1' }, ...overrides });
}

beforeEach(() => {
    storage.setState({ sessions: { 'session-1': session() }, sessionMessages: {},
        machines: { 'machine-1': createMachineFixture({ id: 'machine-1', active: true }) },
        sessionListRowsByServerId: {}, sessionListIndexByServerId: {}, ordinarySessionListMembershipByServerId: {},
        getProjectForSession: () => null });
});
afterEach(async () => { await standardCleanup(); storage.setState(original); });

describe('live file-write hooks', () => {
    it('does no membership or Session-record scans for unrelated transcript arrivals while admitted writes and moves reach tree and tab consumers', async () => {
        // Match the 1,000-Session REVIEW-B3 reproduction; only two belong to this workspace.
        const records = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => {
            const id = `session-${index}`;
            return [id, session(id, { metadata: {
                path: index < 2 ? '/repo' : `/other-${index}`, machineId: 'machine-1', host: 'test',
            } })];
        }));
        let membershipScans = 0;
        let recordReads = 0;
        const sessions = new Proxy(records, {
            ownKeys(target) { membershipScans += 1; return Reflect.ownKeys(target); },
            get(target, key, receiver) {
                if (typeof key === 'string' && key.startsWith('session-')) recordReads += 1;
                return Reflect.get(target, key, receiver);
            },
        });
        storage.setState({ sessions, sessionMessages: {
            'session-0': transcript([]), 'session-1': transcript([]), 'session-999': transcript([]),
        } });
        const settled = vi.fn<(paths: readonly string[]) => void>();
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            // The tree uses both the live map and settlement stream; Details uses the same map via tab presentation.
            useWorkspaceFileWriteSettlements(scope, settled);
            return { writes: useWorkspaceLiveFileWrites(scope), tab: useWorkspaceFileWriteTabPresentation(scope) };
        });
        const initial = hook.getCurrent();
        const initialRenders = renders;
        membershipScans = 0;
        recordReads = 0;
        await act(async () => {
            for (let version = 1; version <= 10; version += 1) {
                storage.setState(state => ({ sessionMessages: {
                    ...state.sessionMessages, 'session-999': transcript([call('unrelated', 'unrelated.ts')], version),
                } }));
            }
        });
        expect({ membershipScans, recordReads, renders: renders - initialRenders }).toEqual({ membershipScans: 0, recordReads: 0, renders: 0 });
        expect(hook.getCurrent()).toBe(initial);

        const file = { key: 'file:src/one.ts', kind: 'file', title: 'one.ts', resource: { kind: 'file', path: 'src/one.ts' }, isPinned: false, isPreview: true };
        await act(async () => storage.setState(state => ({ sessionMessages: {
            ...state.sessionMessages, 'session-0': transcript([call('admitted', 'src/one.ts')]),
        } })));
        expect([...hook.getCurrent().writes.keys()]).toEqual(['src/one.ts']);
        expect(hook.getCurrent().tab(file)).toMatchObject({ status: { tone: 'working' } });
        await act(async () => storage.setState(state => ({ sessionMessages: {
            ...state.sessionMessages, 'session-0': transcript([call('admitted', 'src/one.ts', 'completed')], 2),
        } })));
        expect(settled.mock.calls).toEqual([[['src/one.ts']]]);
        expect(hook.getCurrent().writes.size).toBe(0);
        expect(hook.getCurrent().tab(file)).toBeUndefined();

        await act(async () => storage.setState(state => ({ sessionMessages: {
            ...state.sessionMessages, 'session-1': transcript([call('moving', 'src/one.ts')]),
        } })));
        expect(hook.getCurrent().tab(file)).toMatchObject({ status: { tone: 'working' } });
        await act(async () => storage.setState(state => ({ sessions: {
            ...state.sessions, 'session-1': session('session-1', { metadata: { path: '/elsewhere', machineId: 'machine-1', host: 'test' } }),
        } })));
        expect(hook.getCurrent().writes.size).toBe(0);
        expect(hook.getCurrent().tab(file)).toBeUndefined();
        await act(async () => storage.setState(state => ({ sessions: { ...state.sessions, 'session-1': session() } })));
        expect([...hook.getCurrent().writes.keys()]).toEqual(['src/one.ts']);
        expect(hook.getCurrent().tab(file)).toMatchObject({ status: { tone: 'working' } });
    });

    it('uses the shared tab status for a live file and retains non-file presentation', async () => {
        storage.setState({ sessionMessages: { 'session-1': transcript([call('tab-write', 'src/one.ts')]) } });
        const fallback = { faviconUrl: 'https://example.com/favicon.png', status: { tone: 'attention' as const, label: 'Needs input' } };
        const resolveFallback = () => fallback;
        const hook = await renderHook(() => useWorkspaceFileWriteTabPresentation(scope, resolveFallback));
        const resolve = hook.getCurrent();
        const file = { key: 'file:src/one.ts', kind: 'file', title: 'one.ts', resource: { kind: 'file', path: 'src/one.ts' }, isPinned: false, isPreview: true };
        expect(resolve(file)).toMatchObject({ faviconUrl: fallback.faviconUrl, status: { tone: 'working' } });
        expect(resolve({ ...file, kind: 'browser', resource: {} })).toBe(fallback);
        await act(async () => storage.setState({ sessionMessages: { 'session-1': transcript([call('tab-write', 'src/one.ts', 'completed')], 2) } }));
        expect(hook.getCurrent()(file)).toBe(fallback);
    });

    it('gates stuck running calls through canonical effective activity and keeps stable results on unrelated updates', async () => {
        storage.setState({ sessionMessages: { 'session-1': transcript([call('write-1', 'src/one.ts')]) } });
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useSessionLiveFileWrites({ serverId: 'home-a', sessionId: 'session-1' }, '/repo'); });
        const first = hook.getCurrent();
        expect([...first.keys()]).toEqual(['src/one.ts']);
        const initialRenders = renders;
        await act(async () => storage.setState({ isDataReady: !storage.getState().isDataReady }));
        expect(hook.getCurrent()).toBe(first);
        expect(renders).toBe(initialRenders);
        await act(async () => storage.setState(state => ({ sessions: { 'session-1': { ...state.sessions['session-1'], updatedAt: 99 } } })));
        expect(hook.getCurrent()).toBe(first);
        expect(renders).toBe(initialRenders);
        await act(async () => storage.setState({ sessions: { 'session-1': session('session-1', { thinking: false, latestTurnStatus: 'completed' }) } }));
        expect(hook.getCurrent().size).toBe(0);
        await act(async () => storage.setState({ sessions: { 'session-1': session() } }));
        expect([...hook.getCurrent().keys()]).toEqual(['src/one.ts']);
        const lastSeenAt = Date.now() - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1;
        await act(async () => storage.setState({ sessions: { 'session-1': session('session-1', {
            presence: lastSeenAt, active: false, activeAt: lastSeenAt,
        }) } }));
        expect(hook.getCurrent().size).toBe(0);
    });

    it('unions only attached sessions on the same Home and Machine and rejects same-id transcript leakage', async () => {
        storage.setState({ sessions: {
            one: session('one'), two: session('two'),
            wrongHome: session('wrongHome', { serverId: 'home-b' }),
            wrongRoot: session('wrongRoot', { metadata: { machineId: 'machine-1', path: '/elsewhere', host: 'test' } }),
        }, sessionMessages: {
            one: transcript([call('a', 'a.ts')]), two: transcript([call('b', 'b.ts')]),
            wrongHome: transcript([call('leak', 'leak.ts')]), wrongRoot: transcript([call('outside', 'outside.ts')]),
        } });
        const hook = await renderHook(() => useWorkspaceLiveFileWrites(scope));
        expect([...hook.getCurrent().keys()]).toEqual(['a.ts', 'b.ts']);
        const qualified = await renderHook(() => useSessionLiveFileWrites({ serverId: 'home-a', sessionId: 'wrongHome' }, '/repo'));
        expect(qualified.getCurrent().size).toBe(0);
    });

    it('infers the session workspace for absolute tool paths when no root override is supplied', async () => {
        storage.setState({ sessionMessages: { 'session-1': transcript([call('absolute', '/repo/src/one.ts')]) } });
        const hook = await renderHook(() => useSessionLiveFileWrites({ serverId: 'home-a', sessionId: 'session-1' }));
        expect([...hook.getCurrent().keys()]).toEqual(['src/one.ts']);
    });

    it('keeps own and nested workspace background writes after the primary turn completes without mixing session-current files', async () => {
        const task = createToolCallMessageFixture({ id: 'task', tool: { ...call('task', 'ignored.ts').tool, name: 'Task', input: {} },
            children: [call('nested-background', 'nested-background.ts')] });
        storage.setState({ sessions: { 'session-1': session('session-1', {
            thinking: false, latestTurnStatus: 'completed', runtimeActivityState: 'active', runtimeActivityActiveCount: 1,
        }) }, sessionMessages: { 'session-1': transcript([call('background', 'background.ts'), task]) } });
        const hook = await renderHook(() => ({
            workspace: useWorkspaceLiveFileWrites(scope),
            session: useSessionLiveFileWrites({ serverId: 'home-a', sessionId: 'session-1' }, '/repo'),
        }));
        expect([...hook.getCurrent().workspace.keys()]).toEqual(['background.ts', 'nested-background.ts']);
        expect([...hook.getCurrent().session.keys()]).toEqual(['background.ts']);
    });

    it('keeps normalized subagent sidechains out of the parent live map while retaining child-session attribution and settlements', async () => {
        storage.setState({ sessions: { 'session-1': session(), child: session('child') },
            sessionMessages: { 'session-1': transcript([]), child: transcript([]) } });
        const settled = vi.fn<(paths: readonly string[]) => void>();
        const hook = await renderHook(() => {
            useWorkspaceFileWriteSettlements(scope, settled);
            return {
                parent: useSessionLiveFileWrites({ serverId: 'home-a', sessionId: 'session-1' }, '/repo'),
                child: useSessionLiveFileWrites({ serverId: 'home-a', sessionId: 'child' }, '/repo'),
                workspace: useWorkspaceLiveFileWrites(scope),
            };
        });
        await act(async () => {
            storage.getState().applyMessages('session-1', [{
                id: 'main-message', localId: null, createdAt: 10, role: 'agent', isSidechain: false,
                content: [{ type: 'tool-call', id: 'main-write', name: 'Write', input: { file_path: 'main.ts', content: 'main' },
                    description: null, uuid: 'main-uuid', parentUUID: null },
                { type: 'tool-call', id: 'task', name: 'Task', input: { prompt: 'Write child.ts' },
                    description: null, uuid: 'task-uuid', parentUUID: null }],
            }, {
                id: 'child-mirror', localId: null, createdAt: 20, role: 'agent', isSidechain: true, sidechainId: 'task',
                content: [{ type: 'tool-call', id: 'nested-write', name: 'Write', input: { file_path: 'child.ts', content: 'child' },
                    description: null, uuid: 'nested-uuid', parentUUID: null }],
            }]);
        });
        const parentRows = Object.values(storage.getState().sessionMessages['session-1'].messagesById);
        expect(parentRows.find(message => message.kind === 'tool-call' && message.tool.id === 'task')).toMatchObject({
            children: [{ kind: 'tool-call', tool: { id: 'nested-write', state: 'running' } }],
        });
        expect([...hook.getCurrent().parent.keys()]).toEqual(['main.ts']);
        // A sidechain need not have a separately loaded Session. Workspace presence must retain it.
        expect(hook.getCurrent().workspace.get('child.ts')?.sessionId).toBe('session-1');
        await act(async () => {
            storage.getState().applyMessages('child', [{
                id: 'child-message', localId: null, createdAt: 21, role: 'agent', isSidechain: false,
                content: [{ type: 'tool-call', id: 'child-write', name: 'Write', input: { file_path: 'child.ts', content: 'child' },
                    description: null, uuid: 'child-uuid', parentUUID: null }],
            }]);
        });
        expect([...hook.getCurrent().parent.keys()]).toEqual(['main.ts']);
        expect(hook.getCurrent().child.get('child.ts')?.sessionId).toBe('child');
        expect([...hook.getCurrent().workspace].map(([path, write]) => [path, write.sessionId])).toEqual([
            ['main.ts', 'session-1'], ['child.ts', 'child'],
        ]);
        await act(async () => {
            await storage.getState().applyMessages('session-1', [{
                id: 'nested-result', localId: null, createdAt: 30, role: 'agent', isSidechain: true, sidechainId: 'task',
                content: [{ type: 'tool-result', tool_use_id: 'nested-write', content: 'written', is_error: false,
                    uuid: 'nested-result-uuid', parentUUID: null }],
            }]);
        });
        expect(settled.mock.calls).toEqual([[['child.ts']]]);
        expect([...hook.getCurrent().parent.keys()]).toEqual(['main.ts']);
    });
});

describe('useWorkspaceFileWriteSettlements', () => {
    it('forwards generic semantic Action MCP receipts through the real transcript reducer and existing settlement projection', async () => {
        storage.setState({ sessionMessages: { 'session-1': transcript([]) } });
        const settled = vi.fn<(paths: readonly string[]) => void>();
        const hook = await renderHook(() => {
            useWorkspaceFileWriteSettlements(scope, settled);
            return useWorkspaceLiveFileWrites(scope);
        });
        await act(async () => {
            await storage.getState().applyMessages('session-1', [{
                id: 'semantic-call', localId: null, createdAt: 10, role: 'agent', isSidechain: false,
                content: [{ type: 'tool-call', id: 'code-action', name: 'mcp__happier__action_execute',
                    input: { actionId: 'code.rename.apply', input: { machineId: 'machine-1', rootPath: '/repo', path: 'one.ts',
                        files: [{ path: 'one.ts', renameTo: 'two.ts', expectedHash: 'a'.repeat(64), edits: [] }] } },
                    description: null, uuid: 'semantic-uuid', parentUUID: null }],
            }]);
        });
        expect([...hook.getCurrent().keys()]).toEqual(['one.ts', 'two.ts']);
        await act(async () => {
            await storage.getState().applyMessages('session-1', [{
                id: 'semantic-result', localId: null, createdAt: 20, role: 'agent', isSidechain: false,
                content: [{ type: 'tool-result', tool_use_id: 'code-action',
                    content: { structuredContent: { ok: true, results: [
                        { path: 'one.ts', renameTo: 'two.ts', status: 'replaced' },
                        { path: 'importer.ts', status: 'replaced' }, { path: 'skipped.ts', status: 'skipped' },
                    ] } }, is_error: false, uuid: 'semantic-result-uuid', parentUUID: null }],
            }]);
        });
        expect(hook.getCurrent().size).toBe(0);
        expect(settled.mock.calls).toEqual([[['one.ts', 'two.ts', 'importer.ts']]]);
    });

    it('seeds history, then settles running-to-completed and first-seen error once, even while idle', async () => {
        storage.setState({ sessionMessages: { 'session-1': transcript([call('history', 'old.ts', 'completed'), call('running', 'new.ts')]) } });
        const settled = vi.fn<(paths: readonly string[]) => void>();
        const hook = await renderHook(() => useWorkspaceFileWriteSettlements(scope, settled));
        expect(settled).not.toHaveBeenCalled();
        await act(async () => storage.setState({
            sessions: { 'session-1': session('session-1', { thinking: false, latestTurnStatus: 'completed' }) },
            sessionMessages: { 'session-1': transcript([call('history', 'old.ts', 'completed'), call('running', 'new.ts', 'completed'), call('batched', 'failed.ts', 'error')], 2) },
        }));
        expect(settled.mock.calls).toEqual([[['new.ts', 'failed.ts']]]);
        await hook.rerender();
        await act(async () => storage.setState({ sessionMessages: { 'session-1': transcript([call('running', 'new.ts', 'completed'), call('batched', 'failed.ts', 'error')], 3) } }));
        expect(settled.mock.calls).toEqual([[['new.ts', 'failed.ts']]]);
    });

    it('waits for the initial transcript load before seeding and resets when the workspace changes', async () => {
        const settled = vi.fn<(paths: readonly string[]) => void>();
        const hook = await renderHook(({ rootPath }) => useWorkspaceFileWriteSettlements({ ...scope, rootPath }, settled), { initialProps: { rootPath: '/repo' } });
        await act(async () => storage.setState({ sessionMessages: { 'session-1': transcript([call('loaded-history', 'old.ts', 'completed')]) } }));
        expect(settled).not.toHaveBeenCalled();
        await act(async () => storage.setState({ sessionMessages: { 'session-1': transcript([call('loaded-history', 'old.ts', 'completed'), call('new', 'new.ts', 'completed')], 2) } }));
        expect(settled.mock.calls).toEqual([[['new.ts']]]);
        await hook.rerender({ rootPath: '/other' });
        await act(async () => storage.setState({ sessions: { 'session-1': session('session-1', { metadata: { path: '/other', machineId: 'machine-1', host: 'test' } }) } }));
        expect(settled.mock.calls).toEqual([[['new.ts']]]);
    });

    it('settles a real normalized tool-call stream through the transcript reducer', async () => {
        storage.setState({ sessionMessages: { 'session-1': transcript([]) } });
        const settled = vi.fn<(paths: readonly string[]) => void>();
        const hook = await renderHook(() => {
            useWorkspaceFileWriteSettlements(scope, settled);
            return useWorkspaceLiveFileWrites(scope);
        });
        await act(async () => { storage.getState().applyMessages('session-1', [{
            id: 'provider-call', localId: null, createdAt: Date.now(), role: 'agent', isSidechain: false,
            content: [{ type: 'tool-call', id: 'write-stream', name: 'Write', input: { file_path: '/repo/src/created.ts', content: 'hello' },
                description: null, uuid: 'call-uuid', parentUUID: null }],
        }]); });
        expect([...hook.getCurrent().keys()]).toEqual(['src/created.ts']);
        expect(settled).not.toHaveBeenCalled();
        await act(async () => { storage.getState().applyMessages('session-1', [{
            id: 'provider-result', localId: null, createdAt: Date.now() + 1, role: 'agent', isSidechain: false,
            content: [{ type: 'tool-result', tool_use_id: 'write-stream', content: 'written', is_error: false,
                uuid: 'result-uuid', parentUUID: null }],
        }]); });
        expect(hook.getCurrent().size).toBe(0);
        expect(settled.mock.calls).toEqual([[['src/created.ts']]]);
    });

    it('forwards settled tool paths to language intelligence only while the server accepts external changes', async () => {
        storage.setState({ sessionMessages: { 'session-1': transcript([]) } });
        let accepts = false;
        const syncExternal = vi.fn<(_paths: readonly string[]) => Promise<void>>().mockResolvedValue();
        await renderHook(() => useWorkspaceFileWriteSettlements(scope, (paths) => {
            void forwardCodeIntelligenceSettlements(paths, { acceptsExternalChanges: () => accepts, syncExternal });
        }));
        await act(async () => storage.setState({ sessionMessages: { 'session-1': transcript([call('without-watch', 'ignored.ts', 'completed')], 2) } }));
        expect(syncExternal).not.toHaveBeenCalled();
        accepts = true;
        await act(async () => storage.setState({ sessionMessages: { 'session-1': transcript([
            call('without-watch', 'ignored.ts', 'completed'), call('with-watch', 'src/imported.ts', 'completed'),
        ], 3) } }));
        expect(syncExternal.mock.calls).toEqual([[['src/imported.ts']]]);
    });
});
