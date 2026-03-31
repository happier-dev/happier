import {
    SYSTEM_TASK_PROTOCOL_VERSION,
    type SystemTaskResult,
    type SystemTaskSpec,
} from '@happier-dev/protocol';
import { t } from '@/text';

import type {
    SystemTaskBridgeListenerSet,
    SystemTasksBridge,
} from './types';

type DeterministicScenarioStep =
    | Readonly<{
        delayMs: number;
        type: 'event';
        payload: Record<string, unknown>;
    }>
    | Readonly<{
        delayMs: number;
        type: 'result';
        payload: SystemTaskResult;
    }>;

type BridgeListenerSet = Readonly<{
    taskId: string;
}> & SystemTaskBridgeListenerSet;

type TaskRuntime = {
    timeouts: Set<ReturnType<typeof setTimeout>>;
    completed: boolean;
};

type DevScenarioOverrides = Readonly<Record<string, unknown>>;

function readDevSystemTaskScenarioOverride(taskKind: string): string | null {
    const record: DevScenarioOverrides | null =
        typeof globalThis !== 'undefined'
            && (globalThis as any).__HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__
            && typeof (globalThis as any).__HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__ === 'object'
            ? ((globalThis as any).__HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__ as DevScenarioOverrides)
            : null;
    if (!record) {
        return null;
    }
    const override = record[taskKind];
    return typeof override === 'string' && override.trim().length > 0 ? override.trim() : null;
}

function buildDefaultScenario(spec: SystemTaskSpec, taskId: string): readonly DeterministicScenarioStep[] {
  const taskKind = spec.kind;
    const scenarioOverride = readDevSystemTaskScenarioOverride(taskKind);
    if (taskKind === 'daemon.service.status.v1') {
        return [
            {
                delayMs: 30,
                type: 'result',
                payload: {
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    ok: true,
                    data: {
                        serviceInstalled: true,
                        daemonRunning: true,
                        needsAuth: false,
                        machineId: 'machine-local-1',
                    },
                },
            },
        ];
    }
    if (taskKind === 'secureAccess.tailscale.v1') {
        const approvalUrl = 'https://login.tailscale.com/f/serve?node=node-dev';
        if (scenarioOverride === 'approval') {
            return [
                {
                    delayMs: 30,
                    type: 'event',
                    payload: {
                        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                        taskId,
                        tsMs: 30,
                        type: 'step',
                        stepId: 'tailscale.detect',
                        message: t('common.loading'),
                    },
                },
                {
                    delayMs: 120,
                    type: 'event',
                    payload: {
                        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                        taskId,
                        tsMs: 120,
                        type: 'prompt',
                        stepId: 'tailscale.serveEnable',
                        message: t('common.continue'),
                        data: {
                            kind: 'tailscaleServeApproval',
                            url: approvalUrl,
                        },
                    },
                },
                {
                    delayMs: 180,
                    type: 'result',
                    payload: {
                        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                        taskId,
                        ok: true,
                        data: {
                            tailscaleInstalled: true,
                            tailscaleLoggedIn: true,
                            serveEnabled: false,
                            shareableHttpsUrl: null,
                            requiresApproval: {
                                url: approvalUrl,
                            },
                        },
                    },
                },
            ];
        }

        return [
            {
                delayMs: 30,
                type: 'event',
                payload: {
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    tsMs: 30,
                    type: 'step',
                    stepId: 'tailscale.detect',
                    message: t('common.loading'),
                },
            },
            {
                delayMs: 90,
                type: 'event',
                payload: {
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    tsMs: 90,
                    type: 'progress',
                    stepId: 'tailscale.serveEnable',
                    message: t('settings.localTailscale.statusWorking'),
                },
            },
            {
                delayMs: 150,
                type: 'result',
                payload: {
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    ok: true,
                    data: {
                        tailscaleInstalled: true,
                        tailscaleLoggedIn: true,
                        serveEnabled: true,
                        shareableHttpsUrl: 'https://relay.tailnet.ts.net',
                        requiresApproval: null,
                    },
                },
            },
        ];
    }
    if (taskKind === 'daemon.service.start.v1') {
        return [
            {
                delayMs: 30,
                type: 'event',
                payload: {
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    tsMs: 30,
                    type: 'step',
                    stepId: 'task.step.prepare',
                    message: t('settings.systemTaskStepPrepare'),
                },
            },
            {
                delayMs: 120,
                type: 'event',
                payload: {
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    tsMs: 120,
                    type: 'progress',
                    stepId: 'task.step.finish',
                    message: t('settings.systemTaskStepFinish'),
                },
            },
            {
                delayMs: 180,
                type: 'result',
                payload: {
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    ok: true,
                    data: {
                        serviceInstalled: true,
                        daemonRunning: true,
                        needsAuth: false,
                        machineId: 'machine-local-1',
                    },
                },
            },
        ];
    }
    if (taskKind === 'setup.repairThisComputer.v1') {
        return [
            {
                delayMs: 30,
                type: 'event',
                payload: {
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    tsMs: 30,
                    type: 'step',
                    stepId: 'setup.repairThisComputer.prepare',
                    message: t('server.relayDrift.progressStepPrepare'),
                },
            },
            {
                delayMs: 90,
                type: 'event',
                payload: {
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    tsMs: 90,
                    type: 'progress',
                    stepId: 'setup.repairThisComputer.configureRelay',
                    message: t('server.relayDrift.progressStepConfigureRelay'),
                },
            },
            {
                delayMs: 150,
                type: 'event',
                payload: {
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    tsMs: 150,
                    type: 'progress',
                    stepId: 'setup.repairThisComputer.authenticate',
                    message: t('server.relayDrift.progressStepAuthenticate'),
                },
            },
            {
                delayMs: 210,
                type: 'event',
                payload: {
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    tsMs: 210,
                    type: 'progress',
                    stepId: 'setup.repairThisComputer.finish',
                    message: t('server.relayDrift.progressStepFinish'),
                },
            },
            {
                delayMs: 270,
                type: 'result',
                payload: {
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    ok: true,
                    data: {
                        simulated: true,
                        kind: taskKind,
                    },
                },
            },
        ];
    }

    return [
        {
            delayMs: 30,
            type: 'event',
            payload: {
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                tsMs: 30,
                type: 'step',
                stepId: 'task.step.prepare',
                message: taskKind === 'setup.thisComputer.v1'
                    ? t('settings.machineSetupStageConnect')
                    : t('common.loading'),
            },
        },
        {
            delayMs: 90,
            type: 'event',
            payload: {
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                tsMs: 90,
                type: 'progress',
                stepId: 'task.step.installRuntime',
                message: t('settings.machineSetupStageInstall'),
            },
        },
        {
            delayMs: 150,
            type: 'event',
            payload: {
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                tsMs: 150,
                type: 'progress',
                stepId: 'task.step.finish',
                message: t('settings.machineSetupStageFinish'),
            },
        },
        {
            delayMs: 210,
            type: 'result',
            payload: {
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                ok: true,
                data: {
                    simulated: true,
                    kind: taskKind,
                },
            },
        },
    ];
}

