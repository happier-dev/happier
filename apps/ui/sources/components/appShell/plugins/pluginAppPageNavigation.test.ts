import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import {
    createPluginSurfaceLaunchAuthority,
    type PluginSurfaceLaunchAuthority,
} from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiContributionOriginV1 } from '@/sync/domains/plugins/ui/projectionUnion';

import { resolvePluginPages, selectPluginPagePlacements } from '@/components/plugins/pages/pluginPages';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { createPluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { createPluginSurfaceOpenSurfaceHandler } from '@/components/plugins/surfaces/openPluginSurface';
import {
    createPluginPageLaunchInputStore,
    createPluginPageCatalogActivationHandler,
    createPluginPageOpenSurfaceHandler,
    createPluginPageDestinationHandler,
    resolvePluginPageLaunchAuthorities,
    type PluginPageLaunchOpen,
} from '@/components/plugins/pages/pluginPageNavigation';
import { clearActiveUnsavedChangesGuard, setActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import type { UnsavedChangesDecision } from '@/utils/ui/promptUnsavedChangesAlert';

afterEach(() => clearActiveUnsavedChangesGuard());

// Launch custody/navigation contracts never access the Session-envelope HTTP API.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Session-envelope HTTP API is outside this navigation test'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});

// No Markdown is rendered here; preserve the external SDK boundary if reached.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Markdown SDK is outside this navigation test'); },
}));

const NOTES_PLUGIN_ID = 'acme.notes';
const JOURNAL_PLUGIN_ID = 'acme.journal';
const NOTES_PAGE_ID = `plugin:${NOTES_PLUGIN_ID}:notes`;
const NOTES_ARCHIVE_PAGE_ID = `plugin:${NOTES_PLUGIN_ID}:archive`;
const JOURNAL_PAGE_ID = `plugin:${JOURNAL_PLUGIN_ID}:journal`;

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
    const pluginId = overrides.pluginId ?? NOTES_PLUGIN_ID;
    const descriptorId = overrides.descriptorId ?? 'notes';
    const binding = overrides.binding ?? pageBinding(pluginId, descriptorId);
    return {
        id: overrides.id ?? `surfacePlacement:${pluginId}:${descriptorId}`,
        pluginId,
        // The daemon stamps the serving plugin-slot occurrence on every UI row.
        occurrenceId: `${pluginId}:9`,
        contributionKind: 'surfacePlacement',
        descriptorId,
        binding,
        target: binding.target,
        renderer: { kind: 'reactNative', contributionId: 'notes-renderer' },
        display: { developerFallback: 'Notes' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
        hostOrigin: pageHostOrigin({
            pluginId,
            machineId: 'machine-1',
            materializationId: `${descriptorId}-install-a`,
            generation: 9,
        }),
        ...overrides,
    } satisfies PluginUiSurfacePlacementProjection;
}

function pageExecutionOrigin(input: Readonly<{
    pluginId: string;
    machineId: string;
    materializationId: string;
}>): PluginMachineExecutionOriginV1 {
    return {
        serverIdentityId: 'srv_account_one',
        materializationRef: {
            pluginId: input.pluginId,
            machineId: input.machineId,
            materializationId: input.materializationId,
        },
    };
}

function pageHostOrigin(input: Readonly<{
    pluginId: string;
    machineId: string;
    materializationId: string;
    generation: number;
}>): PluginUiContributionOriginV1 {
    return {
        machineId: input.machineId,
        serverId: 'server-1',
        // The union producer stamps the projection phase; an origin without it
        // is a predecessor stamp and must not recover launch authority.
        phase: 'current',
        interactionEnabled: true,
        executionOrigin: pageExecutionOrigin(input),
    };
}

const pages = resolvePluginPages({ target: { kind: 'app' },
    placements: [
        createPagePlacement(),
        createPagePlacement({
            id: `surfacePlacement:${NOTES_PLUGIN_ID}:archive`,
            descriptorId: 'archive',
            availability: { state: 'disabled', reason: 'plugin_disabled', diagnostics: [] },
        }),
        createPagePlacement({
            id: `surfacePlacement:${JOURNAL_PLUGIN_ID}:journal`,
            pluginId: JOURNAL_PLUGIN_ID,
            descriptorId: 'journal',
            occurrenceId: `${JOURNAL_PLUGIN_ID}:10`,
        }),
    ],
});

