/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the real RNW input, its keyboard events, and the enclosing pane's Escape owner.
vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return { ...actual, Platform: { ...actual.Platform, OS: 'web' } };
});
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { BrowserUrlField } = await import('./BrowserUrlField');
const { MultiPaneHost } = await import('@/components/ui/panels/MultiPaneHost');

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
beforeEach(() => vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {},
})));
afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});

describe('Browser address Escape in a presented pane', () => {
    it('restores and blurs the edited address before a Details overlay can close', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        roots.push(root);
        const onClose = vi.fn();
        const onNavigate = vi.fn();
        const authoritativeUrl = 'https://failed.example/failed';
        await act(async () => root.render(
            <MultiPaneHost
                main={<button>Session</button>}
                detailsPane={<BrowserUrlField testID="browser-address" value={authoritativeUrl} onSubmitUrl={onNavigate} />}
                layout={{ main: 'docked', kind: 'twoPane', right: 'hidden', details: 'overlay' }}
                rightDockWidthPx={360}
                detailsDockWidthPx={520}
                onCloseRight={() => {}}
                onCloseDetails={onClose}
                onCommitRightDockWidthPx={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
            />,
        ));
        const field = container.querySelector<HTMLInputElement>('[data-testid="browser-address"]')!;
        await act(async () => field.focus());
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'http://127.0.0.1/draft-never-navigate');
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(field.value).toBe('http://127.0.0.1/draft-never-navigate');
        await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
        expect(field.value).toBe(authoritativeUrl);
        expect(document.activeElement).not.toBe(field);
        expect(onClose).not.toHaveBeenCalled();
        expect(onNavigate).not.toHaveBeenCalled();

        // The edit layer releases with blur: a subsequent Escape still dismisses the pane.
        const pane = container.querySelector<HTMLElement>('[data-testid="multi-pane-details-modal"]')!;
        await act(async () => {
            pane.focus();
            pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        expect(onClose).toHaveBeenCalledOnce();
    });
});
