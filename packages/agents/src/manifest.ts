import type { AgentCore, AgentId } from './types.js';

export const DEFAULT_AGENT_ID: AgentId = 'claude';

export const AGENTS_CORE = {
    claude: {
        id: 'claude',
        cliSubcommand: 'claude',
        detectKey: 'claude',
        flavorAliases: [],
        cloudConnect: { vendorKey: 'anthropic', status: 'experimental' },
        connectedServices: {
            supportedServiceIds: ['anthropic'],
            supportedKindsByServiceId: {
                anthropic: ['oauth', 'token'],
            },
        },
        resume: { vendorResume: 'supported', vendorResumeIdField: null, runtimeGate: null },
    },
    codex: {
        id: 'codex',
        cliSubcommand: 'codex',
        detectKey: 'codex',
        flavorAliases: ['codex-acp', 'codex-mcp'],
        cloudConnect: { vendorKey: 'openai', status: 'experimental' },
        connectedServices: {
            supportedServiceIds: ['openai-codex'],
            supportedKindsByServiceId: {
                'openai-codex': ['oauth'],
            },
        },
        resume: { vendorResume: 'experimental', vendorResumeIdField: 'codexSessionId', runtimeGate: null },
    },
    opencode: {
        id: 'opencode',
        cliSubcommand: 'opencode',
        detectKey: 'opencode',
        flavorAliases: [],
        cloudConnect: null,
        connectedServices: {
            supportedServiceIds: ['openai-codex', 'anthropic'],
            supportedKindsByServiceId: {
                'openai-codex': ['oauth'],
                anthropic: ['oauth'],
            },
        },
        resume: { vendorResume: 'supported', vendorResumeIdField: 'opencodeSessionId', runtimeGate: 'acpLoadSession' },
    },
    gemini: {
        id: 'gemini',
        cliSubcommand: 'gemini',
        detectKey: 'gemini',
        flavorAliases: [],
        cloudConnect: { vendorKey: 'gemini', status: 'wired' },
        connectedServices: {
            supportedServiceIds: ['gemini'],
            supportedKindsByServiceId: {
                gemini: ['oauth'],
            },
        },
        resume: { vendorResume: 'supported', vendorResumeIdField: 'geminiSessionId', runtimeGate: 'acpLoadSession' },
    },
    auggie: {
        id: 'auggie',
        cliSubcommand: 'auggie',
        detectKey: 'auggie',
        flavorAliases: [],
        cloudConnect: null,
        connectedServices: null,
        resume: { vendorResume: 'supported', vendorResumeIdField: 'auggieSessionId', runtimeGate: 'acpLoadSession' },
    },
    qwen: {
        id: 'qwen',
        cliSubcommand: 'qwen',
        detectKey: 'qwen',
        flavorAliases: ['qwen-code'],
        cloudConnect: null,
        connectedServices: null,
        resume: { vendorResume: 'supported', vendorResumeIdField: 'qwenSessionId', runtimeGate: 'acpLoadSession' },
    },
    kimi: {
        id: 'kimi',
        cliSubcommand: 'kimi',
        detectKey: 'kimi',
        flavorAliases: ['kimi-cli'],
        cloudConnect: null,
        connectedServices: null,
        resume: { vendorResume: 'supported', vendorResumeIdField: 'kimiSessionId', runtimeGate: 'acpLoadSession' },
    },
    kilo: {
        id: 'kilo',
        cliSubcommand: 'kilo',
        detectKey: 'kilo',
        flavorAliases: ['kilocode'],
        cloudConnect: null,
        connectedServices: null,
        resume: { vendorResume: 'supported', vendorResumeIdField: 'kiloSessionId', runtimeGate: 'acpLoadSession' },
    },
    pi: {
        id: 'pi',
        cliSubcommand: 'pi',
        detectKey: 'pi',
        flavorAliases: ['pi-coding-agent'],
        cloudConnect: null,
        connectedServices: {
            supportedServiceIds: ['openai-codex', 'anthropic'],
            supportedKindsByServiceId: {
                'openai-codex': ['oauth'],
                anthropic: ['token'],
            },
        },
        resume: { vendorResume: 'unsupported', vendorResumeIdField: 'piSessionId', runtimeGate: null },
    },
} as const satisfies Record<AgentId, AgentCore>;
