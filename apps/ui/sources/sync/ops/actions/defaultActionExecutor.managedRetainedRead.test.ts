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
    { entry: 'execute', carrier: 'retained' }, { entry: 'prepare', carrier: 'retained' },
    { entry: 'execute', carrier: 'unavailable' }, { entry: 'prepare', carrier: 'unavailable' },
] as const)('keeps the reviewed Delete carrier $carrier through $entry without replacing it with a new read', async ({ entry, carrier }) => {
    const homeId = `srv_reviewed_delete_${entry}_${carrier}`;
    let gets = 0;
    let nativeAdmissions = 0;
    const homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: `https://reviewed-delete-${entry}-${carrier}.test`,
        serverIdentityId: homeId, accountId: 'owner', currentAccount: true }], route: request => {
        if (request.path === '/v1/machines/managed/actions/get') { gets++; throw new Error('A review cannot be replaced'); }
        if (request.path === '/v1/actions/machines.managed.delete') {
            nativeAdmissions++;
            const requestId = request.body && typeof request.body === 'object' && 'requestId' in request.body ? request.body.requestId : undefined;
            return Response.json({ v: 1, requestId, actionId: 'machines.managed.delete',
                execution: { ok: false, errorCode: 'permission_denied', error: 'permission_denied' } });
        }
        return undefined;
    } });
    try {
        const { ManagedMachineReadV1Schema } = await import('@happier-dev/protocol/machines/managed/actionsV1');
        const { openManagedMachineReadSnapshots } = await import('@/sync/ops/machines/machinePresetCollectionClient');
        const read = ManagedMachineReadV1Schema.parse({ machine: {
            id: 'reviewed-managed', homeId, custodianAccountId: 'owner',
            controller: { machineId: 'controller', installationId: 'installation' },
            preset: { id: 'reviewed-preset', revision: 1, contentEncryptionMode: 'plain' },
            allocation: 'may-exist', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 4,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        }, presetContent: { content: { t: 'plain', v: { v: 1, name: 'Unavailable private launch' } }, recipientEnvelope: null } });
        const serverId = homes.homes.a!.id;
        const [snapshot] = await openManagedMachineReadSnapshots({ serverId, accountId: 'owner' }, [read]);
        if (!snapshot) throw new Error('Expected the reviewed row');
        const reviewedManagedMachine = carrier === 'retained' ? snapshot : { ...snapshot };
        const input = { homeId, managedId: 'reviewed-managed', expectedRevision: 4, when: 'now', intent: 'delete', reviewedDependencies: true };
        const context = { serverId, expectedAccountId: 'owner', surface: 'ui' as const, authority: 'present_user' as const,
            actionCaller: { kind: 'host' as const }, reviewedManagedMachine };
        const executor = createDefaultActionExecutor();
        const result = entry === 'execute' ? await executor.execute('machines.managed.delete', input, context)
            : await executor.prepare('machines.managed.delete', input, context).then(prepared =>
                prepared.kind === 'ready' ? prepared.invocation.run() : prepared.result);
        expect(result).toMatchObject({ ok: false, errorCode: carrier === 'retained' ? 'permission_denied' : 'content_unavailable' });
        expect(gets).toBe(0);
        expect(nativeAdmissions).toBe(carrier === 'retained' ? 1 : 0);
    } finally { await homes.dispose(); }
});

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
