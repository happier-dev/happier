import * as React from 'react';
import { AppState, Platform } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useCommittedTranscriptProjectionSnapshot } from '@/components/sessions/transcript/items/useCommittedTranscriptProjectionSnapshot';
import { createReactNativeAppStateEmitter } from '@/dev/testkit';

import { useTranscriptSessionExitHandoff } from './useTranscriptSessionExitHandoff';

type HarnessProps = Readonly<{
    captureAtExit: (itemId: string | undefined) => void;
    committedProjectionRefs: Readonly<{
        canonicalWindowedItemsRef: React.MutableRefObject<readonly string[]>;
        itemsRef: React.MutableRefObject<readonly string[]>;
        listDataRef: React.MutableRefObject<readonly string[]>;
        renderWindowIndexMapRef: React.MutableRefObject<Readonly<{ version: string }>>;
    }>;
    currentSessionIdRef: { current: string };
    listData: readonly string[];
    sessionId: string;
    shouldSuspend?: boolean;
}>;

const neverSettles = new Promise<never>(() => {});

async function withBrowserLifecycleBoundary(
    run: (boundary: Readonly<{
        dispatchDocument(eventName: string): void;
        dispatchWindow(eventName: string): void;
        setVisibilityState(state: 'hidden' | 'visible'): void;
    }>) => Promise<void>,
): Promise<void> {
    const browserTarget = new EventTarget();
    const documentTarget = new EventTarget();
    let visibilityState: 'hidden' | 'visible' = 'visible';
    const browserGlobal = globalThis as unknown as Record<string, unknown>;
    const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const originalAddEventListener = browserGlobal.addEventListener;
    const originalRemoveEventListener = browserGlobal.removeEventListener;
    browserGlobal.addEventListener = browserTarget.addEventListener.bind(browserTarget);
    browserGlobal.removeEventListener = browserTarget.removeEventListener.bind(browserTarget);
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            addEventListener: documentTarget.addEventListener.bind(documentTarget),
            removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
            get visibilityState() {
                return visibilityState;
            },
        },
    });
    try {
        await run({
            dispatchDocument: (eventName) => {
                documentTarget.dispatchEvent(new Event(eventName));
            },
            dispatchWindow: (eventName) => {
                browserTarget.dispatchEvent(new Event(eventName));
            },
            setVisibilityState: (state) => {
                visibilityState = state;
            },
        });
    } finally {
        browserGlobal.addEventListener = originalAddEventListener;
        browserGlobal.removeEventListener = originalRemoveEventListener;
        if (originalDocumentDescriptor) {
            Object.defineProperty(globalThis, 'document', originalDocumentDescriptor);
        } else {
            delete (globalThis as { document?: unknown }).document;
        }
    }
}

function SessionHandoffHarness(props: HarnessProps) {
    const captureAtExitRef = React.useRef(props.captureAtExit);
    const commitSessionId = React.useCallback((sessionId: string) => {
        props.currentSessionIdRef.current = sessionId;
    }, [props.currentSessionIdRef]);
    const exitCurrentSession = React.useCallback(() => {
        captureAtExitRef.current(props.committedProjectionRefs.listDataRef.current[0]);
    }, [props.committedProjectionRefs]);

    useTranscriptSessionExitHandoff({
        commitSessionId,
        exitCurrentSession,
        sessionId: props.sessionId,
    });
    useCommittedTranscriptProjectionSnapshot({
        canonicalWindowedItems: props.listData,
        canonicalWindowedItemsRef: props.committedProjectionRefs.canonicalWindowedItemsRef,
        displayItems: props.listData,
        itemsRef: props.committedProjectionRefs.itemsRef,
        listData: props.listData,
        listDataRef: props.committedProjectionRefs.listDataRef,
        renderWindowIndexMap: { version: props.listData[0] ?? 'empty' },
        renderWindowIndexMapRef: props.committedProjectionRefs.renderWindowIndexMapRef,
    });
    React.useLayoutEffect(() => {
        captureAtExitRef.current = props.captureAtExit;
    }, [props.captureAtExit]);

    if (props.shouldSuspend === true) {
        throw neverSettles;
    }
    return null;
}

