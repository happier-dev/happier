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

    it('treats only the phone root route as the data-active phone sessions surface', () => {
        expect(resolvePhoneRootSessionListSurfaceDataActive('/')).toBe(true);
        expect(resolvePhoneRootSessionListSurfaceDataActive('/session/session-1')).toBe(false);
        expect(resolvePhoneRootSessionListSurfaceDataActive('/new')).toBe(false);
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
