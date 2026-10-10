import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';
import { getStorage } from '@/sync/domains/state/storage';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { buildWidgetSurfaceArtifactHeaderV1, buildWidgetSurfaceArtifactIdV1, WidgetAreaLayoutV1Schema,
    WIDGET_SURFACE_ARTIFACT_KIND_V1, type WidgetAreaLayoutV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createLayoutArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { CurrentUiContextProvider, useOptionalCurrentUiContextReader, type CurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { createCurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { executeCurrentUiContextAction, registerCurrentUiContextActionPort } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { SelectionListFilterChip } from '@/components/ui/selectionList/SelectionListFilterChips';
import { UsageWidgetBody } from './widgets/UsageWidgetBody';
import { UsagePeriodSummaryWidget } from './widgets/UsagePeriodSummaryWidget';
import { UsageWidgetPage } from './UsageWidgetPage';
import { getUsagePeriodDefinition } from '@/sync/api/account/usagePeriods';
import { t } from '@/text';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/settings/usage', segments: ['(app)', 'settings', 'usage'] }).module;
});

const totals: UsageAnalyticsQueryResponse['totals'] = { eventCount: 1,
    tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } };
const accounting: UsageAnalyticsQueryResponse = { v: 1, totals, breakdowns: {
    agent: ['claude', 'codex', 'pi'].map(key => ({ key, ...totals })),
    machine: ['machine-a', 'machine-b', 'machine-c'].map(key => ({ key, ...totals })),
    source: ['native', 'runtime', 'legacy'].map(key => ({ key, ...totals })),
    project: ['project-a', 'project-b', 'project-c'].map(key => ({ key, ...totals })),
} };
let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let reader: CurrentUiContextReader | null = null;
let unregister: (() => void) | undefined;

function CurrentContextPort() {
    reader = useOptionalCurrentUiContextReader();
    React.useEffect(() => {
        if (!reader) return;
        const current = reader;
        unregister = registerCurrentUiContextActionPort(surface => createCurrentUiContextVoiceToolPort({
            reader: current, invocationSurface: surface, readProjection: () => null, readNavigationBinding: () => null,
        }));
        return unregister;
    }, [reader]);
    return null;
}

afterEach(() => {
    standardCleanup(); unregister?.(); unregister = undefined; reader = null;
    retireActiveServerAccountScopeLifetime(); invalidateUsageQueryResources(); home?.dispose(); home = undefined;
});

