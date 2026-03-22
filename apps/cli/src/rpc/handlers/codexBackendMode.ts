import type { CodexBackendMode } from '@happier-dev/agents';
import { readCanonicalAgentRuntimeDescriptorV1ForProvider } from '@happier-dev/protocol';

const CODEX_BACKEND_MODES = ['mcp', 'acp', 'appServer'] as const satisfies readonly CodexBackendMode[];

export function isCodexBackendMode(value: unknown): value is CodexBackendMode {
    return typeof value === 'string' && (CODEX_BACKEND_MODES as readonly string[]).includes(value);
}

export function resolveCanonicalCodexBackendMode(params: Readonly<{
    codexBackendMode?: unknown;
    experimentalCodexAcp?: boolean;
    agentRuntimeDescriptorV1?: unknown;
}>): CodexBackendMode | undefined {
    const runtimeDescriptor = readCanonicalAgentRuntimeDescriptorV1ForProvider(params.agentRuntimeDescriptorV1, 'codex');
    if (runtimeDescriptor?.backendMode) {
        return runtimeDescriptor.backendMode;
    }

    if (isCodexBackendMode(params.codexBackendMode)) {
        return params.codexBackendMode;
    }

    return params.experimentalCodexAcp === true ? 'acp' : undefined;
}
