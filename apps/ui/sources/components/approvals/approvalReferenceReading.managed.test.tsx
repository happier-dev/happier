import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { describeApprovalActionFields } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { useApprovalReferenceReading, readApprovalReferenceForConfirmation } = await import('./approvalReferenceReading');
const { resolveApprovalRequestTitle, useApprovalRequestTitle } = await import('./approvalRequestTitle');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { storage } = await import('@/sync/domains/state/storage');

describe('managed approval references', () => {
    beforeEach(async () => { standardCleanup(); await harness.reset(); });
    afterEach(() => standardCleanup());

    it.each([
        { readable: true, enrolled: true }, { readable: true, enrolled: false }, { readable: false, enrolled: true },
    ])('reads the machine name from the approval Home, with a launch-name fallback before enrollment (%j)', async ({ readable, enrolled }) => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://managed-reference.test',
            accountId: 'account', serverIdentityId: 'srv_approval' });
        const machine = ManagedMachineV1Schema.parse({ id: 'managed-guest', homeId: 'srv_approval', custodianAccountId: 'account',
            controller: { machineId: 'controller', installationId: 'installed' }, launch: {
                provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Studio guest', choices: {} },
            ...(enrolled ? { enrolledMachineId: 'different-enrolled-id' } : {}), allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now',
            resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true });
        harness.answer(home, 'POST /v1/machines/managed/actions/get', readable ? { body: machine } : { status: 403, body: { code: 'permission_denied' } });
        const other = await harness.addHome({ name: 'Focused Home', serverUrl: 'https://other-managed-reference.test',
            accountId: 'other-account', serverIdentityId: 'srv_other' });
        harness.answer(other, 'POST /v1/machines/managed/actions/get', { body: { ...machine, homeId: 'srv_other',
            launch: { ...machine.launch, name: 'Wrong Home guest' } } });
        const guest = createMachineFixture({ id: 'different-enrolled-id', metadata: {
            ...createMachineFixture().metadata!, displayName: 'lima-happier-studio', host: 'studio-host' } });
        storage.setState({ machineListByServerId: { [home]: [guest], [other]: [{ ...guest,
            metadata: { ...guest.metadata!, displayName: 'Wrong Home enrolled guest' } }] } });
        const fields = describeApprovalActionFields({ actionId: 'machines.managed.power.set', actionArgs: {
            homeId: 'srv_approval', managedId: machine.id, intent: 'start', when: 'now', expectedRevision: 1 } });
        const row = fields.rows.find(row => row.kind === 'value' && row.path === 'managedId');
        if (!row || row.kind !== 'value' || !row.reference) throw new Error('Missing managed reference producer');
        const hook = await renderHook(() => useApprovalReferenceReading(row.reference, machine.id, home), { flushOptions: { cycles: 25 } });
        await flushHookEffects({ cycles: 25 });
        expect(hook.getCurrent()).toMatchObject({ subject: 'managedMachine', named: readable });
        expect(hook.getCurrent().text).not.toContain(machine.id);
        const expectedName = enrolled ? 'lima-happier-studio' : 'Studio guest';
        if (readable) expect(hook.getCurrent().text).toBe(expectedName);
        const account = await captureLazyActionAccountContext(home);
        try {
            const confirmation = await readApprovalReferenceForConfirmation(row.reference, account);
            expect(confirmation).toMatchObject({ subject: 'managedMachine', named: readable });
            if (readable) expect(confirmation.text).toBe(expectedName);
            else expect(confirmation.text).not.toContain(machine.id);
        } finally { account.dispose(); }
        expect(harness.requestsFor('/v1/machines/managed/actions/get')).toEqual(expect.arrayContaining([
            expect.objectContaining({ serverId: home, input: { homeId: 'srv_approval', managedId: machine.id } }),
        ]));
        expect(harness.requests.some(request => request.path.includes('different-enrolled-id'))).toBe(false);
        await hook.unmount();
    });

    it('leaves a still-unread managed machine out of the approval title instead of naming it "Machine"', async () => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://managed-title.test',
            accountId: 'account', serverIdentityId: 'srv_title' });
        const machine = ManagedMachineV1Schema.parse({ id: 'managed-title', homeId: 'srv_title', custodianAccountId: 'account',
            controller: { machineId: 'controller', installationId: 'installed' }, launch: {
                provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Studio guest', choices: {} },
            allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now',
            resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true });
        let release!: () => void;
        harness.answer(home, 'POST /v1/machines/managed/actions/get', { body: machine,
            respondAfter: new Promise<void>(resolve => { release = resolve; }) });
        const input = { storedTitle: null, actionId: 'machines.managed.power.set', actionArgs: {
            homeId: 'srv_title', managedId: machine.id, intent: 'start', when: 'now', expectedRevision: 1 } };
        const hook = await renderHook(() => useApprovalRequestTitle(input, home), { flushOptions: { cycles: 25 } });
        await flushHookEffects({ cycles: 25 });
        const unnamed = resolveApprovalRequestTitle({ ...input, subject: null }).title;
        expect(unnamed).not.toBe(resolveApprovalRequestTitle({ ...input, subject: 'Machine' }).title);
        expect(hook.getCurrent().title).toBe(unnamed);
        release();
        await flushHookEffects({ cycles: 25 });
        expect(hook.getCurrent().title).toContain('Studio guest');
        await hook.unmount();
    });
});
