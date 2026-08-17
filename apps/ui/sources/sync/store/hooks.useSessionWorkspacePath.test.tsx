import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { useSessionWorkspacePath } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { resolveWorkspaceTargetForSessionFromState } from '@/sync/domains/session/resolveWorkspaceTargetForSessionFromState';
import type { Session } from '@/sync/domains/state/storageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-1', serverUrl: 'https://example.com', generation: 1 }),
}));

afterEach(() => {
    standardCleanup();
});

function buildSession(overrides?: Partial<Session>): Session {
    return {
        id: 'session-1',
        serverId: 'server-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        metadata: {
            host: 'localhost',
            machineId: 'machine-1',
            path: '/Users/alice/repo',
            homeDir: '/Users/alice',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

describe('useSessionWorkspacePath', () => {
    it('returns a stable path primitive during unrelated session updates', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                sessions: { 'session-1': buildSession() },
                machines: {
                    'machine-1': {
                        id: 'machine-1',
                        seq: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        active: true,
                        activeAt: 1,
                        metadata: {
                            host: 'localhost',
                            platform: 'darwin',
                            happyCliVersion: '1',
                            happyHomeDir: '.happy',
                            homeDir: '/Users/alice',
                        },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                },
                sessionListRenderables: {},
                sessionListIndexByServerId: {},
                getProjectForSession: () => null,
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionWorkspacePath('session-1');
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBe('/Users/alice/repo');

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        'session-1': {
                            ...state.sessions['session-1'],
                            thinking: true,
                            thinkingAt: 2,
                        } as Session,
                    },
                }));
            });

            expect(hook.getCurrent()).toBe('/Users/alice/repo');
            expect(renderCount).toBe(1);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    // The selector is what zustand runs as its snapshot-equality check, so it re-executes on every
    // publish for every mounted consumer. `projectManager.addSession` — the map-writing half of the
    // store's `getProjectForSession`, reached here through the machine-target resolver — must
    // therefore never be reachable from it: a transcript mounts this hook once per row wrapper and a
    // streaming session publishes continuously, so one write per evaluation multiplies by
    // rows x publishes.
    it('costs no project registration per store publish while a consumer is mounted', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { 'session-1': buildSession() },
                machines: {
                    'machine-1': {
                        id: 'machine-1',
                        seq: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        active: true,
                        activeAt: 1,
                        metadata: {
                            host: 'localhost',
                            platform: 'darwin',
                            happyCliVersion: '1',
                            happyHomeDir: '.happy',
                            homeDir: '/Users/alice',
                        },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                },
                sessionListRenderables: {},
                sessionListIndexByServerId: {},
            }));

            const hook = await renderHook(() => useSessionWorkspacePath('session-1'), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            expect(hook.getCurrent()).toBe('/Users/alice/repo');

            const projectWrites = vi.spyOn(projectManager, 'addSession');
            const publishes = 25;
            for (let index = 0; index < publishes; index += 1) {
                act(() => {
                    storage.setState((state) => ({ ...state, lastSyncAt: 1_000 + index }));
                });
            }

            expect(projectWrites).toHaveBeenCalledTimes(0);
            expect(hook.getCurrent()).toBe('/Users/alice/repo');
            projectWrites.mockRestore();

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    // Value parity against the exact expression the hook used to evaluate. The oracle runs *after*
    // the hook so it reproduces the old ordering — the store's `getProjectForSession` registers the
    // session before the resolver reads it back — which is what makes "the registration was
    // redundant" checkable rather than asserted.
    describe('value parity with the registering resolution it replaced', () => {
        const machine = {
            id: 'machine-1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: {
                host: 'localhost',
                platform: 'darwin',
                happyCliVersion: '1',
                happyHomeDir: '.happy',
                homeDir: '/Users/alice',
            },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const cases: ReadonlyArray<Readonly<{
            name: string;
            sessionId: string | null;
            session: Session | null;
            register: Session | null;
            expected: string | null;
        }>> = [
            {
                name: 'session carrying its own machine id and path',
                sessionId: 'session-1',
                session: buildSession(),
                register: null,
                expected: '/Users/alice/repo',
            },
            {
                name: 'session with a path but no machine id (host-scoped project key)',
                sessionId: 'session-1',
                session: buildSession({ metadata: { host: 'localhost', path: '/Users/alice/repo', homeDir: '/Users/alice' } } as never),
                register: null,
                expected: '/Users/alice/repo',
            },
            {
                name: 'session path needing root normalization',
                sessionId: 'session-1',
                session: buildSession({ metadata: { host: 'localhost', machineId: 'machine-1', path: '/Users/alice/repo/', homeDir: '/Users/alice' } } as never),
                register: null,
                expected: '/Users/alice/repo',
            },
            {
                name: 'path-less session still filed under a project (moved/renamed machine)',
                sessionId: 'session-1',
                session: buildSession({ metadata: { host: 'localhost', machineId: 'machine-1', homeDir: '/Users/alice' } } as never),
                register: buildSession(),
                expected: '/Users/alice/repo',
            },
            {
                // A manager mapping alone does not rescue a session the store no longer knows: the
                // machine target is resolved from session metadata, which is gone. Pinned because
                // the pure resolver forwards exactly this case to the manager, so a change here
                // would be the first sign the fallback started answering differently.
                name: 'session absent from the store but still mapped by the manager (orphaned)',
                sessionId: 'session-1',
                session: null,
                register: buildSession(),
                expected: null,
            },
            {
                name: 'path-less session with no project mapping at all',
                sessionId: 'session-1',
                session: buildSession({ metadata: { host: 'localhost', machineId: 'machine-1', homeDir: '/Users/alice' } } as never),
                register: null,
                expected: null,
            },
            {
                name: 'blank session id',
                sessionId: '   ',
                session: buildSession(),
                register: null,
                expected: null,
            },
        ];

        for (const testCase of cases) {
            it(`resolves the same workspace root for ${testCase.name}`, async () => {
                const previousState = storage.getState();
                try {
                    if (testCase.register) {
                        projectManager.addSession(testCase.register, { serverId: 'server-1', machineMetadata: machine.metadata as never });
                    }
                    storage.setState((state) => ({
                        ...state,
                        isDataReady: true,
                        sessions: testCase.session ? { [testCase.session.id]: testCase.session } : {},
                        machines: { 'machine-1': machine as never },
                        sessionListRenderables: {},
                        sessionListIndexByServerId: {},
                    }));

                    const hook = await renderHook(() => useSessionWorkspacePath(testCase.sessionId), {
                        flushOptions: { cycles: 1, turns: 4 },
                    });

                    expect(hook.getCurrent()).toBe(testCase.expected);

                    // The replaced expression, evaluated verbatim.
                    const state = storage.getState();
                    const normalizedSessionId = typeof testCase.sessionId === 'string' ? testCase.sessionId.trim() : '';
                    const legacy = normalizedSessionId
                        ? resolveWorkspaceTargetForSessionFromState({
                            sessions: state.sessions,
                            sessionListRenderables: state.sessionListRenderables,
                            machines: state.machines,
                            sessionListIndexByServerId: state.sessionListIndexByServerId,
                            getProjectForSession: state.getProjectForSession,
                        }, normalizedSessionId)?.rootPath ?? null
                        : null;
                    expect(hook.getCurrent()).toBe(legacy);

                    await hook.unmount();
                } finally {
                    if (testCase.register) {
                        projectManager.removeSession(testCase.register.id);
                    }
                    storage.setState(previousState);
                }
            });
        }
    });
});
