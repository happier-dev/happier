import { createTerminalRuntimeExecutionRunBackend } from '@/agent/runtime/bridges/executionRun/runtime/terminal';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';
import type { AnyTerminalRuntimeOps } from '@/agent/terminalRuntime/providers/types';
import type { ResolvedAgentRuntimeContribution } from '@/plugins/projection/registry/types';

import { buildPluginExecutionRunLaunchParams } from './executionRunLaunch';

export function createPluginExecutionRunBackend(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    launch: NonNullable<AnyTerminalRuntimeOps['launch']>;
    opts: CreateCliExecutionRunBackendParams;
}>) {
    return createTerminalRuntimeExecutionRunBackend({
        cwd: params.opts.cwd,
        backendId: params.opts.backendId,
        backend: params.backend,
        // Forward the host-assembled isolation env (run isolation + connected-services
        // materialization) into the plugin launch params — the catalog backend path consumes
        // `isolation.env` the same way; dropping it here would silently launch plugin backends
        // on ambient auth.
        launch: async (launchParams) => await params.launch(buildPluginExecutionRunLaunchParams({
            ...(launchParams && typeof launchParams === 'object' ? launchParams : {}),
            ...(params.opts.isolation?.env ? { env: params.opts.isolation.env } : {}),
        }) as never),
        modelId: params.opts.modelId,
        permissionMode: params.opts.permissionMode,
        accountSettings: params.opts.accountSettings ?? null,
        start: params.opts.start ?? null,
    });
}
