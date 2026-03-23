import type { AgentCoreConfig } from '@/agents/registry/registryCore';

type ResumeSupportKind =
    | 'supported'
    | 'supportedExperimental'
    | 'notSupported';

type SessionModeKind = AgentCoreConfig['sessionModes']['kind'];

type SessionModeDescriptor = Readonly<{
    source: 'none' | 'acp' | 'provider-native';
    semantics: 'none' | 'policy-presets' | 'agent-modes';
    runtimeSwitch: 'none' | 'metadata-gating' | 'acp-setSessionMode' | 'provider-native';
}>;

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
}>): ResumeSupportKind {
    if (input.supportsVendorResume) {
        return input.experimental ? 'supportedExperimental' : 'supported';
    }
    return 'notSupported';
}

export function classifySessionModeKind(kind: SessionModeKind): SessionModeKind {
    return kind;
}

export function classifySessionModeDescriptor(descriptor: SessionModeDescriptor): Readonly<{
    sessionModeKind: SessionModeKind;
    runtimeSwitchKind: RuntimeSwitchKind;
}> {
    const sessionModeKind: SessionModeKind =
        descriptor.source === 'provider-native' && descriptor.semantics === 'agent-modes'
            ? 'staticAgentModes'
            : descriptor.source === 'acp' && descriptor.semantics === 'agent-modes'
                ? 'acpAgentModes'
                : descriptor.source === 'acp' && descriptor.semantics === 'policy-presets'
                    ? 'acpPolicyPresets'
                    : 'none';

    return {
        sessionModeKind,
        runtimeSwitchKind: classifyRuntimeSwitchKind(descriptor.runtimeSwitch),
    };
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
