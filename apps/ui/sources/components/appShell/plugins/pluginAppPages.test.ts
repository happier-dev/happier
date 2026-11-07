import { describe, expect, it } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { readPluginSurfaceMountBinding } from '@/components/plugins/surfaces/pluginSurfaceMountBinding';
import {
    buildPluginAppPageRoutePath,
    readPluginPageSubPath,
    resolvePluginPageForReference,
    resolvePluginPageForRoute,
    resolvePluginPages,
} from '@/components/plugins/pages/pluginPages';

const NOTES_PLUGIN_ID = 'acme.notes';
const JOURNAL_PLUGIN_ID = 'acme.journal';
const ZETA_PLUGIN_ID = 'acme.zeta';

function pageBinding(
    pluginId: string,
    localId: string,
    rendererId = `${localId}-renderer`,
): PluginUiSurfacePlacementProjection['binding'] {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId,
        destinationId: localId,
        rendererId,
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
    it('selects an explicit Project page independently from the same app destination and scopes baseline reuse', () => {
        const binding = normalizePluginUiDestinationBindingV1({ pluginId: NOTES_PLUGIN_ID, destinationId: 'notes',
            rendererId: 'notes-renderer', container: 'appPage', target: { kind: 'project' } });
        if (!binding) throw new Error('Project page slot must be admitted');
        const project = createPagePlacement({ id: 'project-notes', binding });
        const app = createPagePlacement();
        const target = { kind: 'project' as const, workspaceRefId: 'ref-one', serverId: 'home-one' };
        const pages = resolvePluginPages({ target, placements: [app, project] });
        expect(pages).toHaveLength(1);
        expect(pages[0]?.routePath).toBe('/projects/ref-one/plugins/acme.notes/notes?serverId=home-one');
        expect(pages[0]?.columnPlacement).toBeUndefined();
        expect(resolvePluginPages({ target, placements: [structuredClone(project)], baseline: pages })).toBe(pages);
        const other = resolvePluginPages({ target: { ...target, serverId: 'home-two' }, placements: [project], baseline: pages });
        expect(other[0]).not.toBe(pages[0]);
        expect(other[0]?.routePath).toContain('home-two');
    });

    it('retains canonical contextual refusal for direct routes while marking inapplicable pages invisible to navigation', () => {
        const binding = normalizePluginUiDestinationBindingV1({ pluginId: NOTES_PLUGIN_ID, destinationId: 'notes',
            rendererId: 'notes-renderer', container: 'appPage', target: { kind: 'project' } });
        if (!binding) throw new Error('Project page slot must be admitted');
        const placement = createPagePlacement({ binding, availability: {
            state: 'available', reason: 'available', diagnostics: [],
            when: { fact: 'project.exists', operator: 'equals', value: true },
        } });
        const target = { kind: 'project' as const, workspaceRefId: 'ref-one' };
        expect(resolvePluginPages({ target, placements: [placement], policyContext: {} })[0])
            .toMatchObject({ visible: false, disabledReason: 'availability_fact_unavailable' });
        expect(resolvePluginPages({ target, placements: [placement], policyContext: { data: { project: { exists: false } } } })[0])
            .toMatchObject({ visible: false, disabledReason: 'availability_not_applicable' });
        const disabled = { ...placement, availability: { ...placement.availability,
            disabledWhen: { fact: 'project.exists', operator: 'equals', value: true } as const } };
        expect(resolvePluginPages({ target, placements: [disabled], policyContext: { data: { project: { exists: true } } } })[0]?.disabledReason)
            .toBe('policy_disabled');
    });
    it('publishes no new page values for equal relevant refresh and changes only the keyed page', () => {
        const first = createPagePlacement({ column: {
            binding: pageBinding(NOTES_PLUGIN_ID, 'notes', 'notes-column'),
            renderer: { kind: 'reactNative', contributionId: 'notes-column' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        } });
        const second = createPagePlacement({ id: 'surfacePlacement:acme.journal:notes', pluginId: JOURNAL_PLUGIN_ID });
        const baseline = resolvePluginPages({ target: { kind: 'app' }, placements: [first, second] });
        const equal = resolvePluginPages({ target: { kind: 'app' }, placements: [structuredClone(first), structuredClone(second)], baseline });
        expect(equal).toBe(baseline);
        const changed = resolvePluginPages({ target: { kind: 'app' }, placements: [first, { ...second,
            display: { ...second.display, title: 'New journal' } }], baseline });
        expect(changed.filter(page => !baseline.includes(page))).toHaveLength(1);
        expect(changed.find(page => page.pluginId === NOTES_PLUGIN_ID)).toBe(baseline.find(page => page.pluginId === NOTES_PLUGIN_ID));
        expect(changed.find(page => page.pluginId === NOTES_PLUGIN_ID)?.columnPlacement)
            .toBe(baseline.find(page => page.pluginId === NOTES_PLUGIN_ID)?.columnPlacement);
    });

    it('keeps publication proportional to the changed descriptor across a large authored catalog', () => {
        const placements = Array.from({ length: 128 }, (_, index) => createPagePlacement({
            id: `surfacePlacement:${NOTES_PLUGIN_ID}:page-${index}`, descriptorId: `page-${index}`,
        }));
        const baseline = resolvePluginPages({ target: { kind: 'app' }, placements });
        const equal = resolvePluginPages({ target: { kind: 'app' }, placements: structuredClone(placements).reverse(), baseline });
        expect(equal).toBe(baseline);
        const nextPlacements = structuredClone(placements);
        nextPlacements[64] = { ...nextPlacements[64]!, display: { title: 'Changed page' } };
        const changed = resolvePluginPages({ target: { kind: 'app' }, placements: nextPlacements, baseline });
        expect(changed.filter(page => !baseline.includes(page))).toHaveLength(1);
        expect(changed.filter(page => baseline.includes(page))).toHaveLength(127);
    });

    it('localizes a declared description before any renderer loads, preserving omission', () => {
        const description = { key: 'notes.purpose', fallback: 'Review incoming work.' };
        const [page] = resolvePluginPages({ target: { kind: 'app' },
            placements: [createPagePlacement({ display: { title: 'Notes', description } })],
            localize: createPluginLocalizedTextResolver({ locale: 'fr', projection: {
                ...EMPTY_PLUGIN_UI_PROJECTION,
                translationsByPluginId: { [NOTES_PLUGIN_ID]: {
                    id: `translations:${NOTES_PLUGIN_ID}`, pluginId: NOTES_PLUGIN_ID, contributionKind: 'translations',
                    locales: ['fr'],
                    bundles: { fr: { 'notes.purpose': 'Relire le travail entrant.' } },
                } },
            } }),
        });
        expect(page?.description).toBe('Relire le travail entrant.');
        expect(resolvePluginPages({ target: { kind: 'app' }, placements: [createPagePlacement()] })[0]).not.toHaveProperty('description');
    });

    it('carries a declared toolbar header style before any renderer loads, preserving omission', () => {
        const [toolbarPage] = resolvePluginPages({ target: { kind: 'app' },
            placements: [createPagePlacement({ display: { title: 'Notes', headerStyle: 'toolbar' } })],
        });
        expect(toolbarPage?.headerStyle).toBe('toolbar');
        expect(resolvePluginPages({ target: { kind: 'app' }, placements: [createPagePlacement()] })[0]).not.toHaveProperty('headerStyle');
        const [unknown] = resolvePluginPages({ target: { kind: 'app' },
            placements: [createPagePlacement({ display: { title: 'Notes', headerStyle: 'banner' } })],
        });
        expect(unknown).not.toHaveProperty('headerStyle');
    });

    it('projects a declared page into a qualified, host-generated destination', () => {
        const pages = resolvePluginPages({ target: { kind: 'app' }, placements: [createPagePlacement()] });

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

    it("derives the page's own column as a placement of its column renderer, only while that renderer is available", () => {
        const columnRenderer = { kind: 'reactNative', contributionId: 'notes-column' };
        const columnBinding = pageBinding(NOTES_PLUGIN_ID, 'notes', 'notes-column');
        const available = { state: 'available' as const, reason: 'available', diagnostics: [] };
        const [withColumn] = resolvePluginPages({ target: { kind: 'app' },
            placements: [createPagePlacement({ column: { binding: columnBinding, renderer: columnRenderer, availability: available } })],
        });
        expect(withColumn?.columnPlacement).toMatchObject({
            renderer: columnRenderer,
            availability: available,
            binding: columnBinding,
        });
        expect(withColumn?.columnPlacement?.binding).toBe(columnBinding);
        if (!withColumn?.columnPlacement) throw new Error('available column must be mounted');
        expect(readPluginSurfaceMountBinding({
            descriptor: withColumn.placement, renderer: withColumn.placement.renderer,
        })).not.toBeNull();
        expect(readPluginSurfaceMountBinding({
            descriptor: withColumn.columnPlacement, renderer: columnRenderer,
        })).not.toBeNull();
        expect(readPluginSurfaceMountBinding({
            descriptor: withColumn.columnPlacement, renderer: withColumn.placement.renderer,
        })).toBeNull();
        expect(readPluginSurfaceMountBinding({
            descriptor: { ...withColumn.columnPlacement, pluginId: JOURNAL_PLUGIN_ID }, renderer: columnRenderer,
        })).toBeNull();
        // A second mount of the same page: it must not share the page mount's surface identity.
        expect(withColumn?.columnPlacement?.id).not.toBe(withColumn?.placement.id);

        const [resolving] = resolvePluginPages({ target: { kind: 'app' }, placements: [createPagePlacement({
            availability: { state: 'resolving', reason: 'available', diagnostics: [] },
            column: { binding: columnBinding, renderer: columnRenderer, availability: available },
        })] });
        expect(resolving?.disabledReason).toBeNull();
        expect(resolving?.columnPlacement?.availability.state).toBe('resolving');

        const [unavailable] = resolvePluginPages({ target: { kind: 'app' },
            placements: [createPagePlacement({
                column: { binding: columnBinding, renderer: columnRenderer, availability: { state: 'disabled' as const, reason: 'artifact_missing', diagnostics: [] } },
            })],
        });
        expect(unavailable?.columnPlacement).toBeUndefined();
        expect(resolvePluginPages({ target: { kind: 'app' }, placements: [createPagePlacement()] })[0]?.columnPlacement).toBeUndefined();
    });

    it('keeps two plugins declaring the same local page id apart', () => {
        const pages = resolvePluginPages({ target: { kind: 'app' },
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
        const pages = resolvePluginPages({ target: { kind: 'app' },
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
        expect(resolvePluginPageForReference({
            pages,
            destination: { pluginId: NOTES_PLUGIN_ID, localId: 'details' },
        })).toBeNull();
    });

    it('lists an unavailable page with its reason instead of hiding it', () => {
        const pages = resolvePluginPages({ target: { kind: 'app' },
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
        const pages = resolvePluginPages({ target: { kind: 'app' },
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
        expect(readPluginPageSubPath('../../settings')).toBeNull();
    });

    it('reads the router rest parameter in both spellings', () => {
        expect(readPluginPageSubPath('work/ideas.md')).toBe('work/ideas.md');
        expect(readPluginPageSubPath(['work', 'ideas.md'])).toBe('work/ideas.md');
        expect(readPluginPageSubPath(undefined)).toBe('');
    });

    it('resolves a route to a page only when both identity segments match', () => {
        const pages = resolvePluginPages({ target: { kind: 'app' },
            placements: [
                createPagePlacement(),
                createPagePlacement({
                    id: `surfacePlacement:${JOURNAL_PLUGIN_ID}:notes`,
                    pluginId: JOURNAL_PLUGIN_ID,
                }),
            ],
        });

        expect(resolvePluginPageForRoute({ pages, pluginId: JOURNAL_PLUGIN_ID, localId: 'notes' })?.id)
            .toBe(`plugin:${JOURNAL_PLUGIN_ID}:notes`);
        expect(resolvePluginPageForRoute({ pages, pluginId: NOTES_PLUGIN_ID, localId: 'journal' }))
            .toBeNull();
        expect(resolvePluginPageForRoute({ pages, pluginId: '', localId: 'notes' }))
            .toBeNull();
    });
});

describe('plugin app page openSurface references (EU-5b)', () => {
    const pages = resolvePluginPages({ target: { kind: 'app' },
        placements: [
            createPagePlacement(),
            createPagePlacement({
                    id: `surfacePlacement:${JOURNAL_PLUGIN_ID}:notes`,
                    pluginId: JOURNAL_PLUGIN_ID,
            }),
        ],
    });

    it('resolves an exact qualified reference to a page', () => {
        expect(resolvePluginPageForReference({
            pages,
            destination: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' },
        })?.id).toBe(`plugin:${NOTES_PLUGIN_ID}:notes`);
    });

    it('resolves a qualified reference naming an installed, available plugin page', () => {
        expect(resolvePluginPageForReference({
            pages,
            destination: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' },
        })?.id).toBe(`plugin:${NOTES_PLUGIN_ID}:notes`);
    });

    it('refuses an unknown qualified reference', () => {
        expect(resolvePluginPageForReference({
            pages,
            destination: { pluginId: NOTES_PLUGIN_ID, localId: 'missing' },
        }))
            .toBeNull();
    });
});
