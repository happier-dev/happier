import type { CodexBackendMode } from '@happier-dev/agents';
import { readAgentRuntimeDescriptorV1ForProvider, type AgentRuntimeDescriptorV1 } from '@happier-dev/protocol';

export type CodexBackendTransportFields = {
    codexBackendMode?: CodexBackendMode;
};

export function buildCodexBackendTransportFields(params: Readonly<{
    codexBackendMode?: CodexBackendMode;
    experimentalCodexAcp?: boolean;
    agentRuntimeDescriptorV1?: AgentRuntimeDescriptorV1;
}>): CodexBackendTransportFields {
    const runtimeDescriptor = readAgentRuntimeDescriptorV1ForProvider(params.agentRuntimeDescriptorV1, 'codex');
    if (runtimeDescriptor) {
        return { codexBackendMode: runtimeDescriptor.provider.backendMode };
    }

    if (params.codexBackendMode) {
        return { codexBackendMode: params.codexBackendMode };
    }

    return params.experimentalCodexAcp === true ? { codexBackendMode: 'acp' } : {};
}
