import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HostListener = () => void;

const host = vi.hoisted(() => ({
    platformOS: 'web' as string,
    appState: 'active' as string,
    appStateListeners: new Set<(state: string) => void>(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return host.platformOS;
            },
        },
        AppState: {
            get currentState() {
                return host.appState;
            },
            addEventListener: (event: string, listener: (state: string) => void) => {
                if (event !== 'change') return { remove: () => {} };
                host.appStateListeners.add(listener);
                return { remove: () => host.appStateListeners.delete(listener) };
            },
        },
    });
});

type FakeHost = Readonly<{
    setVisibility: (state: 'visible' | 'hidden') => void;
    setFocused: (focused: boolean) => void;
    emitAppState: (state: string) => void;
    documentListenerCount: (event: string) => number;
    windowListenerCount: (event: string) => number;
    restore: () => void;
}>;

/**
 * Installs the host globals the hook watches. They must exist *before* the module
 * is imported, because the watch samples once when it starts.
 */
function installHost(options: Readonly<{
    tauri?: boolean;
    visibility?: 'visible' | 'hidden';
    focused?: boolean;
    platformOS?: string;
    appState?: string;
}>): FakeHost {
    const documentListeners = new Map<string, Set<HostListener>>();
    const viewListeners = new Map<string, Set<HostListener>>();
    const state = {
        visibility: options.visibility ?? 'visible',
        focused: options.focused ?? true,
    };
    host.platformOS = options.platformOS ?? 'web';
    host.appState = options.appState ?? 'active';

    const add = (registry: Map<string, Set<HostListener>>) => (event: string, listener: HostListener) => {
        const existing = registry.get(event) ?? new Set<HostListener>();
        existing.add(listener);
        registry.set(event, existing);
    };
    const remove = (registry: Map<string, Set<HostListener>>) => (event: string, listener: HostListener) => {
        registry.get(event)?.delete(listener);
    };
    const emit = (registry: Map<string, Set<HostListener>>, event: string) => {
        for (const listener of [...(registry.get(event) ?? [])]) listener();
    };

    const globals = globalThis as Record<string, unknown>;
    const previousDocument = globals.document;
    const previousTauri = globals.__TAURI_INTERNALS__;
    const previousAdd = globals.addEventListener;
    const previousRemove = globals.removeEventListener;

    globals.document = {
        get visibilityState() {
            return state.visibility;
        },
        hasFocus: () => state.focused,
        addEventListener: add(documentListeners),
        removeEventListener: remove(documentListeners),
    };
    globals.addEventListener = add(viewListeners);
    globals.removeEventListener = remove(viewListeners);
    if (options.tauri) globals.__TAURI_INTERNALS__ = { invoke: () => undefined };
    else delete globals.__TAURI_INTERNALS__;

    return {
        setVisibility: (next) => {
            state.visibility = next;
            emit(documentListeners, 'visibilitychange');
        },
        setFocused: (next) => {
            state.focused = next;
            emit(viewListeners, next ? 'focus' : 'blur');
        },
        emitAppState: (next) => {
            host.appState = next;
            for (const listener of [...host.appStateListeners]) listener(next);
        },
        documentListenerCount: (event) => documentListeners.get(event)?.size ?? 0,
        windowListenerCount: (event) => viewListeners.get(event)?.size ?? 0,
        restore: () => {
            if (previousDocument === undefined) delete globals.document;
            else globals.document = previousDocument;
            if (previousTauri === undefined) delete globals.__TAURI_INTERNALS__;
            else globals.__TAURI_INTERNALS__ = previousTauri;
            if (previousAdd === undefined) delete globals.addEventListener;
            else globals.addEventListener = previousAdd;
            if (previousRemove === undefined) delete globals.removeEventListener;
            else globals.removeEventListener = previousRemove;
        },
    };
}

