import { configuration } from '@/configuration';
import { isGenericSubAgentToolName } from '@happier-dev/protocol/tools/v2';

export function rewriteClaudePermissionToolInput(params: Readonly<{
    toolName: string;
    input: unknown;
    agentIdByTaskId: ReadonlyMap<string, string>;
}>): unknown {
    const { toolName, input, agentIdByTaskId } = params;

    if (toolName === 'task' || isGenericSubAgentToolName(toolName)) {
        if (configuration.claudeTaskAllowRunInBackground) return input;
        if (!input || typeof input !== 'object' || Array.isArray(input)) return input;

        const record = input as Record<string, unknown>;
        const requestedBackground =
            record.run_in_background === true || (record as any).runInBackground === true;
        if (!requestedBackground) return input;

        const next: Record<string, unknown> = { ...record, run_in_background: false };
        if ('runInBackground' in next) {
            delete (next as any).runInBackground;
        }
        return next;
    }

    if (toolName !== 'TaskOutput' && toolName !== 'task_output') return input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;

    const record = input as Record<string, unknown>;
    const taskIdRaw = typeof record.task_id === 'string' ? record.task_id.trim() : '';
    if (!taskIdRaw) return input;

    const agentId = agentIdByTaskId.get(taskIdRaw) ?? null;
    if (!agentId || agentId === taskIdRaw) return input;

    return { ...record, task_id: agentId };
}

export function coerceClaudeToolResultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (content == null) return '';

    if (Array.isArray(content)) {
        const chunks: string[] = [];
        for (const item of content) {
            if (!item || typeof item !== 'object') continue;
            if ((item as any).type !== 'text') continue;
            const text = (item as any).text;
            if (typeof text === 'string' && text.trim().length > 0) {
                chunks.push(text);
            }
        }
        return chunks.join('\n');
    }

    return '';
}
