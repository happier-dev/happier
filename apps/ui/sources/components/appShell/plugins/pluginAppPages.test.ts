import { describe, expect, it } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import {
    buildPluginAppPageRoutePath,
    readPluginAppPageSubPath,
    resolvePluginAppPageForReference,
    resolvePluginAppPageForRoute,
    resolvePluginAppPages,
} from './pluginAppPages';

const NOTES_PLUGIN_ID = 'acme.notes';
const JOURNAL_PLUGIN_ID = 'acme.journal';
const ZETA_PLUGIN_ID = 'acme.zeta';

function pageBinding(
    pluginId: string,
    localId: string,
): PluginUiSurfacePlacementProjection['binding'] {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId,
        destinationId: localId,
        rendererId: `${localId}-renderer`,
        container: 'appPage',
        target: { kind: 'app' },
    });
    if (!binding) {
        throw new Error('test fixture must use an admitted V2 app-page binding');
    }
    return binding;
}

function createPagePlacement(
    overrides: Partial<PluginUiSurfacePlacementProjection> = {},
): PluginUiSurfacePlacementProjection {
    const placement = {
        id: `surfacePlacement:${NOTES_PLUGIN_ID}:notes`,
        pluginId: NOTES_PLUGIN_ID,
        contributionKind: 'surfacePlacement',
        descriptorId: 'notes',
        target: { kind: 'app' },
        renderer: { kind: 'reactNative', contributionId: 'notes-renderer' },
        display: { developerFallback: 'Notes', iconToken: 'file' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        ...overrides,
    };
    const binding = placement.binding ?? pageBinding(placement.pluginId, placement.descriptorId);
    return {
        ...placement,
        binding,
        target: binding.target,
    } as PluginUiSurfacePlacementProjection;
}

describe('plugin app page catalog (EU-5b)', () => {
    it('projects a declared page into a qualified, host-generated destination', () => {
        const pages = resolvePluginAppPages({ placements: [createPagePlacement()] });

        expect(pages).toHaveLength(1);
        expect(pages[0]).toMatchObject({
            id: `plugin:${NOTES_PLUGIN_ID}:notes`,
            pluginId: NOTES_PLUGIN_ID,
            localId: 'notes',
            label: 'Notes',
            order: Number.MAX_SAFE_INTEGER,
            disabledReason: null,
            routePath: `/plugins/${NOTES_PLUGIN_ID}/notes`,
        });
    });

    it('keeps two plugins declaring the same local page id apart', () => {
        const pages = resolvePluginAppPages({
            placements: [
                createPagePlacement(),
                createPagePlacement({
                    id: `surfacePlacement:${JOURNAL_PLUGIN_ID}:notes`,
                    pluginId: JOURNAL_PLUGIN_ID,
                    display: { developerFallback: 'Journal', iconToken: 'file' },
                }),
            ],
        });

        expect(pages.map((page) => page.id)).toEqual([
            `plugin:${JOURNAL_PLUGIN_ID}:notes`,
            `plugin:${NOTES_PLUGIN_ID}:notes`,
        ]);
        expect(pages.map((page) => page.routePath)).toEqual([
            `/plugins/${JOURNAL_PLUGIN_ID}/notes`,
            `/plugins/${NOTES_PLUGIN_ID}/notes`,
        ]);
        // The wrong implementation — keying a page by its local id — would have
        // produced one entry here, silently dropping the second plugin's page.
        expect(pages).toHaveLength(2);
    });

    it('rejects every declaration that claims the same canonical page destination', () => {
        const pages = resolvePluginAppPages({
            placements: [
                createPagePlacement({
                    descriptorId: 'details-a',
                    binding: pageBinding(NOTES_PLUGIN_ID, 'details'),
                }),
                createPagePlacement({
                    id: `surfacePlacement:${NOTES_PLUGIN_ID}:details-b`,
                    descriptorId: 'details-b',
                    binding: pageBinding(NOTES_PLUGIN_ID, 'details'),
                }),
            ],
        });

        // Descriptor/projection order must not choose a winner when two rows
        // claim one public destination. The route and openSurface consumers see
        // the same fail-closed catalog rather than an incumbent by accident.
        expect(pages).toEqual([]);
        expect(resolvePluginAppPageForReference({
            pages,
            destination: { pluginId: NOTES_PLUGIN_ID, localId: 'details' },
        })).toBeNull();
    });

    it('lists an unavailable page with its reason instead of hiding it', () => {
        const pages = resolvePluginAppPages({
            placements: [createPagePlacement({
                availability: {
                    state: 'blocked',
                    reason: 'react_native_runtime_unavailable',
                    diagnostics: [],
                },
            })],
        });

        expect(pages).toHaveLength(1);
        expect(pages[0]?.disabledReason).toBe('react_native_runtime_unavailable');
    });

    it('ignores a stale placement order and uses host-stable ordering for distinct pages', () => {
        const pages = resolvePluginAppPages({
            placements: [
                createPagePlacement({
                    id: `surfacePlacement:${ZETA_PLUGIN_ID}:zeta`,
                    pluginId: ZETA_PLUGIN_ID,
                    descriptorId: 'zeta',
                    // V2 never produces this legacy field. A retained reader
                    // would incorrectly move this later qualified destination
                    // ahead of the host's stable catalog order.
                    order: -100,
                }),
                createPagePlacement(),
            ],
        });

        expect(pages.map((page) => page.id)).toEqual([
            `plugin:${NOTES_PLUGIN_ID}:notes`,
            `plugin:${ZETA_PLUGIN_ID}:zeta`,
        ]);
    });
});

describe('plugin app page routes (EU-5b)', () => {
    it('generates a deep link under the host prefix and encodes every segment', () => {
        expect(buildPluginAppPageRoutePath({
            pluginId: NOTES_PLUGIN_ID,
            localId: 'notes',
            subPath: 'work/ideas.md',
        })).toBe(`/plugins/${NOTES_PLUGIN_ID}/notes/work/ideas.md`);

        expect(buildPluginAppPageRoutePath({
            pluginId: 'acme/notes',
            localId: 'my notes',
            subPath: 'a b/c?d',
        })).toBe('/plugins/acme%2Fnotes/my%20notes/a%20b/c%3Fd');
    });

    it('canonicalizes a sub-path so one location is always one route', () => {
        expect(buildPluginAppPageRoutePath({ pluginId: 'n', localId: 'n', subPath: '' }))
            .toBe('/plugins/n/n');
        expect(buildPluginAppPageRoutePath({ pluginId: 'n', localId: 'n', subPath: '/a//b/' }))
            .toBe('/plugins/n/n/a/b');
    });

    it('refuses a relative sub-path rather than letting a plugin address out of its namespace', () => {
        expect(buildPluginAppPageRoutePath({ pluginId: 'n', localId: 'n', subPath: '../../settings' }))
            .toBe('/plugins/n/n');
        expect(readPluginAppPageSubPath('../../settings')).toBeNull();
    });

    it('reads the router rest parameter in both spellings', () => {
        expect(readPluginAppPageSubPath('work/ideas.md')).toBe('work/ideas.md');
        expect(readPluginAppPageSubPath(['work', 'ideas.md'])).toBe('work/ideas.md');
        expect(readPluginAppPageSubPath(undefined)).toBe('');
    });

    it('resolves a route to a page only when both identity segments match', () => {
        const pages = resolvePluginAppPages({
            placements: [
                createPagePlacement(),
                createPagePlacement({
                    id: `surfacePlacement:${JOURNAL_PLUGIN_ID}:notes`,
                    pluginId: JOURNAL_PLUGIN_ID,
                }),
            ],
        });

        expect(resolvePluginAppPageForRoute({ pages, pluginId: JOURNAL_PLUGIN_ID, localId: 'notes' })?.id)
            .toBe(`plugin:${JOURNAL_PLUGIN_ID}:notes`);
        expect(resolvePluginAppPageForRoute({ pages, pluginId: NOTES_PLUGIN_ID, localId: 'journal' }))
            .toBeNull();
        expect(resolvePluginAppPageForRoute({ pages, pluginId: '', localId: 'notes' }))
            .toBeNull();
    });
});

describe('plugin app page openSurface references (EU-5b)', () => {
    const pages = resolvePluginAppPages({
        placements: [
            createPagePlacement(),
            createPagePlacement({
                    id: `surfacePlacement:${JOURNAL_PLUGIN_ID}:notes`,
                    pluginId: JOURNAL_PLUGIN_ID,
            }),
        ],
    });

    it('resolves an exact qualified reference to a page', () => {
        expect(resolvePluginAppPageForReference({
            pages,
            destination: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' },
        })?.id).toBe(`plugin:${NOTES_PLUGIN_ID}:notes`);
    });

    it('resolves a qualified reference naming an installed, available plugin page', () => {
        expect(resolvePluginAppPageForReference({
            pages,
            destination: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' },
        })?.id).toBe(`plugin:${NOTES_PLUGIN_ID}:notes`);
    });

    it('refuses an unknown qualified reference', () => {
        expect(resolvePluginAppPageForReference({
            pages,
            destination: { pluginId: NOTES_PLUGIN_ID, localId: 'missing' },
        }))
            .toBeNull();
    });
});
