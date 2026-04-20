import { createDescriptorBackend } from '@/agent/runtime/registry/createDescriptorBackend';
import type {
    CliEngineAdapter,
    CliRuntimeBindings,
    CreateCliExecutionRunBackendParams,
} from '@/agent/runtime/registry/engineRegistryTypes';
import type { HostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';
import type { ResolvedBackendContribution, ResolvedProviderContribution } from '@/extensions/registry/types';

import { createCodexExecutionRunBackend } from './executionRuns';
import { createCodexSessionRuntime } from '../runtime/session/createSessionRuntime';

type CodexBindingsParams = Readonly<{
    backend: ResolvedBackendContribution;
    provider: ResolvedProviderContribution;
}>;

function createCodexCliBindings(): CliRuntimeBindings {
    return Object.freeze({
        async createSessionRuntime(sessionParams: unknown): Promise<HostSessionRuntimePlan> {
            return createCodexSessionRuntime(sessionParams);
        },
        createExecutionRunBackend(opts: CreateCliExecutionRunBackendParams) {
            const backend = createDescriptorBackend(opts, {
                factory: createCodexExecutionRunBackend,
            });
            if (!backend) {
                throw new Error(`Unsupported execution-run backend: ${opts.backendId}`);
            }
            return backend;
        },
    });
}

export function createCodexBindings(params: CodexBindingsParams): CliEngineAdapter {
    if (params.backend.id !== 'codex' || params.provider.id !== 'codex') {
        throw new Error('Codex bindings require codex backend/provider contributions');
    }
    return Object.freeze({
        bindings: createCodexCliBindings(),
    });
}
