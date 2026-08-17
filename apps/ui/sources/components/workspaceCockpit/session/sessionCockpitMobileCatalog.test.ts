import { describe, expect, it } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';

import {
    resolveSessionCockpitMobileCatalog,
    resolveSessionCockpitMobileTabVisibility,
} from './sessionCockpitMobileCatalog';

function createMobilePluginPlacement(input: Readonly<{
    pluginId: string;
    destinationId: string;
    label: string;
    platforms?: readonly ('ios' | 'android' | 'desktop' | 'web')[];
}>): PluginUiSurfacePlacementProjection {
    const normalizedBinding = normalizePluginUiDestinationBindingV1({
        pluginId: input.pluginId,
        destinationId: input.destinationId,
        rendererId: `${input.destinationId}-panel`,
        container: 'rightSidebarTab',
        target: { kind: 'session', sessionIdPath: '/session/id' },
    });
    if (!normalizedBinding) {
        throw new Error('fixture must produce an admitted V2 session right-sidebar binding');
    }
    const binding = {
        ...normalizedBinding,
        ...(input.platforms === undefined ? {} : { platforms: input.platforms }),
    };

    return {
        id: `surfacePlacement:${input.pluginId}:${input.destinationId}`,
        pluginId: input.pluginId,
        contributionKind: 'surfacePlacement',
        descriptorId: input.destinationId,
        binding,
        target: binding.target,
        renderer: { kind: 'host', rendererId: `${input.destinationId}-panel` },
        display: { developerFallback: input.label },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
    } satisfies PluginUiSurfacePlacementProjection;
}

describe('sessionCockpitMobileCatalog', () => {
    it('keeps a plugin in host-owned discovery and reveals an explicitly pinned plugin in the inline cap', () => {
        const plugin = createMobilePluginPlacement({
            pluginId: 'acme.review',
            destinationId: 'session-review',
            label: 'Review',
        });
        const catalog = resolveSessionCockpitMobileCatalog({
            terminalTabAvailable: true,
            pluginPlacements: [plugin],
            projectionGeneration: 7,
        });

        expect(catalog.map((entry) => entry.id)).toEqual([
            'chat',
            'browse',
            'git',
            'tabs',
            'navigation',
            'browser',
            'services',
            'plugin:acme.review:session-review',
            'terminal',
        ]);

        expect(resolveSessionCockpitMobileTabVisibility({
            catalog,
            pinnedSurfaceIds: [],
        })).toMatchObject({
            visible: [
                { id: 'chat' },
                { id: 'browse' },
                { id: 'git' },
                { id: 'tabs' },
            ],
            overflow: expect.arrayContaining([
                expect.objectContaining({ id: 'plugin:acme.review:session-review' }),
            ]),
        });

        expect(resolveSessionCockpitMobileTabVisibility({
            catalog,
            pinnedSurfaceIds: ['plugin:acme.review:session-review'],
        })).toMatchObject({
            visible: [
                { id: 'chat' },
                { id: 'plugin:acme.review:session-review' },
                { id: 'browse' },
                { id: 'git' },
            ],
        });
    });

    it('never turns unavailable or unknown pinned values into a visible catalog entry', () => {
        const catalog = resolveSessionCockpitMobileCatalog({
            terminalTabAvailable: false,
        });

        expect(resolveSessionCockpitMobileTabVisibility({
            catalog,
            pinnedSurfaceIds: ['plugin:removed:panel', 'not-a-surface'],
        })).toMatchObject({
            visible: [
                { id: 'chat' },
                { id: 'browse' },
                { id: 'git' },
                { id: 'tabs' },
            ],
        });
    });

    it('admits a conservative Android-only destination only to the Android phone catalog', () => {
        const androidOnlyPlugin = createMobilePluginPlacement({
            pluginId: 'acme.android',
            destinationId: 'session-review',
            label: 'Android review',
            platforms: ['android'],
        });
        const iosInput = {
            terminalTabAvailable: true,
            pluginPlacements: [androidOnlyPlugin],
            projectionGeneration: 7,
            runtimeAdmission: { platform: 'ios' as const, formFactor: 'phone' as const },
        };
        const androidInput = {
            ...iosInput,
            runtimeAdmission: { platform: 'android' as const, formFactor: 'phone' as const },
        };

        expect(resolveSessionCockpitMobileCatalog(iosInput).map((entry) => entry.id))
            .not.toContain('plugin:acme.android:session-review');
        expect(resolveSessionCockpitMobileCatalog(androidInput).map((entry) => entry.id))
            .toContain('plugin:acme.android:session-review');
    });
});
