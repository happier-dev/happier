import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { renderHook, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

installApprovalCommonModuleMocks();
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { useManagedEnrolledMachine } = await import('./ManagedMachineSections');
const { useManagedMachineInventory } = await import('./useManagedMachineInventory');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
beforeEach(async () => { await harness.reset(); });
afterEach(() => standardCleanup());

describe('enrolled managed association demand', () => {
    it.each([false, true])('selects one enrolled Machine without unrelated transfers and reuses an admitted inventory (warm=%s)', async warm => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://enrolled-cost.test',
            serverIdentityId: 'srv_enrolled_cost', accountId: 'owner', currentAccount: true });
        const rows = Array.from({ length: 128 }, (_, index) => ManagedMachineV1Schema.parse({
            id: `managed-${index}`, homeId: 'srv_enrolled_cost', custodianAccountId: 'owner', enrolledMachineId: `guest-${index}`,
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: `Guest ${index}`, choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: {} },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        }));
        let transferred = 0;
        harness.answer(serverId, '/v1/machines/managed/actions/list', { select: input => {
            const id = input && typeof input === 'object' && 'enrolledMachineId' in input ? input.enrolledMachineId : undefined;
            const selected = id ? rows.filter(row => row.enrolledMachineId === id) : rows;
            transferred += selected.filter(row => row.enrolledMachineId !== 'guest-64').length;
            return { body: { machines: selected } };
        } });
        const realExecute = createFrontDoorActionExecute(createDefaultActionExecutor());
        let readAdmissions = 0;
        // Observe real admission without substituting any Action logic.
        const executeAction: typeof realExecute = Object.assign((...args: Parameters<typeof realExecute>) => {
            if (args[0] === 'machines.managed.list') readAdmissions += 1;
            return realExecute(...args);
        }, { confirmed: realExecute.confirmed, prepare: realExecute.prepare });
        const broad = await renderHook(() => useManagedMachineInventory(warm ? [serverId] : [], undefined, executeAction));
        if (warm) await waitForHomeGovernance(() => expect(broad.getCurrent().entries.srv_enrolled_cost?.status).toBe('ready'));
        transferred = 0;
        const before = harness.requestsFor('/v1/machines/managed/actions/list').length;
        const hook = await renderHook(() => useManagedEnrolledMachine({ serverId, enrolledMachineId: 'guest-64', executeAction }));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().machine?.id).toBe('managed-64'));
            expect(transferred).toBe(0);
            const reads = harness.requestsFor('/v1/machines/managed/actions/list');
            expect(reads).toHaveLength(before + (warm ? 0 : 1));
            if (warm) expect(hook.getCurrent().machine).toBe(broad.getCurrent().machinesByServerId[serverId]?.[64]);
            else expect(reads.at(-1)?.input).toEqual({ homeId: 'srv_enrolled_cost', enrolledMachineId: 'guest-64' });
            const settledReads = reads.length;
            const settledAdmissions = readAdmissions;
            for (const kind of ['session', 'discussion'] as const) {
                await act(async () => publishHomeAccountChange(serverId, ['unrelated'], { source: 'socket', changeKinds: [kind] }));
                await flushHookEffects({ cycles: 30 });
            }
            await act(async () => publishHomeAccountChange(serverId, ['workflow-run:unrelated'], { source: 'socket', changeKinds: ['account'] }));
            await flushHookEffects({ cycles: 30 });
            expect(harness.requestsFor('/v1/machines/managed/actions/list')).toHaveLength(settledReads);
            expect(readAdmissions).toBe(settledAdmissions);
            rows[64] = { ...rows[64]!, intentRevision: 2 };
            await act(async () => publishHomeAccountChange(serverId));
            await waitForHomeGovernance(() => expect(hook.getCurrent().machine?.intentRevision).toBe(2));
            if (warm) {
                await broad.unmount();
                await act(async () => publishHomeAccountChange(serverId));
                await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/managed/actions/list').at(-1)?.input)
                    .toEqual({ homeId: 'srv_enrolled_cost', enrolledMachineId: 'guest-64' }));
            }
            harness.answer(serverId, '/v1/machines/managed/actions/list', { status: 403, body: { code: 'permission_denied' } });
            await act(async () => publishHomeAccountChange(serverId));
            await waitForHomeGovernance(() => expect(hook.getCurrent().machine).toBeUndefined());
            await flushHookEffects();
        } finally { await hook.unmount(); if (!warm) await broad.unmount(); }
    });
});
