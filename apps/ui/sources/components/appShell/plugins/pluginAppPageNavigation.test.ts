import { describe, expect, it, vi } from 'vitest';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import {
    createPluginSurfaceLaunchAuthority,
    type PluginSurfaceLaunchAuthority,
} from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';

import { resolvePluginAppPages } from './pluginAppPages';
import {
    createPluginAppPageLaunchInputStore,
    createPluginAppPageOpenSurfaceHandler,
    resolvePluginAppPageLaunchAuthorities,
    type PluginAppPageLaunchOpen,
} from './pluginAppPageNavigation';

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
    const placement = {
        id: overrides.id ?? `surfacePlacement:${pluginId}:${descriptorId}`,
        pluginId,
        contributionKind: 'surfacePlacement',
        descriptorId,
        target: { kind: 'app' },
        renderer: { kind: 'reactNative', contributionId: 'notes-renderer' },
        display: { developerFallback: 'Notes' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        hostOrigin: pageHostOrigin({
            pluginId,
            machineId: 'machine-1',
            materializationId: `${descriptorId}-install-a`,
            generation: 9,
        }),
        ...overrides,
    };
    const binding = placement.binding ?? pageBinding(placement.pluginId, placement.descriptorId);
    return {
        ...placement,
        binding,
        target: binding.target,
    } as PluginUiSurfacePlacementProjection;
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
}>): Readonly<Record<string, unknown>> {
    return {
        machineId: input.machineId,
        serverId: 'server-1',
        generation: input.generation,
        interactionEnabled: true,
        executionOrigin: pageExecutionOrigin(input),
    };
}

const pages = resolvePluginAppPages({
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
        }),
    ],
});

