import { describe, expect, it } from 'vitest';

import { resolveRightSidebarMobileProjection } from '@/components/appShell/rightSidebar/rightSidebarMobileProjection';
import { resolveRightSidebarTabs } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import { LOCAL_SETTING_DEFINITIONS } from './localSettingDefinitions';

/**
 * Surfaces that exist without a right-sidebar tab behind them, so the registry projection
 * cannot produce them.
 */
const NON_TAB_SESSION_SURFACES = ['chat', 'tabs'] as const;

function declaredSessionMobileSurfaces(): readonly string[] {
    return resolveRightSidebarMobileProjection({
        scope: 'session',
        tabs: resolveRightSidebarTabs({
            scope: 'session',
            presentation: 'mobile',
            terminalTabAvailable: true,
        }),
    }).map((entry) => entry.surface);
}

describe('LOCAL_SETTING_DEFINITIONS mobile surfaces', () => {
    it('persists every session mobile surface the right-sidebar registry declares', () => {
        const schema = LOCAL_SETTING_DEFINITIONS.sessionLastMobileSurfaceBySessionId.schema;
        const surfaces = [...NON_TAB_SESSION_SURFACES, ...declaredSessionMobileSurfaces()];

        expect(surfaces).toContain('navigation');
        for (const surface of surfaces) {
            expect(
                { surface, accepted: schema.safeParse({ 'session-1': surface }).success },
            ).toEqual({ surface, accepted: true });
        }
    });

    it('still rejects an unknown persisted session surface so a stale value falls back to chat', () => {
        const schema = LOCAL_SETTING_DEFINITIONS.sessionLastMobileSurfaceBySessionId.schema;

        expect(schema.safeParse({ 'session-1': 'browser-preview' }).success).toBe(false);
        expect(schema.safeParse({ 'session-1': 'agents' }).success).toBe(false);
    });
});
