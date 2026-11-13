import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

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
    it.each([true, false])('preserves an explicit bootstrap answer after Action admission without another pairing decision (%s)', async approved => {
        const { Modal } = await import('@/modal');
        // A second presenter would cancel in a headless answering client.
        const confirmation = vi.spyOn(Modal, 'confirm').mockResolvedValue(false);
        await homes.reset();
        const homeId = 'srv_explicit_bootstrap_answer';
        const serverUrl = `https://explicit-bootstrap-${approved}.test`;
        const token = createAccountTokenForTests('account', { currentAccount: true });
        const serverId = await homes.addHome({ name: 'Requester Home', serverUrl, serverIdentityId: homeId,
            accountId: 'account', currentAccount: true, credentials: { token } });
        const machine = ManagedMachineV1Schema.parse({ id: 'paid', homeId, custodianAccountId: 'company', enrollmentAccountId: 'account',
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
            expect(homes.requestsFor('/v1/auth/response')).toHaveLength(approved ? 1 : 0);
            expect(confirmation).not.toHaveBeenCalled();
        } finally { installation.dispose(); confirmation.mockRestore(); await homes.reset(); }
    });
});
