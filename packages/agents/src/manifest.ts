import {
    type AgentCore,
    type AgentId,
    type AgentResumeConfig,
    type CanonicalAgentId,
} from './types.js';
import { mergeAuthoredWithGeneratedAgentFacts } from './definitions/generatedFacts.js';
import { getAgentCliRuntimeSpec } from './cli/runtime.js';
import type { ProviderConnectedServicesAdapter } from './runtime/adjunctAdapters/types.js';

export const DEFAULT_AGENT_ID: AgentId = 'claude';

function providerDetectKey(agentId: AgentId): string {
    return getAgentCliRuntimeSpec(agentId).binaryName;
}

const AUTHORED_CANONICAL_AGENTS_CORE = {
    claude: {
        id: 'claude',
        cliSubcommand: 'claude',
        detectKey: providerDetectKey('claude'),
        flavorAliases: [],
        cloudConnect: { vendorKey: 'anthropic', status: 'wired' },
        connectedServices: {
            supportedServiceIds: ['claude-subscription', 'anthropic'],
            sessionAuthSwitch: {
                continuityMode: 'restart_same_home',
                supportedTransitions: ['same_connected_group'],
                providerStateSharingRequired: {
                    serviceIds: ['claude-subscription', 'anthropic'],
                    supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
                },
            },
            providerStateSharing: {
                config: {
                    supported: true,
                    modes: ['linked', 'copied', 'isolated'],
                },
                state: {
                    supported: true,
                    modes: ['isolated', 'shared'],
                    sharedStatePrivacyRiskAcknowledgementRequired: true,
                },
            },
            supportedKindsByServiceId: {
                'claude-subscription': ['oauth', 'token'],
                anthropic: ['token'],
            },
        },
        resume: { vendorResume: 'supported', vendorResumeIdField: 'claudeSessionId' },
        sessionStorage: { direct: true, persisted: true },
        sessionCapabilities: {
            sessionListing: 'supported',
            sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
            sessionRollback: { conversation: 'unsupported' },
            usageLimitRecovery: { checkNow: 'supported' },
        },
        handoff: { vendorStateTransfer: 'supported' },
        localControl: { supported: true, topology: 'exclusive', attachStrategy: 'terminal_host' },
        runtimeInput: {
            inFlightSteerSupported: true,
            terminalPromptInjectionSupported: true,
        },
        tools: { delivery: 'native_mcp', support: 'supported' },
    },
    codex: {
        id: 'codex',
        cliSubcommand: 'codex',
        detectKey: providerDetectKey('codex'),
        flavorAliases: ['codex-acp', 'codex-mcp', 'openai', 'gpt'],
        cloudConnect: { vendorKey: 'openai', status: 'wired' },
        connectedServices: {
            supportedServiceIds: ['openai-codex', 'openai'],
            sessionAuthSwitch: {
                continuityMode: 'restart_shared_state_required',
                supportedTransitions: ['same_connected_group'],
                providerStateSharingRequired: {
                    serviceIds: ['openai-codex'],
                    supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
                },
            },
            providerStateSharing: {
                config: {
                    supported: true,
                    modes: ['linked', 'copied', 'isolated'],
                },
                state: {
                    supported: true,
                    modes: ['isolated', 'shared'],
                    sharedStatePrivacyRiskAcknowledgementRequired: true,
                },
            },
            supportedKindsByServiceId: {
                'openai-codex': ['oauth'],
                openai: ['token'],
            },
        },
        resume: { vendorResume: 'experimental', vendorResumeIdField: 'codexSessionId' },
        sessionStorage: { direct: true, persisted: true },
        sessionCapabilities: {
            sessionListing: 'supported',
            sessionFork: { conversation: 'supported', fromMessage: 'unsupported' },
            sessionRollback: { conversation: 'supported' },
            usageLimitRecovery: { checkNow: 'supported' },
        },
        runtimeKinds: {
            defaultKind: 'appServer',
            byKind: {
                mcp: {
                    kind: 'mcp',
                    overrides: {
                        resume: { vendorResume: 'unsupported' },
                        sessionCapabilities: {
                            sessionFork: { conversation: 'unsupported' },
                            sessionRollback: { conversation: 'unsupported' },
                            usageLimitRecovery: { checkNow: 'unsupported' },
                        },
                        handoff: { vendorStateTransfer: 'unsupported' },
                        localControl: null,
                    },
                },
                acp: {
                    kind: 'acp',
                    overrides: {
                        sessionCapabilities: {
                            sessionFork: { conversation: 'unsupported' },
                            sessionRollback: { conversation: 'unsupported' },
                            usageLimitRecovery: { checkNow: 'unsupported' },
                        },
                    },
                },
                appServer: { kind: 'appServer' },
            },
        },
        handoff: { vendorStateTransfer: 'experimental', requiresExplicitSessionId: true },
        localControl: { supported: true, topology: 'exclusive', attachStrategy: 'terminal_host' },
        tools: { delivery: 'native_mcp', support: 'supported' },
    },
    gemini: {
        id: 'gemini',
        cliSubcommand: 'gemini',
        detectKey: providerDetectKey('gemini'),
        flavorAliases: [],
        cloudConnect: { vendorKey: 'gemini', status: 'wired' },
        connectedServices: {
            supportedServiceIds: ['gemini'],
            sessionAuthSwitch: {
                continuityMode: 'restart_same_home',
                supportedTransitions: ['native_to_connected', 'connected_to_connected'],
            },
            supportedKindsByServiceId: {
                gemini: ['oauth'],
            },
        },
        resume: { vendorResume: 'supported', vendorResumeIdField: 'geminiSessionId' },
        sessionStorage: { direct: false, persisted: true },
        sessionCapabilities: {
            sessionListing: 'unsupported',
            sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
            sessionRollback: { conversation: 'unsupported' },
            usageLimitRecovery: { checkNow: 'supported' },
        },
        handoff: { vendorStateTransfer: 'unsupported' },
        tools: { delivery: 'native_mcp', support: 'supported' },
    },
    auggie: {
        id: 'auggie',
        cliSubcommand: 'auggie',
        detectKey: providerDetectKey('auggie'),
        flavorAliases: [],
        cloudConnect: null,
        connectedServices: null,
        resume: { vendorResume: 'supported', vendorResumeIdField: 'auggieSessionId' },
        sessionStorage: { direct: false, persisted: true },
        sessionCapabilities: {
            sessionListing: 'unsupported',
            sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
            sessionRollback: { conversation: 'unsupported' },
        },
        handoff: { vendorStateTransfer: 'unsupported' },
        tools: { delivery: 'shell_bridge', support: 'experimental' },
    },
    qwen: {
        id: 'qwen',
        cliSubcommand: 'qwen',
        detectKey: providerDetectKey('qwen'),
        flavorAliases: ['qwen-code'],
        cloudConnect: null,
        connectedServices: null,
        resume: { vendorResume: 'supported', vendorResumeIdField: 'qwenSessionId' },
        sessionStorage: { direct: false, persisted: true },
        sessionCapabilities: {
            sessionListing: 'unsupported',
            sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
            sessionRollback: { conversation: 'unsupported' },
        },
        handoff: { vendorStateTransfer: 'unsupported' },
        tools: { delivery: 'shell_bridge', support: 'experimental' },
    },
    kimi: {
        id: 'kimi',
        cliSubcommand: 'kimi',
        detectKey: providerDetectKey('kimi'),
        flavorAliases: ['kimi-cli'],
        cloudConnect: null,
        connectedServices: null,
        resume: { vendorResume: 'supported', vendorResumeIdField: 'kimiSessionId' },
        sessionStorage: { direct: false, persisted: true },
        sessionCapabilities: {
            sessionListing: 'unsupported',
            sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
            sessionRollback: { conversation: 'unsupported' },
        },
        handoff: { vendorStateTransfer: 'unsupported' },
        tools: { delivery: 'shell_bridge', support: 'experimental' },
    },
    kilo: {
        id: 'kilo',
        cliSubcommand: 'kilo',
        detectKey: providerDetectKey('kilo'),
        flavorAliases: ['kilocode'],
        cloudConnect: null,
        connectedServices: null,
        resume: { vendorResume: 'supported', vendorResumeIdField: 'kiloSessionId' },
        sessionStorage: { direct: false, persisted: true },
        sessionCapabilities: {
            sessionListing: 'unsupported',
            sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
            sessionRollback: { conversation: 'unsupported' },
        },
        handoff: { vendorStateTransfer: 'unsupported' },
        tools: { delivery: 'shell_bridge', support: 'experimental' },
    },
    kiro: {
        id: 'kiro',
        cliSubcommand: 'kiro',
        detectKey: providerDetectKey('kiro'),
        flavorAliases: ['kiro-cli'],
        cloudConnect: null,
        connectedServices: null,
        resume: { vendorResume: 'experimental', vendorResumeIdField: 'kiroSessionId' },
        sessionStorage: { direct: true, persisted: true },
        sessionCapabilities: {
            sessionListing: 'unsupported',
            sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
            sessionRollback: { conversation: 'unsupported' },
        },
        handoff: { vendorStateTransfer: 'unsupported' },
        localControl: { supported: true, topology: 'exclusive', attachStrategy: 'unsupported' },
        tools: { delivery: 'native_mcp', support: 'supported' },
    },
    cursor: {
        id: 'cursor',
        cliSubcommand: 'cursor',
        detectKey: providerDetectKey('cursor'),
        flavorAliases: ['cursor-agent'],
        cloudConnect: null,
        connectedServices: null,
        resume: {
            vendorResume: 'experimental',
            vendorResumeIdField: 'cursorSessionId',
            experimentalResumePolicy: 'runtime_checked',
        },
        sessionStorage: { direct: true, persisted: true },
        sessionCapabilities: {
            sessionListing: 'unsupported',
            sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
            sessionRollback: { conversation: 'unsupported' },
        },
        handoff: { vendorStateTransfer: 'unsupported' },
        localControl: { supported: true, topology: 'exclusive', attachStrategy: 'unsupported' },
        tools: { delivery: 'shell_bridge', support: 'experimental' },
    },
    ohMyPi: {
        id: 'ohMyPi',
        cliSubcommand: 'ohMyPi',
        detectKey: providerDetectKey('ohMyPi'),
        flavorAliases: ['oh-my-pi', 'omp'],
        cloudConnect: null,
        connectedServices: {
            supportedServiceIds: ['openai-codex', 'openai', 'claude-subscription', 'anthropic', 'gemini'],
            supportedKindsByServiceId: {
                'openai-codex': ['oauth'],
                openai: ['token'],
                'claude-subscription': ['token'],
                anthropic: ['token'],
                gemini: ['oauth', 'token'],
            },
        },
        resume: { vendorResume: 'supported', vendorResumeIdField: 'ohMyPiSessionId' },
        sessionStorage: { direct: true, persisted: true },
        sessionCapabilities: {
            sessionListing: 'supported',
            sessionFork: { conversation: 'supported', fromMessage: 'unsupported' },
            sessionRollback: { conversation: 'unsupported' },
        },
        handoff: { vendorStateTransfer: 'unsupported' },
        tools: { delivery: 'native_mcp', support: 'supported' },
    },
    pi: {
        id: 'pi',
        cliSubcommand: 'pi',
        detectKey: providerDetectKey('pi'),
        flavorAliases: ['pi-coding-agent'],
        cloudConnect: null,
        connectedServices: {
            supportedServiceIds: ['openai-codex', 'openai', 'claude-subscription', 'anthropic'],
            sessionAuthSwitch: {
                continuityMode: 'restart_same_home',
                supportedTransitions: ['connected_to_connected'],
                providerStateSharingRequired: {
                    supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
                },
            },
            providerStateSharing: {
                config: {
                    supported: false,
                    modes: ['isolated'],
                    unavailableReason: 'not_implemented',
                },
                state: {
                    supported: true,
                    modes: ['isolated', 'shared'],
                    sharedStatePrivacyRiskAcknowledgementRequired: true,
                },
            },
            supportedKindsByServiceId: {
                'openai-codex': ['oauth'],
                openai: ['token'],
                'claude-subscription': ['token'],
                anthropic: ['token'],
            },
        },
        resume: { vendorResume: 'supported', vendorResumeIdField: 'piSessionId' },
        sessionStorage: { direct: false, persisted: true },
        sessionCapabilities: {
            sessionListing: 'unsupported',
            sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
            sessionRollback: { conversation: 'unsupported' },
            usageLimitRecovery: { checkNow: 'supported' },
        },
        handoff: { vendorStateTransfer: 'unsupported' },
        runtimeInput: {
            inFlightSteerSupported: true,
            terminalPromptInjectionSupported: false,
        },
        tools: { delivery: 'shell_bridge', support: 'experimental' },
    },
    copilot: {
        id: 'copilot',
        cliSubcommand: 'copilot',
        detectKey: providerDetectKey('copilot'),
        flavorAliases: ['github-copilot', 'copilot-cli'],
        cloudConnect: null,
        connectedServices: null,
        resume: { vendorResume: 'supported', vendorResumeIdField: 'copilotSessionId' },
        sessionStorage: { direct: false, persisted: true },
        sessionCapabilities: {
            sessionListing: 'unsupported',
            sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
            sessionRollback: { conversation: 'unsupported' },
        },
        handoff: { vendorStateTransfer: 'unsupported' },
        tools: { delivery: 'shell_bridge', support: 'experimental' },
    },
} as const satisfies Partial<Record<CanonicalAgentId, AgentCore>>;

