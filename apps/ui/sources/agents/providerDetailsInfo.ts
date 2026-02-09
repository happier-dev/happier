import type { AgentCoreConfig } from '@/agents/registryCore';

type ResumeSupportKind =
    | 'supported'
    | 'supportedExperimental'
    | 'runtimeGatedAcpLoadSession'
    | 'notSupported';

type SessionModeKind = AgentCoreConfig['sessionModes']['kind'];

type RuntimeSwitchInput = 'none' | 'metadata-gating' | 'acp-setSessionMode' | 'provider-native';

type RuntimeSwitchKind = 'none' | 'metadataGating' | 'acpSetSessionMode' | 'providerNative';

export function buildCatalogModelList(input: Readonly<{ defaultMode: string; allowedModes: readonly string[] }>): string[] {
    const out: string[] = [];
    if (input.defaultMode.trim().length > 0) {
        out.push(input.defaultMode);
    }
    for (const mode of input.allowedModes) {
        if (typeof mode !== 'string' || mode.trim().length === 0) continue;
        if (out.includes(mode)) continue;
        out.push(mode);
    }
    return out;
}

export function describeResumeSupportKind(input: Readonly<{
    supportsVendorResume: boolean;
    experimental: boolean;
    runtimeGate: AgentCoreConfig['resume']['runtimeGate'];
}>): ResumeSupportKind {
    if (input.supportsVendorResume) {
        return input.experimental ? 'supportedExperimental' : 'supported';
    }
    if (input.runtimeGate === 'acpLoadSession') {
        return 'runtimeGatedAcpLoadSession';
    }
    return 'notSupported';
}

export function classifySessionModeKind(kind: SessionModeKind): SessionModeKind {
    return kind;
}

export function classifyRuntimeSwitchKind(kind: RuntimeSwitchInput): RuntimeSwitchKind {
    switch (kind) {
        case 'metadata-gating':
            return 'metadataGating';
        case 'acp-setSessionMode':
            return 'acpSetSessionMode';
        case 'provider-native':
            return 'providerNative';
        default:
            return 'none';
    }
}
