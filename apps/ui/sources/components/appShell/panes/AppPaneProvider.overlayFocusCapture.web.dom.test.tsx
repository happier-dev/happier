/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useWebOverlayFocusContainment } from '@/keyboard/webOverlayFocusContainment';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: () => undefined,
        useLocalSettingMutable: () => [undefined, () => {}],
    });
});

import { AppPaneProvider, useAppPaneContext } from './AppPaneProvider';
import { useAppPaneScope, type AppPaneScopeApi } from './hooks/useAppPaneScope';
import { applyOpenDetailsOverlay, createEmptyPaneDetailsState } from './details/workspace/detailsWorkspaceReducer';
import type { PaneScopeState } from './model/appPaneReducer';

type MountedHarness = Readonly<{
    unmount: () => Promise<void>;
}>;

const mountedHarnesses: MountedHarness[] = [];
let detailsPane: AppPaneScopeApi | null = null;
let detailsDispatch: ReturnType<typeof useAppPaneContext>['dispatch'] | null = null;
let bottomDispatch: ReturnType<typeof useAppPaneContext>['dispatch'] | null = null;

afterEach(async () => {
    while (mountedHarnesses.length > 0) {
        await mountedHarnesses.pop()?.unmount();
    }
    detailsPane = null;
    detailsDispatch = null;
    bottomDispatch = null;
    document.body.removeAttribute('tabindex');
});

describe('AppPane overlay focus capture', () => {
    it('captures before the Details open command can make its underlay inert', async () => {
        await mountHarness(<DetailsOverlayCommandHarness />);
        const trigger = requireElement<HTMLButtonElement>('details-command-trigger');
        trigger.focus();

        await act(async () => {
            detailsPane?.openDetailsOverlay?.({
                destination: { pluginId: 'com.example.viewer', localId: 'activity-log' },
            });
            simulateInertFocusFixup();
        });

        expect(document.activeElement).toBe(requireElement('details-command-overlay-shell'));

        await act(async () => {
            detailsPane?.closeDetailsOverlay?.();
        });

        expect(document.activeElement).toBe(trigger);
    });

    it('captures direct bottom-destination dispatches, not only useAppPaneScope callers', async () => {
        await mountHarness(<BottomOverlayCommandHarness />);
        const trigger = requireElement<HTMLButtonElement>('bottom-command-trigger');
        trigger.focus();

        await act(async () => {
            bottomDispatch?.({
                type: 'selectBottomDestination',
                scopeId: 'session:bottom-focus',
                destination: { kind: 'builtin', id: 'terminal' },
            });
            simulateInertFocusFixup();
        });

        expect(document.activeElement).toBe(requireElement('bottom-command-overlay-shell'));

        await act(async () => {
            bottomDispatch?.({ type: 'closeBottom', scopeId: 'session:bottom-focus' });
        });

        expect(document.activeElement).toBe(trigger);
    });

    it('uses local fallback for a restored Details overlay with no command capture', async () => {
        await mountHarness(<DetailsOverlayCommandHarness />);
        const trigger = requireElement<HTMLButtonElement>('details-command-trigger');
        trigger.focus();

        await act(async () => {
            detailsDispatch?.({
                type: 'mergePersistedScopes',
                scopes: {
                    'session:details-focus': createScopeState({
                        details: applyOpenDetailsOverlay(createEmptyPaneDetailsState(), {
                            destination: { pluginId: 'com.example.viewer', localId: 'activity-log' },
                        }),
                    }),
                },
            });
        });

        expect(document.activeElement).toBe(requireElement('details-command-overlay-shell'));

        await act(async () => {
            detailsPane?.closeDetailsOverlay?.();
        });

        expect(document.activeElement).toBe(requireElement('details-command-fallback'));
        expect(document.activeElement).not.toBe(trigger);
    });

    it('uses local fallback for a restored Bottom overlay with no command capture', async () => {
        await mountHarness(<BottomOverlayCommandHarness />);
        const trigger = requireElement<HTMLButtonElement>('bottom-command-trigger');
        trigger.focus();

        await act(async () => {
            bottomDispatch?.({
                type: 'mergePersistedScopes',
                scopes: {
                    'session:bottom-focus': createScopeState({
                        bottom: {
                            isOpen: true,
                            activeTabId: 'terminal',
                            selectedDestination: { kind: 'builtin', id: 'terminal' },
                            tabState: {},
                        },
                    }),
                },
            });
        });

        expect(document.activeElement).toBe(requireElement('bottom-command-overlay-shell'));

        await act(async () => {
            bottomDispatch?.({ type: 'closeBottom', scopeId: 'session:bottom-focus' });
        });

        expect(document.activeElement).toBe(requireElement('bottom-command-fallback'));
        expect(document.activeElement).not.toBe(trigger);
    });
});

