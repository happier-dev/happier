/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

vi.mock('react-native', async () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/utils/web/reactDomCjs', async () => {
    const dom = await import('react-dom');
    return { requireReactDOM: () => dom };
});

import { PresentationNoticeHost } from './PresentationNoticeHost';
import { publishPresentationNotice, retirePresentationNotice } from './presentationNotices';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('keeps the single notice and its Undo reachable outside the retained hidden navigator on every route', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const undo = vi.fn();
    try {
        for (const route of ['project', 'usage', 'session']) {
            await act(async () => {
                root.render(<div data-testid="navigator" style={{ display: 'none' }}>
                    <div key={route}>{route}</div><PresentationNoticeHost />
                </div>);
                publishPresentationNotice({ key: route, message: 'Reset done', severity: 'info', undo: { label: 'Undo', run: undo } });
            });
            const notices = document.querySelectorAll('[data-testid="current-session-presentation-notice"]');
            expect(notices).toHaveLength(1);
            let ancestor: Element | null = notices[0]!;
            while (ancestor) {
                expect(window.getComputedStyle(ancestor).display).not.toBe('none');
                ancestor = ancestor.parentElement;
            }
            const button = document.querySelector<HTMLElement>('[data-testid="current-session-presentation-notice-undo"]')!;
            await act(async () => button.focus());
            expect(document.activeElement).toBe(button);
            await act(async () => button.click());
        }
        expect(undo).toHaveBeenCalledTimes(3);
    } finally {
        await act(async () => { root.unmount(); retirePresentationNotice(); });
        container.remove();
    }
});
