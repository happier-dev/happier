import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { CurrentUiContextProvider, useOptionalCurrentUiContextReader, type CurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { CurrentUiContextActionHost } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { useCurrentUiContextCommandBridge } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { Modal, ModalProvider } from '@/modal';
import { BaseModal } from './BaseModal';
import { t } from '@/text';
import type { CustomModalDismissGuard } from '../types';
import { composeUsageRecap, UsageAnalyticsQueryResponseSchema, UsageRecapPrivateComposeInputSchema } from '@happier-dev/protocol';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { renderUsageRecapImage } from '@/components/settings/usage/widgets/recap/renderUsageRecapImage';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiUsageActionPorts } from '@/sync/ops/actions/usageActionDeps';
import { UsageSourcesMachines } from '@/components/settings/usage/widgets/UsageSourcesWidget';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createUsageSourceActionPort } from '@happier-dev/protocol/actions/executor/usageSourceActions';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { normalizeActionsSettingsV1, isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';

import type { UsageSourceV1 } from '@happier-dev/protocol/usage/usageSources';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '/settings/usage', segments: ['(app)', 'settings', 'usage'],
}).module);
// Portals and browser focus/event listeners are platform boundaries; modal and command owners stay real.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
vi.mock('@/utils/web/radixCjs', async importOriginal => {
    const actual = await importOriginal<typeof import('@/utils/web/radixCjs')>();
    const Inline = (props: Readonly<{ children?: React.ReactNode }>) => props.children;
    return { ...actual, requireRadixDismissableLayer: () => ({ Root: Inline, Branch: Inline }),
        requireRadixFocusScope: () => ({ Root: Inline }) };
});

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let reader: CurrentUiContextReader | null = null;

function ObserveReader() {
    reader = useOptionalCurrentUiContextReader();
    return null;
}

afterEach(async () => {
    standardCleanup();
    retireActiveServerAccountScopeLifetime();
    await home?.dispose(); home = undefined; reader = null;
});

