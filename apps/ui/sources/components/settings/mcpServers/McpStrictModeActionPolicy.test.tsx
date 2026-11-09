import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createAccountSettingsHttpBoundary } from '@/dev/testkit/harness/actionHomesHttpHarness';

installSettingsViewCommonModuleMocks({ storage: 'real', text: async () => vi.importActual<typeof import('@/text')>('@/text') });
// Metro's deferred loader is the boundary; settings admission and semantic writes remain real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
await loadSyncSingletonForTests();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeEach(async () => {
    await harness.reset();
    const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
    resetScopedHomeActionExecutorsForTests();
});
afterEach(async () => {
    await standardCleanup();
    await connection?.dispose();
    connection = undefined;
});

describe('MCP strict mode declared settings admission', () => {
    it.each([
        { entry: 'catalog', disabled: true },
        { entry: 'catalog', disabled: false },
        { entry: 'owner', disabled: false },
    ] as const)('honors disabled settings Actions at the $entry ingress (disabled=$disabled)', async ({ entry, disabled }) => {
        const home = await harness.addHome({ name: 'Policy', serverUrl: 'https://mcp-strict.example', serverIdentityId: 'srv_mcp_strict', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(home), accountId: 'owner' };
        const settings = { ...storage.getState().settings, mcpServersStrictMode: false,
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, ...(disabled
                ? { actions: { 'settings.set': { disabledSurfaces: ['ui'] } } }
                : { approvalWaivedSurfaces: { 'settings.set': ['ui'] } }) }) };
        const settingsBoundary = createAccountSettingsHttpBoundary({ serverUrl: 'https://mcp-strict.example',
            initialAccounts: [{ accountId: 'owner', snapshot: { content: { t: 'plain', v: settings }, version: 1 } }] });
        const settingsAnswer = { select: async (_input: unknown, request: Readonly<{ url: string; init: RequestInit | undefined }>) => {
            const response = settingsBoundary.handle(request.url, request.init);
            if (!response) throw new Error('Settings fixture received an unsupported request');
            return { status: response.status, body: await response.json() };
        } };
        harness.answer(home, '/v2/account/settings', settingsAnswer);
        harness.answer(home, 'POST /v2/account/settings', settingsAnswer);
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://mcp-strict.example');
        if (!credentials) throw new Error('Policy fixture has no Account credentials');
        connection = await restoreServerAccountForTest({ serverUrl: 'https://mcp-strict.example',
            serverIdentityId: 'srv_mcp_strict', accountId: 'owner', credentials, request: harness.request });
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        await waitForHomeGovernance(() => expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual(scope));
        const { sync } = await import('@/sync/sync');
        await sync.refreshProfile();
        await sync.refreshAccountSettingsFromServer(1, scope);
        const writesBeforeAction = harness.requestsFor('/v2/account/settings')
            .filter(request => Reflect.get(request.input ?? {}, 'content') !== undefined).length;
        const { Modal } = await import('@/modal');
        const alert = vi.spyOn(Modal, 'alert');
        const { router } = await import('expo-router');
        const push = vi.spyOn(router, 'push');
        try {
            if (entry === 'owner') {
                const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
                const result = await createFrontDoorActionExecute()('settings.set', { anchor: 'session.mcpServersStrictMode', value: true }, {
                    surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                    serverId: home, expectedAccountId: 'owner',
                });
                expect(result).toMatchObject({ ok: true });
                await waitForHomeGovernance(() => expect(storage.getState().settings.mcpServersStrictMode).toBe(true));
            } else if (entry === 'catalog') {
                const { useMcpServersSettings } = await import('./useMcpServersSettings');
                const hook = await renderHook(useMcpServersSettings);
                await act(async () => hook.getCurrent().setStrictMode(true));
                if (disabled) expect(storage.getState().settings.mcpServersStrictMode).toBe(false);
                else await waitForHomeGovernance(() => expect(storage.getState().settings.mcpServersStrictMode).toBe(true));
                await hook.unmount();
            }
            if (disabled) {
                await waitForHomeGovernance(() => expect(alert).toHaveBeenCalled());
                const buttons = alert.mock.calls.at(-1)![2];
                const openSettings = buttons?.find(button => button.style !== 'cancel');
                expect(openSettings?.onPress).toEqual(expect.any(Function));
                await act(async () => { openSettings!.onPress!(); });
                expect(push).toHaveBeenCalledWith('/settings/actions/settings.set');
                expect(harness.requestsFor('/v2/account/settings').filter(request => Reflect.get(request.input ?? {}, 'content') !== undefined).length)
                    .toBe(writesBeforeAction);
            } else {
                await waitForHomeGovernance(() => expect(harness.requestsFor('/v2/account/settings').filter(request =>
                    Reflect.get(request.input ?? {}, 'content') !== undefined).length).toBeGreaterThan(writesBeforeAction));
                expect(alert).not.toHaveBeenCalled();
            }
        } finally { alert.mockRestore(); push.mockRestore(); }
    });
});
