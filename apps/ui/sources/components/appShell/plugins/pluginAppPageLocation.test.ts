import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginUiHostApiRequestEnvelopeV1Schema } from '@happier-dev/protocol/plugins/ui';
import { createWorkspaceBrowserTransport } from '../workspace/workspaceBrowserTransport';
import { createWorkspaceNavigationAdapter } from '../workspace/workspaceNavigationAdapter';
import { createWorkspaceState, reduceWorkspaceState } from '../workspace/workspaceState';
import { resolveCompactAppDestinations, type CompactAppDestination } from '../destinations/compactAppDestinationCatalog';
import { buildPluginAppPageRoutePath } from '@/components/plugins/pages/pluginPageRoute';
import { trackBrowserHistoryNavigation } from '@/utils/navigation/browserHistoryNavigation';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';

import {
    createPluginPageLocationOwner,
    type PluginPageLocationOwner,
} from '@/components/plugins/pages/pluginPageLocation';

/**
 * Page-location normalization, detail history and mount lifetime. The composed
 * workspace transport tests exercise real Back/Forward on web and native.
 */

const PAGE_ROUTE = '/plugins/acme.notes/notes';

function request(payload: unknown) {
    return PluginUiHostApiRequestEnvelopeV1Schema.parse({
        version: 1,
        requestId: 'page-location',
        surface: { pluginId: 'acme.notes', contributionId: 'notes', surfaceId: 'notes-page',
            placement: 'appSurface', platform: 'web', channel: 'internal' },
        method: 'replacePageLocation',
        payload,
    });
}

installPanelCommonModuleMocks();
// Browser navigation never renders Markdown; fail on use of this vendor/native SDK boundary.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected vendor Markdown reveal in workspace browser test'); },
}));
// Recipient-envelope HTTP/process APIs are outside this deterministic browser owner harness.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unavailable = () => { throw new Error('Unexpected recipient-envelope API in workspace browser test'); };
    return { createSessionDataKeyEnvelopeClient: unavailable, readSessionDataKeyEnvelopeCollectionPage: unavailable,
        prepareSessionDataKeyEnvelopesForScope: unavailable, prepareSessionDataKeyEnvelopesDetached: unavailable };
});

describe('plugin page detail history through the workspace transport', () => {
    it.each(['browser', 'native'] as const)('restores a plugin detail with Forward after ordinary Back (%s)', async platform => {
        const page = '/plugins/happier.triage/triage';
        const list = 'q,review';
        const detail = `${list}/e,change,8`;
        const route = (subPath: string) => buildPluginAppPageRoutePath({ pluginId: 'happier.triage', localId: 'triage', subPath });
        const catalog: readonly CompactAppDestination[] = [
            ...resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: false, workflows: false, friends: false }, pages: [] }),
            { kind: 'plugin', container: 'appPage', id: 'plugin:happier.triage:triage', title: 'PRs & Issues',
                icon: 'list', order: 40, placement: { kind: 'rail', region: 'plugins' }, activation: 'navigate',
                routePath: page, destination: { pluginId: 'happier.triage', localId: 'triage' },
                availability: 'available' },
        ];
        let layout = createWorkspaceState({ id: 'A', target: { kind: 'session', params: { id: 'A1' } }, pinned: false, preview: false });
        const entries: Array<{ state: unknown; href: string }> = [{ state: { id: 'initial' }, href: '/session/A1' }];
        let position = 0;
        let id = 0;
        let nativeHref = '/session/A1';
        const href = () => platform === 'browser' ? entries[position].href : nativeHref;
        const browser = {
            get state() { return entries[position].state; },
            pushState(state: unknown, _title: string, url?: string | URL | null) {
                entries.splice(position + 1);
                entries.push({ state, href: String(url) });
                position++;
            },
            replaceState(state: unknown, _title: string, url?: string | URL | null) {
                entries[position] = { state, href: url ? String(url) : entries[position].href };
            },
            go(delta: number) {
                if (position + delta < 0 || position + delta >= entries.length) return;
                position += delta;
                browserTransport.acceptPopState(browser.state);
            },
        };
        const stopTracking = trackBrowserHistoryNavigation(browser, () => {});
        const browserTransport = createWorkspaceBrowserTransport({
            history: browser, getHref: href, createId: () => `browser:${++id}`,
            mirror: next => browser.replaceState({ id: (browser.state as { id: string }).id }, '', next),
            accept: (next, entry, index) => adapter.acceptUrl(next, entry, index),
        });
        const adapter = createWorkspaceNavigationAdapter({
            getCatalog: () => catalog, getState: () => layout,
            dispatch: action => { layout = reduceWorkspaceState(layout, action); },
            transport: platform === 'browser' ? browserTransport : { commit: next => { nativeHref = next; } },
            createId: () => `tab:${++id}`, onChange: () => {},
        });
        const owner = createPluginPageLocationOwner({
            currentSubPath: () => href().slice(page.length + 1).split('/').map(decodeURIComponent).join('/'),
            routePathFor: route,
            replaceLocation: next => { adapter.openHref(next, { replace: true }); },
            pushLocation: (next: string) => { adapter.openHref(next); },
            isCurrent: () => true,
        });
        try {
            adapter.initialize('/session/A1');
            adapter.openHref(route(list));
            const select = (subPath: string) => owner.handleReplaceRequest(PluginUiHostApiRequestEnvelopeV1Schema.parse({
                version: 1, requestId: `select:${subPath}`, method: 'replacePageLocation',
                surface: { pluginId: 'happier.triage', contributionId: 'triage', surfaceId: 'triage-page',
                    placement: 'appSurface', platform: platform === 'browser' ? 'web' : 'ios', channel: 'internal' },
                payload: { subPath, backLocation: list, view: 'triage' },
            }));
            await select(`${list}/e,change,7`);
            await select(detail);
            expect(href()).toBe(route(detail));
            adapter.step(-1);
            expect(href()).toBe(route(list));
            owner.retireForeignLocationChange(list);
            expect(adapter.canGoForward).toBe(true);
            adapter.step(1);
            expect(href()).toBe(route(detail));
            owner.retireForeignLocationChange(detail);
            await select(`${list}/e,change,7`);
            expect(href()).toBe(route(`${list}/e,change,7`));
            await select(detail);
            expect(adapter.history.entries).toHaveLength(3);
        } finally { owner.dispose(); stopTracking(); }
    });
});