export function createDeterministicSystemTaskBridge(options?: Readonly<{
    buildScenario?: (spec: SystemTaskSpec, taskId: string) => readonly DeterministicScenarioStep[];
}>): SystemTasksBridge {
    const listeners = new Set<BridgeListenerSet>();
    const runtimes = new Map<string, TaskRuntime>();
    let nextTaskId = 1;

    const notifyEvent = (taskId: string, payload: unknown) => {
        for (const listener of listeners) {
            if (listener.taskId === taskId) {
                listener.onEvent(payload);
            }
        }
    };

    const notifyResult = (taskId: string, payload: unknown) => {
        for (const listener of listeners) {
            if (listener.taskId === taskId) {
                listener.onResult(payload);
            }
        }
    };

    const clearRuntime = (taskId: string) => {
        const runtime = runtimes.get(taskId);
        if (!runtime) {
            return;
        }
        for (const timeoutId of runtime.timeouts) {
            clearTimeout(timeoutId);
        }
        runtimes.delete(taskId);
    };

    return {
        async start(spec) {
            const taskId = `task_${nextTaskId++}`;
            const runtime: TaskRuntime = {
                timeouts: new Set(),
                completed: false,
            };
            runtimes.set(taskId, runtime);

            const scenario = (options?.buildScenario ?? buildDefaultScenario)(spec, taskId);
            for (const step of scenario) {
                const timeoutId = setTimeout(() => {
                    if (runtime.completed) {
                        return;
                    }
                    if (step.type === 'event') {
                        notifyEvent(taskId, step.payload);
                        return;
                    }
                    runtime.completed = true;
                    notifyResult(taskId, step.payload);
                    clearRuntime(taskId);
                }, step.delayMs);
                runtime.timeouts.add(timeoutId);
            }

            return taskId;
        },
        async cancel(taskId) {
            const runtime = runtimes.get(taskId);
            if (!runtime || runtime.completed) {
                return;
            }
            runtime.completed = true;
            clearRuntime(taskId);
            notifyResult(taskId, {
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                ok: false,
                error: {
                    code: 'cancelled',
                    message: 'Task cancelled',
                },
            });
        },
        async respond() {},
        async subscribe(taskId, listenersForTask) {
            const listener = { taskId, ...listenersForTask };
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
