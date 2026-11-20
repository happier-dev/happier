import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { Modal } from '@/modal';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createSessionCallerHostedHtmlRequestController } from '@/components/ui/surfaces/hostedHtml/sessionCallerHostedHtmlRequestController';
import { resolveScopedPluginSettingsServerIdentity } from '@/sync/domains/plugins/settings/scopedPluginSettingsRuntime';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
// Native viewport measurements are unavailable in the host renderer; keep list/domain logic real.
vi.mock('@legendapp/list/react-native', async importOriginal =>
    (await import('@/dev/testkit/mocks/legendList')).createCapturingLegendListMock({
        original: await importOriginal<Record<string, unknown>>(), renderItems: true,
    }).module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Portal positioning is a browser boundary; the controls and all Action owners remain real.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { ActionsSettingsView } = await import('./ActionsSettingsView');
const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');
const { SegmentedTabBar } = await import('@/components/ui/navigation/SegmentedTabBar');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const originalState = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(originalState, true); });

describe('Action policy controls through their canonical Action', () => {
    it('honors foreign HTML Ask for safe Send through the UI approval policy hook', async () => {
        const account = await createSecretSettingsTestHarness({ serverIdentityId: 'srv_g1_safe_send',
            settings: settingsParse({ memoryUseInNewSessions: false, actionsSettingsV1: { v: 1, actions: {},
                callerSurfacePolicies: { foreign_session_html: { 'session.message.send': 'ask_first' } },
            } }),
        });
        const sessionId = 'foreign-safe-send';
        const session = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId,
            metadata: { path: '/repo', host: 'tester.local' } });
        const request = account.request.getMockImplementation();
        if (!request) throw new Error('Expected the Home HTTP boundary');
        // Hosted Send reaches the Machine transport after policy. This Home has no Machine for the fixture Session.
        account.request.mockImplementation(createSessionReadBatchFetchBoundary(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === `/v2/sessions/${sessionId}`) return Response.json({ session });
            if (path === `/v1/sessions/${sessionId}/turns`) return Response.json({ v: 1, sessionId, updatedAt: 1, turns: [] });
            return request(input, init);
        }));
        const serverIdentityId = resolveScopedPluginSettingsServerIdentity(account.scope.serverId);
        if (!serverIdentityId) throw new Error('Expected the captured Home identity');
        let owned = false;
        const execute = createFrontDoorActionExecute();
        let admission: unknown;
        const controller = createSessionCallerHostedHtmlRequestController({
            sessionId, serverId: account.scope.serverId, serverIdentityId, accountId: account.scope.accountId,
            executeHostAction: async (...args) => { const result = await execute(...args); admission = result; return result; },
            isAccountCurrent: () => true,
            isSessionCurrent: () => true, isSessionOwned: () => owned, pluginTarget: null,
            publishResourceEvent: () => {}, notify: () => {},
        });
        const send = (id: string) => controller.handleRequest({ requestId: id, method: 'executeAction',
            payload: { action: 'session.message.send', input: { message: 'Hello', localId: id } },
        });
        const choose = (mode: 'allowed' | 'off') => account.replaceSettings(settingsParse({ ...account.persistedSettings,
            actionsSettingsV1: { v: 1, actions: {}, callerSurfacePolicies: { foreign_session_html: { 'session.message.send': mode } } },
        }));
        try {
            const asked = await send('foreign-ask');
            expect(asked, JSON.stringify(admission)).toMatchObject({ kind: 'approval_request_created' });
            expect(account.artifacts.list()).toHaveLength(1);
            const body = account.artifacts.readPlainBody(account.artifacts.list()[0]!.id);
            if (!body) throw new Error('Expected the stored approval request');
            expect(ApprovalRequestV2Schema.parse(JSON.parse(body))).toMatchObject({ status: 'open', actionId: 'session.message.send' });
            choose('allowed');
            await expect(send('foreign-allowed')).resolves.toMatchObject({ code: 'target_unavailable' });
            choose('off');
            await expect(send('foreign-off')).resolves.toMatchObject({ code: 'action_disabled' });
            owned = true;
            await expect(send('own-send')).resolves.toMatchObject({ code: 'target_unavailable' });
            expect(account.artifacts.list()).toHaveLength(1);
        } finally { controller.dispose(); standardCleanup(); await account.dispose(); }
    });
    it('keeps foreign HTML Ask replay consistent with ordinary UI policy after an Off change', async () => {
        const outcomes: boolean[] = [];
        for (const foreign of [false, true]) {
            const account = await createSecretSettingsTestHarness({ serverIdentityId: foreign ? 'srv_g1_foreign' : 'srv_g1_ui', settings: settingsParse({
                memoryUseInNewSessions: false,
                actionsSettingsV1: { v: 1, actions: foreign ? {} : { 'actions.policy.set': { approvalRequiredSurfaces: ['ui'] } },
                    ...(foreign ? { callerSurfacePolicies: { foreign_session_html: { 'actions.policy.set': 'ask_first' } } } : {}),
                },
            }) });
            const serverIdentityId = resolveScopedPluginSettingsServerIdentity(account.scope.serverId);
            if (!serverIdentityId) throw new Error('Expected the captured Home identity');
            const controller = createSessionCallerHostedHtmlRequestController({
                sessionId: 'session-foreign', serverId: account.scope.serverId, serverIdentityId, accountId: account.scope.accountId,
                executeHostAction: createFrontDoorActionExecute(), isAccountCurrent: () => true,
                isSessionCurrent: () => true, isSessionOwned: () => !foreign, pluginTarget: null,
                publishResourceEvent: () => {}, notify: () => {},
            });
            try {
                const request = (requestId: string) => controller.handleRequest({ requestId, method: 'executeAction',
                    payload: { action: 'actions.policy.set', input: { actionId: 'session.stop', audience: 'agent', mode: 'off' } },
                });
                await expect(request(foreign ? 'foreign-ask' : 'ui-ask')).resolves.toMatchObject({ kind: 'approval_request_created' });
                expect(account.persistedSettings.actionsSettingsV1.actions['session.stop']?.disabledSurfaces.includes('agent') === true).toBe(false);
                expect(account.artifacts.list()).toHaveLength(1);
                const approved = await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'approve');
                expect(approved, JSON.stringify({ foreign, approved })).toMatchObject({ ok: true, result: { status: 'executed' } });
                expect(account.persistedSettings.actionsSettingsV1.actions['session.stop']?.disabledSurfaces.includes('agent') === true).toBe(true);
                expect(account.artifacts.list()).toHaveLength(1);
                account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: {
                    ...account.persistedSettings.actionsSettingsV1, actions: { ...account.persistedSettings.actionsSettingsV1.actions,
                        'session.stop': { disabledSurfaces: [] } },
                } }));
                await expect(request(foreign ? 'foreign-off-after-ask' : 'ui-off-after-ask'))
                    .resolves.toMatchObject({ kind: 'approval_request_created' });
                expect(account.artifacts.list()).toHaveLength(2);
                account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: {
                    ...account.persistedSettings.actionsSettingsV1,
                    ...(foreign ? { callerSurfacePolicies: { foreign_session_html: { 'actions.policy.set': 'off' } } }
                        : { actions: { 'actions.policy.set': { disabledSurfaces: ['ui'] } } }),
                } }));
                await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[1]!.id, 'approve');
                outcomes.push(account.persistedSettings.actionsSettingsV1.actions['session.stop']?.disabledSurfaces.includes('agent') === true);
            } finally { controller.dispose(); standardCleanup(); await account.dispose(); }
        }
        // A caller class must not change the existing policy contract at replay.
        expect(outcomes[1]).toBe(outcomes[0]);
    });
    for (const control of ['audience', 'placement', 'tool exposure', 'spawn field', 'allow list'] as const) {
        it(`admits ${control} under Off, Ask rejection/approval and Allowed, preserving neighboring settings`, async () => {
            const actionId = control === 'spawn field' || control === 'allow list' ? 'settings.set' : 'actions.policy.set';
            const account = await createSecretSettingsTestHarness({ settings: settingsParse({
                memoryUseInNewSessions: false,
                experiments: true,
                featureToggles: { 'execution.runs': true },
                sessionAgentSpawnPolicyV1: { v: 1, allowCustomDirectory: true, allowCrossMachine: false },
                sessionAgentStartAllowListsV1: { v: 1, allowedRoleIds: ['builder'], allowedAgentTargetKeys: null },
                actionsSettingsV1: { v: 1, actions: {
                    [actionId]: { disabledSurfaces: ['ui'] },
                    'session.stop': { disabledSurfaces: ['agent'] },
                } },
            }) });
            try {
                const screen = await renderSettingsView(<ActionSettingsDetailContent actionId={
                    control === 'spawn field' || control === 'allow list' ? 'session.spawn_new' : 'review.start'
                } />);
                if (control === 'allow list') await screen.pressByTestIdAsync('settings-actions:session-start-allow-lists:agents');
                const change = (alternate = false) => {
                    if (control === 'audience') {
                        screen.findAllByType(SegmentedTabBar).find(node => node.props.testIDPrefix ===
                            'settings-actions:action:review.start:target:cli:mode')!.props.onSelectTab(alternate ? 'off' : 'ask_first');
                    } else if (control === 'placement') {
                        screen.findByTestId('settings-actions:action:review.start:target:command_palette:enabled')!.props.onValueChange(alternate);
                    } else if (control === 'tool exposure') {
                        screen.findAllByType(DropdownMenu).find(node => node.props.itemTrigger?.itemProps?.testID ===
                            'settings-actions:action:review.start:target:agent:tool-exposure')!.props.onSelect(alternate ? 'default' : 'direct');
                    } else if (control === 'spawn field') {
                        screen.findByTestId('settings-actions:session-spawn-policy:allowCustomDirectory')!.props.onValueChange(alternate);
                    } else {
                        screen.findAllByType(DropdownMenu).find(node => node.props.testID ===
                            'settings-actions:session-start-allow-lists:agents:menu')!.props.onSelect(alternate ? 'all' : 'none');
                    }
                };
                const changed = () => {
                    const settings = account.persistedSettings;
                    if (control === 'audience') return settings.actionsSettingsV1.actions['review.start']?.approvalRequiredSurfaces.includes('cli') === true;
                    if (control === 'placement') return settings.actionsSettingsV1.actions['review.start']?.disabledPlacements.includes('command_palette') === true;
                    if (control === 'tool exposure') return settings.actionsSettingsV1.actions['review.start']?.toolExposureModes?.agent === 'direct';
                    if (control === 'spawn field') return settings.sessionAgentSpawnPolicyV1.allowCustomDirectory === false;
                    return settings.sessionAgentStartAllowListsV1.allowedAgentTargetKeys?.length === 0;
                };
                await act(async () => { change(); });
                expect(changed()).toBe(false);
                expect(account.settingsWrites).toEqual([]);
                await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                    actionsSettingsV1: { ...account.persistedSettings.actionsSettingsV1, actions: {
                        ...account.persistedSettings.actionsSettingsV1.actions,
                        [actionId]: { approvalRequiredSurfaces: ['ui'] },
                    } },
                })); });
                const confirm = vi.mocked(Modal.confirm);
                confirm.mockClear().mockResolvedValueOnce(false);
                await act(async () => { change(); });
                await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
                expect(changed()).toBe(false);
                confirm.mockResolvedValueOnce(true);
                await act(async () => { change(); });
                await vi.waitFor(() => expect(changed()).toBe(true));
                expect(confirm).toHaveBeenCalledTimes(2);
                expect(account.artifacts.list()).toEqual([]);
                await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                    actionsSettingsV1: { ...account.persistedSettings.actionsSettingsV1,
                        approvalWaivedSurfaces: { [actionId]: ['ui'] },
                        actions: { ...account.persistedSettings.actionsSettingsV1.actions, [actionId]: {} },
                    },
                })); });
                await act(async () => { change(true); });
                await vi.waitFor(() => expect(changed()).toBe(false));
                expect(account.persistedSettings.actionsSettingsV1.actions['session.stop']?.disabledSurfaces).toEqual(['agent']);
                expect(account.persistedSettings.sessionAgentSpawnPolicyV1.allowCrossMachine).toBe(false);
                expect(account.persistedSettings.sessionAgentStartAllowListsV1.allowedRoleIds).toEqual(['builder']);
                expect(account.persistedSettings.memoryUseInNewSessions).toBe(false);
            } finally { standardCleanup(); await account.dispose(); }
        });
    }
    it('admits global enablement under Off, Ask rejection/approval and Allowed without replacing neighboring policy', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            memoryUseInNewSessions: false,
            actionsSettingsV1: { v: 1, actions: {
                'actions.policy.set': { disabledSurfaces: ['ui'] },
                'session.stop': { disabledSurfaces: ['agent'], approvalRequiredSurfaces: ['mcp'] },
            } },
        }) });
        try {
            const screen = await renderSettingsView(<ActionsSettingsView />);
            const choose = (enabled: boolean) => screen.findByTestId('settings-actions:action:settings.set:enabled')!.props.onValueChange(enabled);
            await act(async () => { choose(false); });
            expect(account.persistedSettings.actionsSettingsV1.actions['settings.set']?.enabled).not.toBe(false);
            expect(account.settingsWrites).toEqual([]);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { ...account.persistedSettings.actionsSettingsV1, actions: {
                    ...account.persistedSettings.actionsSettingsV1.actions,
                    'actions.policy.set': { approvalRequiredSurfaces: ['ui'] },
                } },
            })); });
            const confirm = vi.mocked(Modal.confirm);
            confirm.mockClear().mockResolvedValueOnce(false);
            await act(async () => { choose(false); });
            await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
            expect(account.persistedSettings.actionsSettingsV1.actions['settings.set']?.enabled).not.toBe(false);
            confirm.mockResolvedValueOnce(true);
            await act(async () => { choose(false); });
            await vi.waitFor(() => expect(account.persistedSettings.actionsSettingsV1.actions['settings.set']?.enabled).toBe(false));
            expect(confirm).toHaveBeenCalledTimes(2);
            expect(account.artifacts.list()).toEqual([]);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { ...account.persistedSettings.actionsSettingsV1,
                    approvalWaivedSurfaces: { 'actions.policy.set': ['ui'] },
                    actions: { ...account.persistedSettings.actionsSettingsV1.actions, 'actions.policy.set': {} },
                },
            })); });
            await act(async () => { choose(true); });
            await vi.waitFor(() => expect(account.persistedSettings.actionsSettingsV1.actions['settings.set']?.enabled).not.toBe(false));
            expect(account.persistedSettings.actionsSettingsV1.actions['session.stop']).toMatchObject({
                disabledSurfaces: ['agent'], approvalRequiredSurfaces: ['mcp'],
            });
            expect(account.persistedSettings.memoryUseInNewSessions).toBe(false);
        } finally { standardCleanup(); await account.dispose(); }
    });
});
