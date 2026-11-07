import { beforeEach, describe, expect, it } from 'vitest';

import type { PluginUiHostApiRequestEnvelopeV1 } from '@happier-dev/protocol/plugins/ui';

import {
    createPluginPageLocationOwner,
    type PluginPageLocationOwner,
} from '@/components/plugins/pages/pluginPageLocation';

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
    let owner: PluginPageLocationOwner;

    beforeEach(() => {
        replaced = [];
        current = '';
        mounted = true;
        owner = createPluginPageLocationOwner({
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

    it('keeps a continuing editor protected when its layout and its Back step preserve unsaved changes', async () => {
        current = 'entries/7';
        owner = createPluginPageLocationOwner({ currentSubPath: () => current,
            routePathFor: subPath => `${PAGE_ROUTE}/${subPath}`, replaceLocation: route => { replaced.push(route); },
            isCurrent: () => mounted, beforeReplace: () => false, allowPreservingReplacement: true });
        expect(await owner.handleReplaceRequest(request({ subPath: 'entries/7/page', backLocation: 'entries/7', preserveUnsavedChanges: true })))
            .toEqual({ subPath: 'entries/7/page' });
        expect(owner.hasPreservingBackStep()).toBe(true);
        expect(owner.consumeBack()).toBe(true);
        expect(owner.hasPreservingBackStep()).toBe(false);
        expect(await owner.handleReplaceRequest(request({ subPath: 'entries/8' }))).toEqual({ subPath: 'entries/7' });
        expect(replaced).toEqual([`${PAGE_ROUTE}/entries/7/page`, `${PAGE_ROUTE}/entries/7`]);
    });

    it('refuses preservation when the physical host replaces its document', async () => {
        expect(await owner.handleReplaceRequest(request({ subPath: 'entries/7/page', backLocation: 'entries/7', preserveUnsavedChanges: true })))
            .toMatchObject({ code: 'unavailable' });
        expect(owner.hasBackStep()).toBe(false);
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

    it('keeps the step armed when the router reports the settled location percent-decoded', () => {
        // The route writes a segment's escapes and the router later hands the
        // same segment back decoded (`%3A` arrives as `:`). That is the same
        // location, not a foreign one: retiring it left the system Back leaving
        // the page while the detail it should have closed stayed open.
        owner.handleReplaceRequest(request({ subPath: 'entries/gh%3A7,7', backLocation: 'entries' }));
        settle('entries/gh%3A7,7');
        settle('entries/gh:7,7');
        expect(owner.consumeBack()).toBe(true);
        expect(replaced.at(-1)).toBe(`${PAGE_ROUTE}/entries`);
    });

    it('says whether a Back would spend a step, and tells the chrome when that changes', () => {
        const seen: boolean[] = [];
        const unsubscribe = owner.subscribe(() => { seen.push(owner.hasBackStep()); });
        expect(owner.hasBackStep()).toBe(false);

        owner.handleReplaceRequest(request({ subPath: 'entries/7', backLocation: 'entries' }));
        expect(owner.hasBackStep()).toBe(true);
        expect(owner.consumeBack()).toBe(true);
        // The step is spent: the chrome's Back leaves the page again.
        expect(owner.hasBackStep()).toBe(false);
        expect(seen).toEqual([true, false]);

        unsubscribe();
        owner.handleReplaceRequest(request({ subPath: 'entries/9', backLocation: 'entries' }));
        expect(seen).toEqual([true, false]);
    });

    it('names the declared view a replacement presents until a location the page did not produce', () => {
        // One page, two declared views a lens apart: the chrome titles the one on screen, not the mounted page.
        const seen: (string | null)[] = [];
        const unsubscribe = owner.subscribe(() => { seen.push(owner.selectedView()); });
        expect(owner.selectedView()).toBeNull();

        owner.handleReplaceRequest(request({ subPath: 'tasks,mine', view: 'tasks' }));
        settle('tasks,mine');
        expect(owner.selectedView()).toBe('tasks');

        // A replacement that names no view presents the mounted page again.
        owner.handleReplaceRequest(request({ subPath: '' }));
        expect(owner.selectedView()).toBeNull();

        owner.handleReplaceRequest(request({ subPath: 'tasks,agents', view: 'tasks' }));
        settle('tasks,agents');
        // A deep link or history walk lands on a location this owner did not settle: its view is unknown.
        settle('archive/3');
        expect(owner.selectedView()).toBeNull();
        expect(seen).toEqual(['tasks', null, 'tasks', null]);
        unsubscribe();
    });

    it('carries the presented view in the route, so a cold load of that route names it from its first frame', () => {
        const routed: string[] = [];
        const viewOwner = createPluginPageLocationOwner({
            currentSubPath: () => current,
            routePathFor: (subPath, view) => `${PAGE_ROUTE}/${subPath}${view ? `?view=${view}` : ''}`,
            replaceLocation: (routePath) => { routed.push(routePath); },
            isCurrent: () => mounted,
        });
        viewOwner.handleReplaceRequest(request({ subPath: 'tasks,mine', view: 'tasks' }));
        // The same location in another view still rewrites the route: the view is part of where the reader is.
        current = 'tasks,mine';
        viewOwner.handleReplaceRequest(request({ subPath: 'tasks,mine' }));
        expect(routed).toEqual([`${PAGE_ROUTE}/tasks,mine?view=tasks`, `${PAGE_ROUTE}/tasks,mine`]);

        // A fresh mount on a route that names its view presents it before the page settles anything.
        const cold = createPluginPageLocationOwner({
            currentSubPath: () => 'tasks,mine',
            initialView: 'tasks',
            routePathFor: (subPath) => `${PAGE_ROUTE}/${subPath}`,
            replaceLocation: () => {},
            isCurrent: () => mounted,
        });
        expect(cold.selectedView()).toBe('tasks');
        cold.retireForeignLocationChange('tasks,mine');
        expect(cold.selectedView()).toBe('tasks');
        cold.retireForeignLocationChange('archive/3');
        expect(cold.selectedView()).toBeNull();
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
