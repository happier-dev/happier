import { describe, expect, it } from 'vitest';

import {
    normalizeSessionListSurfaceOwnership,
    resolvePhoneRootSessionListSurfaceDataActive,
    resolveSessionListSurfaceOwnership,
    resolveSidebarSessionListSurfaceInteractive,
} from './sessionListSurfaceOwnership';

describe('sessionListSurfaceOwnership', () => {
    it('keeps only the matching visible owner interactive', () => {
        const phone = resolveSessionListSurfaceOwnership({
            ownerKey: 'phone-root',
            interactiveOwnerKey: 'phone-root',
            visible: true,
        });
        const sidebar = resolveSessionListSurfaceOwnership({
            ownerKey: 'sidebar',
            interactiveOwnerKey: 'phone-root',
            visible: true,
        });

        expect(phone).toMatchObject({
            ownerKey: 'phone-root',
            visible: true,
            interactive: true,
            dataActive: true,
        });
        expect(sidebar).toMatchObject({
            ownerKey: 'sidebar',
            visible: true,
            interactive: false,
            dataActive: true,
        });
    });

    it('keeps visible sidebar and Tauri surfaces data-active without interactive ownership', () => {
        expect(resolveSessionListSurfaceOwnership({
            ownerKey: 'sidebar',
            interactiveOwnerKey: 'phone-root',
            visible: true,
        })).toMatchObject({
            ownerKey: 'sidebar',
            visible: true,
            interactive: false,
            dataActive: true,
        });
        expect(resolveSessionListSurfaceOwnership({
            ownerKey: 'tauri-sidebar',
            interactiveOwnerKey: 'phone-root',
            visible: true,
        })).toMatchObject({
            ownerKey: 'tauri-sidebar',
            visible: true,
            interactive: false,
            dataActive: true,
        });
    });

    it('makes hidden retained phone surfaces inactive even when their owner key matches', () => {
        expect(resolveSessionListSurfaceOwnership({
            ownerKey: 'phone-root',
            interactiveOwnerKey: 'phone-root',
            visible: false,
        })).toMatchObject({
            ownerKey: 'phone-root',
            visible: false,
            interactive: false,
            dataActive: false,
        });
    });

    it('normalizes visible retained surfaces as non-interactive when their data is inactive', () => {
        expect(normalizeSessionListSurfaceOwnership({
            ownerKey: 'phone-root',
            visible: true,
            interactive: true,
            dataActive: false,
        })).toMatchObject({
            ownerKey: 'phone-root',
            visible: true,
            interactive: false,
            dataActive: false,
        });
    });

    it('keeps the phone list data-active under an overlay route, which leaves it visible behind', () => {
        const at = (routePathname: string, surfaceRoutePathname: string, isFocused: boolean) =>
            resolvePhoneRootSessionListSurfaceDataActive({ routePathname, surfaceRoutePathname, isFocused });

        expect(at('/', '/', true)).toBe(true);
        // The anchor decides whether this list is the surface at all.
        expect(at('/session/session-1', '/session/session-1', true)).toBe(false);
        // A blurred root is inactive — whatever sits above it owns the surface.
        expect(at('/', '/', false)).toBe(false);
        // ...but an overlay is the one blur that must NOT deactivate it: `/new` is a transparent
        // modal, so the list stays fully visible behind it, and deactivating remounts every visible
        // row. The anchor stays `/` while the overlay is open, which is exactly why the raw route
        // has to be consulted for the overlay test.
        expect(at('/new', '/', false)).toBe(true);
        expect(at('/zen/new', '/', false)).toBe(true);
        // An overlay above a session route still leaves the phone list off-surface.
        expect(at('/new', '/session/session-1', false)).toBe(false);
    });

    it('stops sidebar interaction under every overlay route, not just the new-session one', () => {
        expect(resolveSidebarSessionListSurfaceInteractive('/')).toBe(true);
        expect(resolveSidebarSessionListSurfaceInteractive('/session/session-1')).toBe(true);
        expect(resolveSidebarSessionListSurfaceInteractive('/new')).toBe(false);
        expect(resolveSidebarSessionListSurfaceInteractive('/new/pick/machine')).toBe(false);
        expect(resolveSidebarSessionListSurfaceInteractive('/direct/browse')).toBe(false);
        expect(resolveSidebarSessionListSurfaceInteractive('/zen/new')).toBe(false);
    });
});
