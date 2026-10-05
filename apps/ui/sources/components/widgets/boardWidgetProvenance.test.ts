import { describe, expect, it } from 'vitest';

import type { PluginProjectionV2 } from '@happier-dev/protocol';
import { normalizePluginUiInlineSurfaceBindingV1 } from '@happier-dev/protocol/plugins/ui';
import type { SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';

import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { WIDGET_ROLE } from '@/sync/domains/plugins/ui/widgetContract';

import { resolveBoardWidgetProvenance } from './boardWidgetProvenance';

/**
 * A durable Board item outlives the plugin generation that renders it, so its
 * source line must stay truthful and specific. The failure pinned here is the
 * one a person cannot recover from: two plugin widgets on one Board both saying
 * "From a plugin", which makes "Manage plugin" a guess.
 */

function projectionWith(input: Readonly<{
    surfaces?: ReadonlyArray<Readonly<{ pluginId: string; localId: string; title: string }>>;
    installed?: Readonly<Record<string, string>>;
}>) {
    const entries = (input.surfaces ?? []).map((surface) => {
        const binding = normalizePluginUiInlineSurfaceBindingV1({
            pluginId: surface.pluginId,
            surfaceId: surface.localId,
            rendererId: 'review-native',
            role: WIDGET_ROLE,
            target: { kind: 'session' },
        });
        if (!binding) throw new Error('fixture must use an admitted inline binding');
        return {
            id: `surfacePlacement:${surface.pluginId}:${surface.localId}`,
            pluginId: surface.pluginId,
            contributionKind: 'surfacePlacement',
            descriptorId: surface.localId,
            // The daemon producer stamps every projected UI entry with its plugin-slot occurrence.
            occurrenceId: `${surface.pluginId}#1`,
            binding,
            target: binding.target,
            renderer: { kind: 'declarative', contributionId: 'review-native' },
            display: { title: surface.title },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        };
    });
    return normalizePluginUiProjection({
        v: 2,
        generation: 1,
        installedPackagesById: Object.fromEntries(
            Object.entries(input.installed ?? {}).map(([pluginId, displayName]) => [pluginId, {
                id: pluginId,
                displayName,
                enabled: true,
                source: { kind: 'local', path: `/plugins/${pluginId}` },
            }]),
        ),
        actionsById: {},
        familiesById: { pluginUi: { entriesById: Object.fromEntries(entries.map((e) => [e.id, e])) } },
    } as unknown as PluginProjectionV2);
}

const installedSource: SessionSurfaceItemV1['source'] = {
    kind: 'widget',
    instance: { v: 1, id: 'review-widget', definition: { kind: 'installed', surface: { pluginId: 'acme.review', localId: 'review-status-widget' } }, bindings: {} },
};

describe('Session widget provenance', () => {
    it('names the installed plugin and its contribution, never a generic plugin line', () => {
        const provenance = resolveBoardWidgetProvenance(installedSource, projectionWith({
            surfaces: [{ pluginId: 'acme.review', localId: 'review-status-widget', title: 'Review status' }],
            installed: { 'acme.review': 'Review Assistant' },
        }));
        expect(provenance.label).toContain('Review status');
        expect(provenance.label).toContain('Review Assistant');
    });

    it('names the plugin id when the plugin is not installed here', () => {
        const provenance = resolveBoardWidgetProvenance(installedSource, projectionWith({}));
        expect(provenance.label).toContain('acme.review');
    });

    it('keeps the qualified identity announced when two plugins share a display name', () => {
        const projection = projectionWith({
            surfaces: [
                { pluginId: 'acme.review', localId: 'review-status-widget', title: 'Status' },
                { pluginId: 'other.review', localId: 'review-status-widget', title: 'Status' },
            ],
            installed: { 'acme.review': 'Review', 'other.review': 'Review' },
        });
        const provenance = resolveBoardWidgetProvenance(installedSource, projection);
        expect(provenance.accessibilityLabel).toContain('acme.review');
        expect(provenance.accessibilityLabel).not.toBe(provenance.label);
    });

    it('contributes no contribution title when the surface resolves ambiguously', () => {
        // Projection order must not appoint a name any more than it appoints a
        // mount: the plugin name alone is the truthful answer.
        const provenance = resolveBoardWidgetProvenance(installedSource, projectionWith({
            surfaces: [{ pluginId: 'acme.review', localId: 'review-status-widget', title: 'Review status' }],
            installed: { 'acme.review': 'Review Assistant' },
        }));
        expect(provenance.label).toContain('Review status');

        const absent = resolveBoardWidgetProvenance(installedSource, projectionWith({
            installed: { 'acme.review': 'Review Assistant' },
        }));
        expect(absent.label).toBe('Review Assistant');
    });
});
