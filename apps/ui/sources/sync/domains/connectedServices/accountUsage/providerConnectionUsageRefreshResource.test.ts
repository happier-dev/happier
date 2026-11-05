import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { DaemonProviderUsageRefreshResponseV1Schema, RPC_METHODS, type DaemonProviderUsageRefreshResponseV1 } from '@happier-dev/protocol/rpc';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const account = createProviderSettingsAccountHarness();
const rpc = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(rpc);
await loadSyncSingletonForTests();
const { createProviderConnectionUsageRefreshResource, acquireProviderConnectionUsageRefreshResource,
    invalidateProviderConnectionUsage } = await import('./providerConnectionUsageRefreshResource');
const { refreshProviderConnectionUsage } = await import('@/providers/actions/client');
const { handleEphemeralSocketUpdate } = await import('@/sync/engine/socket/socket');

const method = RPC_METHODS.DAEMON_PROVIDERS_USAGE_REFRESH;
const requests = () => rpc.state.requests.filter(request => request.method === method);
const recordKey = { providerId: 'provider', accountSubjectId: 'credential-fingerprint', subjectKind: 'account', quotaScope: 'account' } as const;
const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({
    v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'provider',
    accountSubject: { kind: 'providerSubject', id: 'credential-fingerprint' },
    observedAtMs: 1000, fetchedAtMs: 1000, staleAfterMs: 60_000,
    source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [],
});
const good = DaemonProviderUsageRefreshResponseV1Schema.parse({
    status: 'success', sources: [{ sourceId: 'credits', status: 'ok', snapshot }],
});

beforeEach(async () => { standardCleanup(); await account.reset(); rpc.reset(); installProviderSettingsRpcBoundary(rpc); });
afterEach(() => { standardCleanup(); vi.useRealTimers(); });

async function setup() {
    const { serverId } = await account.restore({ waivedActions: ['providers.usage.refresh'] });
    let presented = true;
    let current = true;
    const controller = new AbortController();
    const resource = createProviderConnectionUsageRefreshResource({ serverId, accountId: 'account-a', machineId: 'machine-a', connectionId: 'pc_a',
        // The raw client without approval options: a queued approval surfaces as its typed error.
        invoke: request => refreshProviderConnectionUsage(request),
        lifetime: { signal: controller.signal, isCurrent: () => current }, isPresented: () => presented });
    return { serverId, resource, hide: () => { presented = false; }, retire: () => { current = false; } };
}

