import { beforeEach, describe, expect, it } from 'vitest';

import type { PluginUiHostApiRequestEnvelopeV1 } from '@happier-dev/protocol/plugins/ui';

import {
    createPluginAppPageLocationOwner,
    type PluginAppPageLocationOwner,
} from './pluginAppPageLocation';

/**
 * `NAV-2`/`NAV-3` at the app-page navigation owner: same-page location
 * replacement, and the single page-internal Back step it may declare.
 *
 * The interesting cases are all the ones where a wrong implementation is
 * SILENT: a Back that consumes a press and changes nothing, a Back step that
 * survives a navigation it was not declared for, and a replacement that pushes.
 */

const PAGE_ROUTE = '/plugins/acme.notes/notes';

function request(payload: unknown): PluginUiHostApiRequestEnvelopeV1 {
    return {
        v: 1,
        method: 'replacePageLocation',
        payload,
    } as unknown as PluginUiHostApiRequestEnvelopeV1;
}

describe('plugin app page location owner', () => {
    let replaced: string[];
    let current: string | null;
    let mounted: boolean;
    let owner: PluginAppPageLocationOwner;

    beforeEach(() => {
        replaced = [];
        current = '';
        mounted = true;
        owner = createPluginAppPageLocationOwner({
            currentSubPath: () => current,
            routePathFor: (subPath) => (subPath === '' ? PAGE_ROUTE : `${PAGE_ROUTE}/${subPath}`),
            // The real router does NOT settle the screen synchronously: the
            // location the page renders arrives on a later React render. Two
            // Back presses inside that window are the exact case a
            // "still armed" participant gets wrong, so the fixture keeps the
            // gap rather than closing it.
            replaceLocation: (routePath) => { replaced.push(routePath); },
            isCurrent: () => mounted,
        });
    });

    /** What the screen does when the router's new location reaches it. */
    function settle(subPath: string): void {
        current = subPath;
        owner.retireForeignLocationChange(subPath);
    }

    it('replaces the current location and settles on the canonical one', () => {
        expect(owner.handleReplaceRequest(request({ subPath: '/entries//7/' })))
            .toEqual({ subPath: 'entries/7' });
        expect(replaced).toEqual([`${PAGE_ROUTE}/entries/7`]);

        // A replacement to the location already shown is a state change, not a
        // navigation: it settles without touching history at all.
        settle('entries/7');
        replaced = [];
        expect(owner.handleReplaceRequest(request({ subPath: 'entries/7' })))
            .toEqual({ subPath: 'entries/7' });
        expect(replaced).toEqual([]);
    });

    it('refuses a location outside the page namespace before it can become a route', () => {
        expect(owner.handleReplaceRequest(request({ subPath: '../../settings' })))
            .toMatchObject({ code: 'invalid_payload' });
        expect(owner.handleReplaceRequest(request({ subPath: 'a', backLocation: '../..' })))
            .toMatchObject({ code: 'invalid_payload' });
        expect(owner.handleReplaceRequest(request({ subPath: 'a', push: true })))
            .toMatchObject({ code: 'invalid_payload' });
        expect(replaced).toEqual([]);
    });

    it('consumes exactly one Back with the declared step and then yields', () => {
        owner.handleReplaceRequest(request({ subPath: 'entries/7', backLocation: 'entries' }));
        replaced = [];

        expect(owner.consumeBack()).toBe(true);
        expect(replaced).toEqual([`${PAGE_ROUTE}/entries`]);

        // A second press BEFORE the first replacement has reached the screen is
        // the rapid-navigation case. A participant that stayed armed would fire
        // twice here and trap the user on the page; the step is spent.
        expect(owner.consumeBack()).toBe(false);
        expect(replaced).toEqual([`${PAGE_ROUTE}/entries`]);

        // …and it is still spent once the location does arrive.
        settle('entries');
        expect(owner.consumeBack()).toBe(false);
        expect(replaced).toEqual([`${PAGE_ROUTE}/entries`]);
    });

    it('yields rather than consuming a press that would visibly do nothing', () => {
        // Declaring the location you are replacing TO is the shape a page
        // reaches when it clears its own detail: the step is already where the
        // user is. Consuming here would be a Back that changes nothing.
        owner.handleReplaceRequest(request({ subPath: 'entries', backLocation: 'entries' }));
        expect(owner.consumeBack()).toBe(false);
        expect(replaced).toEqual([`${PAGE_ROUTE}/entries`]);
    });

    it('retires a declared step when the location changed for a reason the page did not produce', () => {
        owner.handleReplaceRequest(request({ subPath: 'entries/7', backLocation: 'entries' }));
        // The user pushed, deep-linked or walked history: this location was not
        // the one the step was declared for.
        settle('archive/3');
        expect(owner.consumeBack()).toBe(false);

        // …while the owner's OWN settled location keeps the step armed.
        owner.handleReplaceRequest(request({ subPath: 'entries/9', backLocation: 'entries' }));
        settle('entries/9');
        expect(owner.consumeBack()).toBe(true);
        expect(replaced.at(-1)).toBe(`${PAGE_ROUTE}/entries`);
    });

    it('refuses to write the route once the mount is no longer current', () => {
        owner.handleReplaceRequest(request({ subPath: 'entries/7', backLocation: 'entries' }));
        replaced = [];
        mounted = false;

        expect(owner.handleReplaceRequest(request({ subPath: 'entries/8' })))
            .toMatchObject({ code: 'stale_surface' });
        expect(owner.consumeBack()).toBe(false);
        expect(replaced).toEqual([]);
    });

    it('refuses a withdrawn request and a disposed mount', () => {
        const withdrawn = new AbortController();
        withdrawn.abort();
        expect(owner.handleReplaceRequest(request({ subPath: 'a' }), { signal: withdrawn.signal }))
            .toMatchObject({ code: 'unavailable' });

        owner.handleReplaceRequest(request({ subPath: 'entries/7', backLocation: 'entries' }));
        owner.dispose();
        expect(owner.handleReplaceRequest(request({ subPath: 'b' })))
            .toMatchObject({ code: 'stale_surface' });
        expect(owner.consumeBack()).toBe(false);
    });

    it('refuses to replace a location that is not a live page location', () => {
        current = null;
        expect(owner.handleReplaceRequest(request({ subPath: 'a' })))
            .toMatchObject({ code: 'unavailable' });
        expect(replaced).toEqual([]);
    });
});
