import { AGENT_MODEL_CONFIG } from '@happier-dev/plugin-sdk/experimental/agents';

export type ClaudeSessionModelsState = {
    v: 1;
    agentId: 'claude';
    updatedAt: number;
    currentModelId: string;
    availableModels: Array<{
        id: string;
        name: string;
        description?: string;
        contextWindowTokens?: number;
        modelOptions?: Array<{
            id: string;
            name: string;
            description?: string;
            type: string;
            currentValue: string | number | boolean | null;
            options?: Array<{
                value: string | number | boolean | null;
                name: string;
                description?: string;
            }>;
        }>;
    }>;
};

export async function resolveClaudeSessionModelsState(params: Readonly<{
    cwd: string;
    timeoutMs: number;
    currentModelId: string;
    nowMs: () => number;
    probeHelpText: (params: Readonly<{ cwd: string; timeoutMs: number }>) => Promise<string | null>;
}>): Promise<ClaudeSessionModelsState | null> {
    const helpText = await params.probeHelpText({ cwd: params.cwd, timeoutMs: params.timeoutMs });
    if (!helpText) return null;

    const supportsEffort = /\B--effort\b/i.test(helpText);
    if (!supportsEffort) return null;

    const updatedAt = params.nowMs();
    const models = AGENT_MODEL_CONFIG.claude.staticModels ?? [];

    return {
        v: 1,
        agentId: 'claude',
        updatedAt,
        currentModelId: params.currentModelId,
        availableModels: models.map((model) => {
            const description = typeof model.description === 'string' ? model.description : '';
            return {
                id: model.id,
                name: model.name,
                ...(description ? { description } : {}),
                ...(typeof model.contextWindowTokens === 'number' ? { contextWindowTokens: model.contextWindowTokens } : {}),
                ...(Array.isArray(model.modelOptions) && model.modelOptions.length > 0
                    ? { modelOptions: model.modelOptions }
                    : {}),
            };
        }),
    };
}
