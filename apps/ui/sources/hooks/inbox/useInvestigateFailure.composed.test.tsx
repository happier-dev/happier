import * as React from 'react';
import { afterEach, expect, it } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import type { FailureInvestigationSubject } from './accountNoticeInvestigation';
import {
    createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storage');
const { useInvestigateFailure } = await import('./useInvestigateFailure');
const { InboxSummaryProvider } = await import('./useInboxSummary');
const { AccountNoticeInvestigationBoundary, useAccountNoticeInvestigation } = await import('./AccountNoticeInvestigationProvider');
const { getMountedWorkReadAddresses } = await import('@/sync/ops/actions/mountedWorkReadAction');

afterEach(async () => { standardCleanup(); await account.reset(); });

function ShellSummaryRoot({ children }: React.PropsWithChildren) {
    return <InboxSummaryProvider>{children}</InboxSummaryProvider>;
}

function FailurePageRoot({ children }: React.PropsWithChildren) {
    return <AccountNoticeInvestigationBoundary>{children}</AccountNoticeInvestigationBoundary>;
}

it('reaches Investigate from a receipt surface under the app shell without mounting the Inbox model', async () => {
    await account.restore({ machines: [] });
    const scope = storage.getState().profileScope!;
    const subject = { kind: 'deploymentReceipt', serverId: scope.serverId,
        environmentId: 'failed-environment', deploymentId: 'failed-receipt' } as const;
    const hook = await renderHook<ReturnType<typeof useInvestigateFailure>, FailureInvestigationSubject | null>(
        useInvestigateFailure, { initialProps: subject, wrapper: ShellSummaryRoot });
    try {
        expect(getMountedWorkReadAddresses().some(address => address.actionId === 'inbox.get')).toBe(false);
        expect(hook.getCurrent().outcome).toBeNull();
        await act(async () => { await hook.getCurrent().investigate(); });
        // This Home has no configured Triage: the shared owner must return its typed refusal,
        // rather than the page silently doing nothing because no Inbox model owns it.
        expect(hook.getCurrent().outcome).toEqual({ kind: 'unavailable', code: 'catalogUnavailable' });
        await hook.rerender({ ...subject, deploymentId: 'another-failed-receipt' });
        expect(hook.getCurrent().outcome).toBeNull();
        expect(hook.getCurrent().pending).toBe(false);
    } finally { await hook.unmount(); }
});

it('mounts a managed setup surface without reads and retires its old Account owner on an Account switch', async () => {
    await account.restore({ machines: [] });
    const scope = storage.getState().profileScope!;
    const subject = { kind: 'managedMachineOperation', operation: { serverId: scope.serverId,
        machineId: 'setup-controller', operationId: 'failed-setup' } } as const;
    const httpBefore = account.home.requests.length;
    const rpcBefore = rpc.state.requests.length;
    const hook = await renderHook(() => ({ intent: useInvestigateFailure(subject), owner: useAccountNoticeInvestigation() }),
        { wrapper: FailurePageRoot });
    try {
        expect(account.home.requests).toHaveLength(httpBefore);
        expect(rpc.state.requests).toHaveLength(rpcBefore);
        const oldOwner = hook.getCurrent().owner;
        expect(oldOwner.isEligible(subject)).toBe(true);
        await act(async () => { await account.restore({ accountId: 'account-b', machines: [] }); });
        expect(oldOwner.isEligible(subject)).toBe(false);
        expect(hook.getCurrent().intent.outcome).toBeNull();
        expect(hook.getCurrent().owner.isEligible(subject)).toBe(true);
    } finally { await hook.unmount(); }
});
