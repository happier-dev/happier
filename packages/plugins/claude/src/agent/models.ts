import {
    type AgentModelConfig,
    type AgentModelDescriptor,
} from '@happier-dev/plugin-sdk/agents';

import { ANTHROPIC_STATIC_MODELS } from '../provider/catalog.js';
import { CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS } from './contextWindow.js';

export const CLAUDE_STATIC_MODELS: readonly AgentModelDescriptor[] = ANTHROPIC_STATIC_MODELS.map((model) => (
    // Claude Code's standard window is independent of the Provider API's 1M
    // capacity; the declared variant is the native opt-in for these models.
    model.extendedContextModelId
        ? { ...model, contextWindowTokens: CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS }
        : model
));

export const CLAUDE_AGENT_MODEL_CONFIG: AgentModelConfig = Object.freeze({
    supportsSelection: true,
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    dynamicProbe: 'auto',
    dynamicProbeControl: {
        accountSettingId: 'claudeDynamicModelProbeEnabled',
        environmentVariable: 'HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED',
    },
    nativeCatalogObservation: {
        providerLocalId: 'anthropic',
        purpose: 'model_upstream',
        connectedServiceId: 'claude-subscription',
        nativeBearer: {
            fileId: '.credentials.json',
            jsonPath: ['claudeAiOauth', 'accessToken'],
        },
    },
    defaultMode: 'default',
    allowedModes: CLAUDE_STATIC_MODELS.map((model) => model.id),
    staticModels: CLAUDE_STATIC_MODELS,
} satisfies AgentModelConfig);
