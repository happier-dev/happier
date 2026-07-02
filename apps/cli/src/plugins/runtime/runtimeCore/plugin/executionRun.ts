import { createTerminalRuntimeExecutionRunBackend } from '@/agent/runtime/bridges/executionRun/runtime/terminal';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';
import type { AnyTerminalRuntimeOps } from '@/agent/terminalRuntime/providers/types';
import type { ResolvedBackendContribution } from '@/plugins/projection/registry/types';

import { buildPluginExecutionRunLaunchParams } from './executionRunLaunch';

export function createPluginExecutionRunBackend(params: Readonly<{
    backend: ResolvedBackendContribution;
    launch: NonNullable<AnyTerminalRuntimeOps['launch']>;
    opts: CreateCliExecutionRunBackendParams;
}>) {
    return createTerminalRuntimeExecutionRunBackend({
        cwd: params.opts.cwd,
        backendId: params.opts.backendId,
        backend: params.backend,
        launch: async (launchParams) => await params.launch(buildPluginExecutionRunLaunchParams(launchParams) as never),
        modelId: params.opts.modelId,
        permissionMode: params.opts.permissionMode,
        accountSettings: params.opts.accountSettings ?? null,
        start: params.opts.start ?? null,
    });
}
