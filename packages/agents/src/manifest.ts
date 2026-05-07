import type { AgentCore, AgentId } from './types.js';
import { getProviderCliRuntimeSpec } from './providers/providerCliRuntime.js';

export const DEFAULT_AGENT_ID: AgentId = 'claude';

const NO_NATIVE_IMAGE_GENERATION = 'unsupported' as const;
const GENERIC_SESSION_MEDIA_OUTPUT = 'supported' as const;
const EXPERIMENTAL_SESSION_MEDIA_OUTPUT = 'experimental' as const;

function providerDetectKey(agentId: AgentId): string {
    return getProviderCliRuntimeSpec(agentId).binaryName;
}

export const AGENTS_CORE = {
    claude: {
        id: 'claude',
        cliSubcommand: 'claude',
        detectKey: providerDetectKey('claude'),
        flavorAliases: [],
        cloudConnect: { vendorKey: 'anthropic', status: 'wired' },
        connectedServices: {
            supportedServiceIds: ['claude-subscription', 'anthropic'],
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
        },
        handoff: { vendorStateTransfer: 'supported' },
        localControl: { supported: true, topology: 'exclusive', attachStrategy: 'tmux' },
        tools: { delivery: 'native_mcp', support: 'supported' },
        media: {
            acceptsImageInput: 'supported',
            emitsSessionMedia: GENERIC_SESSION_MEDIA_OUTPUT,
            nativeImageGeneration: NO_NATIVE_IMAGE_GENERATION,
        },
    },
    codex: {
        id: 'codex',
        cliSubcommand: 'codex',
        detectKey: providerDetectKey('codex'),
        flavorAliases: ['codex-acp', 'codex-mcp', 'openai', 'gpt'],
        cloudConnect: { vendorKey: 'openai', status: 'wired' },
        connectedServices: {
            supportedServiceIds: ['openai-codex', 'openai'],
            supportedKindsByServiceId: {
                'openai-codex': ['oauth'],
                openai: ['token'],
            },
        },
        nativeCliPassthroughSubcommands: ['resume', 'fork'],
        resume: { vendorResume: 'experimental', vendorResumeIdField: 'codexSessionId' },
        sessionStorage: { direct: true, persisted: true },
        sessionCapabilities: {
            sessionListing: 'supported',
            sessionFork: { conversation: 'supported', fromMessage: 'unsupported' },
            sessionRollback: { conversation: 'supported' },
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
                        },
                        handoff: { vendorStateTransfer: 'unsupported' },
                        localControl: null,
                        media: { nativeImageGeneration: NO_NATIVE_IMAGE_GENERATION },
                    },
                },
                acp: {
                    kind: 'acp',
                    overrides: {
                        sessionCapabilities: {
                            sessionFork: { conversation: 'unsupported' },
                            sessionRollback: { conversation: 'unsupported' },
                        },
                        media: { nativeImageGeneration: NO_NATIVE_IMAGE_GENERATION },
                    },
                },
                appServer: { kind: 'appServer' },
            },
        },
        handoff: { vendorStateTransfer: 'experimental', requiresExplicitSessionId: true },
        localControl: { supported: true, topology: 'exclusive', attachStrategy: 'tmux' },
        tools: { delivery: 'native_mcp', support: 'supported' },
        media: {
            acceptsImageInput: 'supported',
            emitsSessionMedia: GENERIC_SESSION_MEDIA_OUTPUT,
            nativeImageGeneration: 'supported',
        },
    },
    opencode: {
        id: 'opencode',
        cliSubcommand: 'opencode',
        detectKey: providerDetectKey('opencode'),
        flavorAliases: ['open-code'],
        cloudConnect: null,
        connectedServices: {
            supportedServiceIds: ['openai-codex', 'openai', 'anthropic'],
            supportedKindsByServiceId: {
                'openai-codex': ['oauth'],
                openai: ['token'],
                anthropic: ['token'],
            },
        },
        resume: { vendorResume: 'supported', vendorResumeIdField: 'opencodeSessionId' },
        sessionStorage: { direct: true, persisted: true },
        sessionCapabilities: {
            sessionListing: 'supported',
            sessionFork: { conversation: 'supported', fromMessage: 'supported' },
            sessionRollback: { conversation: 'unsupported' },
        },
        runtimeKinds: {
            defaultKind: 'server',
            byKind: {
                server: { kind: 'server' },
                acp: {
                    kind: 'acp',
                    overrides: {
                        sessionStorage: { direct: false },
                        sessionCapabilities: {
                            sessionFork: { fromMessage: 'unsupported' },
                        },
                        localControl: null,
                    },
                },
            },
        },
        handoff: { vendorStateTransfer: 'supported' },
        localControl: { supported: true, topology: 'shared', attachStrategy: 'provider_attach' },
        tools: { delivery: 'native_mcp', support: 'supported' },
        media: {
            acceptsImageInput: 'experimental',
            emitsSessionMedia: GENERIC_SESSION_MEDIA_OUTPUT,
            nativeImageGeneration: NO_NATIVE_IMAGE_GENERATION,
        },
    },
    gemini: {
        id: 'gemini',
        cliSubcommand: 'gemini',
        detectKey: providerDetectKey('gemini'),
        flavorAliases: [],
        cloudConnect: { vendorKey: 'gemini', status: 'wired' },
        connectedServices: {
            supportedServiceIds: ['gemini'],
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
        },
        handoff: { vendorStateTransfer: 'unsupported' },
        tools: { delivery: 'shell_bridge', support: 'experimental' },
        media: {
            acceptsImageInput: 'supported',
            emitsSessionMedia: 'unsupported',
            nativeImageGeneration: NO_NATIVE_IMAGE_GENERATION,
        },
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
        media: {
            acceptsImageInput: 'experimental',
            emitsSessionMedia: EXPERIMENTAL_SESSION_MEDIA_OUTPUT,
            nativeImageGeneration: NO_NATIVE_IMAGE_GENERATION,
        },
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
        media: {
            acceptsImageInput: 'experimental',
            emitsSessionMedia: GENERIC_SESSION_MEDIA_OUTPUT,
            nativeImageGeneration: NO_NATIVE_IMAGE_GENERATION,
        },
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
        media: {
            acceptsImageInput: 'experimental',
            emitsSessionMedia: GENERIC_SESSION_MEDIA_OUTPUT,
            nativeImageGeneration: NO_NATIVE_IMAGE_GENERATION,
        },
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
        media: {
            acceptsImageInput: 'experimental',
            emitsSessionMedia: GENERIC_SESSION_MEDIA_OUTPUT,
            nativeImageGeneration: NO_NATIVE_IMAGE_GENERATION,
        },
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
        media: {
            acceptsImageInput: 'experimental',
            emitsSessionMedia: GENERIC_SESSION_MEDIA_OUTPUT,
            nativeImageGeneration: NO_NATIVE_IMAGE_GENERATION,
        },
    },
    customAcp: {
        id: 'customAcp',
        cliSubcommand: 'customAcp',
        detectKey: providerDetectKey('customAcp'),
        flavorAliases: ['custom-acp'],
        cloudConnect: null,
        connectedServices: null,
        resume: { vendorResume: 'unsupported' },
        sessionStorage: { direct: true, persisted: true },
        sessionCapabilities: {
            sessionListing: 'unsupported',
            sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
            sessionRollback: { conversation: 'unsupported' },
        },
        handoff: { vendorStateTransfer: 'unsupported' },
        tools: { delivery: 'native_mcp', support: 'supported' },
        media: {
            acceptsImageInput: 'experimental',
            emitsSessionMedia: GENERIC_SESSION_MEDIA_OUTPUT,
            nativeImageGeneration: NO_NATIVE_IMAGE_GENERATION,
        },
    },
    pi: {
        id: 'pi',
        cliSubcommand: 'pi',
        detectKey: providerDetectKey('pi'),
        flavorAliases: ['pi-coding-agent'],
        cloudConnect: null,
        connectedServices: {
            supportedServiceIds: ['openai-codex', 'openai', 'claude-subscription', 'anthropic'],
            supportedKindsByServiceId: {
                'openai-codex': ['oauth'],
                openai: ['token'],
                'claude-subscription': ['token'],
                anthropic: ['token'],
            },
        },
        resume: { vendorResume: 'unsupported', vendorResumeIdField: 'piSessionId' },
        sessionStorage: { direct: false, persisted: true },
        sessionCapabilities: {
            sessionListing: 'unsupported',
            sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
            sessionRollback: { conversation: 'unsupported' },
        },
        handoff: { vendorStateTransfer: 'unsupported' },
        tools: { delivery: 'shell_bridge', support: 'experimental' },
        media: {
            acceptsImageInput: 'experimental',
            emitsSessionMedia: EXPERIMENTAL_SESSION_MEDIA_OUTPUT,
            nativeImageGeneration: NO_NATIVE_IMAGE_GENERATION,
        },
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
        media: {
            acceptsImageInput: 'experimental',
            emitsSessionMedia: GENERIC_SESSION_MEDIA_OUTPUT,
            nativeImageGeneration: NO_NATIVE_IMAGE_GENERATION,
        },
    },
} as const satisfies Record<AgentId, AgentCore>;
