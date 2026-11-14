import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
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

    it.each(['plain', 'e2ee'] as const)('opens the exact %s preset snapshot for a pre-enrollment confirmation name', async mode => {
        const { encodeBase64 } = await import('@happier-dev/protocol/crypto/base64');
        const { computeContentPublicKeyFingerprint } = await import('@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint');
        const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
        const { sealManagedMachinePresetContentV1, projectManagedMachinePresetForRecipientV1 } = await import(
            '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1');
        const { ManagedGetOutputV1Schema } = await import('@happier-dev/protocol/machines/managed/actionsV1');
        const credentials = mode === 'e2ee' ? { token: createAccountTokenForTests('account', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(67), 'base64url') } : undefined;
        const encryption = credentials ? await createEncryptionFromAuthCredentials(credentials) : null;
        const home = await harness.addHome({ name: 'Snapshot Home', serverUrl: 'https://snapshot-approval.test',
            accountId: 'account', serverIdentityId: 'srv_snapshot_approval', accountEncryptionMode: mode, credentials,
            currentAccount: true });
        const controller = { machineId: 'controller', installationId: 'installed' };
        const launch = { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1,
            name: 'Private snapshot guest', choices: {} };
        const setup = { scripts: [], items: [] };
        const content = { v: 1 as const, name: 'Private preset title', launch, setup };
        const reviewedFacts = { launch, optionStatus: 'current' as const,
            billing: { location: 'local' as const, stoppedBilling: 'not-billed' as const }, prerequisites: [],
            retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] as const },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
        const nativeResult = { kind: 'bound' as const,
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: { id: 'native-private' } } };
        const sealed = mode === 'plain' ? sealManagedMachinePresetContentV1({ presetId: 'snapshot-preset', mode, content })
            : sealManagedMachinePresetContentV1({ presetId: 'snapshot-preset', mode, content, randomBytes: length => new Uint8Array(length).fill(19),
                recipientCensus: [{ account: { kind: 'account', accountId: 'account', firstName: null, lastName: null,
                    username: null, avatarUrl: null }, envelopeStatus: 'missing', readiness: { status: 'available',
                    contentPublicKey: encodeBase64(encryption!.contentDataKey, 'base64'),
                    contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(encryption!.contentDataKey) } }] });
        const { ManagedOpaquePresetMachineV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachineV1');
        const { prepareManagedOpaquePresetReportV1 } = await import('@happier-dev/cli-common/machines/managed');
        const machine = ManagedOpaquePresetMachineV1Schema.parse({
            id: 'snapshot-guest', homeId: 'srv_snapshot_approval', custodianAccountId: 'account', controller,
            preset: { id: 'snapshot-preset', revision: 2, contentEncryptionMode: mode }, allocation: 'bound',
            creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        });
        const admittedSnapshot = prepareManagedOpaquePresetReportV1({ machine, content: sealed.content,
            recipients: sealed.recipients, opened: { ...content, reviewedFacts }, accountId: 'account', reviewedFacts, nativeResult,
            ...(mode === 'e2ee' ? { accountKey: encryption!.getContentPrivateKey() } : {}),
            randomBytes: length => new Uint8Array(length).fill(23) });
        if (!admittedSnapshot) throw new Error('Expected daemon-sealed managed preset snapshot');
        const read = ManagedGetOutputV1Schema.parse({ machine: {
            ...machine,
        }, presetContent: projectManagedMachinePresetForRecipientV1({ content: admittedSnapshot.content, recipients: sealed.recipients,
            recipientAccountId: 'account' }) });
        if (mode === 'e2ee') expect(JSON.stringify(read)).not.toContain(launch.name);
        harness.answer(home, 'POST /v1/machines/managed/actions/get', { body: read });
        await harness.addHome({ name: 'Other Home', serverUrl: 'https://other-snapshot-approval.test',
            accountId: 'other', serverIdentityId: 'srv_other_snapshot', currentAccount: true });
        const account = await captureLazyActionAccountContext(home);
        try {
            const confirmation = await readApprovalReferenceForConfirmation({ kind: 'managedMachine',
                homeId: 'srv_snapshot_approval', id: 'snapshot-guest' }, account);
            expect(confirmation).toMatchObject({ subject: 'managedMachine', named: true, text: launch.name });
        } finally { account.dispose(); }
        expect(harness.requestsFor('/v1/machines/managed/actions/get')).toHaveLength(1);
        expect(harness.requests.filter(request => request.path.startsWith('/v1/machines/presets/'))).toEqual([]);
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
