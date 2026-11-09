import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { useMountedActionExecution } = await import('./useMountedActionExecution');

afterEach(async () => {
    await standardCleanup();
    await account.reset();
});

it('admits its own Account and refuses the captured scope after a real Account switch with request identity', async () => {
    onTestFinished(await installRealActionExecutorModuleLoader());
    const scope = await account.restore({ machines: [], currentAccount: true });
    const hook = await renderHook(() => useMountedActionExecution(scope));
    await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
    const execute = hook.getCurrent().execute;
    expect(await execute('settings.get', { anchor: 'appearance.glassTint' })).toMatchObject({ ok: true });
    await act(async () => { await account.home.switchAccount(scope.serverId, 'replacement-account', { currentAccount: true }); });
    expect(await execute('settings.get', { anchor: 'appearance.glassTint' }, { actionRequestId: 'switched-account-request' }))
        .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed', requestId: 'switched-account-request',
            details: { reason: 'client_account_scope_changed' } });
    await hook.unmount();
});

it('gives a retired mounted invocation a generated Request ID without dispatching it', async () => {
    const scope = await account.restore({ machines: [], currentAccount: true });
    const hook = await renderHook(() => useMountedActionExecution(scope));
    const execute = hook.getCurrent().execute;
    await hook.unmount();
    expect(await execute('settings.get', { anchor: 'appearance.glassTint' }))
        .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed', requestId: expect.any(String),
            details: { reason: 'client_account_scope_changed' } });
});
