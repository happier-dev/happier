import { describe, expect, it, vi } from 'vitest';
import { widgetCandidateDefinitionV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';

import { describeAuthoredWidgetDefinitionV1, selectBuiltinWidgetCandidates, type WidgetCandidate } from '@/components/widgets/widgetCatalog';

import { buildHomeWidgetAddSections } from './HomeWidgetAddPopover';

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
    sessionInputPath: 'session',
    inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json', required: true }] },
};
const copy = (id: string, candidate: WidgetCandidate, sessionId?: string): WidgetInstanceV1 => ({
    v: 1, id, definition: widgetCandidateDefinitionV1(candidate),
    bindings: sessionId ? { session: { kind: 'value', value: { serverId: 'home', sessionId } } } : {},
});

describe('Add to Home', () => {
    it('counts configured copies, keeps a widget without inputs Added, and asks Home for the Session', async () => {
        const addInstance = vi.fn(async (_instance: WidgetInstanceV1) => {});
        const plugins = buildHomeWidgetAddSections({
            candidates: [LATEST, SUMMARY],
            instances: [copy('default:happier.triage/latest', LATEST), copy('a', SUMMARY, 'A'), copy('b', SUMMARY, 'B')],
            addInstance,
            scope: { serverId: 'home', accountId: 'me', owner: { kind: 'home' } },
        }).find((section) => section.id === 'plugins');
        const latest = plugins!.entries.find((entry) => entry.id === 'plugin-happier.triage/latest')!;
        const summary = plugins!.entries.find((entry) => entry.id === 'plugin-happier.sessions/summary')!;
        expect(latest.added).toBe(true);
        expect(latest.setup).toBeUndefined();
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
        }).find((section) => section.id === 'plugins');
        const setup = plugins!.entries[0]!.setup!();
        await expect(setup.submit({ bindings: { session: { kind: 'value', value: { serverId: 'home', sessionId: 'C' } } } }))
            .resolves.toEqual({ ok: false, message: 'widgetAdd.addFailed' });
    });

    it('offers Happier’s own widgets in a Built in section ahead of plugin widgets, each asking Home for its Session', () => {
        const sections = buildHomeWidgetAddSections({
            candidates: [...selectBuiltinWidgetCandidates(), LATEST],
            instances: [],
            addInstance: vi.fn(async () => {}),
            scope: { serverId: 'home', accountId: 'me', owner: { kind: 'home' } },
        });
        expect(sections.map((section) => section.id)).toEqual(['builtins', 'plugins']);
        const builtIn = sections[0]!.entries;
        expect(builtIn.map((entry) => entry.id)).toEqual([
            'plugin-builtin:session_summary', 'plugin-builtin:agent_plan', 'plugin-builtin:changes', 'plugin-builtin:local_services',
        ]);
        expect(sections[1]!.entries.map((entry) => entry.id)).toEqual(['plugin-happier.triage/latest']);
        const setup = builtIn[0]!.setup!();
        expect(setup.fields[0]!.field.optionsSourceId).toBe('sessions');
        expect(setup.resolve(setup.initial).status).toBe('selection_required');
    });

    it('offers the Account’s own definitions under Your widgets and adds a copy that references the one definition', async () => {
        const definition = { v: 1 as const, id: 'signups', name: 'Signups this week', provenance: { source: { kind: 'authored' as const } },
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
        expect(sections.map((section) => section.id)).toEqual(['builtins', 'plugins', 'yours']);
        const plugins = sections.find((section) => section.id === 'plugins')!;
        expect(plugins.entries.map((entry) => entry.title)).toEqual(['New for you']);
        const entry = sections.find((section) => section.id === 'yours')!.entries[0]!;
        expect(entry).toMatchObject({ title: 'Signups this week', subtitle: 'analytics replica', added: false });
        entry.onPick();
        await Promise.resolve();
        expect(addInstance).toHaveBeenCalledTimes(1);
        expect(addInstance.mock.calls[0]![0]).toMatchObject({ v: 1, definition: { kind: 'artifact', artifactId: 'signups-artifact' }, bindings: {} });
    });
});

