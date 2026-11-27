import { expect, it } from 'vitest';
import { createWorkspaceGalleryDetailsTab } from '@/components/appShell/panes/details/galleryDetailsTab';
import { buildSessionDetailsTabHref, createSessionPaneDetailsTab, parseSessionPaneUrlState } from './sessionPaneUrlState';

it('round trips root, folder and session galleries through the existing Details destination', () => {
    for (const resource of [
        { kind: 'gallery', path: '' },
        { kind: 'gallery', path: 'nested/a b', rootPath: '/other' },
        { kind: 'gallery', scope: 'session-media' },
    ] as const) {
        const tab = createWorkspaceGalleryDetailsTab(resource);
        const href = buildSessionDetailsTabHref({ sessionId: 'my/session', serverId: 'other-home', tab });
        expect(href).toBeTruthy();
        const url = new URL(href!, 'https://example.test');
        expect(url.pathname).toBe('/session/my%2Fsession/details');
        expect(url.searchParams.get('serverId')).toBe('other-home');
        const target = parseSessionPaneUrlState(Object.fromEntries(url.searchParams))?.details;
        expect(target).toEqual(resource);
        expect(createSessionPaneDetailsTab(target!)?.key).toBe(tab.key);
    }
    expect(parseSessionPaneUrlState({ details: 'gallery', path: '../outside' })).toBeNull();
    expect(parseSessionPaneUrlState({ details: 'gallery' })).toBeNull();
});