export const CANONICAL_AGENTS_CORE: Readonly<Record<CanonicalAgentId, AgentCore>> =
    mergeAuthoredWithGeneratedAgentFacts<AgentCore>({
        authored: AUTHORED_CANONICAL_AGENTS_CORE,
        label: 'agent core',
        readGenerated: (definition) => definition.core,
    });

export const AGENTS_CORE = CANONICAL_AGENTS_CORE;

export function getAgentCore(agentId: AgentId): AgentCore {
    return CANONICAL_AGENTS_CORE[agentId];
}

export function getProviderConnectedServicesAdapter(agentId: AgentId): ProviderConnectedServicesAdapter | null {
    const providerCore = getAgentCore(agentId);

    if (providerCore.cloudConnect == null && providerCore.connectedServices == null) {
        return null;
    }

    return {
        ...(providerCore.cloudConnect != null ? { cloudConnect: providerCore.cloudConnect } : {}),
        ...(providerCore.connectedServices != null ? { connectedServices: providerCore.connectedServices } : {}),
    };
}

export function getAgentResumeConfig(agentId: AgentId): AgentResumeConfig {
    return getAgentCore(agentId).resume;
}

export function isRuntimeCheckedExperimentalVendorResume(agentId: AgentId): boolean {
    const resume = getAgentResumeConfig(agentId);
    return resume.vendorResume === 'experimental' && resume.experimentalResumePolicy === 'runtime_checked';
}
