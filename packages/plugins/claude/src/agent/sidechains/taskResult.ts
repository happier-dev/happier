export function extractAgentIdFromTaskResultText(text: string): { agentId: string | null; taskId: string | null } {
    const raw = String(text ?? '');

    const agentId =
        raw.match(/\bagentId\s*[:=]\s*([A-Za-z0-9@._-]+)/i)?.[1] ??
        raw.match(/\bagent_id\s*[:=]\s*([A-Za-z0-9@._-]+)/i)?.[1] ??
        null;

    const taskId =
        raw.match(/\btask_id\s*[:=]\s*([A-Za-z0-9._-]+)/i)?.[1] ??
        raw.match(/\btaskId\s*[:=]\s*([A-Za-z0-9._-]+)/i)?.[1] ??
        null;

    return {
        agentId: agentId ? String(agentId) : null,
        taskId: taskId ? String(taskId) : null,
    };
}

export function extractOutputFilePathFromTaskResultText(text: string): string | null {
    const raw = String(text ?? '');
    const match = raw.match(/\boutput_file\s*[:=]\s*([^\s]+)/i);
    const value = match?.[1] ? String(match[1]).trim() : '';
    if (!value) return null;
    return value.replace(/^['"]|['"]$/g, '').trim() || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function coerceClaudeToolUseResultExtraLines(base: string, toolUseResult: Record<string, unknown>): string[] {
    const extras: string[] = [];
    const agentId = readTrimmedString(toolUseResult.agent_id ?? toolUseResult.agentId ?? toolUseResult.teammate_id);
    if (agentId && !/\bagent_id\b|\bagentId\b|\bteammate_id\b/i.test(base)) {
        extras.push(`agent_id: ${agentId}`);
    }

    const taskId = readTrimmedString(toolUseResult.task_id ?? toolUseResult.taskId);
    if (taskId && !/\btask_id\b|\btaskId\b/i.test(base)) {
        extras.push(`task_id: ${taskId}`);
    }

    const teamName = readTrimmedString(toolUseResult.team_name ?? toolUseResult.teamName);
    if (teamName && !/\bteam_name\b|\bteamName\b/i.test(base)) {
        extras.push(`team_name: ${teamName}`);
    }

    return extras;
}

export function coerceClaudeToolResultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (content == null) return '';

    if (isRecord(content)) {
        const base = Object.prototype.hasOwnProperty.call(content, 'content')
            ? coerceClaudeToolResultText(content.content)
            : '';

        const toolUseResult = isRecord(content.tool_use_result) ? content.tool_use_result : null;
        if (!toolUseResult) return base;

        const extras = coerceClaudeToolUseResultExtraLines(base, toolUseResult);
        if (extras.length === 0) return base;
        return base ? `${base}\n${extras.join('\n')}` : extras.join('\n');
    }

    if (Array.isArray(content)) {
        const chunks: string[] = [];
        for (const item of content) {
            if (!isRecord(item)) continue;
            if (item.type !== 'text') continue;
            const text = item.text;
            if (typeof text === 'string' && text.trim().length > 0) {
                chunks.push(text);
            }
        }
        return chunks.join('\n');
    }

    return '';
}