describe('CustomModal shared dismissal commands', () => {
    it('exposes the real recap renderer cancel through the existing mounted Action host port', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-recap-port.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 900 } });
        const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1,
            tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
        const composed = composeUsageRecap({ input: UsageRecapPrivateComposeInputSchema.parse({ query, style: 'sigil',
            format: 'story', selectedFields: ['tokens'] }), snapshot: resolveUsagePageAggregation({ queries: [query],
            accounting: [{ query, value: accounting, status: 'available', asOfMs: 900 }] }, bundledUsageModelPriceCatalog).results[0]! });
        if (composed.kind !== 'composed') throw new Error('Canonical recap fixture was not composed');
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><ModalProvider><CurrentUiContextProvider>
                <CurrentUiContextActionHost /><ObserveReader />
            </CurrentUiContextProvider></ModalProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const account = await captureLazyActionAccountContext(server.id);
        const ports = createUiUsageActionPorts(account);
        let rendered: ReturnType<typeof renderUsageRecapImage> | undefined;
        await act(async () => { rendered = ports.renderRecap!(composed, { surface: 'agent' }); });
        await vi.waitFor(() => expect(screen.findByTestId('usage-recap-image.stage')).not.toBeNull());
        const close = reader!.readCurrentUiContext()!.commands.find(candidate => candidate.title === t('common.close'));
        expect(close).toBeDefined();
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        await act(async () => { await executor.execute('ui.current_context.command.invoke', { commandId: close!.id }, { surface: 'agent' }); });
        expect(await rendered).toEqual({ kind: 'unavailable', reason: 'render_target_unavailable' });
        account.dispose();
    });

    it('shares prompt draft, continue and cancel commands with the mounted input and buttons', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-source-prompt.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        let answer: Promise<string | null> | undefined;
        const confirmingActor = vi.fn();
        let show: (() => void) | undefined;
        let confirmation: Promise<boolean> | undefined;
        let showConfirmation: (() => void) | undefined;
        let acknowledgement: Promise<void> | undefined;
        let showAlert: (() => void) | undefined;
        const acknowledged = vi.fn();
        function Opener() {
            const Bridge = useCurrentUiContextCommandBridge();
            show = () => { answer = Modal.prompt('Source folder', undefined, { commandBridge: Bridge,
                defaultValue: '/original', confirmText: 'Continue', onConfirmContext: confirmingActor }); };
            showConfirmation = () => { confirmation = Modal.confirm('Remove source?', undefined, {
                commandBridge: Bridge, confirmText: 'Remove', destructive: true }); };
            showAlert = () => { acknowledgement = Modal.alertAsync('Folder unavailable', undefined,
                [{ text: 'Acknowledge', onPress: acknowledged }], { commandBridge: Bridge }); };
            return null;
        }
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><ModalProvider><CurrentUiContextProvider>
                <CurrentUiContextActionHost /><ObserveReader /><Opener />
            </CurrentUiContextProvider></ModalProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        await act(async () => { show!(); });
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        const invoke = (title: string, input?: { value: string }) => {
            const command = reader!.readCurrentUiContext()!.commands.find(candidate => candidate.title === title);
            expect(command).toBeDefined();
            return executor.execute('ui.current_context.command.invoke', { commandId: command!.id,
                ...(input === undefined ? {} : { input }) }, { surface: 'agent' });
        };
        await act(async () => { expect(await invoke('Source folder', { value: '/agent' })).toMatchObject({ ok: true }); });
        expect(screen.findByTestId('web-prompt-input')!.props.value).toBe('/agent');
        await act(async () => { screen.findByTestId('web-prompt-input')!.props.onChangeText('/ui'); });
        expect(await invoke('Source folder')).toMatchObject({ ok: true, result: { value: '/ui' } });
        await act(async () => { await invoke('Continue'); });
        expect(await answer).toBe('/ui');
        expect(confirmingActor).toHaveBeenCalledWith(expect.objectContaining({ surface: 'agent' }));
        expect(confirmingActor.mock.calls[0]![0].signal?.aborted).not.toBe(true);
        await act(async () => { show!(); });
        await screen.pressByTestIdAsync('web-prompt-cancel');
        expect(await answer).toBeNull();
        await act(async () => { showConfirmation!(); });
        await act(async () => { await invoke('Remove'); });
        expect(await confirmation).toBe(true);
        await act(async () => { showConfirmation!(); });
        await screen.pressByTestIdAsync('web-modal-cancel');
        expect(await confirmation).toBe(false);
        await act(async () => { showAlert!(); });
        await act(async () => { await invoke('Acknowledge'); });
        await acknowledgement;
        expect(acknowledged).toHaveBeenCalledOnce();
        await act(async () => { showAlert!(); });
        await screen.pressByTestIdAsync('web-modal-button-0');
        await acknowledgement;
        expect(acknowledged).toHaveBeenCalledTimes(2);
        await act(async () => { showAlert!(); });
        await act(async () => { await invoke(t('common.close')); });
        await acknowledgement;
        expect(acknowledged).toHaveBeenCalledTimes(2);
        await act(async () => { showAlert!(); });
        await act(async () => { screen.findAllByType(BaseModal).find(modal => modal.props.visible !== false)!.props.onClose(); });
        await acknowledgement;
        expect(acknowledged).toHaveBeenCalledTimes(2);
    });

    it('commits a Source folder confirmed by an agent after the real prompt closes', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://source-folder-confirm.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const authority = captureActiveServerAccountScopeLifetime();
        if (!authority) throw new Error('Source fixture requires its restored Account');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        let source: UsageSourceV1 = { serverId: server.id, machineId: 'mac', sourceId: 'claude-default',
            agent: { pluginId: 'happier.agent.claude', localId: 'claude' }, accountingSources: ['claude-assistant-usage'],
            captureKind: 'from_logs', root: { kind: 'default', path: '/original' }, consent: 'disabled',
            status: 'found', coverage: 'unknown', pendingCount: 0, asOfMs: null };
        const settings = normalizeActionsSettingsV1({ v: 1,
            approvalWaivedSurfaces: { 'usage.sources.root.set': ['ui', 'agent'] } });
        const actors: ActionExecutorContext[] = [];
        const roots: (string | null)[] = [];
        const deps = {
            usageSourceAction: createUsageSourceActionPort({ serverId: server.id,
                assertCurrent: context => { context.signal?.throwIfAborted(); },
                // The Machine RPC is the boundary; source/controller/Action/prompt owners remain real.
                rpc: async request => {
                    if (request.actionId === 'usage.sources.root.set') {
                        roots.push(request.input.root);
                        source = { ...source, root: { kind: 'override', path: request.input.root } };
                        return { source };
                    }
                    return { sources: [source] };
                } }),
            isActionEnabled: (id, context) => {
                if (id === 'usage.sources.root.set') actors.push(context);
                return isActionEnabledByActionsSettings(id, settings, context);
            },
            readActionsSettings: () => settings,
        } satisfies Partial<ActionExecutorDeps>;
        // This fixture configures only the Source Action slice and its genuine Machine boundary.
        const sourceExecutor = createActionExecutor(deps as ActionExecutorDeps);
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><ModalProvider><CurrentUiContextProvider>
                <CurrentUiContextActionHost /><ObserveReader /><UsageSourcesMachines lifetime={authority} serverId={server.id} executor={sourceExecutor}
                        testID="sources" input={{ agents: [], machines: [], sources: [] }}
                        machines={[{ id: 'mac', name: 'Mac', online: true }]} />
            </CurrentUiContextProvider></ModalProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('sources.machine.mac.source.claude-default')).toBeTruthy());
        const menu = screen.findAllByType(ItemRowActions).find(row => row.props.overflowTriggerTestID === 'sources.machine.mac.source.claude-default.options')!;
        await act(async () => { menu.props.actions.find((row: { id: string }) => row.id.endsWith('.folder')).onPress(); });
        await vi.waitFor(() => expect(screen.findByTestId('web-prompt-input')).toBeTruthy());
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        const invoke = (title: string, input?: { value: string }) => {
            const command = reader!.readCurrentUiContext()!.commands.find(row => row.title === title);
            expect(command).toBeDefined();
            return executor.execute('ui.current_context.command.invoke', { commandId: command!.id,
                ...(input === undefined ? {} : { input }) }, { surface: 'agent' });
        };
        await act(async () => { await invoke(t('usage.board.sources.folderPromptTitle'), { value: '/agent/folder' }); });
        await act(async () => { await invoke(t('common.ok')); });
        await vi.waitFor(() => expect(roots).toEqual(['/agent/folder']));
        expect(actors).toEqual([expect.objectContaining({ surface: 'agent' })]);
        await vi.waitFor(() => expect(screen.findByTestId('web-prompt-input')).toBeNull());
        expect(screen.getTextContent()).toContain('/agent/folder');
    });

    it.each(['button', 'shell', 'agent'] as const)('uses one guarded shared close request through %s and retires its command', async surface => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: `https://modal-close-${surface}.test`, accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        let allowed = false;
        const guard = vi.fn<CustomModalDismissGuard>(async () => allowed);
        const requested = vi.fn();
        let show: (() => void) | undefined;
        function Opener() {
            const Bridge = useCurrentUiContextCommandBridge();
            show = () => Modal.show({ component: () => null, commandBridge: Bridge,
                onDismissRequest: guard, onRequestClose: requested,
                chrome: { kind: 'card', title: 'Prices', closeButtonTestID: 'prices-close' } });
            return null;
        }
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><ModalProvider><CurrentUiContextProvider>
                <CurrentUiContextActionHost /><ObserveReader /><Opener />
            </CurrentUiContextProvider></ModalProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        await act(async () => { show!(); });
        const command = reader!.readCurrentUiContext()!.commands.find(candidate => candidate.title === t('common.close'));
        expect(command).toBeDefined();
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        const invokeAgent = () => executor.execute('ui.current_context.command.invoke', { commandId: command!.id }, { surface: 'agent' });
        const close = async () => {
            if (surface === 'button') await screen.pressByTestIdAsync('prices-close');
            else if (surface === 'shell') await act(async () => { screen.findByType(BaseModal).props.onClose(); });
            else await act(async () => { await invokeAgent(); });
        };
        await close();
        expect(guard.mock.calls).toEqual([['shared']]);
        expect(requested).not.toHaveBeenCalled();
        expect(reader!.readCurrentUiContext()!.commands.find(candidate => candidate.id === command!.id)).toBeDefined();
        allowed = true;
        await close();
        expect(guard.mock.calls).toEqual([['shared'], ['shared']]);
        expect(requested).toHaveBeenCalledOnce();
        expect(await invokeAgent()).toMatchObject({ ok: false });
        expect(guard).toHaveBeenCalledTimes(2);
    });
});