function renderHarness(props: HarnessProps): React.ReactElement {
    return (
        <React.Suspense fallback={null}>
            <SessionHandoffHarness {...props} />
        </React.Suspense>
    );
}

describe('useTranscriptSessionExitHandoff', () => {
    it('synchronously exits once per native inactive/background episode, rearms on active, and does not duplicate on unmount', async () => {
        const originalPlatformOS = Platform.OS;
        const appStateBoundary = createReactNativeAppStateEmitter();
        const restoreAppState = appStateBoundary.install(AppState);
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        try {
            const commitSessionId = vi.fn();
            const exitCurrentSession = vi.fn();
            const revalidateAfterLifecycleResume = vi.fn();

            function Harness() {
                useTranscriptSessionExitHandoff({
                    commitSessionId,
                    exitCurrentSession,
                    revalidateAfterLifecycleResume,
                    sessionId: 'session-a',
                });
                return null;
            }

            let tree!: renderer.ReactTestRenderer;
            await act(async () => {
                tree = renderer.create(<Harness />);
            });

            expect(commitSessionId).toHaveBeenCalledExactlyOnceWith('session-a');
            expect(appStateBoundary.getListenerCount()).toBe(1);
            appStateBoundary.emit('active');
            appStateBoundary.emit('active');
            expect(revalidateAfterLifecycleResume).not.toHaveBeenCalled();

            appStateBoundary.emit('inactive');
            expect(exitCurrentSession).toHaveBeenCalledExactlyOnceWith({ deferEmit: false });

            appStateBoundary.emit('background');
            expect(exitCurrentSession).toHaveBeenCalledTimes(1);

            appStateBoundary.emit('active');
            appStateBoundary.emit('active');
            expect(revalidateAfterLifecycleResume).toHaveBeenCalledTimes(1);
            appStateBoundary.emit('background');
            expect(exitCurrentSession).toHaveBeenCalledTimes(2);
            expect(exitCurrentSession).toHaveBeenLastCalledWith({ deferEmit: false });
            appStateBoundary.emit('active');
            expect(revalidateAfterLifecycleResume).toHaveBeenCalledTimes(2);
            appStateBoundary.emit('background');
            expect(exitCurrentSession).toHaveBeenCalledTimes(3);

            await act(async () => {
                tree.unmount();
            });
            expect(exitCurrentSession).toHaveBeenCalledTimes(3);
            expect(appStateBoundary.getListenerCount()).toBe(0);

            appStateBoundary.emit('active');
            appStateBoundary.emit('inactive');
            expect(exitCurrentSession).toHaveBeenCalledTimes(3);
        } finally {
            restoreAppState();
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('synchronously exits once for one hidden-page lifecycle and resumes normal unmount capture after restore', async () => {
        await withBrowserLifecycleBoundary(async (boundary) => {
            const commitSessionId = vi.fn();
            const exitCurrentSession = vi.fn();
            const revalidateAfterLifecycleResume = vi.fn();

            function Harness() {
                useTranscriptSessionExitHandoff({
                    commitSessionId,
                    exitCurrentSession,
                    revalidateAfterLifecycleResume,
                    sessionId: 'session-a',
                });
                return null;
            }

            let tree!: renderer.ReactTestRenderer;
            await act(async () => {
                tree = renderer.create(<Harness />);
            });

            boundary.setVisibilityState('hidden');
            boundary.dispatchDocument('visibilitychange');
            expect(exitCurrentSession).toHaveBeenCalledExactlyOnceWith({ deferEmit: false });

            boundary.dispatchWindow('pagehide');
            boundary.dispatchWindow('freeze');
            expect(exitCurrentSession).toHaveBeenCalledTimes(1);

            boundary.setVisibilityState('visible');
            boundary.dispatchDocument('visibilitychange');
            boundary.dispatchWindow('pageshow');
            boundary.dispatchWindow('resume');
            expect(revalidateAfterLifecycleResume).not.toHaveBeenCalled();

            await act(async () => {
                tree.unmount();
            });
            expect(exitCurrentSession).toHaveBeenCalledTimes(2);
            expect(exitCurrentSession).toHaveBeenLastCalledWith();

            boundary.dispatchWindow('pageshow');
            boundary.dispatchWindow('pagehide');
            boundary.setVisibilityState('hidden');
            boundary.dispatchDocument('visibilitychange');
            expect(exitCurrentSession).toHaveBeenCalledTimes(2);
        });
    });

    it.each(['pagehide', 'freeze'] as const)(
        'publishes synchronously on %s and does not duplicate during unmount cleanup',
        async (eventName) => {
            await withBrowserLifecycleBoundary(async (boundary) => {
                const exitCurrentSession = vi.fn();

                function Harness() {
                    useTranscriptSessionExitHandoff({
                        commitSessionId: () => undefined,
                        exitCurrentSession,
                        sessionId: 'session-a',
                    });
                    return null;
                }

                let tree!: renderer.ReactTestRenderer;
                await act(async () => {
                    tree = renderer.create(<Harness />);
                });

                boundary.dispatchWindow(eventName);
                expect(exitCurrentSession).toHaveBeenCalledExactlyOnceWith({ deferEmit: false });

                await act(async () => {
                    tree.unmount();
                });
                expect(exitCurrentSession).toHaveBeenCalledTimes(1);
            });
        },
    );

    it('subscribes before a page lifecycle event can occur after commit but before passive effects', async () => {
        await withBrowserLifecycleBoundary(async (boundary) => {
            const commitSessionId = vi.fn();
            const exitCurrentSession = vi.fn();

            function Harness() {
                useTranscriptSessionExitHandoff({
                    commitSessionId,
                    exitCurrentSession,
                    sessionId: 'session-a',
                });
                React.useLayoutEffect(() => {
                    boundary.dispatchWindow('pagehide');
                }, []);
                return null;
            }

            let tree!: renderer.ReactTestRenderer;
            await act(async () => {
                tree = renderer.create(<Harness />);
            });

            expect(commitSessionId).toHaveBeenCalledExactlyOnceWith('session-a');
            expect(exitCurrentSession).toHaveBeenCalledExactlyOnceWith({ deferEmit: false });

            await act(async () => {
                tree.unmount();
            });
            expect(exitCurrentSession).toHaveBeenCalledTimes(1);
        });
    });

    it('does not report a StrictMode probe cleanup as a real session exit', async () => {
        const commitSessionId = vi.fn();
        const exitCurrentSession = vi.fn();

        function StrictModeHarness() {
            useTranscriptSessionExitHandoff({
                commitSessionId,
                exitCurrentSession,
                sessionId: 'session-a',
            });
            return null;
        }

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <React.StrictMode>
                    <StrictModeHarness />
                </React.StrictMode>,
                { unstable_strictMode: true } as unknown as renderer.TestRendererOptions,
            );
        });

        expect(commitSessionId).toHaveBeenCalledExactlyOnceWith('session-a');
        expect(exitCurrentSession).not.toHaveBeenCalled();

        await act(async () => {
            tree.unmount();
        });
        expect(exitCurrentSession).toHaveBeenCalledTimes(1);
    });

    it('captures the keyed parent while the child imperative list ref still points at A', async () => {
        type ListHandle = Readonly<{ itemId: string }>;
        const ImperativeList = React.forwardRef<ListHandle, Readonly<{ itemId: string }>>(
            function ImperativeList(props, ref) {
                React.useImperativeHandle(ref, () => ({ itemId: props.itemId }), [props.itemId]);
                return null;
            },
        );
        const captureA = vi.fn();
        const captureB = vi.fn();

        function KeyedHost(props: Readonly<{
            capture: (itemId: string | undefined) => void;
            itemId: string;
            sessionId: string;
        }>) {
            const listRef = React.useRef<ListHandle | null>(null);
            const exitCurrentSession = React.useCallback(() => {
                props.capture(listRef.current?.itemId);
            }, [props.capture]);
            useTranscriptSessionExitHandoff({
                commitSessionId: () => undefined,
                exitCurrentSession,
                sessionId: props.sessionId,
            });
            return <ImperativeList ref={listRef} itemId={props.itemId} />;
        }

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <KeyedHost
                    key="session-a"
                    capture={captureA}
                    itemId="item-a"
                    sessionId="session-a"
                />,
            );
        });
        await act(async () => {
            tree.update(
                <KeyedHost
                    key="session-b"
                    capture={captureB}
                    itemId="item-b"
                    sessionId="session-b"
                />,
            );
        });

        expect(captureA).toHaveBeenCalledExactlyOnceWith('item-a');
        expect(captureB).not.toHaveBeenCalled();

        await act(async () => {
            tree.unmount();
        });
        expect(captureB).toHaveBeenCalledExactlyOnceWith('item-b');
    });

    it('keeps A authoritative through an abandoned same-session B render, then publishes B without exiting A', async () => {
        const captureA = vi.fn();
        const captureB = vi.fn();
        const committedProjectionRefs = {
            canonicalWindowedItemsRef: { current: ['item-a'] as readonly string[] },
            itemsRef: { current: ['item-a'] as readonly string[] },
            listDataRef: { current: ['item-a'] as readonly string[] },
            renderWindowIndexMapRef: { current: { version: 'item-a' } },
        };
        const currentSessionIdRef = { current: 'session-a' };
        let tree!: renderer.ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(renderHarness({
                captureAtExit: captureA,
                committedProjectionRefs,
                currentSessionIdRef,
                listData: ['item-a'],
                sessionId: 'session-a',
            }), { unstable_isConcurrent: true } as unknown as renderer.TestRendererOptions);
        });

        await act(async () => {
            React.startTransition(() => {
                tree.update(renderHarness({
                    captureAtExit: captureB,
                    committedProjectionRefs,
                    currentSessionIdRef,
                    listData: ['item-b'],
                    sessionId: 'session-a',
                    shouldSuspend: true,
                }));
            });
            await Promise.resolve();
        });

        expect(captureA).not.toHaveBeenCalled();
        expect(captureB).not.toHaveBeenCalled();
        expect(currentSessionIdRef.current).toBe('session-a');
        expect(committedProjectionRefs).toMatchObject({
            canonicalWindowedItemsRef: { current: ['item-a'] },
            itemsRef: { current: ['item-a'] },
            listDataRef: { current: ['item-a'] },
            renderWindowIndexMapRef: { current: { version: 'item-a' } },
        });

        await act(async () => {
            tree.update(renderHarness({
                captureAtExit: captureB,
                committedProjectionRefs,
                currentSessionIdRef,
                listData: ['item-b'],
                sessionId: 'session-a',
            }));
        });

        expect(captureA).not.toHaveBeenCalled();
        expect(captureB).not.toHaveBeenCalled();
        expect(currentSessionIdRef.current).toBe('session-a');
        expect(committedProjectionRefs).toMatchObject({
            canonicalWindowedItemsRef: { current: ['item-b'] },
            itemsRef: { current: ['item-b'] },
            listDataRef: { current: ['item-b'] },
            renderWindowIndexMapRef: { current: { version: 'item-b' } },
        });

        await act(async () => {
            tree.unmount();
        });
        expect(captureA).not.toHaveBeenCalled();
        expect(captureB).toHaveBeenCalledExactlyOnceWith('item-b');
    });
});