function DetailsOverlayCommandHarness(): React.ReactElement {
    const pane = useAppPaneScope('session:details-focus');
    const { dispatch } = useAppPaneContext();
    const shellRef = React.useRef<HTMLDivElement | null>(null);
    const fallbackRef = React.useRef<HTMLButtonElement | null>(null);
    const overlayFocus = pane.scopeState?.details.overlay ?? null;
    detailsPane = pane;
    detailsDispatch = dispatch;
    useWebOverlayFocusContainment({
        active: overlayFocus != null,
        containerRef: shellRef,
        fallbackRef,
        focusReturn: {
            kind: 'pre-mutation',
            ref: pane.detailsOverlayFocusReturnRef!,
            discardPendingCapture: false,
        },
    });

    return (
        <>
            <button data-testid="details-command-trigger">Details trigger</button>
            <button ref={fallbackRef} data-testid="details-command-fallback">Fallback</button>
            {overlayFocus ? <div ref={shellRef} data-testid="details-command-overlay-shell" tabIndex={-1} /> : null}
        </>
    );
}

function BottomOverlayCommandHarness(): React.ReactElement {
    const pane = useAppPaneScope('session:bottom-focus');
    const { dispatch } = useAppPaneContext();
    const shellRef = React.useRef<HTMLDivElement | null>(null);
    const fallbackRef = React.useRef<HTMLButtonElement | null>(null);
    bottomDispatch = dispatch;
    useWebOverlayFocusContainment({
        active: pane.scopeState?.bottom.isOpen === true,
        containerRef: shellRef,
        fallbackRef,
        focusReturn: {
            kind: 'pre-mutation',
            ref: pane.bottomOverlayFocusReturnRef!,
            discardPendingCapture: false,
        },
    });

    return (
        <>
            <button data-testid="bottom-command-trigger">Bottom trigger</button>
            <button ref={fallbackRef} data-testid="bottom-command-fallback">Fallback</button>
            {pane.scopeState?.bottom.isOpen ? (
                <div ref={shellRef} data-testid="bottom-command-overlay-shell" tabIndex={-1} />
            ) : null}
        </>
    );
}

async function mountHarness(content: React.ReactNode): Promise<void> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedHarnesses.push({
        unmount: async () => {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        },
    });
    await act(async () => {
        root.render(<AppPaneProvider>{content}</AppPaneProvider>);
    });
}

function requireElement<TElement extends HTMLElement = HTMLElement>(testId: string): TElement {
    const element = document.querySelector<TElement>(`[data-testid="${testId}"]`);
    if (!element) throw new Error(`Missing ${testId}`);
    return element;
}

function simulateInertFocusFixup(): void {
    document.body.tabIndex = -1;
    document.body.focus();
    expect(document.activeElement).toBe(document.body);
}

function createScopeState(input: Readonly<{
    details?: PaneScopeState['details'];
    bottom?: PaneScopeState['bottom'];
}>): PaneScopeState {
    return {
        right: {
            isOpen: false,
            activeTabId: null,
            selectedDestination: null,
            tabState: {},
        },
        details: input.details ?? createEmptyPaneDetailsState(),
        bottom: input.bottom ?? {
            isOpen: false,
            activeTabId: null,
            selectedDestination: null,
            tabState: {},
        },
    };
}