const authority = createPluginSurfaceLaunchAuthority({
    serverId: 'server-1',
    machineId: 'machine-1',
    occurrenceId: 'plugin-occurrence-9',
});
const nextOccurrence = createPluginSurfaceLaunchAuthority({
    serverId: 'server-1',
    machineId: 'machine-1',
    occurrenceId: 'plugin-occurrence-10',
});
const otherServer = createPluginSurfaceLaunchAuthority({
    serverId: 'server-2',
    machineId: 'machine-1',
    occurrenceId: 'plugin-occurrence-9',
});
const otherMachine = createPluginSurfaceLaunchAuthority({
    serverId: 'server-1',
    machineId: 'machine-2',
    occurrenceId: 'plugin-occurrence-9',
});
const selectedNotesMaterialization = createPluginSurfaceLaunchAuthority({
    serverId: 'server-1',
    machineId: 'machine-1',
    occurrenceId: 'plugin-occurrence-9',
    executionOrigin: pageExecutionOrigin({
        pluginId: NOTES_PLUGIN_ID,
        machineId: 'machine-1',
        materializationId: 'notes-install-a',
    }),
});
const replacementNotesMaterialization = createPluginSurfaceLaunchAuthority({
    serverId: 'server-1',
    machineId: 'machine-1',
    occurrenceId: 'plugin-occurrence-9',
    executionOrigin: pageExecutionOrigin({
        pluginId: NOTES_PLUGIN_ID,
        machineId: 'machine-1',
        materializationId: 'notes-install-b',
    }),
});

function createHandler() {
    const navigate = vi.fn();
    const staged: Array<Readonly<{
        pageId: string;
        subPath: string;
        input: unknown;
    }>> = [];
    const open = createPluginPageOpenSurfaceHandler({
        pages,
        placements: pages.map((page) => page.placement),
        navigate,
        stageLaunchInput: (entry) => {
            staged.push(entry);
            return true;
        },
    });
    return { navigate, open, staged };
}

function stageOpen(
    store: ReturnType<typeof createPluginPageLaunchInputStore>,
    overrides: Partial<PluginPageLaunchOpen> = {},
): void {
    store.stage({
        authority,
        pageId: NOTES_PAGE_ID,
        subPath: '',
        input: { noteId: 'a' },
        ...overrides,
    });
}

function authorityWithAccountLifetime(
    lifetime: ActiveServerAccountScopeLifetime,
): PluginSurfaceLaunchAuthority {
    return createPluginSurfaceLaunchAuthority({
        serverId: 'server-1',
        machineId: 'machine-1',
        occurrenceId: 'plugin-occurrence-9',
        accountLifetime: lifetime,
    });
}

