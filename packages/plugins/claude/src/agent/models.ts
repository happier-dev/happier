import type { AgentModelConfig, AgentModelDescriptor, AgentModelOption } from '@happier-dev/plugin-sdk/experimental/agents';

import { isClaude1mContextOptInModelId, toClaude1mModelId } from './contextWindow.js';
import {
    formatClaudeEffortLevelLabel,
    isClaudeUltracodeSupportedModelId,
    resolveClaudeDefaultEffortLevelForModelId,
    resolveClaudeEffortLevelsForModelId,
} from './runtime/reasoningEffort.js';

function withClaudeModelFacts(model: AgentModelDescriptor): AgentModelDescriptor {
    const levels = resolveClaudeEffortLevelsForModelId(model.id);
    const currentValue = resolveClaudeDefaultEffortLevelForModelId(model.id);
    const modelOptions: AgentModelOption[] = [];
    if (levels.length > 0 && currentValue) {
        modelOptions.push({
            id: 'reasoning_effort',
            name: 'Thinking',
            type: 'select',
            currentValue,
            options: levels.map((level) => ({
                value: level,
                name: formatClaudeEffortLevelLabel(level),
            })),
        });
    }
    // Ultracode is a session-scoped boolean toggle (never an effort level) and is only
    // honorable on xhigh-capable models.
    if (isClaudeUltracodeSupportedModelId(model.id)) {
        modelOptions.push({
            id: 'ultracode',
            name: 'Ultracode',
            description: 'Maximum coding effort. Overrides the Thinking level while enabled.',
            type: 'boolean',
            currentValue: 'false',
        });
    }

    return {
        ...model,
        // The `[1m]` variant id is published only where 1M context is genuinely opt-in;
        // always-1M models get no toggle.
        ...(isClaude1mContextOptInModelId(model.id)
            ? { extendedContextModelId: toClaude1mModelId(model.id) }
            : {}),
        ...(modelOptions.length > 0 ? { modelOptions } : {}),
    };
}

const CLAUDE_STATIC_MODEL_BASE = [
    {
        id: 'claude-opus-5',
        name: 'Opus 5',
        description: 'Latest highest-capability Claude model for the hardest coding and reasoning tasks.',
        contextWindowTokens: 1_000_000,
    },
    {
        id: 'claude-fable-5',
        name: 'Fable 5',
        description: 'Newest highest-capability generally available Claude model for the hardest coding and reasoning tasks.',
        contextWindowTokens: 1_000_000,
    },
    {
        id: 'claude-opus-4-8',
        name: 'Opus 4.8',
        description: 'Newest highest-capability Claude model for the hardest coding and reasoning tasks.',
        contextWindowTokens: 1_000_000,
    },
    {
        id: 'claude-opus-4-7',
        name: 'Opus 4.7',
        description: 'Prior highest-capability Claude model for hard coding and reasoning tasks.',
        contextWindowTokens: 1_000_000,
    },
    {
        id: 'claude-opus-4-6',
        name: 'Opus 4.6',
        description: 'Highest-capability Claude model for the hardest coding and reasoning tasks.',
    },
    {
        id: 'claude-sonnet-4-6',
        name: 'Sonnet 4.6',
        description: 'Balanced Claude model for everyday coding, editing, and analysis.',
    },
    {
        id: 'claude-haiku-4-5',
        name: 'Haiku 4.5',
        description: 'Fastest Claude option for lighter tasks and lower-latency replies.',
    },
    {
        id: 'claude-opus-4-5',
        name: 'Opus 4.5',
        description: 'Prior Opus generation alias for compatibility with existing Claude setups.',
    },
    {
        id: 'claude-sonnet-4-5',
        name: 'Sonnet 4.5',
        description: 'Prior Sonnet generation alias for compatibility with existing Claude setups.',
    },
] as const satisfies readonly AgentModelDescriptor[];

export const CLAUDE_STATIC_MODELS: readonly AgentModelDescriptor[] = Object.freeze(
    CLAUDE_STATIC_MODEL_BASE.map(withClaudeModelFacts),
);

export const CLAUDE_AGENT_MODEL_CONFIG = Object.freeze({
    supportsSelection: true,
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    dynamicProbe: 'static-only',
    defaultMode: 'default',
    allowedModes: CLAUDE_STATIC_MODELS.map((model) => model.id),
    staticModels: CLAUDE_STATIC_MODELS,
} satisfies AgentModelConfig);
