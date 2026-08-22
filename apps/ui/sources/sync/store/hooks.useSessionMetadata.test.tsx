import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import { useSessionMetadata } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';

import { useSessionDisplayNameSource } from './hooks';

afterEach(() => {
    standardCleanup();
});

describe('useSessionMetadata', () => {
    it('does not re-render when non-metadata session fields change', async () => {
        const previousState = storage.getState();
        try {
            const metadata: Session['metadata'] = { flavor: 'codex', host: 'localhost', path: '/tmp/project' };
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    's-1': ({
                        id: 's-1',
                        seq: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        active: true,
                        activeAt: 1,
                        metadata,
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 1,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 1,
                    } satisfies Session),
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionMetadata('s-1');
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const initialRenderCount = renderCount;

            expect(hook.getCurrent()).toBe(metadata);

            await act(async () => {
                storage.setState((state) => {
                    const session = state.sessions['s-1'];
                    if (!session) return state;
                    return {
                        ...state,
                        sessions: {
                            ...state.sessions,
                            's-1': {
                                ...session,
                                active: false,
                                updatedAt: 2,
                            },
                        },
                    };
                });
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            expect(hook.getCurrent()).toBe(metadata);
            expect(renderCount).toBe(initialRenderCount);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});

describe('useSessionDisplayNameSource', () => {
    it('does not re-render when turn-lifecycle Session fields change', async () => {
        const previousState = storage.getState();
        try {
            const metadata: Session['metadata'] = { flavor: 'codex', host: 'localhost', path: '/tmp/project' };
            const ownerMetadataView: Session['ownerMetadataView'] = { ...metadata, name: 'Initial title' };
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    's-1': ({
                        id: 's-1',
                        seq: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        active: true,
                        activeAt: 1,
                        metadata,
                        metadataLayoutVersion: 1,
                        ownerMetadataView,
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 1,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 1,
                    } satisfies Session),
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionDisplayNameSource('s-1');
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const initialRenderCount = renderCount;
            const initialSource = hook.getCurrent();

            expect(initialSource).toMatchObject({
                id: 's-1',
                metadata,
                metadataLayoutVersion: 1,
                ownerMetadataView,
            });

            await act(async () => {
                storage.setState((state) => {
                    const session = state.sessions['s-1'];
                    if (!session) return state;
                    return {
                        ...state,
                        sessions: {
                            ...state.sessions,
                            's-1': {
                                ...session,
                                thinking: true,
                                updatedAt: 2,
                            },
                        },
                    };
                });
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            expect(hook.getCurrent()).toBe(initialSource);
            expect(renderCount).toBe(initialRenderCount);

            const updatedOwnerMetadataView: Session['ownerMetadataView'] = { ...metadata, name: 'Updated title' };
            await act(async () => {
                storage.setState((state) => {
                    const session = state.sessions['s-1'];
                    if (!session) return state;
                    return {
                        ...state,
                        sessions: {
                            ...state.sessions,
                            's-1': {
                                ...session,
                                ownerMetadataView: updatedOwnerMetadataView,
                            },
                        },
                    };
                });
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            expect(hook.getCurrent()).toMatchObject({ ownerMetadataView: updatedOwnerMetadataView });
            expect(renderCount).toBe(initialRenderCount + 1);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