describe('Provider connection usage data resource', () => {
    it('shares settings and picker demand, invalidates only the exact connection, and cancels only the last demand', async () => {
        const { serverId } = await account.restore({ waivedActions: ['providers.usage.refresh'] });
        const controller = new AbortController();
        const input = { serverId, accountId: 'account-a', machineId: 'machine-a', connectionId: 'pc_a', identity: 'declaration/key',
            invoke: (request: Parameters<typeof refreshProviderConnectionUsage>[0]) => refreshProviderConnectionUsage(request),
            lifetime: { signal: controller.signal, isCurrent: () => !controller.signal.aborted } };
        let finish!: (response: DaemonProviderUsageRefreshResponseV1) => void;
        rpc.intercept(method, () => new Promise(resolve => { finish = resolve; }));
        const settings = acquireProviderConnectionUsageRefreshResource(input);
        const picker = acquireProviderConnectionUsageRefreshResource(input);
        expect(picker.resource).toBe(settings.resource);
        await waitForHomeGovernance(() => expect(requests()).toHaveLength(1));
        settings.release();
        finish(good);
        await waitForHomeGovernance(() => expect(picker.resource.getCurrent()?.snapshotsBySourceId.credits).toEqual(snapshot));
        invalidateProviderConnectionUsage({ serverId, accountId: 'account-a', connectionId: 'pc_other', machineId: 'machine-a' });
        expect(requests()).toHaveLength(1);
        const push = (sourceServerId: string, providerConnectionId: string, machineId = 'machine-a', shouldContinue = () => true,
            sourceAccountId = 'account-a') => handleEphemeralSocketUpdate({
            sourceServerId, sourceAccountId, shouldContinue, update: { type: 'usage', id: 'session-a', key: 'agent:model', tokens: {}, cost: {}, timestamp: 1000,
                providerConnectionId, machineId }, addActivityUpdate() {}, addMachineActivityUpdate() {}, getSessionEncryption: () => null,
            getSession: () => undefined, applyMessages() {},
        });
        await push(serverId, 'pc_other');
        await push(serverId, 'pc_a', 'other-machine');
        await push('other-home', 'pc_a');
        await push(serverId, 'pc_a', 'machine-a', () => false);
        await push(serverId, 'pc_a', 'machine-a', () => true, 'retired-account');
        expect(requests()).toHaveLength(1);
        await push(serverId, 'pc_a');
        await waitForHomeGovernance(() => expect(requests()).toHaveLength(2));
        picker.release();
        finish(good);
        await waitForHomeGovernance(() => expect(picker.resource.getCurrent()).toBeNull());
        invalidateProviderConnectionUsage({ serverId, accountId: 'account-a', connectionId: 'pc_a', machineId: 'machine-a' });
        expect(requests()).toHaveLength(2);
    });

    it('retires shared protected facts and pending results when the credential authority changes', async () => {
        const { serverId } = await account.restore({ waivedActions: ['providers.usage.refresh'] });
        const controller = new AbortController();
        const input = { serverId, accountId: 'account-a', machineId: 'machine-a', connectionId: 'pc_a', identity: 'old-key',
            invoke: (request: Parameters<typeof refreshProviderConnectionUsage>[0]) => refreshProviderConnectionUsage(request),
            lifetime: { signal: controller.signal, isCurrent: () => true } };
        rpc.setResponse(method, good);
        const old = acquireProviderConnectionUsageRefreshResource(input);
        await waitForHomeGovernance(() => expect(old.resource.getCurrent()?.snapshotsBySourceId.credits).toEqual(snapshot));
        const finishes: ((response: DaemonProviderUsageRefreshResponseV1) => void)[] = [];
        rpc.intercept(method, () => new Promise(resolve => { finishes.push(resolve); }));
        const oldPending = old.resource.refresh();
        await waitForHomeGovernance(() => expect(finishes).toHaveLength(1));
        const next = acquireProviderConnectionUsageRefreshResource({ ...input, identity: 'new-key' });
        expect(old.resource.getCurrent()).toBeNull();
        expect(next.resource.getCurrent()).toBeNull();
        finishes[0]!(good);
        await expect(oldPending).resolves.toBeNull();
        await waitForHomeGovernance(() => expect(finishes).toHaveLength(2));
        old.release(); next.release();
        finishes[1]!(good);
    });
    it('keeps admitted last-good facts while the canonical Action awaits user approval', async () => {
        const { resource, serverId } = await setup();
        rpc.setResponse(method, good);
        await resource.refresh();
        const before = resource.getCurrent();
        await account.home.requireUiApproval(serverId, 'providers.usage.refresh');
        await expect(resource.refresh()).rejects.toMatchObject({ code: 'approval_request_created' });
        expect(resource.getCurrent()).toBe(before);
        expect(requests()).toHaveLength(1);
        resource.dispose();
    });
    it('does no hidden work, shares concurrent explicit refreshes through the Action and stays idle after settlement', async () => {
        const hidden = await setup();
        hidden.hide();
        await expect(hidden.resource.refresh()).resolves.toBeNull();
        expect(requests()).toHaveLength(0);
        hidden.resource.dispose();
        const shown = await setup();
        let finish!: (response: DaemonProviderUsageRefreshResponseV1) => void;
        rpc.intercept(method, () => new Promise(resolve => { finish = resolve; }));
        const first = shown.resource.refresh();
        expect(shown.resource.refresh()).toBe(first);
        await waitForHomeGovernance(() => expect(requests()).toHaveLength(1));
        finish(good);
        const view = await first;
        expect(view?.snapshotsBySourceId.credits).toEqual(snapshot);
        expect(view?.result).toEqual(good);
        vi.useFakeTimers();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(requests()).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
        shown.resource.dispose();
    });

    it('retains only admitted last-good source facts for upstream failures and removes missing or unauthorized sources', async () => {
        const { resource } = await setup();
        rpc.setResponse(method, good);
        await resource.refresh();
        const error = createProviderErrorV1('provider_endpoint_rate_limited');
        rpc.setResponse(method, { status: 'success', sources: [{ sourceId: 'credits', status: 'error', error }] });
        expect(await resource.refresh()).toMatchObject({ result: { sources: [{ status: 'error', error }] },
            snapshotsBySourceId: { credits: snapshot }, stateBySourceId: { credits: 'error_last_known_good' } });
        rpc.setResponse(method, { status: 'error', error: createProviderErrorV1('provider_endpoint_unreachable') });
        expect(await resource.refresh()).toMatchObject({ result: { status: 'error' },
            snapshotsBySourceId: { credits: snapshot }, stateBySourceId: { credits: 'error_last_known_good' } });
        rpc.setResponse(method, { status: 'success', sources: [{ sourceId: 'credits', status: 'not_configured' }] });
        expect((await resource.refresh())?.snapshotsBySourceId).toEqual({});
        rpc.setResponse(method, good);
        await resource.refresh();
        rpc.setResponse(method, { status: 'success', sources: [{ sourceId: 'credits', status: 'error',
            error: createProviderErrorV1('provider_secret_missing') }] });
        expect((await resource.refresh())?.snapshotsBySourceId).toEqual({});
        rpc.setResponse(method, good);
        await resource.refresh();
        rpc.setResponse(method, { status: 'error', error: createProviderErrorV1('provider_authorization_changed') });
        expect((await resource.refresh())?.snapshotsBySourceId).toEqual({});
        resource.dispose();
    });

    it.each(['dispose', 'retire'] as const)('drops completed and pending protected facts after %s', async ending => {
        const { resource, retire } = await setup();
        rpc.setResponse(method, good);
        await resource.refresh();
        let finish!: (response: DaemonProviderUsageRefreshResponseV1) => void;
        rpc.intercept(method, () => new Promise(resolve => { finish = resolve; }));
        const pending = resource.refresh();
        await waitForHomeGovernance(() => expect(requests()).toHaveLength(2));
        if (ending === 'dispose') resource.dispose();
        else retire();
        expect(resource.getCurrent()).toBeNull();
        finish(good);
        await expect(pending).resolves.toBeNull();
        await expect(resource.refresh()).resolves.toBeNull();
        expect(requests()).toHaveLength(2);
        resource.dispose();
    });
});