const authority = createPluginSurfaceLaunchAuthority({
    serverId: 'server-1',
    machineId: 'machine-1',
    generation: 9,
});
const nextGeneration = createPluginSurfaceLaunchAuthority({
    serverId: 'server-1',
    machineId: 'machine-1',
    generation: 10,
});
const otherServer = createPluginSurfaceLaunchAuthority({
    serverId: 'server-2',
    machineId: 'machine-1',
    generation: 9,
});
const otherMachine = createPluginSurfaceLaunchAuthority({
    serverId: 'server-1',
    machineId: 'machine-2',
    generation: 9,
});
const selectedNotesMaterialization = createPluginSurfaceLaunchAuthority({
    serverId: 'server-1',
    machineId: 'machine-1',
    generation: 9,
    executionOrigin: pageExecutionOrigin({
        pluginId: NOTES_PLUGIN_ID,
        machineId: 'machine-1',
        materializationId: 'notes-install-a',
    }),
});
const replacementNotesMaterialization = createPluginSurfaceLaunchAuthority({
    serverId: 'server-1',
    machineId: 'machine-1',
    generation: 9,
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
    const open = createPluginAppPageOpenSurfaceHandler({
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
    store: ReturnType<typeof createPluginAppPageLaunchInputStore>,
    overrides: Partial<PluginAppPageLaunchOpen> = {},
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
        generation: 9,
        accountLifetime: lifetime,
    });
}

describe('plugin app page host navigation (EU-5b)', () => {
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
            { pageId: NOTES_PAGE_ID, subPath: '', input: { noteId: 'a' } },
            { pageId: NOTES_PAGE_ID, subPath: '', input: undefined },
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

    it('does not navigate when the page scope cannot prove the exact selected contribution origin', async () => {
        const navigate = vi.fn();
        const open = createPluginAppPageOpenSurfaceHandler({
            pages,
            placements: pages.map((page) => page.placement),
            navigate,
            // The navigation owner is not allowed to substitute its ambient
            // union machine when exact page authority is absent.
            stageLaunchInput: () => false,
        });

        expect(await open({ destination: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' } })).toEqual({
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
    it('maps two pages to their own selected contribution origins, never the app union', () => {
        const pagesWithDistinctOrigins = resolvePluginAppPages({
            placements: [
                createPagePlacement({
                    id: `surfacePlacement:${NOTES_PLUGIN_ID}:notes`,
                    pluginId: NOTES_PLUGIN_ID,
                    descriptorId: 'notes',
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
                    hostOrigin: pageHostOrigin({
                        pluginId: JOURNAL_PLUGIN_ID,
                        machineId: 'machine-b',
                        materializationId: 'journal-b',
                        generation: 12,
                    }),
                }),
            ],
        });

        const authorities = resolvePluginAppPageLaunchAuthorities({
            pages: pagesWithDistinctOrigins,
            accountLifetime: null,
        });

        expect(authorities.get(NOTES_PAGE_ID)).toMatchObject({
            machineId: 'machine-a',
            serverId: 'server-1',
            generation: 11,
            executionOrigin: pageExecutionOrigin({
                pluginId: NOTES_PLUGIN_ID,
                machineId: 'machine-a',
                materializationId: 'notes-a',
            }),
        });
        expect(authorities.get(JOURNAL_PAGE_ID)).toMatchObject({
            machineId: 'machine-b',
            serverId: 'server-1',
            generation: 12,
            executionOrigin: pageExecutionOrigin({
                pluginId: JOURNAL_PLUGIN_ID,
                machineId: 'machine-b',
                materializationId: 'journal-b',
            }),
        });
    });

    it('delivers a pending open only at the location it was addressed to', () => {
        const store = createPluginAppPageLaunchInputStore();
        stageOpen(store, { subPath: 'work' });

        expect(store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: 'work' })?.input)
            .toEqual({ noteId: 'a' });
        expect(store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: '' })).toBeNull();
        expect(store.peek({ authority, pageId: NOTES_ARCHIVE_PAGE_ID, subPath: 'work' })).toBeNull();
    });

    it('refuses to deliver an open into a different authority', () => {
        const store = createPluginAppPageLaunchInputStore();
        stageOpen(store);

        const query = { pageId: NOTES_PAGE_ID, subPath: '' } as const;
        expect(store.peek({ ...query, authority })?.input).toEqual({ noteId: 'a' });
        // A replaced generation, another server/account and another contributing
        // machine are each a different producer of the same qualified page.
        expect(store.peek({ ...query, authority: nextGeneration })).toBeNull();
        expect(store.peek({ ...query, authority: otherServer })).toBeNull();
        expect(store.peek({ ...query, authority: otherMachine })).toBeNull();
    });

    it('refuses a same-coordinate input when the selected materialization changes', () => {
        const store = createPluginAppPageLaunchInputStore();
        store.stage({
            authority: selectedNotesMaterialization,
            pageId: NOTES_PAGE_ID,
            subPath: '',
            input: { noteId: 'old-install' },
        });

        // Machine/server/generation alone are insufficient after a plugin is
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
        const store = createPluginAppPageLaunchInputStore();
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
        const store = createPluginAppPageLaunchInputStore();

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
        const store = createPluginAppPageLaunchInputStore();
        stageOpen(store);

        store.retire(nextGeneration);

        // Not merely undeliverable: the bounded JSON is dropped, so it cannot
        // outlive the account/generation that produced it inside one process.
        expect(store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: '' })).toBeNull();
    });

    it('retires a pending input when its page no longer has the exact selected origin', () => {
        const store = createPluginAppPageLaunchInputStore();
        stageOpen(store);

        store.retireOutside([otherMachine]);

        expect(store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: '' })).toBeNull();
    });

    it('keeps an open that is still under the current authority', () => {
        const store = createPluginAppPageLaunchInputStore();
        stageOpen(store);

        store.retire(authority);

        expect(store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: '' })?.input)
            .toEqual({ noteId: 'a' });
    });

    it('settles a delivered open so a later navigation cannot inherit it', () => {
        const store = createPluginAppPageLaunchInputStore();
        stageOpen(store);
        const delivered = store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: '' });
        expect(delivered).not.toBeNull();

        store.settle(delivered!);

        expect(store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: '' })).toBeNull();
    });

    it('never lets a settled predecessor discard the open that replaced it', () => {
        const store = createPluginAppPageLaunchInputStore();
        stageOpen(store);
        const first = store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: '' });
        stageOpen(store, { input: { noteId: 'b' } });

        store.settle(first!);

        expect(store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: '' })?.input)
            .toEqual({ noteId: 'b' });
    });

    it('notifies subscribers on stage, settle and retire', () => {
        const store = createPluginAppPageLaunchInputStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);

        stageOpen(store);
        expect(listener).toHaveBeenCalledTimes(1);

        const delivered = store.peek({ authority, pageId: NOTES_PAGE_ID, subPath: '' });
        store.settle(delivered!);
        expect(listener).toHaveBeenCalledTimes(2);

        stageOpen(store);
        store.retire(nextGeneration);
        expect(listener).toHaveBeenCalledTimes(4);

        unsubscribe();
        stageOpen(store);
        expect(listener).toHaveBeenCalledTimes(4);
    });
});