describe('useHostActivelyViewed', () => {
    afterEach(() => {
        standardCleanup();
        vi.resetModules();
        host.appStateListeners.clear();
        host.appState = 'active';
        host.platformOS = 'web';
    });

    it('reports a hidden Tauri window as inactive', async () => {
        const fake = installHost({ tauri: true, visibility: 'hidden', focused: false });
        try {
            // `isRuntimeActive()` returns true for every Tauri host so background
            // probes keep polling in a desktop webview. Motion must not: a 60 Hz
            // loop behind a hidden window is cost nobody can see.
            const { readHostActivelyViewed } = await import('./useHostActivelyViewed');
            expect(readHostActivelyViewed()).toBe(false);
        } finally {
            fake.restore();
        }
    });

    it('reports a visible but unfocused desktop window as viewed', async () => {
        // The hands-free posture: the user is talking to Voice while their
        // editor holds focus. The window is on screen, so its context remains
        // current for ordinary visibility consumers; Voice energy separately
        // consumes the narrower focused projection.
        const fake = installHost({ tauri: true, visibility: 'visible', focused: false });
        try {
            const { readHostActivelyViewed } = await import('./useHostActivelyViewed');
            expect(readHostActivelyViewed()).toBe(true);
        } finally {
            fake.restore();
        }
    });

    it('projects focused desktop presence separately while sharing the existing host watch', async () => {
        const fake = installHost({ tauri: true, visibility: 'visible', focused: false });
        try {
            const {
                readHostActivelyFocused,
                readHostActivelyViewed,
                useHostActivelyFocused,
                useHostActivelyViewed,
            } = await import('./useHostActivelyViewed');

            function Consumer(): React.ReactElement | null {
                useHostActivelyViewed();
                useHostActivelyFocused();
                return null;
            }

            await renderScreen(<Consumer />);

            // Current-UI and other visibility consumers keep their visible-window
            // fact. Voice energy consumes the focus projection instead.
            expect(readHostActivelyViewed()).toBe(true);
            expect(readHostActivelyFocused()).toBe(false);
            // Both projections must reuse the module's one app-lifetime watch,
            // rather than installing a Voice-specific focus/blur observer.
            expect(fake.documentListenerCount('visibilitychange')).toBe(1);
            expect(fake.windowListenerCount('focus')).toBe(1);
            expect(fake.windowListenerCount('blur')).toBe(1);

            act(() => {
                fake.setFocused(true);
            });
            expect(readHostActivelyFocused()).toBe(true);
        } finally {
            fake.restore();
        }
    });

    it('escapes a wedged hidden visibilityState when the desktop window reports focus', async () => {
        // macOS can leave a desktop webview latched at 'hidden' with no further
        // visibilitychange. A focused document cannot be hidden, so focus is the
        // contradiction that releases the latch.
        const fake = installHost({ tauri: true, visibility: 'hidden', focused: true });
        try {
            const { readHostActivelyViewed } = await import('./useHostActivelyViewed');
            expect(readHostActivelyViewed()).toBe(true);
        } finally {
            fake.restore();
        }
    });

    it('reports a focused, visible Tauri window as active', async () => {
        const fake = installHost({ tauri: true, visibility: 'visible', focused: true });
        try {
            const { readHostActivelyViewed } = await import('./useHostActivelyViewed');
            expect(readHostActivelyViewed()).toBe(true);
        } finally {
            fake.restore();
        }
    });

    it('treats the native app state "inactive" as not active', async () => {
        const fake = installHost({ platformOS: 'ios', appState: 'inactive' });
        try {
            const { readHostActivelyViewed } = await import('./useHostActivelyViewed');
            expect(readHostActivelyViewed()).toBe(false);
        } finally {
            fake.restore();
        }
    });

    it('watches the host once for every consumer, not once per consumer', async () => {
        const fake = installHost({});
        try {
            const { useHostActivelyViewed } = await import('./useHostActivelyViewed');

            function Consumer(): React.ReactElement | null {
                useHostActivelyViewed();
                return null;
            }

            await renderScreen(
                <>
                    {Array.from({ length: 12 }, (_, index) => <Consumer key={index} />)}
                </>,
            );

            expect(fake.documentListenerCount('visibilitychange')).toBe(1);
        } finally {
            fake.restore();
        }
    });

    it('publishes host transitions to every consumer', async () => {
        const fake = installHost({ tauri: true });
        try {
            const { useHostActivelyViewed } = await import('./useHostActivelyViewed');
            const observed: boolean[] = [];

            function Consumer(props: Readonly<{ index: number }>): React.ReactElement | null {
                const active = useHostActivelyViewed();
                React.useEffect(() => {
                    observed[props.index] = active;
                }, [active, props.index]);
                return null;
            }

            await renderScreen(
                <>
                    {Array.from({ length: 3 }, (_, index) => <Consumer key={index} index={index} />)}
                </>,
            );

            expect(observed).toEqual([true, true, true]);

            // Focus alone never withdraws a visible window.
            act(() => {
                fake.setFocused(false);
            });
            expect(observed).toEqual([true, true, true]);

            act(() => {
                fake.setVisibility('hidden');
            });
            expect(observed).toEqual([false, false, false]);

            // Regaining focus while still latched at 'hidden' releases the latch.
            act(() => {
                fake.setFocused(true);
            });
            expect(observed).toEqual([true, true, true]);

            act(() => {
                fake.setFocused(false);
            });
            expect(observed).toEqual([false, false, false]);

            act(() => {
                fake.setVisibility('visible');
            });
            expect(observed).toEqual([true, true, true]);
        } finally {
            fake.restore();
        }
    });

    it('publishes app-state transitions on native', async () => {
        const fake = installHost({ platformOS: 'ios' });
        try {
            const { useHostActivelyViewed } = await import('./useHostActivelyViewed');
            const observed: boolean[] = [];

            function Consumer(): React.ReactElement | null {
                const active = useHostActivelyViewed();
                React.useEffect(() => {
                    observed.push(active);
                }, [active]);
                return null;
            }

            await renderScreen(<Consumer />);
            expect(observed).toEqual([true]);

            act(() => {
                fake.emitAppState('background');
            });
            expect(observed).toEqual([true, false]);

            act(() => {
                fake.emitAppState('active');
            });
            expect(observed).toEqual([true, false, true]);
        } finally {
            fake.restore();
        }
    });
});
