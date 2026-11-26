import { describe, expect, it, vi } from 'vitest';
import { buildInboxMachineSignInItems } from '@/components/inbox/inboxItems';
import { createActionExecutorBoundaryFixture, createUiActionExecutorBoundary } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { publishHomeAccountChangeWake } from '@/sync/runtime/orchestration/homeAccountChange';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { MANAGED_MACHINE_SIGN_IN_OCCURRENCE_ENTITY_PREFIX_V1, type ManagedMachineSignInOccurrenceV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { respondToManagedInstallation } from '@happier-dev/protocol/machines/managed/installationResponse';
import { ManagedOpaquePresetMachineV1Schema, type ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { observeInboxMachineSignInItems, openInboxMachineSignInTarget } from './useInboxMachineSignInItems';

const scope = { serverId: 'sign-in-server', accountId: 'requester' };
const occurrence = { homeId: 'home', requesterAccountId: 'requester', managedId: 'guest-resource',
    operationId: 'acquire-operation', taskId: 'sign-in-task', promptKind: 'auth.approveRemoteProvisioning',
    state: 'pending' } satisfies ManagedMachineSignInOccurrenceV1;

function lifetime() {
    const listeners = new Set<() => void>();
    let current = true;
    const binding: ServerAccountScopeLifetime = { scope, isCurrent: () => current, onRetire(listener) {
        listeners.add(listener);
        return { dispose: () => { listeners.delete(listener); } };
    } };
    return { binding, retire: () => { current = false; for (const listener of listeners) listener(); } };
}

describe('Inbox managed sign-in data', () => {
    it('opens the exact pending occurrence and removes it on its Home wake', async () => {
        const { binding, retire } = lifetime();
        let occurrences: readonly ManagedMachineSignInOccurrenceV1[] = [occurrence];
        const read = vi.fn(async () => ({ ok: true as const, value: { occurrences } }));
        const publish = vi.fn();
        const dispose = observeInboxMachineSignInItems({ binding, publish, read });
        try {
            await vi.waitFor(() => expect(publish).toHaveBeenCalledWith([expect.objectContaining({
                type: 'confirm_machine_sign_in', view: 'needs_you', machine: { homeId: 'home', id: 'guest-resource' },
                openTarget: { kind: 'managed_machine_sign_in_approval', serverId: scope.serverId,
                    requesterAccountId: scope.accountId, homeId: 'home', managedId: 'guest-resource',
                    operationId: 'acquire-operation', taskId: 'sign-in-task' },
            })]));
            publishHomeAccountChangeWake(scope.serverId, { t: 'account-change', changeKinds: ['artifact'],
                entityIds: ['different-domain'] }, 'socket');
            expect(read).toHaveBeenCalledTimes(1);
            occurrences = [{ ...occurrence, state: 'expired' }];
            const wake = publishHomeAccountChangeWake(scope.serverId, { t: 'account-change', changeKinds: ['account'],
                entityIds: [MANAGED_MACHINE_SIGN_IN_OCCURRENCE_ENTITY_PREFIX_V1 + 'id'] }, 'socket');
            expect(wake).toMatchObject({ accountSettingsAffects: false, publicProfileAffects: false });
            await vi.waitFor(() => expect(publish).toHaveBeenLastCalledWith([]));
            expect(read).toHaveBeenCalledTimes(2);
            retire();
            publishHomeAccountChangeWake(scope.serverId, { t: 'account-change', changeKinds: ['account'],
                entityIds: [MANAGED_MACHINE_SIGN_IN_OCCURRENCE_ENTITY_PREFIX_V1 + 'id'] }, 'socket');
            expect(read).toHaveBeenCalledTimes(2);
        } finally { dispose(); }
    });

    it.each(['retirement', 'unmount'] as const)('quietly cancels an in-flight sign-in read on %s', async reason => {
        const { binding, retire } = lifetime();
        let signal: AbortSignal | undefined;
        // The Home HTTP read rejects with its AbortSignal's reason when cancelled.
        const read = vi.fn((_scope: ServerAccountScopeLifetime['scope'], input: AbortSignal) => new Promise<never>((_resolve, reject) => {
            signal = input;
            input.addEventListener('abort', () => reject(input.reason), { once: true });
        }));
        const publish = vi.fn();
        const unhandled: unknown[] = [];
        const recordUnhandled = (error: unknown) => { unhandled.push(error); };
        process.on('unhandledRejection', recordUnhandled);
        const dispose = observeInboxMachineSignInItems({ binding, publish, read });
        try {
            expect(signal).toBeDefined();
            if (reason === 'retirement') retire();
            else dispose();
            expect(signal?.aborted).toBe(true);
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(unhandled).toEqual([]);
            expect(publish).not.toHaveBeenCalled();
            publishHomeAccountChangeWake(scope.serverId, { t: 'account-change', changeKinds: ['account'],
                entityIds: [MANAGED_MACHINE_SIGN_IN_OCCURRENCE_ENTITY_PREFIX_V1 + 'id'] }, 'socket');
            expect(read).toHaveBeenCalledTimes(1);
        } finally {
            dispose();
            process.removeListener('unhandledRejection', recordUnhandled);
        }
    });

    it.each([
        { replaced: false, opaque: false }, { replaced: true, opaque: false }, { replaced: false, opaque: true },
    ])('passes only the addressed current task to the member-client approve flow ($replaced, $opaque)', async ({ replaced, opaque }) => {
        const launch = { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} };
        const controller = { machineId: 'controller', installationId: 'installed-controller' };
        const machine: ManagedMachineFullV1 = { id: occurrence.managedId, homeId: occurrence.homeId,
            custodianAccountId: 'owner', enrollmentAccountId: scope.accountId, controller, launch, allocation: 'bound',
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: { nativeId: 'guest' } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const { resource: _, launch: _launch, ...structural } = machine;
        const originalMachine = opaque ? ManagedOpaquePresetMachineV1Schema.parse({
            ...structural, preset: { id: 'team-preset', revision: 1, contentEncryptionMode: 'plain' },
        }) : machine;
        const getResult = opaque ? {
            machine: originalMachine,
            presetContent: { content: { t: 'plain', v: { v: 1, name: 'Guest', launch } }, recipientEnvelope: null },
        } : machine;
        const snapshot: ActionOperationSnapshotV1 = { version: 1, operationId: occurrence.operationId, revision: 1,
            actionId: 'machines.managed.acquire', state: 'running', scope: { accountId: scope.accountId, machineId: controller.machineId },
            title: 'Acquire', createdAt: 1, startedAt: 1, cancellation: 'supported', domainRef: {
                kind: 'managedMachine', id: machine.id, resource: machine.resource, controller,
                bootstrapTask: { id: replaced ? 'replacement-task' : occurrence.taskId, taskKind: 'remote.ssh.bootstrapMachine.v1',
                    prompt: { kind: occurrence.promptKind, message: 'Approve remote provisioning' } },
            } };
        const view = { kind: 'found' as const, operation: snapshot };
        const approval = vi.fn(async () => undefined);
        const calls: unknown[] = [];
        const now = Date.now();
        const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
            'machines.managed.get': ['ui'], 'action.operations.get': ['ui'], 'machines.managed.bootstrap.respond': ['ui'],
        } });
        const actions = createUiActionExecutorBoundary(createActionExecutorBoundaryFixture({
            readActionsSettings: () => settings,
            managedMachineAction: async () => getResult,
            actionOperationAction: async request => {
                expect(request.input).toMatchObject({ managed: { homeId: occurrence.homeId, managedId: occurrence.managedId },
                    operationId: occurrence.operationId });
                return view;
            },
            machineManagedInstallationRespond: (input, context) => respondToManagedInstallation(input, context, {
                accountId: scope.accountId, homeId: occurrence.homeId, accountAuthority: true, assertCurrent: () => {},
                readMachine: async () => ({ originalMachine, machine }), readOperation: async () => view,
                invokeTask: async () => { throw new Error('Requester must use the managed approval path'); },
                invokeInstallation: async request => {
                    calls.push(request);
                    return { ok: true, result: request.delivery ? { publicKey: 'pairing-public-key',
                        homeServerIdentityId: occurrence.homeId, pairing: { secretB64Url: 'private-pairing-data',
                            createdAtMs: now, expiresAtMs: now + 60_000 }, supportsTokenOnly: true,
                        pairingRequirement: 'v3', enrollmentAccountId: scope.accountId } : { taskId: occurrence.taskId } };
                },
                approvePairing: approval,
            }),
        }), scope.accountId, settings);
        const [item] = buildInboxMachineSignInItems(scope, [occurrence]);
        expect(JSON.stringify(item)).not.toContain('private-pairing-data');
        const result = await openInboxMachineSignInTarget({ target: item!.openTarget, binding: lifetime().binding,
            executeAction: createFrontDoorActionExecute(actions) });
        if (replaced) {
            expect(result).toMatchObject({ ok: false, errorCode: 'no_prompt' });
            expect(approval).not.toHaveBeenCalled();
            expect(calls).toEqual([]);
        } else {
            expect(result).toMatchObject({ ok: true, result: { taskId: occurrence.taskId } });
            expect(approval).toHaveBeenCalledOnce();
            expect(calls).toEqual([
                expect.objectContaining({ taskId: occurrence.taskId, delivery: { kind: 'terminalPairing' } }),
                expect.objectContaining({ taskId: occurrence.taskId, answer: { approved: true } }),
            ]);
        }
    });
});
