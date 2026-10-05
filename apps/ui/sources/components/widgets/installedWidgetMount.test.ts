import { describe, expect, it } from 'vitest';

import type { PluginProjectionV2 } from '@happier-dev/protocol';
import { normalizePluginUiInlineSurfaceBindingV1 } from '@happier-dev/protocol/plugins/ui';

import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';

import { widgetInstalledPackage, widgetProjectionOf } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { WIDGET_ROLE } from '@/sync/domains/plugins/ui/widgetContract';

import {
    resolveInstalledWidgetMount,
    type InstalledWidgetSource,
} from './installedWidgetMount';

function inlineEntry(input: Readonly<{
    pluginId: string;
    localId: string;
    role: typeof WIDGET_ROLE | 'sessionSubagentDetails';
    entryId?: string;
}>) {
    const binding = normalizePluginUiInlineSurfaceBindingV1({
        pluginId: input.pluginId,
        surfaceId: input.localId,
        rendererId: 'review-native',
        role: input.role,
        target: { kind: 'session' },
    });
    if (!binding) throw new Error('fixture must use an admitted inline binding');
    return {
        id: input.entryId ?? `surfacePlacement:${input.pluginId}:${input.localId}`,
        pluginId: input.pluginId,
        contributionKind: 'surfacePlacement',
        descriptorId: input.localId,
        // The daemon producer stamps every projected UI entry with its exact plugin-slot
        // occurrence; a fixture without one is not a projection the product can produce.
        occurrenceId: `${input.pluginId}#1`,
        binding,
        target: binding.target,
        renderer: { kind: 'declarative', contributionId: 'review-native' },
        display: { title: input.localId },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
    };
}

function projectionOf(entries: readonly ReturnType<typeof inlineEntry>[]) {
    return normalizePluginUiProjection({
        v: 2,
        generation: 1,
        installedPackagesById: {},
        actionsById: {},
        familiesById: {
            pluginUi: {
                entriesById: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
            },
        },
    } as unknown as PluginProjectionV2);
}

function runtime(input: Partial<SessionPluginRuntimeState>): SessionPluginRuntimeState {
    return {
        pluginUiProjection: null,
        pluginBrowserProjection: null,
        phase: 'current',
        interactionEnabled: true,
        machineId: 'machine-a',
        serverId: 'home-a',
        platform: 'web',
        ...input,
    } as SessionPluginRuntimeState;
}

const source: InstalledWidgetSource = {
    kind: 'installedSurface',
    surface: { pluginId: 'acme.review', localId: 'review-status-widget' },
};

describe('installed widget correlation', () => {
    it('resolves a widget only for the target it was made for', () => {
        const projection = widgetProjectionOf(
            [{ pluginId: 'acme.review', localId: 'latest', target: 'app' }],
            { 'acme.review': widgetInstalledPackage('acme.review', 'Review Assistant') },
        );
        const latest: InstalledWidgetSource = { kind: 'installedSurface', surface: { pluginId: 'acme.review', localId: 'latest' } };
        expect(resolveInstalledWidgetMount({
            source: latest,
            target: 'app',
            presentation: 'content',
            runtime: runtime({ pluginUiProjection: projection }),
        }).placement?.descriptorId).toBe('latest');
        expect(resolveInstalledWidgetMount({
            source: latest,
            target: 'session',
            presentation: 'content',
            runtime: runtime({ pluginUiProjection: projection }),
        }).unresolved?.reasonCode).toBe('widget_surface_absent');
    });

    it('resolves exactly one admitted placement and the Registry role/presentation pair', () => {
        const resolved = resolveInstalledWidgetMount({
            source,
            target: 'session',
            presentation: 'fill',
            runtime: runtime({
                pluginUiProjection: projectionOf([
                    inlineEntry({ pluginId: 'acme.review', localId: 'review-status-widget', role: WIDGET_ROLE }),
                    inlineEntry({ pluginId: 'acme.ci', localId: 'build-health', role: WIDGET_ROLE }),
                ]),
            }),
        });
        expect(resolved.unresolved).toBeNull();
        expect(resolved.placement?.descriptorId).toBe('review-status-widget');
        expect(resolved.inlineMount).toEqual({ role: WIDGET_ROLE, presentation: 'fill' });
    });

    it('never turns another role with the same local id into a widget', () => {
        const resolved = resolveInstalledWidgetMount({
            source,
            target: 'session',
            presentation: 'content',
            runtime: runtime({
                pluginUiProjection: projectionOf([
                    inlineEntry({ pluginId: 'acme.review', localId: 'review-status-widget', role: 'sessionSubagentDetails' }),
                ]),
            }),
        });
        expect(resolved.placement).toBeNull();
        expect(resolved.unresolved?.state).toBe('unavailable');
        expect(resolved.unresolved?.reasonCode).toBe('widget_surface_absent');
    });

    it('fails closed on a duplicate qualified identity instead of taking the first match', () => {
        const resolved = resolveInstalledWidgetMount({
            source,
            target: 'session',
            presentation: 'content',
            runtime: runtime({
                pluginUiProjection: projectionOf([
                    inlineEntry({ pluginId: 'acme.review', localId: 'review-status-widget', role: WIDGET_ROLE }),
                    inlineEntry({
                        pluginId: 'acme.review',
                        localId: 'review-status-widget',
                        role: WIDGET_ROLE,
                        entryId: 'surfacePlacement:acme.review:review-status-widget-duplicate',
                    }),
                ]),
            }),
        });
        expect(resolved.placement).toBeNull();
        expect(resolved.unresolved?.reasonCode).toBe('widget_surface_ambiguous');
    });

    it('presents an establishing projection as loading, not as a removed surface', () => {
        expect(resolveInstalledWidgetMount({
            source,
            target: 'session',
            presentation: 'content',
            runtime: runtime({ pluginUiProjection: null, phase: 'establishing' }),
        }).unresolved).toEqual({ state: 'loading', reasonCode: 'widget_projection_establishing' });
        expect(resolveInstalledWidgetMount({
            source,
            target: 'session',
            presentation: 'content',
            runtime: runtime({ pluginUiProjection: null, phase: 'unavailable' }),
        }).unresolved?.state).toBe('unavailable');
    });

    // In-place source-identity substitution is rejected by the ONE owner of that
    // rule, `isSessionSurfaceItemSourceCompatible`, and proved at the Board
    // mutation paths that consume it: `packages/protocol/src/sessions/board/item.test.ts`,
    // `apps/ui/sources/sync/api/session/sessionBoardActions.test.ts` and
    // `apps/cli/src/session/board/sessionBoardActionDeps.test.ts` all pin
    // `session_board_source_conflict`. Restating it here would only pin a second copy.
});
