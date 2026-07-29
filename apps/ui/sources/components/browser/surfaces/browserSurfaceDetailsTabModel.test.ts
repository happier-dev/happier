import { describe, expect, it } from 'vitest';

import {
    BROWSER_VIEW_DETAILS_TAB_KIND,
    createBrowserLaunchpadDetailsTab,
    createBrowserViewDetailsTab,
    readBrowserViewDetailsResource,
    readBrowserViewLaunchpadResource,
} from './browserSurfaceDetailsTabModel';

describe('browser surface details tab model', () => {
    it('builds the launchpad as a canonical browser-view tab carrying a launchpad resource', () => {
        const launchpad = createBrowserLaunchpadDetailsTab();

        expect(launchpad.kind).toBe(BROWSER_VIEW_DETAILS_TAB_KIND);
        expect(launchpad.resource).toMatchObject({
            kind: 'browser-view',
            mode: 'launchpad',
            browserSessionId: 'browser_surface:details:browser_launchpad',
        });
        // The launchpad is recognized by the launchpad reader but NOT the single-view reader.
        expect(readBrowserViewLaunchpadResource(launchpad.resource)).not.toBeNull();
        expect(readBrowserViewDetailsResource(launchpad.resource)).toBeNull();
    });

    it('builds a browser-view tab carrying the workspace seam resource (browserSessionId, viewId, target)', () => {
        const target = {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 'session_1',
            machineId: 'machine_1',
            display: { title: 'Preview' },
        } as const;
        const tab = createBrowserViewDetailsTab({ target });

        expect(tab.kind).toBe(BROWSER_VIEW_DETAILS_TAB_KIND);
        expect(tab.title).toBe('Preview');
        expect(tab.resource).toEqual({
            kind: 'browser-view',
            browserSessionId: 'browser_surface:details:localServicePreview:session_1:preview_1',
            viewId: 'browser_view:preview_1',
            target,
        });
    });

    it('derives a stable key per target+session so reopening focuses the existing workspace tab', () => {
        const target = {
            kind: 'externalUrl',
            targetId: 'docs',
            url: 'https://docs.test/',
        } as const;
        const first = createBrowserViewDetailsTab({ target });
        const second = createBrowserViewDetailsTab({ target });
        expect(first.key).toBe(second.key);
    });

    it('honors an explicit browserSessionId / viewId override (scoped mounts)', () => {
        const target = {
            kind: 'externalUrl',
            targetId: 'docs',
            url: 'https://docs.test/',
        } as const;
        const tab = createBrowserViewDetailsTab({
            target,
            browserSessionId: 'scoped:session',
            viewId: 'scoped:view',
            scope: 'mobile',
        });
        expect(tab.resource).toMatchObject({
            kind: 'browser-view',
            browserSessionId: 'scoped:session',
            viewId: 'scoped:view',
        });
    });

    it('reads a single-view browser-view resource and rejects the launchpad resource', () => {
        const target = {
            kind: 'externalUrl',
            targetId: 'docs',
            url: 'https://docs.test/',
        } as const;
        const tab = createBrowserViewDetailsTab({ target });
        expect(readBrowserViewDetailsResource(tab.resource)).not.toBeNull();
        expect(readBrowserViewDetailsResource(createBrowserLaunchpadDetailsTab().resource)).toBeNull();
        expect(readBrowserViewDetailsResource({ kind: 'browser-view' })).toBeNull();
    });
});
