import {
    buildCodexAgentRuntimeDescriptor,
    normalizeCodexBackendMode,
    type CodexBackendMode,
} from '@happier-dev/agents';
import {
    readRuntimeDescriptorV1ForProvider,
    readBackendTargetRefV2,
    type RuntimeDescriptorV1,
    type BackendTargetRefV1,
    type BackendTargetRefV2Input,
} from '@happier-dev/protocol';

export type CodexBackendTransportFields = {
    codexBackendMode?: CodexBackendMode;
};

export type CodexBackendRuntimeSynthesis = Readonly<{
    runtimeDescriptorV1?: RuntimeDescriptorV1;
}>;

export type CodexBackendTransportSynthesis = CodexBackendTransportFields & CodexBackendRuntimeSynthesis;

type BackendTargetInput = BackendTargetRefV1 | BackendTargetRefV2Input;

function isCodexTargetBackend(backendTarget: BackendTargetInput | undefined): boolean {
    if (!backendTarget) return false;

    try {
        const canonicalTarget = readBackendTargetRefV2(backendTarget);
        return canonicalTarget.kind === 'backend'
            && canonicalTarget.sourceKind !== 'configured'
            && canonicalTarget.backendId === 'codex';
    } catch {
        return false;
    }
}

export function buildCodexBackendTransportFields(params: Readonly<{
    backendTarget?: BackendTargetInput;
    codexBackendMode?: unknown;
    experimentalCodexAcp?: boolean;
    runtimeDescriptorV1?: RuntimeDescriptorV1;
    resume?: string;
}>): CodexBackendTransportSynthesis {
    if (!isCodexTargetBackend(params.backendTarget)) {
        return {};
    }

    const runtimeDescriptor =
        readRuntimeDescriptorV1ForProvider(params.runtimeDescriptorV1, 'codex');
    const resolvedBackendMode =
        normalizeCodexBackendMode(runtimeDescriptor?.provider.backendMode)
        ?? normalizeCodexBackendMode(params.codexBackendMode)
        ?? (params.experimentalCodexAcp === true ? 'acp' : undefined);

    if (!resolvedBackendMode) {
        return {};
    }

    if (runtimeDescriptor) {
        const runtimeBackendMode = normalizeCodexBackendMode(runtimeDescriptor.provider.backendMode);
        return {
            ...(runtimeBackendMode ? { codexBackendMode: runtimeBackendMode } : {}),
            runtimeDescriptorV1: runtimeDescriptor,
        };
    }

    const synthesizedRuntimeDescriptor = buildCodexAgentRuntimeDescriptor({
        backendMode: resolvedBackendMode,
        providerSessionId: params.resume,
    });

    return {
        codexBackendMode: resolvedBackendMode,
        runtimeDescriptorV1: synthesizedRuntimeDescriptor,
    };
}
