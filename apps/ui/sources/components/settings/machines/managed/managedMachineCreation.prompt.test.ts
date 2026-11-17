import { describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { respondToManagedInstallation } from '@happier-dev/protocol/machines/managed/installationResponse';
import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createActionExecutorBoundaryFixture, createUiActionExecutorBoundary } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { Modal } from '@/modal';
import { runManagedMachineCreation } from './managedMachineCreation';

describe('owner managed creation prompts', () => {
    it.each([false, true])('answers one-off host trust through the existing prompt and response owners (retained=%s)', async retained => {
        const controller = { machineId: 'controller', installationId: 'installation' };
        const launch = { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} };
        let machine: ManagedMachineFullV1 = { id: 'paid', homeId: 'home', custodianAccountId: 'owner', controller, launch,
            allocation: 'bound', resource: { contributionRef: launch.provider, schemaVersion: 1, value: { nativeId: 'guest' } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const prompt = { kind: 'ssh.trustHost' as const, message: 'Trust this guest?', host: 'guest.test', keyType: 'ssh-ed25519',
            fingerprint: 'SHA256:guest', existingFingerprint: null };
        const operation = (): ActionOperationSnapshotV1 => ({ version: 1, operationId: 'install', revision: machine.enrolledMachineId ? 2 : 1,
            actionId: 'machines.managed.acquire', state: machine.enrolledMachineId ? 'succeeded' : 'running',
            scope: { accountId: 'owner', machineId: controller.machineId }, title: 'Install', createdAt: 1, startedAt: 1,
            ...(machine.enrolledMachineId ? { settledAt: 2 } : {}), cancellation: 'supported',
            domainRef: { kind: 'managedMachine', id: machine.id, controller, resource: machine.resource,
                ...(!machine.enrolledMachineId ? { bootstrapTask: { id: 'trust-task', taskKind: 'remote.ssh.bootstrapMachine.v1', prompt } } : {}) } });
        const responses: unknown[] = [];
        const waits: unknown[] = [];
        const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
                'machines.managed.acquire': ['ui'], 'machines.managed.get': ['ui'],
                'machines.managed.bootstrap.respond': ['ui'], 'action.operations.get': ['ui'],
            } });
        const executor = createUiActionExecutorBoundary(createActionExecutorBoundaryFixture({
            readActionsSettings: () => settings,
            // Home persistence and controller RPC are the external boundaries; Action admission and prompt correlation stay real.
            managedMachineAction: async request => request.actionId === 'machines.managed.get' ? machine
                : request.actionId === 'machines.managed.acquire' ? { managedId: machine.id, operation: { operationId: 'install' } }
                : (() => { throw new Error('Unexpected managed mutation'); })(),
            actionOperationAction: async request => {
                waits.push(request.input);
                return { kind: 'found', operation: operation() };
            },
            machineManagedInstallationRespond: (input, context) => respondToManagedInstallation(input, context, {
                accountId: 'owner', homeId: 'home', accountAuthority: true, assertCurrent: () => {},
                readMachine: async () => ({ originalMachine: machine, machine }),
                readOperation: async () => ({ kind: 'found', operation: operation() }),
                invokeTask: async (machineId, response) => {
                    responses.push({ machineId, ...response });
                    machine = { ...machine, enrolledMachineId: 'guest' };
                    return { ok: true, result: { ok: true } };
                },
                invokeInstallation: async () => { throw new Error('Owner must use the existing task response'); },
                approvePairing: async () => { throw new Error('Trust must not approve pairing'); },
            }),
        }), 'owner', settings);
        const draft = createManagedMachineSelectionDraft({ enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
            selection: { kind: 'one-off', homeId: 'home', launch, controller, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            receipt: { launch, controller, optionStatus: 'current', prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' },
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const question = vi.spyOn(Modal, 'show').mockImplementation(config => {
            const props: unknown = config.props;
            if (config.chrome?.testID !== 'ssh-host-key-modal' || !props || typeof props !== 'object'
                || !('onResolve' in props) || typeof props.onResolve !== 'function') throw new Error('Expected the existing SSH host-key sheet');
            props.onResolve(true);
            return 'host-key-question';
        });
        try {
            const result = await runManagedMachineCreation({ draft,
                acquisition: { requestId: 'owner-add', selection: draft.selection,
                    ...(retained ? { managedId: machine.id, operation: { operationId: 'install' } } : {}) },
                scope: { serverId: 'server', accountId: 'owner' }, signal: new AbortController().signal, isCurrent: () => true,
                executeAction: createFrontDoorActionExecute(executor), onAcquisitionChange: () => {}, onProgress: () => {},
                onApprovalPending: () => { throw new Error('Unexpected second approval'); } });
            expect(result).toMatchObject({ kind: 'enrolled', machine: { id: 'paid', enrolledMachineId: 'guest' } });
            expect(question).toHaveBeenCalledOnce();
            expect(responses).toEqual([{ machineId: controller.machineId, taskId: 'trust-task', expectedPromptKind: 'ssh.trustHost', answer: { trusted: true } }]);
            expect(waits).toEqual([expect.objectContaining({ operationId: 'install', waitForTerminal: true, includeManagedPrompt: true }),
                expect.objectContaining({ operationId: 'install', waitForTerminal: true, includeManagedPrompt: true })]);
            expect(waits.every(value => typeof value === 'object' && value !== null && !('managed' in value))).toBe(true);
        } finally { question.mockRestore(); }
    });
});
