import { vi } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { publishLocalDaemonStatus } from '@/components/settings/machines/localControl/localDaemonSharedState';
import { discardMachineAddFlowDraft } from '@/components/machines/add/machineAddFlowStore';
import { createManualSystemTaskRunner } from './harness/manualSystemTaskRunner';

/** The desktop OS bridge is the substituted boundary. Task state, retained
 * enrollment, Account custody and every Action producer are production code. */
export function createUiMachineOutputFixture(serverId: string) {
    vi.stubGlobal('isTauri', true);
    const manual = createManualSystemTaskRunner('tauri');
    const nativeTasks = new Map<string, SystemTaskSpec>();
    const start = manual.bridge.start.getMockImplementation()!;
    const subscribe = manual.bridge.subscribe.getMockImplementation()!;
    const localStatus = { serviceInstalled: false, daemonRunning: false, needsAuth: false,
        machineId: null, serviceAutostart: 'on-demand' as const, managedServiceInstalled: false };
    manual.bridge.start.mockImplementation(async spec => {
        const taskId = await start(spec); nativeTasks.set(taskId, spec); return taskId;
    });
    manual.bridge.subscribe.mockImplementation(async (taskId, listeners) => {
        const unlisten = await subscribe(taskId, listeners);
        const spec = nativeTasks.get(taskId);
        if (spec?.kind.startsWith('daemon.service.') || spec?.kind === 'cli.update.v1') {
            queueMicrotask(() => manual.emitResult(taskId, { protocolVersion: 1, taskId, ok: true,
                data: spec.kind === 'daemon.service.status.v1' ? localStatus
                    : spec.kind === 'daemon.service.relay.disconnect.v1' ? { outcome: 'no_service' } : {} }));
        }
        return unlisten;
    });
    publishLocalDaemonStatus(manual.runner, localStatus);
    const executor = createDefaultActionExecutor({ homeRuntimeRunner: manual.runner });
    const context = { surface: 'ui', authority: 'present_user', serverId } as const;
    const execute = (id: ActionId, input: unknown) => executor.execute(id, input, context);
    let localTaskId: string | undefined;
    let sshTaskId: string | undefined;
    const taskIdFrom = (output: Awaited<ReturnType<typeof execute>>) => {
        if (!output.ok || !output.result || typeof output.result !== 'object'
            || !('taskId' in output.result) || typeof output.result.taskId !== 'string') {
            throw new Error('Real enrollment producer did not start a native task');
        }
        return output.result.taskId;
    };
    const startLocal = async () => localTaskId = taskIdFrom(await execute('machines.add.local.start', { serverId }));
    const startSsh = async () => {
        discardMachineAddFlowDraft();
        sshTaskId = taskIdFrom(await execute('machines.add.ssh.start', { serverId, host: 'output-contract-host',
            username: 'dev', authMode: 'keyfile', identityFilePath: '/fixture/id_ed25519' }));
        return sshTaskId;
    };
    const cases = new Map<ActionId, () => Promise<unknown> | unknown>([
        ['machines.local.service.status', () => ({ serverId })],
        ['machines.local.service.start', () => ({ serverId })],
        ['machines.local.service.stop', () => ({ serverId })],
        ['machines.local.service.restart', () => ({ serverId })],
        ['machines.local.service.autostart.set', () => ({ serverId, autostart: 'on-demand' })],
        ['machines.local.service.update', () => ({ serverId })],
        ['machines.local.service.disconnect', () => ({ serverId })],
        ['machines.add.local.start', () => ({ serverId })],
        ['machines.add.local.cancel', async () => ({ taskId: localTaskId ?? await startLocal() })],
        ['machines.add.ssh.start', () => { discardMachineAddFlowDraft(); return { serverId, host: 'output-contract-host',
            username: 'dev', authMode: 'keyfile', identityFilePath: '/fixture/id_ed25519' }; }],
        ['machines.add.ssh.status', async () => ({ taskId: sshTaskId ?? await startSsh() })],
        ['machines.add.ssh.respond', async () => {
            const taskId = sshTaskId ?? await startSsh();
            manual.emitEvent(taskId, { type: 'prompt', message: 'Trust host', data: { kind: 'ssh.trustHost',
                host: 'output-contract-host', fingerprint: 'SHA256:fixture', keyType: 'ssh-ed25519', existingFingerprint: null } });
            return { taskId, answer: { kind: 'ssh.trustHost', trusted: true } };
        }],
        ['machines.add.ssh.cancel', async () => ({ taskId: sshTaskId ?? await startSsh() })],
    ]);
    return { cases,
        execute: async (id: ActionId, input: unknown) => {
            const output = await execute(id, input);
            if (id === 'machines.add.local.start') localTaskId = taskIdFrom(output);
            if (id === 'machines.add.ssh.start' || id === 'machines.add.ssh.respond') sshTaskId = taskIdFrom(output);
            return output;
        },
        close() { discardMachineAddFlowDraft(); vi.unstubAllGlobals(); },
    };
}
