import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installSettingsViewCommonModuleMocks({ storage: 'real', text: async () => vi.importActual<typeof import('@/text')>('@/text') });
// Metro's deferred loader is the boundary; settings admission and semantic writes remain real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
beforeEach(async () => {
    await harness.reset();
    const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
    resetScopedHomeActionExecutorsForTests();
    await loadSyncSingletonForTests();
});
afterEach(standardCleanup);

describe('MCP strict mode declared settings admission', () => {
    it.each([
        { entry: 'catalog', disabled: true }, { entry: 'preview', disabled: true },
        { entry: 'catalog', disabled: false }, { entry: 'preview', disabled: false },
    ] as const)('honors disabled settings Actions at the $entry ingress (disabled=$disabled)', async ({ entry, disabled }) => {
        const home = await harness.addHome({ name: 'Policy', serverUrl: 'https://mcp-strict.example', serverIdentityId: 'srv_mcp_strict', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        const settings = { ...storage.getState().settings, mcpServersStrictMode: false,
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, ...(disabled
                ? { actions: { 'settings.set': { disabledSurfaces: ['ui'] } } }
                : { approvalWaivedSurfaces: { 'settings.set': ['ui'] } }) }) };
        storage.setState({ settings, settingsVersion: 1 });
        harness.answer(home, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
        harness.answer(home, 'POST /v2/account/settings', { body: { success: true, version: 2 } });
        const { Modal } = await import('@/modal');
        const alert = vi.spyOn(Modal, 'alert');
        try {
            if (entry === 'catalog') {
                const { useMcpServersSettings } = await import('./useMcpServersSettings');
                const hook = await renderHook(useMcpServersSettings);
                await act(async () => hook.getCurrent().setStrictMode(true));
                await waitForHomeGovernance(() => expect(storage.getState().settings.mcpServersStrictMode).toBe(!disabled));
                await hook.unmount();
            } else {
                const { McpSessionPreviewScreen } = await import('./McpSessionPreviewScreen');
                const screen = await renderScreen(<McpSessionPreviewScreen />);
                await act(async () => screen.findByTestId('settings.mcpServers.strictMode')!.props.onChange('stop'));
                await waitForHomeGovernance(() => expect(storage.getState().settings.mcpServersStrictMode).toBe(!disabled));
                await screen.unmount();
            }
            if (disabled) {
                await waitForHomeGovernance(() => expect(alert).toHaveBeenCalledWith('Error', 'action_disabled'));
                expect(harness.requestsFor('/v2/account/settings').filter(request => Reflect.get(request.input ?? {}, 'content') !== undefined)).toEqual([]);
            } else {
                await waitForHomeGovernance(() => expect(harness.requestsFor('/v2/account/settings').some(request =>
                    Reflect.get(request.input ?? {}, 'content') !== undefined)).toBe(true));
                expect(alert).not.toHaveBeenCalled();
            }
        } finally { alert.mockRestore(); }
    });
});
