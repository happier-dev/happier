import { describe, expect, it } from 'vitest';

import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
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
    it('says what an agent visual is: a chart or a table reads as such, a note stays a note', () => {
        const declarative = (root: unknown) => ({ kind: 'declarative', document: { version: 1, root } }) as SessionSurfaceItemV1['source'];
        const data = { kind: 'value', value: [] };
        expect(resolveBoardWidgetProvenance(declarative({ kind: 'chart', label: 'Orders', style: 'bar', rows: [], data,
            x: { path: ['day'], type: 'string' }, y: { path: ['orders'], type: 'number' } }), null).label).toBe('Chart');
        expect(resolveBoardWidgetProvenance(declarative({ kind: 'table', label: 'Orders', rows: [], data, columns: [] }), null).label).toBe('Table');
        expect(resolveBoardWidgetProvenance(declarative({ kind: 'markdown', text: 'Hello' }), null).label).toBe('Note');
    });

    it('names the installed plugin and its contribution, never a generic plugin line', () => {
        const provenance = resolveBoardWidgetProvenance(installedSource, projectionWith({
            surfaces: [{ pluginId: 'acme.review', localId: 'review-status-widget', title: 'Review status' }],
            installed: { 'acme.review': 'Review Assistant' },
        }));
        // The item's own title already says which widget it is; the source line says only whose it is.
        expect(provenance.label).toBe('Review Assistant');
    });

    it('calls a posted snapshot a snapshot, not the note its frozen document is stored as', () => {
        const frozen: SessionSurfaceItemV1['source'] = { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Frozen' } } };
        expect(resolveBoardWidgetProvenance(frozen, null, { snapshot: true }).label).toBe('Snapshot');
        expect(resolveBoardWidgetProvenance(frozen, null).label).toBe('Note');
        const snapshot = { asOf: '2026-10-19T08:00:00.000Z', provenance: [], postedByAccountId: 'poster' };
        expect(resolveBoardWidgetProvenance(frozen, null, { snapshot, viewerAccountId: 'poster' }).label).toBe('Snapshot by you');
        expect(resolveBoardWidgetProvenance(frozen, null, { snapshot, viewerAccountId: 'viewer', posterDisplayName: 'Morgan' }).label).toBe('Snapshot by Morgan');
        expect(resolveBoardWidgetProvenance(frozen, null, { snapshot, viewerAccountId: 'viewer' }).label).toBe('Snapshot');
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
});
