import { createDescriptorBackend } from '@/agent/runtime/registry/createDescriptorBackend';
import type {
    CliEngineAdapter,
    CliRuntimeCore,
    CreateCliExecutionRunBackendParams,
} from '@/agent/runtime/registry/engineRegistryTypes';
import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import type { ResolvedBackendContribution, ResolvedProviderContribution } from '@/plugins/projection/registry/types';

import { createCodexExecutionRunBackend } from './executionRuns';
import { createCodexSessionRuntime } from '../runtime/session/createSessionRuntime';
import { codexSessionStateFacet } from '../sessionState';

type CodexRuntimeCoreParams = Readonly<{
    backend: ResolvedBackendContribution;
    provider: ResolvedProviderContribution;
}>;

function createCodexRuntimeCoreObject(): CliRuntimeCore {
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

export function createCodexRuntimeCore(params: CodexRuntimeCoreParams): CliEngineAdapter {
    if (params.backend.id !== 'codex' || params.provider.id !== 'codex') {
        throw new Error('Codex runtimeCore require codex backend/provider contributions');
    }
    return Object.freeze({
        facets: {
            sessionState: codexSessionStateFacet,
        },
        runtimeCore: createCodexRuntimeCoreObject(),
    });
}
