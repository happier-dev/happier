import { describe, expect, it } from 'vitest';

import {
    normalizeSessionListSurfaceOwnership,
    resolveFocusedSessionListSurfaceOwnership,
} from './sessionListSurfaceOwnership';
import * as sessionListSurfaceOwnership from './sessionListSurfaceOwnership';

type ResolveSessionListSurfaceOwnership = (input: Readonly<{
    ownerKey: string;
    visible: boolean;
    interactiveOwnerKey?: string | null;
    dataActive?: boolean;
    interactive?: boolean;
}>) => unknown;

const exportsRecord = sessionListSurfaceOwnership as typeof sessionListSurfaceOwnership & Record<string, unknown>;

describe('sessionListSurfaceOwnership', () => {
    it('normalizes absent ownership as the visible default owner', () => {
        expect(normalizeSessionListSurfaceOwnership(undefined)).toEqual({
            ownerKey: 'default',
            visible: true,
            interactive: true,
            dataActive: true,
        });
    });

    it('keeps hidden surfaces inactive even when interaction is requested', () => {
        expect(normalizeSessionListSurfaceOwnership({
            ownerKey: 'phone-root',
            visible: false,
            interactive: true,
            dataActive: true,
        })).toEqual({
            ownerKey: 'phone-root',
            visible: false,
            interactive: false,
            dataActive: false,
        });
    });

    it('keeps visible retained surfaces painted when their data is inactive', () => {
        expect(normalizeSessionListSurfaceOwnership({
            ownerKey: 'phone-root',
            visible: true,
            interactive: true,
            dataActive: false,
        })).toEqual({
            ownerKey: 'phone-root',
            visible: true,
            interactive: false,
            dataActive: false,
        });
    });

    it('keeps only the matching visible owner interactive', () => {
        expect(exportsRecord.resolveSessionListSurfaceOwnership).toBeTypeOf('function');
        const resolveOwnership = exportsRecord.resolveSessionListSurfaceOwnership as ResolveSessionListSurfaceOwnership;

        expect(resolveOwnership({
            ownerKey: 'phone-root',
            interactiveOwnerKey: 'phone-root',
            visible: true,
        })).toEqual({
            ownerKey: 'phone-root',
            visible: true,
            interactive: true,
            dataActive: true,
        });
        expect(resolveOwnership({
            ownerKey: 'sidebar',
            interactiveOwnerKey: 'phone-root',
            visible: true,
        })).toEqual({
            ownerKey: 'sidebar',
            visible: true,
            interactive: false,
            dataActive: true,
        });
    });

    it('treats focused ownership as a visible default owner only while focused', () => {
        expect(resolveFocusedSessionListSurfaceOwnership(true)).toEqual({
            ownerKey: 'default',
            visible: true,
            interactive: true,
            dataActive: true,
        });
        expect(resolveFocusedSessionListSurfaceOwnership(false)).toEqual({
            ownerKey: 'default',
            visible: false,
            interactive: false,
            dataActive: false,
        });
    });

    it('treats only the root route as the data-active phone sessions surface', () => {
        expect(exportsRecord.resolvePhoneRootSessionListSurfaceDataActive).toBeTypeOf('function');
        const resolveDataActive = exportsRecord.resolvePhoneRootSessionListSurfaceDataActive as (pathname: string) => boolean;

        expect(resolveDataActive('/')).toBe(true);
        expect(resolveDataActive('/new')).toBe(false);
        expect(resolveDataActive('/session/session-1')).toBe(false);
    });

    it('keeps the sidebar interactive except while an overlay route covers it', () => {
        expect(exportsRecord.resolveSidebarSessionListSurfaceInteractive).toBeTypeOf('function');
        const resolveInteractive = exportsRecord.resolveSidebarSessionListSurfaceInteractive as (pathname: string) => boolean;

        expect(resolveInteractive('/')).toBe(true);
        expect(resolveInteractive('/session/session-1')).toBe(true);
        expect(resolveInteractive('/new')).toBe(false);
        expect(resolveInteractive('/new/pick/path')).toBe(false);
        expect(resolveInteractive('/new?mode=quick')).toBe(false);
        expect(resolveInteractive('/external/browse')).toBe(false);
        expect(resolveInteractive('/direct/browse')).toBe(false);
        expect(resolveInteractive('/zen/new')).toBe(false);
    });
});