describe('plugin app page location owner', () => {
    let replaced: string[];
    let pushed: string[];
    let current: string | null;
    let mounted: boolean;
    let owner: PluginPageLocationOwner;

    beforeEach(() => {
        replaced = [];
        pushed = [];
        current = '';
        mounted = true;
        owner = createPluginPageLocationOwner({
            currentSubPath: () => current,
            routePathFor: (subPath) => (subPath === '' ? PAGE_ROUTE : `${PAGE_ROUTE}/${subPath}`),
            // The real router does NOT settle the screen synchronously: the
            // location the page renders arrives on a later React render.
            replaceLocation: (routePath) => { replaced.push(routePath); },
            pushLocation: routePath => { pushed.push(routePath); },
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
            pushLocation: route => { pushed.push(route); },
            isCurrent: () => mounted, beforeReplace: () => false, allowPreservingReplacement: true });
        owner.handleReplaceRequest(request({ subPath: 'entries/7', backLocation: 'entries' }));
        expect(await owner.handleReplaceRequest(request({ subPath: 'entries/7/page', backLocation: 'entries/7', preserveUnsavedChanges: true })))
            .toEqual({ subPath: 'entries/7/page' });
        expect(owner.hasPreservingBackStep()).toBe(true);
        expect(await owner.handleReplaceRequest(request({ subPath: 'entries/7', preserveUnsavedChanges: true })))
            .toEqual({ subPath: 'entries/7' });
        expect(owner.hasPreservingBackStep()).toBe(false);
        expect(await owner.handleReplaceRequest(request({ subPath: 'entries/8' }))).toEqual({ subPath: 'entries/7' });
        expect(pushed).toEqual([`${PAGE_ROUTE}/entries/7/page`]);
        expect(replaced).toEqual([`${PAGE_ROUTE}/entries/7`]);
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

    it('replaces filters without adding a detail history entry', () => {
        owner.handleReplaceRequest(request({ subPath: 'entries', backLocation: 'entries' }));
        expect(owner.hasBackStep()).toBe(false);
        expect(pushed).toEqual([]);
        expect(replaced).toEqual([`${PAGE_ROUTE}/entries`]);
    });

    it('retires a declared step when the location changed for a reason the page did not produce', () => {
        owner.handleReplaceRequest(request({ subPath: 'entries/7', backLocation: 'entries' }));
        // The user pushed, deep-linked or walked history: this location was not
        // the one the step was declared for.
        settle('archive/3');
        expect(owner.hasBackStep()).toBe(false);

        // …while the owner's OWN settled location keeps the step armed.
        owner.handleReplaceRequest(request({ subPath: 'entries/9', backLocation: 'entries' }));
        settle('entries/9');
        expect(owner.hasBackStep()).toBe(true);
    });

    it('keeps the step armed when the router reports the settled location percent-decoded', () => {
        // The route writes a segment's escapes and the router later hands the
        // same segment back decoded (`%3A` arrives as `:`). That is the same
        // location, not a foreign one: retiring it left the system Back leaving
        // the page while the detail it should have closed stayed open.
        owner.handleReplaceRequest(request({ subPath: 'entries/gh%3A7,7', backLocation: 'entries' }));
        settle('entries/gh%3A7,7');
        settle('entries/gh:7,7');
        expect(owner.hasBackStep()).toBe(true);
    });

    it('tells chrome when a detail has been opened or left through history', () => {
        const seen: boolean[] = [];
        const unsubscribe = owner.subscribe(() => { seen.push(owner.hasBackStep()); });
        expect(owner.hasBackStep()).toBe(false);

        owner.handleReplaceRequest(request({ subPath: 'entries/7', backLocation: 'entries' }));
        expect(owner.hasBackStep()).toBe(true);
        settle('entries');
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
            pushLocation: routePath => { routed.push(routePath); },
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
            pushLocation: () => {},
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
        expect(owner.hasBackStep()).toBe(false);
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
        expect(owner.hasBackStep()).toBe(false);
    });

    it('refuses to replace a location that is not a live page location', () => {
        current = null;
        expect(owner.handleReplaceRequest(request({ subPath: 'a' })))
            .toMatchObject({ code: 'unavailable' });
        expect(replaced).toEqual([]);
    });
});
