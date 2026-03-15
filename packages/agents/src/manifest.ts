import type { AgentCore, AgentId } from './types.js';

export const DEFAULT_AGENT_ID: AgentId = 'claude';

export const AGENTS_CORE = {
    claude: {
        id: 'claude',
        cliSubcommand: 'claude',
        detectKey: 'claude',
        flavorAliases: [],
        cloudConnect: { vendorKey: 'anthropic', status: 'wired' },
        connectedServices: {
            supportedServiceIds: ['claude-subscription', 'anthropic'],
            supportedKindsByServiceId: {
                'claude-subscription': ['oauth', 'token'],
                anthropic: ['token'],
            },
        },
        resume: { vendorResume: 'supported', vendorResumeIdField: 'claudeSessionId', runtimeGate: null },
    },
    codex: {
        id: 'codex',
        cliSubcommand: 'codex',
        detectKey: 'codex',
        flavorAliases: ['codex-acp', 'codex-mcp', 'openai', 'gpt'],
        cloudConnect: { vendorKey: 'openai', status: 'wired' },
        connectedServices: {
            supportedServiceIds: ['openai-codex', 'openai'],
            supportedKindsByServiceId: {
                'openai-codex': ['oauth'],
                openai: ['token'],
            },
        },
        resume: { vendorResume: 'experimental', vendorResumeIdField: 'codexSessionId', runtimeGate: null },
    },
    opencode: {
        id: 'opencode',
        cliSubcommand: 'opencode',
        detectKey: 'opencode',
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
        resume: { vendorResume: 'supported', vendorResumeIdField: 'opencodeSessionId', runtimeGate: null },
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
        resume: { vendorResume: 'supported', vendorResumeIdField: 'geminiSessionId', runtimeGate: null },
    },
    auggie: {
        id: 'auggie',
        cliSubcommand: 'auggie',
        detectKey: 'auggie',
        flavorAliases: [],
        cloudConnect: null,
        connectedServices: null,
        resume: { vendorResume: 'supported', vendorResumeIdField: 'auggieSessionId', runtimeGate: null },
    },
    qwen: {
        id: 'qwen',
        cliSubcommand: 'qwen',
        detectKey: 'qwen',
        flavorAliases: ['qwen-code'],
        cloudConnect: null,
        connectedServices: null,
        resume: { vendorResume: 'supported', vendorResumeIdField: 'qwenSessionId', runtimeGate: null },
    },
    kimi: {
        id: 'kimi',
        cliSubcommand: 'kimi',
        detectKey: 'kimi',
        flavorAliases: ['kimi-cli'],
        cloudConnect: null,
        connectedServices: null,
        resume: { vendorResume: 'supported', vendorResumeIdField: 'kimiSessionId', runtimeGate: null },
    },
    kilo: {
        id: 'kilo',
        cliSubcommand: 'kilo',
        detectKey: 'kilo',
        flavorAliases: ['kilocode'],
        cloudConnect: null,
        connectedServices: null,
        resume: { vendorResume: 'supported', vendorResumeIdField: 'kiloSessionId', runtimeGate: null },
    },
    pi: {
        id: 'pi',
        cliSubcommand: 'pi',
        detectKey: 'pi',
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
        resume: { vendorResume: 'unsupported', vendorResumeIdField: 'piSessionId', runtimeGate: null },
    },
    copilot: {
        id: 'copilot',
        cliSubcommand: 'copilot',
        detectKey: 'copilot',
        flavorAliases: ['github-copilot', 'copilot-cli'],
        cloudConnect: null,
        connectedServices: null,
        resume: { vendorResume: 'supported', vendorResumeIdField: 'copilotSessionId', runtimeGate: null },
    },
} as const satisfies Record<AgentId, AgentCore>;
