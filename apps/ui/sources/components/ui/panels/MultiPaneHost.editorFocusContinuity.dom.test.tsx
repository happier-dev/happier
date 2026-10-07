/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FocusReturnTarget } from '@/keyboard/focusReturn';

vi.mock('react-native', async () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllGlobals(); });

describe('retained editor DOM focus', () => {
    it.each(['details', 'right'] as const)('retains the %s caret through dock, overlay, and dock but restores the opener on real close', async (kind) => {
        // The OS reduced-motion preference is a browser boundary; pane motion/resizing remain real.
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} }));
        const { MultiPaneHost } = await import('./MultiPaneHost');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
        const openerRef: React.MutableRefObject<FocusReturnTarget> = { current: null };
        let mounts = 0;
        function Editor() {
            React.useEffect(() => { mounts += 1; }, []);
            return <input data-testid="draft" defaultValue="Unsubmitted work" />;
        }
        const render = async (presentation: 'docked' | 'overlay', open = true) => {
            await act(async () => root.render(<MultiPaneHost
                main={<button data-testid="opener">Open</button>}
                detailsPane={kind === 'details' && open ? <Editor /> : null}
                rightPane={kind === 'right' && open ? <Editor /> : null}
                layout={{ kind: presentation === 'overlay' ? 'overlayStack' : 'twoPane', details: kind === 'details' ? presentation : 'hidden', right: kind === 'right' ? presentation : 'hidden' }}
                detailsDockWidthPx={390}
                rightDockWidthPx={390}
                onCloseDetails={() => {}}
                onCloseRight={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
                onCommitRightDockWidthPx={() => {}}
                detailsOverlayFocusReturnRef={openerRef}
                rightOverlayFocusReturnRef={openerRef}
            />));
        };
        await render('docked');
        const input = container.querySelector<HTMLInputElement>('[data-testid="draft"]')!;
        const opener = container.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
        input.focus();
        input.setSelectionRange(3, 8);
        for (const presentation of ['overlay', 'docked'] as const) {
            await render(presentation);
            expect(container.querySelector('[data-testid="draft"]')).toBe(input);
            expect(document.activeElement).toBe(input);
            expect([input.selectionStart, input.selectionEnd]).toEqual([3, 8]);
            expect(input.value).toBe('Unsubmitted work');
            expect(mounts).toBe(1);
        }
        openerRef.current = opener;
        await render('overlay');
        await render('overlay', false);
        expect(document.activeElement).toBe(opener);
    });
});
