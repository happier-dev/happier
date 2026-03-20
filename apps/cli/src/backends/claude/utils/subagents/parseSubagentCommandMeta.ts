import { parseSubagentCommandV1, type SubagentCommandV1 } from '@happier-dev/protocol';

import { readClaudeHappierEnvelope } from '@/backends/claude/utils/structuredMessages/readClaudeHappierEnvelope';

export type ClaudeSubagentCommandMeta = Readonly<{
    payload: SubagentCommandV1;
}>;

export function parseSubagentCommandMeta(meta: unknown): ClaudeSubagentCommandMeta | null {
    const env = readClaudeHappierEnvelope(meta);
    if (!env || env.kind !== 'subagent_command.v1') return null;
    const payload = parseSubagentCommandV1(env.payload);
    return payload ? { payload } : null;
}
