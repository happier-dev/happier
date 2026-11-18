import { describe, expect, it, vi } from 'vitest';
import { HEALTH_BUILTIN_WIDGET_IDS_V1, HOME_BUILTIN_WIDGET_IDS_V1, MACHINE_BUILTIN_WIDGET_IDS_V1, PROJECT_BUILTIN_WIDGET_IDS_V1, isProjectSurfaceBuiltinWidgetIdV1, SESSION_COMPANION_BUILTIN_ITEM_IDS, USAGE_BUILTIN_WIDGET_IDS_V1, WIDGET_SIZE_POLICY_V1, widgetCandidateDefinitionV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';

import { describeAuthoredWidgetDefinitionV1, selectBuiltinWidgetCandidates, type WidgetCandidate } from '@/components/widgets/widgetCatalog';

import { buildHomeWidgetAddSections } from './HomeWidgetAddPopover';
import { buildAccountWidgetAddSections } from './accountWidgetAddSections';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

/**
 * Add to Home (lab `dashboards` dbind G, dadd A): Home holds configured copies, counted by
 * definition; a widget with inputs can be added again and asks for what Home cannot fill (a Session),
 * one without inputs stays Added. Every add is one Home layout intent with a fresh instance id.
 */
const LATEST: WidgetCandidate = {
    surface: { pluginId: 'happier.triage', localId: 'latest' },
    key: 'happier.triage/latest',
    title: 'New for you',
    pluginName: 'PRs & Issues',
    sharedPluginName: false,
    icon: 'git-pull-request',
    homeDefault: 'shown',
    target: 'app',
    sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' },
};
const SUMMARY: WidgetCandidate = {
    surface: { pluginId: 'happier.sessions', localId: 'summary' },
    key: 'happier.sessions/summary',
    title: 'Summary',
    pluginName: 'Sessions',
    sharedPluginName: false,
    icon: 'chat-circle',
    homeDefault: 'available',
    target: 'session',
    sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' },
    sessionInputPath: 'session',
    inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json', required: true }] },
};
const copy = (id: string, candidate: WidgetCandidate, sessionId?: string): WidgetInstanceV1 => ({
    v: 1, id, definition: widgetCandidateDefinitionV1(candidate),
    bindings: sessionId ? { session: { kind: 'value', value: { serverId: 'home', sessionId } } } : {},
});

describe('Add to Home', () => {
    it('offers an inputless grid widget’s declared sizes in its pane, and none on a linear surface', () => {
        const addInstance = vi.fn(async () => {});
        const labels = { submit: 'Add', count: () => '' };
        const grid = { serverId: 'home', accountId: 'me', owner: { kind: 'home' as const } };
        const setup = (scope: Parameters<typeof buildAccountWidgetAddSections>[0]['scope'], widget = LATEST) =>
            buildAccountWidgetAddSections({ candidates: [widget], instances: [], addInstance, scope, labels })
                .find(section => section.id === 'plugin:happier.triage')!.entries[0]!.setup!();
        const choice = setup(grid);
        expect(choice.resolve(choice.initial).status).toBe('ready');
        expect(choice.initial.size).toBe('medium');
        expect(choice.sizeChoices?.sizes).toEqual(['small', 'medium', 'wide', 'full', 'tall', 'large']);
        expect(addInstance).not.toHaveBeenCalled();
        expect(setup(grid, { ...LATEST, sizeDeclaration: { sizes: ['small', 'wide'], defaultSize: 'wide' } }).sizeChoices?.sizes).toEqual(['small', 'wide']);
        expect(setup({ ...grid, owner: { kind: 'project', projectId: 'p' } }).sizeChoices).toBeUndefined();
        expect(setup({ ...grid, owner: { kind: 'companion', sessionId: 's' } }).sizeChoices).toBeUndefined();
    });
    it('adds selected size atomically through the existing add intent', async () => {
        const addInstance = vi.fn(async (_instance: WidgetInstanceV1, _size?: string) => {});
        const entry = buildHomeWidgetAddSections({ candidates: [{ ...SUMMARY,
            sizeDeclaration: { sizes: ['small', 'medium', 'large'], defaultSize: 'medium' } }], instances: [], addInstance,
            scope: { serverId: 'home', accountId: 'me', owner: { kind: 'home' } },
        }).find(section => section.id === 'plugin:happier.sessions')!.entries[0]!;
        const setup = entry.setup!();
        await setup.submit({ bindings: { session: { kind: 'value', value: { serverId: 'home', sessionId: 'C' } } }, size: 'large' });
        expect(addInstance).toHaveBeenCalledWith(expect.objectContaining({ bindings: { session: { kind: 'value',
            value: { serverId: 'home', sessionId: 'C' } } } }), 'large');
    });

    it('counts configured copies, keeps a widget without inputs Added, and asks Home for the Session', async () => {
        const addInstance = vi.fn(async (_instance: WidgetInstanceV1) => {});
        const entries = buildHomeWidgetAddSections({
            candidates: [LATEST, SUMMARY],
            instances: [copy('default:happier.triage/latest', LATEST), copy('a', SUMMARY, 'A'), copy('b', SUMMARY, 'B')],
            addInstance,
            scope: { serverId: 'home', accountId: 'me', owner: { kind: 'home' } },
        }).flatMap((section) => section.entries);
        const latest = entries.find((entry) => entry.id === 'plugin-happier.triage/latest')!;
        const summary = entries.find((entry) => entry.id === 'plugin-happier.sessions/summary')!;
        expect(latest.added).toBe(true);
        expect(summary.added).toBeUndefined();
        expect(summary.count).toBe('widgetAdd.countOnHome(count=2)');

        // Home has no Session of its own: the step is needed, nothing is borrowed.
        const setup = summary.setup!();
        expect(setup.submitLabel).toBe('widgetAdd.addToHome');
        expect(setup.initial.bindings).toEqual({});
        expect(setup.resolve(setup.initial).status).toBe('selection_required');

        const pinnedC = { bindings: { session: { kind: 'value' as const, value: { serverId: 'home', sessionId: 'C' } } } };
        expect(setup.resolve(pinnedC)).toEqual({ status: 'ready', input: { session: { serverId: 'home', sessionId: 'C' } } });
        await expect(setup.submit(pinnedC)).resolves.toEqual({ ok: true });
        expect(addInstance).toHaveBeenCalledTimes(1);
        const added = addInstance.mock.calls[0]![0];
        expect(added).toMatchObject({ v: 1, definition: { kind: 'installed', surface: SUMMARY.surface }, bindings: pinnedC.bindings });
        expect(['a', 'b']).not.toContain(added.id);
    });

    it('reports a refused Home write in the step instead of claiming it was added', async () => {
        const plugins = buildHomeWidgetAddSections({
            candidates: [SUMMARY],
            instances: [],
            addInstance: vi.fn(async () => { throw new Error('home_hub_scope_retired'); }),
            scope: null,
        }).find((section) => section.id === 'plugin:happier.sessions');
        const setup = plugins!.entries[0]!.setup!();
        await expect(setup.submit({ bindings: { session: { kind: 'value', value: { serverId: 'home', sessionId: 'C' } } } }))
            .resolves.toEqual({ ok: false, message: 'widgetAdd.addFailed' });
    });

    it('offers Happier’s own widgets in a Built in section ahead of each plugin’s widgets under its name, each asking Home for its Session', () => {
        const sections = buildHomeWidgetAddSections({
            candidates: [...selectBuiltinWidgetCandidates(), LATEST],
            instances: [],
            addInstance: vi.fn(async () => {}),
            scope: { serverId: 'home', accountId: 'me', owner: { kind: 'home' } },
        });
        expect(sections.map((section) => [section.id, section.title])).toEqual([
            ['builtins:machines', 'machines.widgets.machine_fleet'], ['builtins:usage', 'usage.board.page.title'],
            ['builtins:projects', 'tabs.projects'], ['builtins:session', 'widgetAdd.sessionDetails'], ['builtins', 'widgetAdd.builtIn'],
            ['plugin:happier.triage', 'PRs & Issues'],
        ]);
        const companion = sections.find(section => section.id === 'builtins:session')!.entries;
        expect(sections.filter(section => section.id.startsWith('builtins')).flatMap(section => section.entries.map(entry => entry.id)).sort()).toEqual([
            ...[...SESSION_COMPANION_BUILTIN_ITEM_IDS, ...PROJECT_BUILTIN_WIDGET_IDS_V1.filter(id => !isProjectSurfaceBuiltinWidgetIdV1(id)), ...USAGE_BUILTIN_WIDGET_IDS_V1, ...MACHINE_BUILTIN_WIDGET_IDS_V1, ...HOME_BUILTIN_WIDGET_IDS_V1, ...HEALTH_BUILTIN_WIDGET_IDS_V1].map(id => `plugin-builtin:${id}`),
        ].sort());
        expect(sections.find(section => section.id === 'plugin:happier.triage')!.entries.map((entry) => entry.id)).toEqual(['plugin-happier.triage/latest']);
        const setup = companion[0]!.setup!();
        expect(setup.provenance).toBe('widgetAdd.builtIn · widgetAdd.readsChosenSession');
        expect(setup.fields[0]!.field.optionsSourceId).toBe('sessions');
        expect(setup.resolve(setup.initial).status).toBe('selection_required');
    });

    it('offers the Account’s own definitions under Your widgets and adds a copy that references the one definition', async () => {
        const definition = { v: 1 as const, id: 'signups', name: 'Signups this week',
            provenance: { author: { kind: 'agent' as const }, createdAt: Date.UTC(2026, 9, 3, 12), source: { kind: 'authored' as const } },
            sizeDeclaration: { sizes: [...WIDGET_SIZE_POLICY_V1.home.sizes], defaultSize: WIDGET_SIZE_POLICY_V1.home.defaultSize },
            body: { kind: 'declarative' as const, document: { version: 1 as const, root: { kind: 'text' as const, text: 'Signups' } } },
            inputs: { fields: [] }, inputSchema: { type: 'object' as const, additionalProperties: false } };
        const yours = { ...describeAuthoredWidgetDefinitionV1(definition, { kind: 'artifact', artifactId: 'signups-artifact' }), pluginName: 'analytics replica' };
        const addInstance = vi.fn(async (_instance: WidgetInstanceV1) => {});
        const sections = buildHomeWidgetAddSections({
            candidates: [LATEST, yours],
            instances: [],
            addInstance,
            scope: { serverId: 'home', accountId: 'me', owner: { kind: 'home' } },
        });
        expect(sections.map((section) => section.id)).toEqual(['builtins', 'plugin:happier.triage', 'yours']);
        const plugins = sections.find((section) => section.id === 'plugin:happier.triage')!;
        expect(plugins.entries.map((entry) => entry.title)).toEqual(['New for you']);
        const entry = sections.find((section) => section.id === 'yours')!.entries[0]!;
        // The row says what it is for; where it comes from is the section and the pane's provenance.
        expect(entry).toMatchObject({ title: 'Signups this week', added: false });
        expect(entry.subtitle).toBeUndefined();
        const setup = entry.setup!();
        // Who made it and when come from the definition itself; its saved read names its source.
        expect(setup.provenance).toBe('widgetDefinition.yourWidget · widgetAdd.savedQueryOn(source=analytics replica), widgetAdd.madeByAgent(date=Oct 3)');
        await setup.submit(setup.initial);
        expect(addInstance).toHaveBeenCalledTimes(1);
        expect(addInstance.mock.calls[0]![0]).toMatchObject({ v: 1, definition: { kind: 'artifact', artifactId: 'signups-artifact' }, bindings: {} });
    });
});
