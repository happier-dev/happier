import { afterEach, describe, expect, it } from 'vitest';

import {
    clearPendingMobileSurfaceTransition,
    clearPendingMobileSurfaceTransitionForPathname,
    prepareMobileSurfaceTransition,
    resolveMobileSurfaceTransitionIntent,
    resolvePendingMobileSurfaceTransitionStackOptions,
} from './mobileSurfaceTransitionIntent';

describe('mobileSurfaceTransitionIntent', () => {
    afterEach(() => {
        clearPendingMobileSurfaceTransition();
    });

    it('animates main tabs from the visual left when moving from settings to inbox', () => {
        expect(resolveMobileSurfaceTransitionIntent({
            currentPathname: '/settings',
            targetHref: '/inbox',
            operation: 'replace',
        })).toEqual({
            animation: 'slide_from_left',
            animationTypeForReplace: 'pop',
            targetPathname: '/inbox',
            targetRouteName: 'inbox/index',
        });
    });

    it('animates main tabs from the visual right when moving from inbox to settings', () => {
        expect(resolveMobileSurfaceTransitionIntent({
            currentPathname: '/inbox',
            targetHref: '/settings',
            operation: 'replace',
        })).toMatchObject({
            animation: 'slide_from_right',
            animationTypeForReplace: 'push',
            targetRouteName: 'settings',
        });
    });

    it('animates session tabs according to the cockpit surface order', () => {
        expect(resolveMobileSurfaceTransitionIntent({
            currentPathname: '/session/s1/files',
            targetHref: '/session/s1/git?serverId=server-a',
            operation: 'replace',
        })).toMatchObject({
            animation: 'slide_from_right',
            animationTypeForReplace: 'push',
            targetRouteName: 'session/[id]/git',
        });

        expect(resolveMobileSurfaceTransitionIntent({
            currentPathname: '/session/s1/details?sourceSurface=browse',
            targetHref: '/session/s1/git?serverId=server-a',
            operation: 'replace',
        })).toMatchObject({
            animation: 'slide_from_left',
            animationTypeForReplace: 'pop',
            targetRouteName: 'session/[id]/git',
        });
    });

    it('treats file and commit normalization routes as the details cockpit surface', () => {
        expect(resolveMobileSurfaceTransitionIntent({
            currentPathname: '/session/s1',
            targetHref: '/session/s1/file?path=README.md',
            operation: 'push',
        })).toMatchObject({
            animation: 'slide_from_right',
            targetRouteName: 'session/[id]/file',
        });

        expect(resolveMobileSurfaceTransitionIntent({
            currentPathname: '/session/s1/git',
            targetHref: '/session/s1/commit?sha=abc1234',
            operation: 'push',
        })).toMatchObject({
            animation: 'slide_from_right',
            targetRouteName: 'session/[id]/commit',
        });
    });

    it('does not animate unrelated, same-surface, or cross-session navigation', () => {
        expect(resolveMobileSurfaceTransitionIntent({
            currentPathname: '/session/s1/files',
            targetHref: '/session/s2/git',
            operation: 'replace',
        })).toBeNull();

        expect(resolveMobileSurfaceTransitionIntent({
            currentPathname: '/session/s1/git',
            targetHref: '/session/s1/git?serverId=server-a',
            operation: 'replace',
        })).toBeNull();

        expect(resolveMobileSurfaceTransitionIntent({
            currentPathname: '/settings',
            targetHref: '/session/s1/git',
            operation: 'push',
        })).toBeNull();
    });

    it('stores pending stack options only for the intended route and expires stale intent', () => {
        const intent = prepareMobileSurfaceTransition({
            currentPathname: '/settings',
            targetHref: '/inbox',
            operation: 'replace',
            nowMs: 10,
        });

        expect(intent).not.toBeNull();
        expect(resolvePendingMobileSurfaceTransitionStackOptions({
            routeName: 'inbox/index',
            nowMs: 20,
        })).toEqual({
            animation: 'slide_from_left',
            animationTypeForReplace: 'pop',
        });
        expect(resolvePendingMobileSurfaceTransitionStackOptions({
            routeName: 'settings',
            nowMs: 20,
        })).toEqual({});
        expect(resolvePendingMobileSurfaceTransitionStackOptions({
            routeName: 'inbox/index',
            nowMs: 10_000,
        })).toEqual({});
    });

    it('clears the pending intent after the target pathname is reached', () => {
        prepareMobileSurfaceTransition({
            currentPathname: '/settings',
            targetHref: '/inbox',
            operation: 'replace',
            nowMs: 10,
        });

        clearPendingMobileSurfaceTransitionForPathname('/inbox?filter=unread', 20);

        expect(resolvePendingMobileSurfaceTransitionStackOptions({
            routeName: 'inbox/index',
            nowMs: 20,
        })).toEqual({});
    });
});
