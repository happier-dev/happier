// Synthetic dimensions and clocks based on the r205 shape census; no QA contents.
export const USAGE_RIG_DAY = 86_400_000;
export const USAGE_RIG_NOW = Date.UTC(2026, 10, 17, 12);

export function seedUsageRigAccountingRows(accountId: string, claudeSessionId: string, codexSessionId: string) {
    return Array.from({ length: 45_000 }, (_, index) => {
        const claude = index < 8_500;
        const day = claude ? index % 13 : index % 22;
        const observedAt = USAGE_RIG_NOW - day * USAGE_RIG_DAY - (index % 86_000) * 1_000;
        const inputTokens = 800 + (index % 101);
        const outputTokens = 200 + (index % 37);
        const totalTokens = inputTokens + outputTokens;
        return {
            accountId, sessionId: claude ? claudeSessionId : codexSessionId,
            observedAt: new Date(observedAt), agentId: claude ? 'claude' : 'codex',
            backendMode: claude ? 'anthropic' : 'openai', modelId: claude ? 'claude-3-5-sonnet' : 'gpt-5-mini',
            projectKey: claude ? 'project-claude' : 'project-codex', workspaceId: claude ? 'workspace-a' : 'workspace-b',
            machineId: claude ? 'machine-claude' : 'machine-codex', source: claude ? 'claude_sdk' : 'codex_app_server',
            scope: 'turn_delta', externalKey: `usage-rig-${index}`, isCumulative: false,
            inputTokens, outputTokens, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens,
            estimatedCostUsd: totalTokens / 100_000, costSource: 'pricing_estimate', currency: 'USD',
            metadata: { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } },
        };
    });
}
