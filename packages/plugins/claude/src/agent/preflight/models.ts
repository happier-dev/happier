import { AGENT_MODEL_CONFIG, type AgentModelDescriptor } from '@happier-dev/agents';

export type ClaudePreflightModel = Readonly<{
    id: string;
    name: string;
    description?: string;
    contextWindowTokens?: number;
    modelOptions?: AgentModelDescriptor['modelOptions'] | undefined;
}>;

export async function probeClaudePreflightModels(params: Readonly<{
    cwd: string;
    timeoutMs: number;
    probeHelpText: (params: Readonly<{ cwd: string; timeoutMs: number }>) => Promise<string | null>;
}>): Promise<ClaudePreflightModel[] | null> {
    const helpText = await params.probeHelpText({ cwd: params.cwd, timeoutMs: params.timeoutMs });
    if (!helpText) return null;

    const supportsEffort = /\B--effort\b/i.test(helpText);
    if (!supportsEffort) return null;

    const models = AGENT_MODEL_CONFIG.claude.staticModels ?? [];
    return models.map((model) => ({
        id: model.id,
        name: model.name,
        ...(typeof model.description === 'string' ? { description: model.description } : {}),
        ...(typeof model.contextWindowTokens === 'number' ? { contextWindowTokens: model.contextWindowTokens } : {}),
        ...(Array.isArray(model.modelOptions) && model.modelOptions.length > 0
            ? { modelOptions: model.modelOptions }
            : { modelOptions: undefined }),
    }));
}
