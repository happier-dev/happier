import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';

// Modal presentation and translation are platform boundaries; admission and pairing stay real.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createManagedMachineInstallationRespond } = await import('./managedMachineInstallationAction');

describe('managed bootstrap response admission', () => {
    it.each([true, false])('preserves a legacy full preset bootstrap answer and resource after Action admission (%s)', async approved => {
        const { Modal } = await import('@/modal');
        // A second presenter would cancel in a headless answering client.
        const confirmation = vi.spyOn(Modal, 'confirm').mockResolvedValue(false);
        await homes.reset();
        const homeId = 'srv_explicit_bootstrap_answer';
        const serverUrl = `https://explicit-bootstrap-${approved}.test`;
        const token = createAccountTokenForTests('account', { currentAccount: true });
        const serverId = await homes.addHome({ name: 'Requester Home', serverUrl, serverIdentityId: homeId,
            accountId: 'account', currentAccount: true, credentials: { token } });
        const machine = ManagedMachineFullV1Schema.parse({ id: 'paid', homeId, custodianAccountId: 'company', enrollmentAccountId: 'account',
            preset: { id: 'legacy-plain-preset', revision: 4, contentEncryptionMode: 'plain' },
            launch: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound',
            resource: { contributionRef: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, value: { nativeId: 'guest' } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const { installManagedInstallationResponseBoundary } = await import('@/dev/testkit/harness/managedInstallationResponseBoundary');
        const installation = installManagedInstallationResponseBoundary({ homes, serverId, serverUrl, homeId, token,
            enrollmentAccountId: 'account', readMachine: () => machine, onAnswer: () => {} });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            machineManagedInstallationRespond: createManagedMachineInstallationRespond(),
        }));
        try {
            const result = await executor.execute('machines.managed.bootstrap.respond', {
                serverId, homeId, managedId: machine.id, operationId: 'install', taskId: 'requester-pairing',
                purpose: 'approve', prompt: { kind: 'auth.approveRemoteProvisioning', message: 'Sign this guest into your Account?' }, approved,
            }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId,
                runtimeAccountId: 'account', actionRequestId: `explicit-answer-${approved}` });
            expect(result).toMatchObject({ ok: true, result: { taskId: 'requester-pairing' } });
            expect(installation.answers).toEqual([expect.objectContaining({ answer: { approved } })]);
            expect(installation.answers[0]).toHaveProperty('resource', machine.resource);
            expect(homes.requestsFor('/v1/auth/response')).toHaveLength(approved ? 1 : 0);
            expect(confirmation).not.toHaveBeenCalled();
        } finally { installation.dispose(); confirmation.mockRestore(); await homes.reset(); }
    });

    it('keeps an opened opaque preset resource out of the requester Home installation response', async () => {
        await homes.reset();
        const homeId = 'srv_opaque_bootstrap_answer';
        const serverUrl = 'https://opaque-bootstrap-answer.test';
        const credentials = { token: createAccountTokenForTests('account', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(59), 'base64url') };
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const serverId = await homes.addHome({ name: 'Requester Home', serverUrl, serverIdentityId: homeId,
            accountId: 'account', currentAccount: true, accountEncryptionMode: 'e2ee', credentials });
        const launch = { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1,
            name: 'Private guest', choices: {} } as const;
        const controller = { machineId: 'controller', installationId: 'installation' };
        const setup = { scripts: [], items: [] };
        const resource = { contributionRef: launch.provider, schemaVersion: 1,
            value: { namespace: 'private-native-namespace', nativeId: 'private-native-id' } };
        const { replaceManagedMachinePresetLaunchNameV1, sealManagedMachinePresetContentV1,
            projectManagedMachinePresetForRecipientV1 } = await import(
            '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1');
        const sealed = sealManagedMachinePresetContentV1({ presetId: 'private-preset', mode: 'e2ee',
            content: { v: 1, name: launch.name, launch, setup },
            recipientCensus: [{ account: { kind: 'account', accountId: 'account', name: 'Requester', firstName: 'Requester',
                lastName: null, username: 'requester', avatarUrl: null }, readiness: { status: 'available',
                contentPublicKey: encodeBase64(encryption.contentDataKey, 'base64'),
                contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(encryption.contentDataKey) }, envelopeStatus: 'missing' }],
            randomBytes: length => new Uint8Array(length).fill(7) });
        const content = replaceManagedMachinePresetLaunchNameV1({ presetId: 'private-preset', mode: 'e2ee',
            content: sealed.content, recipients: sealed.recipients, accountId: 'account',
            accountKey: encryption.getContentPrivateKey(), launchName: launch.name,
            reviewedFacts: { launch, controller, optionStatus: 'current',
                billing: { location: 'local', stoppedBilling: 'not-billed' }, prerequisites: [],
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, setup },
            nativeResult: { kind: 'bound', resource }, randomBytes: length => new Uint8Array(length).fill(11) });
        if (!content) throw new Error('Expected the real controller snapshot producer to seal its native result');
        const { ManagedMachineReadV1Schema } = await import('@happier-dev/protocol/machines/managed/actionsV1');
        const read = ManagedMachineReadV1Schema.parse({ machine: { id: 'paid', homeId,
            custodianAccountId: 'company', enrollmentAccountId: 'account', controller,
            preset: { id: 'private-preset', revision: 4, contentEncryptionMode: 'e2ee' },
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            presetContent: projectManagedMachinePresetForRecipientV1({ content, recipients: sealed.recipients,
                recipientAccountId: 'account' }) });
        const { installManagedInstallationResponseBoundary } = await import('@/dev/testkit/harness/managedInstallationResponseBoundary');
        const installation = installManagedInstallationResponseBoundary({ homes, serverId, serverUrl, homeId,
            token: credentials.token, enrollmentAccountId: 'account', readMachine: () => read, onAnswer: () => {} });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            machineManagedInstallationRespond: createManagedMachineInstallationRespond(),
        }));
        try {
            const result = await executor.execute('machines.managed.bootstrap.respond', {
                serverId, homeId, managedId: 'paid', operationId: 'install', taskId: 'requester-pairing',
                purpose: 'approve', prompt: { kind: 'auth.approveRemoteProvisioning', message: 'Sign this guest into your Account?' }, approved: false,
            }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId,
                runtimeAccountId: 'account', actionRequestId: 'opaque-answer' });
            expect(result).toMatchObject({ ok: true, result: { taskId: 'requester-pairing' } });
            expect(installation.answers).toEqual([expect.objectContaining({ answer: { approved: false },
                homeId, managedId: 'paid', controller, expectedIntentRevision: 1 })]);
            expect(installation.answers[0]).not.toHaveProperty('resource');
            expect(JSON.stringify(installation.answers)).not.toContain('private-native-');
            expect(homes.requestsFor('/v1/auth/response')).toHaveLength(0);
        } finally { installation.dispose(); await homes.reset(); }
    });
});
