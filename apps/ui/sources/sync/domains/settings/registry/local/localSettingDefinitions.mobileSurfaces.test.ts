import { describe, expect, it } from 'vitest';

import { resolveRightSidebarMobileProjection } from '@/components/appShell/rightSidebar/rightSidebarMobileProjection';
import { resolveRightSidebarTabs } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import { LOCAL_SETTING_DEFINITIONS } from './localSettingDefinitions';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';

/**
 * Surfaces that exist without a right-sidebar tab behind them, so the registry projection
 * cannot produce them.
 */
const NON_TAB_SESSION_SURFACES = ['chat', 'tabs', 'companion'] as const;

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
    it('stores shared placements with tolerant reads while preserving all known surface preferences', () => {
        const stored = localSettingsParse({ navigationSurfacePlacementsV1: { appRail: { orderedIds: ['plugin:removed'], placements: { 'plugin:removed': 'hidden' }, future: true }, futureSurface: {} } });
        expect(stored.navigationSurfacePlacementsV1).toEqual({ appRail: { orderedIds: ['plugin:removed'], placements: { 'plugin:removed': 'hidden' } } });
    });
    it('persists every session mobile surface the right-sidebar registry declares', () => {
        const schema = LOCAL_SETTING_DEFINITIONS.sessionLastMobileSurfaceBySessionId.schema;
        const surfaces = [...NON_TAB_SESSION_SURFACES, ...declaredSessionMobileSurfaces()];

        expect(surfaces).toContain('navigation');
        expect(surfaces).toContain('companion');
        expect(surfaces).toContain('agents');
        for (const surface of surfaces) {
            expect(
                { surface, accepted: schema.safeParse({ 'session-1': surface }).success },
            ).toEqual({ surface, accepted: true });
        }
    });

    it('still rejects an unknown persisted session surface so a stale value falls back to chat', () => {
        const schema = LOCAL_SETTING_DEFINITIONS.sessionLastMobileSurfaceBySessionId.schema;

        expect(schema.safeParse({ 'session-1': 'browser-preview' }).success).toBe(false);
    });

    it('keeps the cockpit bar as qualified non-empty ids with no count cap, and null until changed', () => {
        const schema = LOCAL_SETTING_DEFINITIONS.sessionCockpitBarSurfaceIds.schema;

        expect(schema.safeParse(['plugin:acme.one:panel', 'browser', 'services', 'git', 'terminal']).success).toBe(true);
        expect(schema.parse(null)).toBeNull();
        expect(schema.parse([''])).toBeNull();
    });

    it('persists bounded compact destination order and visibility independently of route state', () => {
        const definitions = LOCAL_SETTING_DEFINITIONS as unknown as Record<string, {
            schema?: Readonly<{ safeParse: (value: unknown) => Readonly<{ success: boolean }> }>;
        }>;
        const schema = definitions.compactAppDestinationPreferencesV1?.schema;

        expect(schema?.safeParse({
            orderedDestinationIds: ['plugin:acme.notes:notes'],
            hiddenDestinationIds: ['rightSidebarTab:plugin:acme.review:review'],
        }).success).toBe(true);
        expect(schema?.safeParse({
            orderedDestinationIds: [''],
            hiddenDestinationIds: [],
        }).success).toBe(false);
        expect(schema?.safeParse({
            orderedDestinationIds: Array.from({ length: 129 }, (_unused, index) => `plugin:acme:${index}`),
            hiddenDestinationIds: [],
        }).success).toBe(false);
    });
});
