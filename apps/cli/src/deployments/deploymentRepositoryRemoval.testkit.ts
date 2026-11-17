import { onTestFinished } from 'vitest';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { StoredCredentials } from '@/persistence';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ProjectNativeToolchainIoForHost } from '@/plugins/runtime/invocation/services/exec';
import type { ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';

/** Real containing operation and Project runtime; the temporary checkout is unassociated. */
export async function createDeploymentRepositoryRemovalFixture(input: Readonly<{
    serverId: string; serverHttpBaseUrl: string; machineId: string; accountId: string;
    credentials: StoredCredentials; installedPluginRuntime?: true;
}>) {
    const plugin = input.installedPluginRuntime ? null : await createAdmittedPluginRuntimeFixture({
        controller: pluginReloadController, runtimeOptions: { pluginIds: [], contributes: createResolvedContributionRegistry({}) },
    });
    const terminalSessions = createTerminalPtySessionManager({
        // The OS process boundary must stay unused for an unassociated temporary checkout.
        ptyProvider: { spawn() { throw new Error('Unexpected temporary checkout cleanup process'); } },
        config: readDaemonTerminalPtyConfig({}).sessionManager,
    });
    onTestFinished(async () => { await terminalSessions.dispose(); await plugin?.dispose(); });
    const operationRuntime = createHostActionOperationRuntime({ serverId: input.serverId,
        machineId: input.machineId, resolveAccountId: async () => input.accountId, supportsCoreCancellation: () => true });
    const environmentIo: ProjectNativeToolchainIoForHost = { resolveTool: async () => null,
        run: async () => { throw new Error('Unexpected temporary checkout toolchain process'); }, createInvocation: () => environmentIo };
    const runtime: ProjectFiniteActionRuntime = { ...input, operationRuntime, terminalSessions,
        workerAdmission: createProjectWorkerAdmission({ machineId: input.machineId, admissionDrain: createDaemonAdmissionDrain(),
            readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: 1 }, source: 'default', metadataVersion: 1 }) }),
        resolveWorkspaceExecutionConfig: async () => null, nativeIo: { resolveTool: async () => null }, environmentIo };
    return {
        operationRuntime,
        resolveRemovalRuntime: async (context: ActionExecutorContext) => ({ runtime, ingress: { signal: context.signal } }),
        async run<T>(actionId: string, actionInput: unknown, context: ActionExecutorContext,
            execute: (context: ActionExecutorContext) => Promise<T>): Promise<T> {
            let output: { value: T } | undefined;
            const result = await operationRuntime.observeExecution({ actionId, input: actionInput,
                rpcContext: { ...context, signal: context.signal ?? new AbortController().signal }, execute: async operation => {
                    const value = await execute({ ...context, ...operation });
                    output = { value };
                    return { ok: true, result: value };
                } });
            if (!result.ok) throw createActionExecuteFailureError(result);
            if (!output) throw new Error('Containing operation did not execute');
            return output.value;
        },
    };
}