describe('mounted Usage page scope commands', () => {
    it('publishes the toolbar choices, toggles multiple dimensions through the same bindings and refuses retired descriptors', async () => {
        let artifact: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | undefined;
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-page-filters.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] })
                : request.path === '/v2/usage/query' ? Response.json(accounting)
                : artifact?.request(request.url, { method: request.method }) });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const surface: WidgetSurfaceRefV1 = { serverId: server.id, accountId: 'account-a',
            owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' } };
        const followed = Object.fromEntries(['period', 'agents', 'machines', 'projects', 'sources', 'session', 'costBasis']
            .map(slot => [slot, { kind: 'context' as const, slot }]));
        const layout = WidgetAreaLayoutV1Schema.parse({ v: 1, surface, items: [
            { kind: 'group', id: 'following', children: [{ kind: 'widget', instance: { v: 1, id: 'following-body',
                definition: { kind: 'builtin', id: 'usage_period_summary' }, bindings: { ...followed,
                    metric: { kind: 'value', value: 'tokens' }, breakdown: { kind: 'value', value: ['agent'] } } } }] },
            { kind: 'group', id: 'pinned', context: { period: { kind: 'value', value: { startMs: 1000, endMs: 2000 } } }, children: [{ kind: 'widget', instance: { v: 1, id: 'pinned-body',
                definition: { kind: 'builtin', id: 'usage_period_summary' }, bindings: { ...followed,
                    metric: { kind: 'value', value: 'cost' }, breakdown: { kind: 'value', value: ['model'] } } } }] },
        ] });
        artifact = createLayoutArtifactHttpBoundary('account-a', { artifactId: buildWidgetSurfaceArtifactIdV1(surface),
            kind: WIDGET_SURFACE_ARTIFACT_KIND_V1, defaultLayout: layout, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
            buildHeader: buildWidgetSurfaceArtifactHeaderV1 });
        artifact.seed(layout);
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><UsageWidgetPage />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        await flushHookEffects({ cycles: 40 });
        const published = await executeCurrentUiContextAction({ actionId: 'ui.current_context.read', input: {}, context: { surface: 'ui' } });
        expect(published).toMatchObject({ ok: true, result: { entity: { kind: 'usage_summary' } } });
        const invoke = async (title: string) => {
            const descriptor = reader?.readCurrentUiContext()?.commands.find(command => command.title === title);
            expect(descriptor, `mounted command: ${title}`).toBeDefined();
            await act(async () => {
                const result = await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
                    input: { commandId: descriptor!.id }, context: { surface: 'ui' } });
                expect(result.ok).toBe(true);
            });
            await flushHookEffects({ cycles: 30 });
            return descriptor!.id;
        };
        const chip = (field: string) => screen.findAllByType(SelectionListFilterChip)
            .find(node => node.props.filter.id === field)!.props.filter;
        const choice = (field: string, value: string) => chip(field).options.find((option: { id: string }) => option.id === value)!.label;
        // UI scope intents must obey the same Action admission as agent commands.
        const settings = getStorage().getState().settings;
        const scope = { serverId: server.id, accountId: 'account-a' };
        await act(async () => {
            getStorage().getState().applySettingsForScope(scope, { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
                v: 1, actions: { 'ui.current_context.command.invoke': { disabledSurfaces: ['ui'] } },
            }) }, 2);
            await chip('agents').onChange('claude');
        });
        await flushHookEffects({ cycles: 20 });
        expect(screen.findAllByType(UsageWidgetBody).every(node => normalizeUsageQuery(node.props.input).agents.length === 0)).toBe(true);
        await act(async () => { getStorage().getState().applySettingsForScope(scope, settings, 3); });
        await flushHookEffects({ cycles: 10 });
        // Losing the mounted dispatcher must not fall back to a raw page setter.
        unregister?.();
        await act(async () => { await chip('agents').onChange('claude'); });
        await flushHookEffects({ cycles: 10 });
        expect(screen.findAllByType(UsageWidgetBody).every(node => normalizeUsageQuery(node.props.input).agents.length === 0)).toBe(true);
        const currentReader = reader!;
        unregister = registerCurrentUiContextActionPort(surface => createCurrentUiContextVoiceToolPort({
            reader: currentReader, invocationSurface: surface, readProjection: () => null, readNavigationBinding: () => null,
        }));
        const oldId = await invoke(`${chip('agents').label}: ${choice('agents', 'codex')}`);
        await act(async () => { chip('agents').onChange('claude'); });
        await flushHookEffects({ cycles: 30 });
        await invoke(`${chip('machines').label}: ${choice('machines', 'machine-a')}`);
        await invoke(`${chip('sources').label}: ${choice('sources', 'native')}`);
        await invoke(`${chip('projects').label}: ${choice('projects', 'project-a')}`);
        const bodies = () => screen.findAllByType(UsageWidgetBody).map(node => normalizeUsageQuery(node.props.input));
        expect(bodies()).toHaveLength(2);
        for (const input of bodies()) expect(input).toMatchObject({ agents: ['claude', 'codex'], machines: ['machine-a'],
            sources: ['native'], projects: ['project-a'] });
        expect(bodies()).toEqual(expect.arrayContaining([
            expect.objectContaining({ period: { startMs: 1000, endMs: 2000 }, metric: 'cost', breakdown: ['model'] }),
            expect.objectContaining({ metric: 'tokens', breakdown: ['agent'] }),
        ]));
        const shownQueries = () => screen.findAllByType(UsagePeriodSummaryWidget).map(node => normalizeUsageQuery(node.props.query));
        expect(shownQueries()).toHaveLength(2);
        for (const query of shownQueries()) expect(query).toMatchObject({ agents: ['claude', 'codex'], machines: ['machine-a'],
            sources: ['native'], projects: ['project-a'] });
        const previousFollowingPeriod = shownQueries().find(query => query.metric === 'tokens')!.period;
        await invoke(t(getUsagePeriodDefinition('30days').translationKey));
        expect(shownQueries().find(query => query.metric === 'tokens')!.period).not.toEqual(previousFollowingPeriod);
        expect(shownQueries().find(query => query.metric === 'cost')).toMatchObject({
            period: { startMs: 1000, endMs: 2000 }, metric: 'cost', breakdown: ['model'],
        });
        const allAgents = chip('agents').options[0].label;
        await invoke(`${chip('agents').label}: ${allAgents}`);
        expect(bodies().every(input => input.agents.length === 0)).toBe(true);
        expect(bodies().every(input => input.machines[0] === 'machine-a')).toBe(true);
        await invoke(`${chip('agents').label}: ${choice('agents', 'pi')}`);
        await invoke(`${chip('agents').label}: ${choice('agents', 'pi')}`);
        expect(bodies().every(input => input.agents.length === 0)).toBe(true);
        const stale = await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
            input: { commandId: oldId }, context: { surface: 'ui' } });
        expect(stale).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
        expect(bodies().every(input => input.agents.length === 0)).toBe(true);
        const currentId = reader!.readCurrentUiContext()!.commands[0]!.id;
        await act(async () => retireActiveServerAccountScopeLifetime());
        const retired = await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
            input: { commandId: currentId }, context: { surface: 'ui' } });
        expect(retired.ok).toBe(false);
    });
});
