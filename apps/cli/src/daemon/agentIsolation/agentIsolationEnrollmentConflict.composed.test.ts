import { expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { MachineAgentIsolationSetResultV1Schema } from '@happier-dev/protocol/machines/agentIsolationV1';
import { applyManagedMachineEnrollmentIsolation } from '@happier-dev/cli-common/machines/managed';
import type { MachineSetupBackend } from '@happier-dev/cli-common/machineSetup';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { publishMachineMetadataOnce, readOpenedMachineMetadataSnapshot } from '@/api/machine/machineMetadataPublication';
import type { Machine } from '@/api/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations';
import { readAgentIsolationSnapshot } from './agentIsolationPolicy';
import { createAgentIsolationEffectsBoundary } from './agentIsolationEffects.testkit';

it.skipIf(process.platform !== 'linux').each(['unrelated', 'desired', 'desired-native-observations', 'root-native-observations',
  'post-apply-pending', 'post-apply-unavailable', 'post-apply-target', 'policy', 'native'] as const)(
  'compares reviewed isolation facts after a %s publication through bootstrap and native Apply', async publication => {
    const postApplyPublication = publication.startsWith('post-apply-');
    const initialVersion = postApplyPublication ? 109 : 101;
    const machine: Machine = { id: 'guest', encryptionMode: 'plain', metadataVersion: initialVersion, daemonStateVersion: 1,
        metadata: { host: 'guest', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/happier', happyHomeDir: '/home/happier/.happier' },
        daemonState: { status: 'running', runtimeId: 'daemon', agentIsolation: { kind: 'unavailable', code: 'provisioning_unavailable' } } };
    const port = {
        read: async () => readOpenedMachineMetadataSnapshot(machine, true),
        compareAndSwap: (input: Parameters<typeof publishMachineMetadataOnce>[1]) => publishMachineMetadataOnce({
            getMachine: () => machine, codec: createMachineContentCodec({ encryptionMode: 'plain' }), expectedDataEncryptionKey: null,
            isContentCurrent: () => true, retireAndRefreshContent: async () => {}, notifyMetadataChanged: () => {},
            // Socket persistence is the boundary; the metadata publisher and CAS stay real.
            socket: { connected: true, emitWithAck: async (_event, payload) => ({ result: 'success' as const,
                version: payload.expectedVersion + 1, metadata: payload.metadata }) },
        }, input),
    };
    let sessionsToReplace = 0, previews = 0, confirmations = 0, managerInstalledObservations = 0;
    let applyResult: unknown;
    const desiredPublication = publication === 'desired' || publication === 'desired-native-observations'
        || publication === 'root-native-observations' || postApplyPublication;
    const installed = new Set<string>();
    // The OS can report a new manager PID/tree snapshot while retaining the
    // same account, target groups and workspace access. CHECK/APPLY stays real.
    const backend: MachineSetupBackend = {
        async observe(step) {
            const manager = step.kind === 'command' && step.check.kind === 'userManagerGroups';
            // The first installed observation verifies APPLY; the next is the
            // daemon's post-Apply CHECK, where systemd can still be settling.
            const postApply = manager && installed.has(step.id) && ++managerInstalledObservations > 1;
            const changed = publication === 'desired-native-observations' ? machine.metadataVersion >= 102
                : machine.daemonState?.agentIsolation?.kind === 'applying';
            return { stepId: step.id, status: publication === 'post-apply-unavailable' && postApply ? 'unavailable'
                : postApplyPublication && postApply ? 'drifted'
                : step.kind === 'workspaceAccess' || installed.has(step.id) ? 'satisfied' : 'drifted',
                facts: step.kind === 'user' ? { present: true, username: step.username, uid: 1002, gid: 1002,
                    home: step.home ?? '/home/member', locked: installed.has(step.id) }
                    : step.kind === 'group' && postApplyPublication ? { present: true, gid: 1002 }
                    : step.kind === 'command' ? { pid: changed ? 2719288 : 2702756,
                        ...(postApplyPublication ? { uid: publication === 'post-apply-target' && postApply ? 1003 : 1002, gid: 1002 } : {}),
                        expectedGroupIds: [1001, 1002], actualGroupIds: [1001, 1002],
                        ...(postApplyPublication && postApply ? { requiredFact: 'userManagerGroups', pendingReason: 'user_manager_starting' } : {}) }
                    : step.kind === 'workspaceAccess' ? { treeDigest: (changed ? 'b' : 'a').repeat(64), agentUid: 1002, groupId: 1002 }
                    : { present: installed.has(step.id) } };
        },
        async apply(step) { installed.add(step.id); },
    };
    const native = createAgentIsolationEffectsBoundary({ installationId: 'guest-installation',
        ...(publication.endsWith('native-observations') || postApplyPublication ? { backend } : {}),
        installedCli: '/opt/happier/cli/current/happier',
        readRoots: () => [{ rootId: 'reviewed-workspace', path: process.cwd() }], readSessionsToReplace: () => sessionsToReplace,
        publishStatus: async status => { machine.daemonState = { ...machine.daemonState!, agentIsolation: status }; } });
    const rpc = new RpcHandlerManager({ scopePrefix: machine.id, localMachineId: machine.id, encryptionMode: 'plain',
        logger: () => {}, authorizeRequest: async () => ({ ok: true }) });
    registerDaemonMachineAgentIsolationRpcHandlers(rpc, {
        target: () => ({ serverId: 'home', machineId: machine.id, installationId: 'guest-installation', custodianAccountId: 'owner' }),
        read: () => readAgentIsolationSnapshot({ metadata: readOpenedMachineMetadataSnapshot(machine, true),
            daemonState: machine.daemonState, runtimeId: 'daemon', platform: 'linux' }),
        captureMetadataPort: () => port, effects: { ...native.effects, backend: undefined,
            // OS identity lookup is unavailable; the real readiness owner must settle that fact.
            nativeReadiness: { privateRoots: [], system: { run: async () => { throw Object.assign(new Error('No native account'), { code: 'ENOENT' }); } } } },
        runActionOperation: createHostActionOperationRuntime({ serverId: 'home', machineId: machine.id,
            resolveAccountId: async () => 'owner' }).runActionOperation,
    });
    const executor = createActionExecutor({ presentUserActionConfirmation: async () => { confirmations++; return true; },
        machineAgentIsolationAction: async ({ actionId, input, context }) => {
        if (actionId === 'machines.agentIsolation.preview') previews++;
        return rpc.invokeLocal(actionId, input, {
        rpcContext: { signal: new AbortController().signal, callerAuthority: 'present_user',
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: machine.id,
                installationId: 'guest-installation', role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true }, localActionContext: context,
    }); } });
    const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner',
        generateOperationId: () => 'bootstrap-conflict' });
    const outcome = operations.observeExecution({ actionId: 'machines.managed.bootstrap.retry',
        input: { homeId: 'home', managedId: 'managed' }, actionRequestId: 'retry', execute: async () => {
            await applyManagedMachineEnrollmentIsolation({ target: { serverId: 'home', machineId: machine.id },
                policy: { enabled: true, memberProvisioning: 'linuxUsersV1' },
                dispatch: async request => {
                    const result = await executor.execute(request.actionId, request.input, { surface: 'ui', authority: 'present_user',
                        serverId: 'home', runtimeAccountId: 'owner', actionCaller: { kind: 'host' }, actionRequestId: 'isolation' });
                    if (!result.ok) throw new Error(result.errorCode);
                    if (request.actionId === 'machines.agentIsolation.set') {
                        applyResult = result.result;
                        if (publication === 'post-apply-pending') {
                            const applied = MachineAgentIsolationSetResultV1Schema.parse(result.result);
                            if (applied.kind === 'plan_changed') expect(applied.current.plan.planDigest).toBe(request.input.expectedPlanDigest);
                        }
                    }
                    if (request.actionId === 'machines.agentIsolation.preview') {
                        // Publish through the real metadata CAS, after the person's review.
                        await port.compareAndSwap({ expectedMetadataVersion: machine.metadataVersion,
                            metadata: { ...machine.metadata!, happyCliVersion: 'refreshed',
                                ...(publication === 'policy' ? { agentIsolation: { enabled: true } } :
                                    desiredPublication ? { agentIsolation: { enabled: true, memberProvisioning: 'linuxUsersV1' } } : {}) } });
                        if (publication === 'native') sessionsToReplace = 1;
                        if (publication === 'desired') {
                            // c6: publishing the requested enable changes policy, never the reviewed effects.
                            const refreshed = await executor.execute(request.actionId, request.input, { surface: 'ui', authority: 'present_user',
                                serverId: 'home', runtimeAccountId: 'owner', actionCaller: { kind: 'host' }, actionRequestId: 'inspect-enabled' });
                            expect(refreshed).toMatchObject({ ok: true, result: { kind: 'ready', plan: {
                                planDigest: (result.result as { plan: { planDigest: string } }).plan.planDigest,
                            } } });
                        }
                    }
                    return result.result;
                } });
            return { ok: true, result: {} };
        } });
    if (publication === 'unrelated' || desiredPublication && publication !== 'post-apply-target') {
        await expect(outcome).resolves.toMatchObject({ ok: true });
        expect(await operations.handlers.getV2({ operationId: 'bootstrap-conflict', waitForTerminal: true }))
            .toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
        expect(machine.metadata).toMatchObject({ happyCliVersion: 'refreshed',
            agentIsolation: { enabled: true, memberProvisioning: 'linuxUsersV1' } });
        if (publication === 'post-apply-pending') {
            expect(applyResult).toMatchObject({ kind: 'accepted', metadataVersion: 110,
                status: { kind: 'unavailable', code: 'provisioning_unavailable', prerequisite: {
                    reason: 'native_effect_pending', requiredFact: 'userManagerGroups', detail: 'user_manager_starting',
                    remedy: 'machines.agentIsolation.preview',
                } } });
            expect(machine.daemonState?.agentIsolation).toEqual((applyResult as { status: unknown }).status);
            const repair = await executor.execute('machines.agentIsolation.preview', {
                machineId: machine.id, enabled: true, memberProvisioning: 'linuxUsersV1',
            }, { surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: 'owner',
                actionCaller: { kind: 'host' }, actionRequestId: 'repair-pending' });
            expect(repair).toMatchObject({ ok: true, result: { kind: 'ready', plan: { requiresAdmin: true } } });
        } else if (publication === 'post-apply-unavailable') {
            expect(applyResult).toMatchObject({ kind: 'accepted', status: { kind: 'unavailable', code: 'provisioning_unavailable',
                setup: { reasonCode: 'native_check_unavailable' } } });
            expect(machine.daemonState?.agentIsolation?.kind).toBe('unavailable');
        } else expect(machine.daemonState?.agentIsolation).toEqual({ kind: 'unavailable', code: 'agent_user_missing' });
        expect(native.mutations.length).toBeGreaterThan(0);
        // Only the explicit c6 inspection and registered pending repair add a Preview.
        expect(previews).toBe(publication === 'desired' || publication === 'post-apply-pending' ? 2 : 1);
        expect(confirmations).toBe(1);
    } else {
        const code = publication === 'policy' ? 'conflict' : 'plan_changed';
        await expect(outcome).rejects.toMatchObject({ code, details: { kind: 'managedAgentIsolation',
            phase: 'machines.agentIsolation.set', code, expectedMetadataVersion: initialVersion, metadataVersion: initialVersion + 1 } });
        expect(await operations.handlers.getV2({ operationId: 'bootstrap-conflict', waitForTerminal: true }))
            .toMatchObject({ kind: 'found', operation: { state: 'failed', error: { errorCode: code } } });
        expect(machine.metadata?.agentIsolation).toEqual(publication === 'policy' ? { enabled: true }
            : postApplyPublication ? { enabled: true, memberProvisioning: 'linuxUsersV1' } : undefined);
        if (postApplyPublication) {
            expect(applyResult).toMatchObject({ kind: 'plan_changed' });
            expect(native.mutations.length).toBeGreaterThan(0);
        } else expect(native.mutations).toEqual([]);
    }
    expect(native.boundaryFailures).toEqual([]);
});
