import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { CollectionSessionRequestPeekData } from '@/components/ui/lists/collection/CollectionSessionRequestPeekData';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { getStorage } from '@/sync/domains/state/storage';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { CurrentUiContextProvider, useOptionalCurrentUiContextReader, usePublishCurrentUiContext, type CurrentUiContextReader } from './CurrentUiContextProvider';
import { createCurrentUiContextVoiceToolPort } from './currentUiContextVoiceToolPort';
import { executeCurrentUiContextAction, registerCurrentUiContextActionPort } from './currentUiContextActionRuntime';
import { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands, useCurrentUiContextLocalCommands } from './CurrentUiContextCommands';
import { t } from '@/text';

const routeState = vi.hoisted(() => ({ pathname: '/settings/usage', segments: ['(app)', 'settings', 'usage'] }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => routeState.pathname, segments: () => routeState.segments }).module;
});

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let reader: CurrentUiContextReader | null = null;
let unregister: (() => void) | undefined;
const intents = new Map<string, (key: string) => Promise<boolean>>();
const changes: string[] = [];

function Publication(props: Readonly<{ author?: boolean }> = {}) {
    reader = useOptionalCurrentUiContextReader();
    const commands = useCurrentUiContextComposedCommands();
    const authorCommands = React.useMemo(() => [{ title: 'Author details', command: { kind: 'hostLocal' as const,
        invoke: () => { changes.push('author'); return { ok: true as const }; } } }], []);
    const enrichment = React.useMemo(() => ({ commands: props.author ? authorCommands : commands }), [authorCommands, commands, props.author]);
    usePublishCurrentUiContext(enrichment);
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

function Descendant(props: Readonly<{ id: string; value: string }>) {
    // Inline callbacks model body renders: publication must not cause a registration loop.
    const commands = useCurrentUiContextLocalCommands([{ key: 'details', title: `${props.id} details`,
        invoke: () => { changes.push(props.value); } }]);
    intents.set(props.id, commands.invoke);
    return null;
}

function ComposedPage(props: Readonly<{ authority: ServerAccountScopeLifetime | null; second?: boolean; value?: string }>) {
    return <CurrentUiContextCommandsProvider authority={props.authority}>
        <Publication /><Descendant id="first" value={props.value ?? 'first'} />
        {props.second ? <Descendant id="second" value="second" /> : null}
    </CurrentUiContextCommandsProvider>;
}

afterEach(async () => {
    standardCleanup(); unregister?.(); unregister = undefined; reader = null;
    retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined;
    intents.clear(); changes.length = 0;
    routeState.pathname = '/settings/usage'; routeState.segments = ['(app)', 'settings', 'usage'];
});

describe('mounted current-context descendant commands', () => {
    it('retries an opened request through its mounted hydration command and retires it on close', async () => {
        let servedSession: ReturnType<typeof createSessionFixture> | null = null;
        const boundary = createSessionMetadataHttpBoundary(() => servedSession ? { [servedSession.id]: servedSession } : {});
        const sessionReads = createSessionReadBatchHttpBoundary(request => boundary.handle(request.url)
            ?? (request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined));
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://collection-request-retry.test', accountId: 'account-a', currentAccount: true }],
            route: sessionReads.handle });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        const session = createSessionFixture({ id: 'request-retry-session', serverId: server.id, encryptionMode: 'plain',
            active: true, agentState: { controlledByUser: null, requests: { permission: {
                tool: 'Bash', kind: 'permission', arguments: { command: 'git status' }, createdAt: 1,
            } }, completedRequests: {} } });
        getStorage().getState().applySessions([session]);
        const tree = (open: boolean) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <Publication /><CollectionSessionRequestPeekData open={open}
                        request={{ kind: 'permission', serverId: server.id, sessionId: session.id, requestId: 'permission' }}>
                        {() => null}
                    </CollectionSessionRequestPeekData>
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree(true));
        await vi.waitFor(() => expect(reader!.readCurrentUiContext()!.commands.some(command => command.title === t('common.retry'))).toBe(true));
        // Introduce the server update after startup, so this measures the mounted
        // Retry command rather than startup's legacy-display maintenance read.
        servedSession = createSessionFixture({ ...session, metadata: { ...session.metadata!, name: 'Current request context' },
            metadataVersion: session.metadataVersion + 1 });
        const command = reader!.readCurrentUiContext()!.commands.find(command => command.title === t('common.retry'))!;
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke', { commandId: command.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        await vi.waitFor(() => expect(getStorage().getState().sessions[session.id]?.metadata?.name).toBe('Current request context'));
        expect(sessionReads.componentRequests.filter(request => request.path === `/v2/sessions/${session.id}`)).toHaveLength(1);
        await screen.update(tree(false));
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: command.id }, { surface: 'agent' })).toMatchObject({ ok: false });
        await screen.update(tree(true));
        await vi.waitFor(() => expect(reader!.readCurrentUiContext()!.commands.some(command => command.title === t('common.retry'))).toBe(true));
        expect(sessionReads.componentRequests.filter(request => request.path === `/v2/sessions/${session.id}`)).toHaveLength(1);
    });

    it('keeps an unchanged local command when its owner adds a sibling and invokes its latest callback', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://local-command-reconcile.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        function Choices(props: Readonly<{ extra: boolean }>) {
            const choices = useCurrentUiContextLocalCommands([
                { key: 'first', title: 'First choice', invoke: () => { changes.push(props.extra ? 'latest' : 'original'); } },
                ...(props.extra ? [{ key: 'second', title: 'Second choice', invoke: () => { changes.push('second'); } }] : []),
            ]);
            intents.set('choices', choices.invoke);
            return <Publication />;
        }
        const tree = (extra: boolean) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive><Choices extra={extra} /></PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree(false));
        const first = reader!.readCurrentUiContext()!.commands[0]!;
        const retirement = reader!.resolveCurrentUiCommand(first.id)!.retirementSignal;
        await screen.update(tree(true));
        expect(reader!.readCurrentUiContext()!.commands[0]!.id).toBe(first.id);
        expect(retirement.aborted).toBe(false);
        await act(async () => { expect(await intents.get('choices')!('first')).toBe(true); });
        expect(changes).toEqual(['latest']);
        const second = reader!.readCurrentUiContext()!.commands[1]!;
        const secondRetirement = reader!.resolveCurrentUiCommand(second.id)!.retirementSignal;
        await screen.update(tree(false));
        expect(reader!.readCurrentUiContext()!.commands[0]!.id).toBe(first.id);
        expect(reader!.resolveCurrentUiCommand(second.id)).toBeNull();
        expect(secondRetirement.aborted).toBe(true);
        await screen.unmount();
        expect(retirement.aborted).toBe(true);
    });

    it('keeps Settings admission out of Session context and publishes the Settings identity on navigation', async () => {
        routeState.pathname = '/session/session-a'; routeState.segments = ['(app)', 'session', '[id]'];
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://current-context-settings-demand.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const governancePaths = new Set((['home.governance.get', 'home.governance.eligibility.get'] as const).map(id =>
            bindHomeDomainActionHttpRequestV1(id, {}).path));
        const priorReads = home.httpRequests.filter(request => governancePaths.has(request.path)).length;
        const tree = () => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider><Publication /></CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree());
        expect(reader!.readCurrentUiContext()).not.toBeNull();
        expect(home.httpRequests.filter(request => governancePaths.has(request.path))).toHaveLength(priorReads);
        routeState.pathname = '/settings/usage'; routeState.segments = ['(app)', 'settings', 'usage'];
        await screen.update(tree());
        expect(reader!.readCurrentUiContext()?.navigation).toMatchObject({ area: 'settings', title: t('settings.usage') });
        await screen.unmount();
    });
    it('publishes mounted host commands alongside author commands through the real UI Actions and retires them on unmount', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://mounted-host-commands.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const tree = (show: boolean) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <Publication author />{show ? <Descendant id="widget" value="expanded" /> : null}
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree(true));
        const read = await executor.execute('ui.current_context.read', {}, { surface: 'agent' });
        expect(read.ok).toBe(true);
        const command = reader!.readCurrentUiContext()!.commands.find(command => command.title === 'widget details');
        const author = reader!.readCurrentUiContext()!.commands.find(command => command.title === 'Author details')!;
        const authorRetirement = reader!.resolveCurrentUiCommand(author.id)!.retirementSignal;
        expect(command).toBeDefined();
        expect(reader!.readCurrentUiContext()!.commands.map(command => command.title)).toEqual(['Author details', 'widget details']);
        await act(async () => {
            expect(await executor.execute('ui.current_context.command.invoke', { commandId: command!.id }, { surface: 'agent' })).toMatchObject({ ok: true });
        });
        expect(changes).toEqual(['expanded']);
        await screen.update(tree(false));
        expect(reader!.readCurrentUiContext()!.commands.map(command => command.title)).toEqual(['Author details']);
        expect(reader!.readCurrentUiContext()!.commands[0]!.id).toBe(author.id);
        expect(authorRetirement.aborted).toBe(false);
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: command!.id }, { surface: 'agent' })).toMatchObject({ ok: false });
        await screen.unmount();
        expect(authorRetirement.aborted).toBe(true);
    });
    it('composes descendants through Action admission and retires removed, unbound and Account-stale capabilities', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://current-context-composition.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const authority = captureActiveServerAccountScopeLifetime();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const tree = (second: boolean, value = 'first', scope = authority) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <ComposedPage authority={scope} second={second} value={value} />
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree(true));
        expect(reader?.readCurrentUiContext()?.commands.map(command => command.title)).toEqual(['first details', 'second details']);
        const removed = reader!.readCurrentUiContext()!.commands[1]!;
        const retiredIntent = intents.get('second')!;
        const settings = getStorage().getState().settings;
        await act(async () => {
            getStorage().getState().applySettingsForScope(authority!.scope, { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
                v: 1, actions: { 'ui.current_context.command.invoke': { disabledSurfaces: ['ui'] } },
            }) }, 2);
            expect(await intents.get('first')!('details')).toBe(false);
        });
        expect(changes).toEqual([]);
        await act(async () => { getStorage().getState().applySettingsForScope(authority!.scope, settings, 3); });
        await act(async () => { expect(await intents.get('first')!('details')).toBe(true); });
        expect(changes).toEqual(['first']);
        await screen.update(tree(false, 'updated'));
        expect(reader!.readCurrentUiContext()!.commands.map(command => command.title)).toEqual(['first details']);
        await act(async () => { expect(await retiredIntent('details')).toBe(false); });
        await expect(executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input: { commandId: removed.id },
            context: { surface: 'agent' } })).resolves.toMatchObject({ ok: false });
        await act(async () => { expect(await intents.get('first')!('details')).toBe(true); });
        expect(changes).toEqual(['first', 'updated']);
        unregister?.();
        await act(async () => { expect(await intents.get('first')!('details')).toBe(false); });
        await screen.update(tree(false, 'unbound', null));
        expect(reader!.readCurrentUiContext()!.commands).toEqual([]);
        await act(async () => { expect(await intents.get('first')!('details')).toBe(false); });
        await screen.update(tree(false));
        await act(async () => { retireActiveServerAccountScopeLifetime(); expect(await intents.get('first')!('details')).toBe(false); });
        expect(changes).toEqual(['first', 'updated']);
    });
});
