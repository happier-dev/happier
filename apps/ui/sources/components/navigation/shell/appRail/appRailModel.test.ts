import { describe, expect, it, vi } from 'vitest';
import type { SessionOrganizationMoveInput } from '@happier-dev/protocol/actions/sessionOrganizationMoveAction';
import { treeRowId } from '@/components/sessions/shell/drop-resolution/treeRowId';

import type { PluginAppPage } from '@/components/appShell/plugins/pluginAppPages';
import {
    isCompactAppDestinationInvokable,
    isCompactAppDestinationVisible,
    resolveCompactAppDestinations,
} from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { createSessionFixture } from '@/dev/testkit';
import { buildSessionOrganizationProjection, buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';

import {
    buildAppRailEntries,
    buildAppRailPlacementItems,
    resolveAppRailEntryColumn,
    resolveAppShellLocation,
    resolveAppRailBotDropDestinationKey,
} from './appRailModel';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

function page(
    localId: string,
    placement?: PluginAppPage['requestedPlacement'],
    rankHint?: number,
    extra: Partial<PluginAppPage> = {},
): PluginAppPage {
    return {
        ...extra,
        id: `plugin:acme.${localId}:${localId}`,
        pluginId: `acme.${localId}`,
        descriptorId: localId,
        localId,
        label: localId,
        icon: 'note',
        order: 10,
        disabledReason: null,
        ...(placement === undefined ? {} : { requestedPlacement: placement }),
        ...(rankHint === undefined ? {} : { rankHint }),
        placement: {} as PluginAppPage['placement'],
        routePath: `/plugins/acme.${localId}/${localId}`,
    } as PluginAppPage;
}

const SESSIONS_COLUMN = { kind: 'column', column: 'sessions' } as const;

function catalog(pages: readonly PluginAppPage[], externalSessions = true) {
    return resolveCompactAppDestinations({
        builtins: { externalSessions, inbox: true, workflows: true, friends: false },
        pages,
    });
}

const ids = (entries: readonly { id: string }[]) => entries.map((entry) => entry.id);

describe('app rail model', () => {
    it('puts rail destinations in their region, and a column destination in its column instead of on the rail', () => {
        const rail = buildAppRailEntries(catalog([page('triage', undefined, 1), page('notes', SESSIONS_COLUMN), page('board', { kind: 'rail' }, 0)]));

        expect(ids(rail.app)).toEqual(['sessions', 'search', 'inbox', 'projects', 'workflows', 'boards', 'artifacts', 'bots']);
        // Plugins anchors its region, then plugin pages by rank.
        expect(ids(rail.plugins)).toEqual(['plugins', 'plugin:acme.board:board', 'plugin:acme.triage:triage']);
        expect(ids(rail.account)).toEqual(['settings']);
        // Browse external sessions and the notes page belong to the Sessions column, not the rail.
        expect(ids([...rail.app, ...rail.plugins, ...rail.account])).not.toContain('browseExistingSessions');
        expect(ids([...rail.app, ...rail.plugins, ...rail.account])).not.toContain('plugin:acme.notes:notes');
    });

    it('lists Machines once on the rail and in its customizer (its footer control), while the palette can open it', () => {
        const destinations = catalog([]);
        const entries = buildAppRailEntries(destinations, { includeHidden: true });
        expect(ids([...entries.app, ...entries.plugins, ...entries.account])).not.toContain('machines');
        const items = buildAppRailPlacementItems(entries, false);
        expect(items.filter(item => item.id === 'machines' || item.id === 'app-rail-machines').map(item => item.id))
            .toEqual(['app-rail-machines']);
        // The command palette lists every visible, invokable destination: Machines is one (MPG-34).
        const machines = destinations.find(destination => destination.id === 'machines');
        expect(machines && isCompactAppDestinationVisible(machines) && isCompactAppDestinationInvokable(machines)).toBe(true);
        expect(machines?.routePath).toBe('/machines');
    });

    it('projects only explicit rail-pinned Bots, keeping demoted choices for re-promotion', () => {
        const bot = (id: string) => createSessionFixture({ id, metadata: { path: '/repo', host: 'host', bot: { kind: 'bot' } } });
        const regular = createSessionFixture({ id: 'ordinary' });
        const pin = (sessionId: string, sortKey: string, listPinned: boolean, railPinned: boolean) =>
            ({ sessionId, sortKey, pinnedAt: 1, listPinned, railPinned });
        const rows = [
            { serverId: 'home-a', session: bot('list-only'), pin: pin('list-only', 'a', true, false) },
            { serverId: 'home-a', session: regular, pin: pin('ordinary', 'b', true, true) },
            { serverId: 'home-a', session: bot('second'), pin: pin('second', 'd', true, true) },
            { serverId: 'home-a', session: bot('first'), pin: pin('first', 'c', false, true) },
            { serverId: 'home-b', session: bot('first'), pin: pin('first', 'a', false, true) },
        ];
        const botHomes = (entries: typeof rows) => [...new Set(entries.map(row => row.serverId))].map(serverId => {
            const homeRows = entries.filter(row => row.serverId === serverId);
            return { serverId,
                rowsBySessionId: Object.fromEntries(homeRows.map(row => [row.session.id, row.session])),
                organization: buildSessionOrganizationProjection({
                    schemaVersionByServerId: {}, snapshotVersionByServerId: {},
                    appearancesBySessionKey: {}, sessionAppearancesSupportedByServerId: {},
                    pinsBySessionKey: Object.fromEntries(homeRows.map(row => [buildSessionOrganizationSessionKey(serverId, row.session.id), row.pin])),
                    foldersByFolderKey: {}, folderAssignmentsBySessionKey: {}, tagsByTagKey: {}, tagAssignmentsBySessionKey: {},
                    attentionStandingsBySessionKey: {}, orderEntriesByScopeKey: {}, labelsByLabelKey: {},
                }, serverId),
            };
        });
        const entries = buildAppRailEntries(catalog([]), { botHomes: botHomes(rows) });
        expect(entries.app.filter(entry => entry.id === 'bots')).toHaveLength(1);
        expect(entries.bots.map(entry => [entry.serverId, entry.sessionId])).toEqual([
            ['home-a', 'first'], ['home-a', 'second'], ['home-b', 'first'],
        ]);
        const promoted = buildAppRailEntries(catalog([]), { botHomes: botHomes(rows.map(row => row.session.id === 'ordinary'
            ? { ...row, session: bot('ordinary') } : row)) });
        expect(promoted.bots.map(entry => entry.sessionId)).toContain('ordinary');
        // The membership record is untouched by demotion; projecting again restores its explicit choice.
        expect(buildAppRailEntries(catalog([]), { botHomes: botHomes(rows) }).bots).toEqual(entries.bots);
    });

    it('derives the open rail entry and the column beside the page from the one current destination', () => {
        const destinations = catalog([page('triage'), page('notes', SESSIONS_COLUMN)]);
        const at = (pathname: string) => {
            const location = resolveAppShellLocation(destinations, pathname);
            return [location.current?.id ?? null, location.railEntryId, location.column.kind === 'builtin' ? location.column.id : location.column.kind];
        };
        expect(at('/')).toEqual(['sessions', 'sessions', 'sessions']);
        expect(at('/session/abc')).toEqual(['sessions', 'sessions', 'sessions']);
        expect(at('/runs')).toEqual([null, null, 'none']);
        expect(at('/new/pick/server')).toEqual([null, null, 'none']);
        // A column destination opens its page beside its column, with the column's owner open on the rail.
        expect(at('/external/browse')).toEqual(['browseExistingSessions', 'sessions', 'sessions']);
        expect(at('/plugins/acme.notes/notes/today')).toEqual(['plugin:acme.notes:notes', 'sessions', 'sessions']);
        expect(at('/inbox/approvals')).toEqual(['inbox', 'inbox', 'none']);
        // Projects stands its column beside every project page and the index.
        expect(at('/projects')).toEqual(['projects', 'projects', 'projects']);
        expect(at('/projects/ws-1/code')).toEqual(['projects', 'projects', 'projects']);
        // Workflows stands its column beside the library, the editor and every run (FIN 04 §3.1).
        expect(at('/workflows')).toEqual(['workflows', 'workflows', 'workflows']);
        expect(at('/workflows/runs/run-1')).toEqual(['workflows', 'workflows', 'workflows']);
        // What remains of the Automation pages opens inside Workflows, beside its column.
        expect(at('/automations/a-1')).toEqual(['workflows', 'workflows', 'workflows']);
        expect(at('/plugins')).toEqual(['plugins', 'plugins', 'plugins']);
        expect(at('/plugins/acme.tools')).toEqual(['plugins', 'plugins', 'plugins']);
        expect(at('/plugins/acme.triage/triage/pr/1')).toEqual(['plugin:acme.triage:triage', 'plugin:acme.triage:triage', 'none']);
        expect(at('/settings/appearance')).toEqual(['settings', 'settings', 'settings']);
        // The rail door of the Machines page: the machine list as its column, the Machines rail item open (R1).
        expect(at('/machines')).toEqual(['machines', 'machines', 'machines']);
        expect(at('/machines/m-1')).toEqual(['machines', 'machines', 'machines']);
        expect(at('/machines/m-1/doctor')).toEqual(['machines', 'machines', 'machines']);
        // The Settings door keeps the Settings column.
        expect(at('/settings/machines/m-1')).toEqual(['settings', 'settings', 'settings']);
        // A Home's console keeps the settings navigation beside its own.
        expect(at('/settings/home/srv%201/people/acc')).toEqual(['settings', 'settings', 'settings']);
        expect(at('/search')).toEqual(['search', 'search', 'none']);
        expect(at('/artifacts')).toEqual(['artifacts', 'artifacts', 'none']);
        expect(at('/artifacts/artifact-1')).toEqual(['artifacts', 'artifacts', 'none']);
    });

    it("stands a plugin page's own column beside it, and peeks it from its rail icon", () => {
        const withColumn = page('triage', undefined, undefined, { columnPlacement: {} as PluginAppPage['placement'] });
        const destinations = catalog([withColumn, page('notes')]);
        const location = resolveAppShellLocation(destinations, '/plugins/acme.triage/triage/views/mine');
        expect(location.railEntryId).toBe('plugin:acme.triage:triage');
        expect(location.column).toEqual({ kind: 'plugin', destinationId: 'plugin:acme.triage:triage' });
        // The model is referentially stable for the same destination.
        expect(resolveAppShellLocation(destinations, '/plugins/acme.triage/triage').column).toBe(location.column);
        const rail = buildAppRailEntries(destinations);
        expect(resolveAppRailEntryColumn(rail.plugins.find((entry) => entry.id === 'plugin:acme.triage:triage')!))
            .toBe(location.column);
        expect(resolveAppRailEntryColumn(rail.plugins.find((entry) => entry.id === 'plugin:acme.notes:notes')!)).toBeNull();
    });

    it('reserves and peeks no column for an unavailable plugin page, whose column renderer mounts nothing', () => {
        const disabled = { ...page('triage', undefined, undefined, { columnPlacement: {} as PluginAppPage['placement'] }), disabledReason: 'plugin_disabled' } as PluginAppPage;
        const destinations = catalog([disabled]);
        expect(resolveAppShellLocation(destinations, '/plugins/acme.triage/triage').column).toEqual({ kind: 'none' });
        const entry = buildAppRailEntries(destinations).plugins.find((candidate) => candidate.id === 'plugin:acme.triage:triage');
        expect(entry && resolveAppRailEntryColumn(entry)).toBeFalsy();
    });

    it('never places a plugin in the Settings column: settings contributions are settings pages', () => {
        const destinations = catalog([page('prefs', { kind: 'column', column: 'settings' })]);
        expect(destinations.find((destination) => destination.id === 'plugin:acme.prefs:prefs')?.placement)
            .toEqual({ kind: 'rail', region: 'plugins' });
    });

    it('peeks only the rail entries whose destination has a column', () => {
        const rail = buildAppRailEntries(catalog([page('notes')]));
        const columns = Object.fromEntries([...rail.app, ...rail.plugins, ...rail.account].map((entry) => {
            const column = resolveAppRailEntryColumn(entry);
            return [entry.id, column?.kind === 'builtin' ? column.id : column?.kind ?? null];
        }));
        expect(columns).toMatchObject({
            sessions: 'sessions', search: null, inbox: null, projects: 'projects', workflows: 'workflows',
            plugins: 'plugins', 'plugin:acme.notes:notes': null, settings: 'settings',
        });
    });
});


it('keys rail moves by the resulting shared pin position, including list-only pins', () => {
    const scope = { serverId: 'home', accountId: 'account' };
    const move = (target: string, instructionKind: 'reorder-before' | 'reorder-after'): SessionOrganizationMoveInput => ({
        scope, projection: 'rail', sourceKind: 'leaf', sourceRowId: treeRowId.session('home', 'moving'),
        targetRowId: treeRowId.session('home', target), instructionKind, containerId: 'pinned', parentRowId: null, depth: 0,
        edge: instructionKind === 'reorder-before' ? 'top' : 'bottom',
    });
    const pins = ['a', 'b', 'c', 'moving'];
    const gap = resolveAppRailBotDropDestinationKey?.(move('a', 'reorder-after'), pins);
    expect(gap).toEqual(expect.any(String));
    expect(resolveAppRailBotDropDestinationKey?.(move('b', 'reorder-before'), pins)).toBe(gap);
    expect(resolveAppRailBotDropDestinationKey?.(move('c', 'reorder-after'), pins)).not.toBe(gap);
    const sharedPins = ['a', 'list-only', 'b', 'moving'];
    expect(resolveAppRailBotDropDestinationKey?.(move('a', 'reorder-after'), sharedPins))
        .not.toBe(resolveAppRailBotDropDestinationKey?.(move('b', 'reorder-before'), sharedPins));
});