describe('plugin app page host navigation (EU-5b)', () => {
    it('settles unsaved edits before replacing launch input or opening another page', async () => {
        const store = createPluginPageLaunchInputStore();
        const current = { authority, pageId: NOTES_PAGE_ID, subPath: '', input: { noteId: 'original' } };
        store.stage(current);
        const navigate = vi.fn();
        const dirty = { current: true };
        const requestDecision = vi.fn<() => Promise<UnsavedChangesDecision>>()
            .mockResolvedValueOnce('keepEditing').mockResolvedValueOnce('discard');
        setActiveUnsavedChangesGuard({ isDirtyRef: dirty, requestDecision, tag: 'plugin-page' });
        const open = createPluginPageOpenSurfaceHandler({
            pages, placements: pages.map(page => page.placement), navigate,
            stageLaunchInput: entry => store.stage({ ...entry, authority }),
        });
        const request = { destination: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' }, input: { noteId: 'replacement' } };
        expect(await open(request)).toMatchObject({ ok: false, code: 'unavailable' });
        expect(navigate).not.toHaveBeenCalled();
        expect(store.peek(current)?.input).toEqual({ noteId: 'original' });
        expect(dirty.current).toBe(true);

        expect(await open(request)).toEqual({ ok: true });
        expect(navigate).toHaveBeenCalledOnce();
        expect(store.peek(current)?.input).toEqual({ noteId: 'replacement' });
        expect(dirty.current).toBe(false);
    });

    it('does not clear a mounted page launch input while catalog departure is awaiting confirmation', async () => {
        const store = createPluginPageLaunchInputStore();
        const current = { authority, pageId: NOTES_PAGE_ID, subPath: '', input: { noteId: 'original' } };
        store.stage(current);
        const navigate = vi.fn();
        let decide!: (decision: UnsavedChangesDecision) => void;
        const decision = new Promise<UnsavedChangesDecision>(resolve => { decide = resolve; });
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, tag: 'plugin-page',
            requestDecision: () => decision });
        const activate = createPluginPageCatalogActivationHandler({
            navigate,
            stageLaunchInput: entry => store.stage({ ...entry, authority }),
        });
        activate({ id: NOTES_PAGE_ID, routePath: '/notes' });
        expect(store.peek(current)?.input).toEqual({ noteId: 'original' });
        expect(navigate).not.toHaveBeenCalled();
        decide('discard');
        await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/notes'));
        expect(store.peek(current)?.input).toBeUndefined();
    });

    it('routes a catalog open even when its cached pathname still names the page root', () => {
        const navigate = vi.fn();
        const activate = createPluginPageCatalogActivationHandler({
            navigate, stageLaunchInput: () => true,
        });
        activate({ id: NOTES_PAGE_ID, routePath: '/plugins/acme.notes/notes' });
        expect(navigate).toHaveBeenCalledWith('/plugins/acme.notes/notes');
    });

    it('cannot activate an app catalog entry for an otherwise identical Project binding', async () => {
        const binding = normalizePluginUiDestinationBindingV1({ pluginId: NOTES_PLUGIN_ID, destinationId: 'notes',
            rendererId: 'notes-renderer', container: 'appPage', target: { kind: 'project' } });
        if (!binding) throw new Error('Project page binding must be admitted');
        const placement = createPagePlacement({ binding });
        const navigate = vi.fn();
        const open = createPluginPageOpenSurfaceHandler({ target: { kind: 'project', workspaceRefId: 'ref-one' },
            placements: [placement], pages, navigate, stageLaunchInput: () => true });
        expect(await open({ destination: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' } }))
            .toMatchObject({ ok: false, code: 'unavailable' });
        expect(navigate).not.toHaveBeenCalled();
    });
    it('opens Browse through the native Session handoff and registered App page before a replica is selected', async () => {
        const pluginId = 'happier.triage';
        const localId = 'triage';
        const accountLifetime: ActiveServerAccountScopeLifetime = {
            scope: { serverId: 'server-1', accountId: 'account-1' },
            isCurrent: () => true,
            onRetire: () => ({ dispose() {} }),
        };
        const union = unionPluginUiProjections(['machine-1', 'machine-2'].map(machineId => {
            const origin = pageExecutionOrigin({ pluginId, machineId, materializationId: `install-${machineId}` });
            const placement = createPagePlacement({ pluginId, descriptorId: localId,
                occurrenceId: `occurrence-${machineId}`, ...origin });
            return { machineId, serverId: 'server-1', phase: 'current' as const, interactionEnabled: true,
                projection: { ...EMPTY_PLUGIN_UI_PROJECTION,
                    surfacePlacementsById: { [placement.id]: placement } } };
        }));
        const placements = selectPluginPagePlacements(union.pluginUiProjection, { container: 'appPage', targetKind: 'app' });
        expect(placements).toHaveLength(1);
        expect(placements[0].hostOrigin).toBeNull();
        expect(placements[0].availability.state).toBe('available');
        const pages = resolvePluginPages({ target: { kind: 'app' }, placements });
        const authorities = resolvePluginPageLaunchAuthorities({ pages, accountLifetime });
        const store = createPluginPageLaunchInputStore();
        const routes: string[] = [];
        const app = createPluginSurfaceDestinationNavigationBinding({ targetKind: 'app', placements, accountLifetime });
        const unregister = app.registerOwner({ container: 'appPage', handler: createPluginPageDestinationHandler({
            pages, navigate: route => { routes.push(route); }, stageLaunchInput: open => {
                const authority = authorities.get(open.pageId);
                return authority ? store.stage({ ...open, authority }) : false;
            },
        }) });
        const session = createPluginSurfaceDestinationNavigationBinding({ targetKind: 'session', placements,
            accountLifetime, enclosingOpenSurface: app.openSurface });
        const host = createPluginSurfaceOpenSurfaceHandler(session.openSurface);
        const request = { version: 1 as const, requestId: 'browse-native', method: 'openSurface' as const,
            surface: { pluginId, contributionId: 'session-entries', surfaceId: 'session-entries',
                placement: 'rightSidebarSurface' as const, platform: 'web' as const, channel: 'internal' as const,
                resourceScope: [], diagnostics: [] }, payload: { destination: { pluginId, localId } } };
        await expect(host(request)).resolves.toBeNull();
        expect(routes).toEqual(['/plugins/happier.triage/triage']);
        // An actual launch value still needs the exact selected producer.
        await expect(host({ ...request, payload: { ...request.payload, input: { issue: 42 } } }))
            .resolves.toMatchObject({ code: 'unavailable', diagnostics: ['plugin_surface_open_origin_unavailable'] });
        expect(routes).toHaveLength(1);
        unregister();
        await expect(host(request)).resolves.toMatchObject({ code: 'unavailable' });
        expect(routes).toHaveLength(1);
    });
    it('pushes the generated route for the exact qualified destination', async () => {
        const { navigate, open } = createHandler();

        expect(await open({ destination: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' } })).toEqual({ ok: true });
        expect(navigate).toHaveBeenCalledWith(`/plugins/${NOTES_PLUGIN_ID}/notes`);
    });

    it('carries a sub-path into the pushed route so back walks page-internal history', async () => {
        const { navigate, open } = createHandler();

        await open({ destination: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' }, subPath: 'work/ideas.md' });

        expect(navigate).toHaveBeenCalledWith(`/plugins/${NOTES_PLUGIN_ID}/notes/work/ideas.md`);
    });

    it('stages the open argument against the destination LOCATION, not the page alone', async () => {
        const { open, staged } = createHandler();

        await open({
            destination: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' },
            input: { noteId: 'a' },
            subPath: 'work/ideas.md',
        });

        // The location the navigation is going to — the same canonical spelling
        // the mounted route carries — so an argument addressed to one location
        // cannot be delivered at another.
        expect(staged).toEqual([{
            target: { kind: 'app' },
            pageId: NOTES_PAGE_ID,
            subPath: 'work/ideas.md',
            input: { noteId: 'a' },
        }]);
    });

    it('rejects a singleton instance key instead of fabricating route identity', async () => {
        const { navigate, open, staged } = createHandler();

        await expect(open({
            destination: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' },
            input: { noteId: 'a' },
            subPath: 'work/ideas.md',
            instanceKey: 'compare:before',
        })).resolves.toEqual({
            ok: false,
            code: 'invalid_payload',
            reason: 'plugin_surface_open_instance_key_unsupported',
        });

        expect(navigate).not.toHaveBeenCalled();
        expect(staged).toEqual([]);
    });

    it('stages an explicit empty argument when the open carries none', async () => {
        const { open, staged } = createHandler();

        await open({ destination: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' }, input: { noteId: 'a' } });
        await open({ destination: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' } });

        // §3.7: an open WITHOUT input REPLACES the previous argument. Staging
        // nothing at all would leave the previous one to be delivered again.
        expect(staged).toEqual([
            { target: { kind: 'app' }, pageId: NOTES_PAGE_ID, subPath: '', input: { noteId: 'a' } },
            { target: { kind: 'app' }, pageId: NOTES_PAGE_ID, subPath: '', input: undefined },
        ]);
    });

    it('fails typed and navigates nowhere when the destination is unknown', async () => {
        const { navigate, open, staged } = createHandler();

        expect(await open({ destination: { pluginId: NOTES_PLUGIN_ID, localId: 'missing' } })).toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_surface_open_destination_unknown',
        });
        expect(navigate).not.toHaveBeenCalled();
        expect(staged).toEqual([]);
    });

    it('fails typed with the catalog reason when the destination is unavailable', async () => {
        const { navigate, open, staged } = createHandler();

        expect(await open({ destination: { pluginId: NOTES_PLUGIN_ID, localId: 'archive' } })).toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_disabled',
        });
        expect(navigate).not.toHaveBeenCalled();
        // A refused open must not stage an argument a later successful open
        // would then deliver.
        expect(staged).toEqual([]);
    });

    it('does not deliver input when the page scope cannot prove the exact selected contribution origin', async () => {
        const navigate = vi.fn();
        const open = createPluginPageOpenSurfaceHandler({
            pages,
            placements: pages.map((page) => page.placement),
            navigate,
            // The navigation owner is not allowed to substitute its ambient
            // union machine when exact page authority is absent.
            stageLaunchInput: () => false,
        });

        expect(await open({ destination: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' }, input: { noteId: 'a' } })).toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_surface_open_origin_unavailable',
        });
        expect(navigate).not.toHaveBeenCalled();
    });

    it('opens an installed, available qualified cross-plugin page through the same resolver', async () => {
        const { navigate, open, staged } = createHandler();

        expect(await open({
            destination: { pluginId: JOURNAL_PLUGIN_ID, localId: 'journal' },
            input: { repair: 'provider-setup' },
            subPath: 'repair',
        })).toEqual({
            ok: true,
        });
        expect(navigate).toHaveBeenCalledWith(`/plugins/${JOURNAL_PLUGIN_ID}/journal/repair`);
        expect(staged).toEqual([{
            target: { kind: 'app' },
            pageId: JOURNAL_PAGE_ID,
            subPath: 'repair',
            input: { repair: 'provider-setup' },
        }]);
    });

    it('rejects an invalid plugin-local path instead of opening the page root', async () => {
        const { navigate, open, staged } = createHandler();

        expect(await open({
            destination: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' },
            subPath: '../../settings',
        })).toEqual({
            ok: false,
            code: 'invalid_payload',
            reason: 'plugin_surface_open_sub_path_invalid',
        });
        expect(navigate).not.toHaveBeenCalled();
        expect(staged).toEqual([]);
    });

});

describe('plugin app page launch-input handoff (EU-5b)', () => {
    it('isolates the same page and location across target kind, exact Project, checkout and Home', () => {
        const store = createPluginPageLaunchInputStore();
        const target = { kind: 'project' as const, workspaceRefId: 'ref-one', serverId: 'home-one', rawWorktreeId: 'tree-one' };
        const open = { authority, target, pageId: NOTES_PAGE_ID, subPath: 'runs/one', input: { secret: 'private' } };
        expect(store.stage(open)).toBe(true);
        for (const other of [
            { kind: 'app' as const }, { ...target, workspaceRefId: 'ref-two' },
            { ...target, serverId: 'home-two' }, { ...target, rawWorktreeId: 'tree-two' },
        ]) expect(store.peek({ ...open, target: other })).toBeNull();
        const delivered = store.peek(open);
        expect(delivered).toEqual(open);
        if (!delivered) throw new Error('same target must receive its launch');
        store.settle(delivered);
        expect(store.peek(open)).toBeNull();
    });
    it('maps two pages to their own selected contribution origins, never the app union', () => {
        const pagesWithDistinctOrigins = resolvePluginPages({ target: { kind: 'app' },
            placements: [
                createPagePlacement({
                    id: `surfacePlacement:${NOTES_PLUGIN_ID}:notes`,
                    pluginId: NOTES_PLUGIN_ID,
                    descriptorId: 'notes',
                    occurrenceId: `${NOTES_PLUGIN_ID}:73`,
                    hostOrigin: pageHostOrigin({
                        pluginId: NOTES_PLUGIN_ID,
                        machineId: 'machine-a',
                        materializationId: 'notes-a',
                        generation: 11,
                    }),
                }),
                createPagePlacement({
                    id: `surfacePlacement:${JOURNAL_PLUGIN_ID}:journal`,
                    pluginId: JOURNAL_PLUGIN_ID,
                    descriptorId: 'journal',
                    occurrenceId: `${JOURNAL_PLUGIN_ID}:74`,
                    hostOrigin: pageHostOrigin({
                        pluginId: JOURNAL_PLUGIN_ID,
                        machineId: 'machine-b',
                        materializationId: 'journal-b',
                        generation: 12,
                    }),
                }),
            ],
        });

        const authorities = resolvePluginPageLaunchAuthorities({
            pages: pagesWithDistinctOrigins,
            accountLifetime: null,
        });

        expect(authorities.get(NOTES_PAGE_ID)).toMatchObject({
            machineId: 'machine-a',
            serverId: 'server-1',
            occurrenceId: `${NOTES_PLUGIN_ID}:73`,
            executionOrigin: pageExecutionOrigin({
                pluginId: NOTES_PLUGIN_ID,
                machineId: 'machine-a',
                materializationId: 'notes-a',
            }),
        });
        expect(authorities.get(JOURNAL_PAGE_ID)).toMatchObject({
            machineId: 'machine-b',
            serverId: 'server-1',
            occurrenceId: `${JOURNAL_PLUGIN_ID}:74`,
            executionOrigin: pageExecutionOrigin({
                pluginId: JOURNAL_PLUGIN_ID,
                machineId: 'machine-b',
                materializationId: 'journal-b',
            }),
        });
    });

    it('delivers a pending open only at the location it was addressed to', () => {
        const store = createPluginPageLaunchInputStore();
        stageOpen(store, { subPath: 'work' });

        expect(store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: 'work' })?.input)
            .toEqual({ noteId: 'a' });
        expect(store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: '' })).toBeNull();
        expect(store.peek({ authority, pageId: NOTES_ARCHIVE_PAGE_ID, subPath: 'work' })).toBeNull();
    });

    it('refuses to deliver an open into a different authority', () => {
        const store = createPluginPageLaunchInputStore();
        stageOpen(store);

        const query = { pageId: NOTES_PAGE_ID, subPath: '' } as const;
        expect(store.peek({ ...query, authority })?.input).toEqual({ noteId: 'a' });
        // A replaced occurrence, another server/account and another contributing
        // machine are each a different producer of the same qualified page.
        expect(store.peek({ ...query, authority: nextOccurrence })).toBeNull();
        expect(store.peek({ ...query, authority: otherServer })).toBeNull();
        expect(store.peek({ ...query, authority: otherMachine })).toBeNull();
    });

    it('refuses a same-coordinate input when the selected materialization changes', () => {
        const store = createPluginPageLaunchInputStore();
        store.stage({
            authority: selectedNotesMaterialization,
            pageId: NOTES_PAGE_ID,
            subPath: '',
            input: { noteId: 'old-install' },
        });

        // Machine/server/occurrence alone are insufficient after a plugin is
        // re-materialized. The replacement must not receive bounded input from
        // the selected predecessor.
        expect(store.peek({
            authority: replacementNotesMaterialization,
            pageId: NOTES_PAGE_ID,
            subPath: '',
        })).toBeNull();
        store.retire(replacementNotesMaterialization);
        expect(store.peek({
            authority: selectedNotesMaterialization,
            pageId: NOTES_PAGE_ID,
            subPath: '',
        })).toBeNull();
    });

    it('refuses a same-coordinate launch after its captured Account lifetime changes or retires', () => {
        const accountA = {
            scope: { serverId: 'server-1', accountId: 'account-a' },
            isCurrent: () => accountACurrent,
            onRetire: () => ({ dispose() {} }),
        } satisfies ActiveServerAccountScopeLifetime;
        const accountB = {
            scope: { serverId: 'server-1', accountId: 'account-b' },
            isCurrent: () => true,
            onRetire: () => ({ dispose() {} }),
        } satisfies ActiveServerAccountScopeLifetime;
        let accountACurrent = true;
        const authorityA = authorityWithAccountLifetime(accountA);
        const authorityB = authorityWithAccountLifetime(accountB);
        const store = createPluginPageLaunchInputStore();
        const query = { pageId: NOTES_PAGE_ID, subPath: '' } as const;

        store.stage({
            authority: authorityA,
            pageId: query.pageId,
            subPath: query.subPath,
            input: { noteId: 'account-a' },
        });

        // A same-server Account transition keeps the historical triple intact,
        // so triple-only equality would expose Account A's input to Account B.
        expect(store.peek({ ...query, authority: authorityB })).toBeNull();

        accountACurrent = false;
        // The retirement callback fences before the next Account mounts; even a
        // stale render holding the same object cannot retrieve the old input.
        expect(store.peek({ ...query, authority: authorityA })).toBeNull();
    });

    it('refuses to stage a page open after its captured Account lifetime has retired', () => {
        let accountCurrent = true;
        const accountLifetime = {
            scope: { serverId: 'server-1', accountId: 'account-a' },
            isCurrent: () => accountCurrent,
            onRetire: () => ({ dispose() {} }),
        } satisfies ActiveServerAccountScopeLifetime;
        const staleAuthority = authorityWithAccountLifetime(accountLifetime);
        const store = createPluginPageLaunchInputStore();

        accountCurrent = false;

        // A late open from Account A must not remain in the handoff slot while
        // Account B is mounting. Delivery is already currentness-fenced, but
        // staging itself is the owner-local synchronous retirement boundary.
        expect(store.stage({
            authority: staleAuthority,
            pageId: NOTES_PAGE_ID,
            subPath: '',
            input: { noteId: 'late-account-a-open' },
        })).toBe(false);
        expect(store.peek({
            authority: staleAuthority,
            pageId: NOTES_PAGE_ID,
            subPath: '',
        })).toBeNull();
    });

    it('retires an open whose authority has been superseded', () => {
        const store = createPluginPageLaunchInputStore();
        stageOpen(store);

        store.retire(nextOccurrence);

        // Not merely undeliverable: the bounded JSON is dropped, so it cannot
        // outlive the account/occurrence that produced it inside one process.
        expect(store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: '' })).toBeNull();
    });

    it('retires a pending input when its page no longer has the exact selected origin', () => {
        const store = createPluginPageLaunchInputStore();
        stageOpen(store);

        store.resolveIngressAuthority(new Map([[NOTES_PAGE_ID, otherMachine]]));

        expect(store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: '' })).toBeNull();
        expect(store.peek({ authority: otherMachine, pageId: NOTES_PAGE_ID, subPath: '' })).toBeNull();
    });

    it('keeps an open that is still under the current authority', () => {
        const store = createPluginPageLaunchInputStore();
        stageOpen(store);

        store.retire(authority);

        expect(store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: '' })?.input)
            .toEqual({ noteId: 'a' });
    });

    it('settles a delivered open so a later navigation cannot inherit it', () => {
        const store = createPluginPageLaunchInputStore();
        stageOpen(store);
        const delivered = store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: '' });
        expect(delivered).not.toBeNull();

        store.settle(delivered!);

        expect(store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: '' })).toBeNull();
    });

    it('never lets a settled predecessor discard the open that replaced it', () => {
        const store = createPluginPageLaunchInputStore();
        stageOpen(store);
        const first = store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: '' });
        stageOpen(store, { input: { noteId: 'b' } });

        store.settle(first!);

        expect(store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: '' })?.input)
            .toEqual({ noteId: 'b' });
    });

    it('notifies subscribers on stage, settle and retire', () => {
        const store = createPluginPageLaunchInputStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);

        stageOpen(store);
        expect(listener).toHaveBeenCalledTimes(1);

        const delivered = store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: '' });
        store.settle(delivered!);
        expect(listener).toHaveBeenCalledTimes(2);

        stageOpen(store);
        store.retire(nextOccurrence);
        expect(listener).toHaveBeenCalledTimes(4);

        unsubscribe();
        stageOpen(store);
        expect(listener).toHaveBeenCalledTimes(4);
    });
});
