import { afterEach, expect, it } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import { bindPresentUserActionConfirmation } from './presentUserConfirmation';

installApprovalCommonModuleMocks();
afterEach(async () => { await standardCleanup(); });

it.each([
    { read: 'transport', entry: 'execute' },
    { read: 'cancelled', entry: 'execute' },
    { read: 'transport', entry: 'prepare' },
    { read: 'cancelled', entry: 'prepare' },
] as const)('settles retained Delete $entry before native effects when the review read is $read', async ({ read, entry }) => {
    const homeId = `srv_delete_${entry}_read_${read}`;
    const cancellation = new AbortController();
    const nativeRequests: string[] = [];
    const homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: `https://delete-${entry}-read-${read}.test`,
        serverIdentityId: homeId, accountId: 'requester', currentAccount: true }], route: request => {
        if (request.path === '/v1/machines/managed/actions/get') {
            if (read === 'transport') throw new TypeError('Review transport unavailable');
            cancellation.abort();
            throw new DOMException('Review cancelled', 'AbortError');
        }
        if (request.path.includes('/machines/managed/')) nativeRequests.push(request.path);
        return undefined;
    } });
    try {
        const state = storage.getState();
        state.applySettings({ ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1 }) },
            (state.settingsVersion ?? 0) + 1);
        const actionId = 'machines.managed.delete';
        const input = { homeId, managedId: 'foreign-managed', expectedRevision: 4, when: 'now' as const,
            intent: 'delete' as const, reviewedDependencies: true as const };
        const context = bindPresentUserActionConfirmation(actionId, input, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: homes.homes.a!.id, serverIdentityId: homeId, runtimeAccountId: 'requester',
            actionRequestId: `delete-${entry}-read-${read}`, signal: cancellation.signal,
        });
        const executor = createDefaultActionExecutor();
        const result = entry === 'prepare' ? await executor.prepare(actionId, input, context).then(prepared => {
            expect(prepared.kind).toBe('settled');
            if (prepared.kind !== 'settled') throw new Error('A failed retained read must settle before native preparation');
            return prepared.result;
        }) : await executor.execute(actionId, input, context);
        expect(result).toMatchObject({ ok: false, errorCode: read === 'transport' ? 'managed_request_failed' : 'cancelled' });
        expect(nativeRequests).toEqual([]);
    } finally { await homes.dispose(); }
});
