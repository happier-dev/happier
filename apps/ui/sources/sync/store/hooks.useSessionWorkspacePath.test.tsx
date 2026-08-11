import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { resolveSessionWorkspacePath } from '@/sync/domains/session/resolveSessionWorkspacePath';
import type { Session } from '@/sync/domains/state/storageTypes';

import { useSessionWorkspacePath } from './hooks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function buildSession(overrides: Partial<Session> & { id: string }): Session {
    return {
        seq: 1,
        createdAt: 10,
        updatedAt: 20,
        active: true,
        activeAt: 20,
        archivedAt: null,
        metadata: { path: '/repo', host: 'localhost', machineId: 'm-1' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    } as Session;
}

describe('useSessionWorkspacePath', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('does not rerender when the session updates without changing its workspace path', async () => {
        const previousState = storage.getState();
        try {
            storage.setState({
                sessions: {
                    s1: {
                        id: 's1',
                        active: true,
                        metadata: {
                            path: '/workspace',
                        },
                    },
                },
                getProjectForSession: () => null,
                isDataReady: true,
            } as never);

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionWorkspacePath('s1');
            });

            expect(hook.getCurrent()).toBe('/workspace');
            expect(renderCount).toBe(1);

            await act(async () => {
                const previousSession = storage.getState().sessions.s1;
                storage.setState({
                    sessions: {
                        s1: {
                            ...previousSession,
                            thinking: true,
                            thinkingAt: 456,
                        },
                    },
                } as never);
            });

            expect(hook.getCurrent()).toBe('/workspace');
            expect(renderCount).toBe(1);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    // The selector is what zustand runs as its snapshot-equality check, so it re-executes on every
    // publish for every mounted consumer. `projectManager.addSession` — the map-writing half of the
    // store's `getProjectForSession` — must therefore never be reachable from it: a transcript
    // mounts this hook once per row wrapper, and a streaming session publishes continuously, so a
    // single write per evaluation multiplies by rows x publishes.
    it('costs no project registration per store publish while a consumer is mounted', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({ ...state, isDataReady: true }));
            act(() => {
                storage.getState().applySessions([buildSession({ id: 's-1' })]);
            });

            const hook = await renderHook(() => useSessionWorkspacePath('s-1'), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            expect(hook.getCurrent()).toBe('/repo');

            const projectWrites = vi.spyOn(projectManager, 'addSession');
            const publishes = 25;
            for (let index = 0; index < publishes; index += 1) {
                act(() => {
                    storage.setState((state) => ({ ...state, lastSyncAt: 1_000 + index }));
                });
            }

            expect(projectWrites).toHaveBeenCalledTimes(0);
            expect(hook.getCurrent()).toBe('/repo');
            projectWrites.mockRestore();

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    // Value parity against the exact expression the hook used to evaluate. The oracle is run *after*
    // the hook so it reproduces the old ordering (the store's `getProjectForSession` registers the
    // session before reading it back), which is what makes "the write was redundant" checkable
    // rather than asserted.
    describe('value parity with the registering resolution it replaced', () => {
        const cases: ReadonlyArray<Readonly<{
            name: string;
            sessionId: string | null;
            session: Session | null;
            register: Session | null;
            expected: string | null;
        }>> = [
            {
                name: 'session carrying its own path',
                sessionId: 's-path',
                session: buildSession({ id: 's-path' }),
                register: null,
                expected: '/repo',
            },
            {
                name: 'session path needing normalization',
                sessionId: 's-untrimmed',
                session: buildSession({ id: 's-untrimmed', metadata: { path: '  /repo/nested  ', host: 'h', machineId: 'm-1' } } as never),
                register: null,
                expected: '/repo/nested',
            },
            {
                name: 'session on a machine with no id (unknown project scope)',
                sessionId: 's-unknown-machine',
                session: buildSession({ id: 's-unknown-machine', metadata: { path: '/orphan', host: 'h' } } as never),
                register: null,
                expected: '/orphan',
            },
            {
                name: 'path-less session still filed under a project (moved/renamed machine)',
                sessionId: 's-fallback',
                session: buildSession({ id: 's-fallback', metadata: { host: 'h', machineId: 'm-renamed' } } as never),
                register: buildSession({ id: 's-fallback', metadata: { path: '/previous', host: 'h', machineId: 'm-renamed' } } as never),
                expected: '/previous',
            },
            {
                name: 'session absent from the store but still mapped by the manager (orphaned)',
                sessionId: 's-orphan',
                session: null,
                register: buildSession({ id: 's-orphan', metadata: { path: '/gone', host: 'h', machineId: 'm-offline' } } as never),
                expected: '/gone',
            },
            {
                name: 'path-less session with no project mapping at all',
                sessionId: 's-nothing',
                session: buildSession({ id: 's-nothing', metadata: { host: 'h', machineId: 'm-1' } } as never),
                register: null,
                expected: null,
            },
            {
                name: 'no session id',
                sessionId: null,
                session: null,
                register: null,
                expected: null,
            },
        ];

        for (const testCase of cases) {
            it(`resolves the same path for ${testCase.name}`, async () => {
                const previousState = storage.getState();
                try {
                    if (testCase.register) {
                        projectManager.addSession(testCase.register);
                    }
                    storage.setState((state) => ({
                        ...state,
                        isDataReady: true,
                        sessions: testCase.session ? { [testCase.session.id]: testCase.session } : {},
                    }));

                    const hook = await renderHook(() => useSessionWorkspacePath(testCase.sessionId), {
                        flushOptions: { cycles: 1, turns: 4 },
                    });

                    expect(hook.getCurrent()).toBe(testCase.expected);

                    // The replaced expression, evaluated verbatim.
                    const state = storage.getState();
                    const legacy = testCase.sessionId
                        ? resolveSessionWorkspacePath({
                            sessionPath: state.sessions[testCase.sessionId]?.metadata?.path ?? null,
                            projectPath: state.getProjectForSession(testCase.sessionId)?.key?.path ?? null,
                        })
                        : resolveSessionWorkspacePath({ sessionPath: null, projectPath: null });
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
