import { parseSubagentLaunchV1, type SubagentLaunchV1 } from '@happier-dev/protocol';

import { readClaudeHappierEnvelope } from '@/backends/claude/utils/structuredMessages/readClaudeHappierEnvelope';

export type ClaudeSubagentLaunchMeta = Readonly<{
    payload: SubagentLaunchV1;
}>;

export function parseSubagentLaunchMeta(meta: unknown): ClaudeSubagentLaunchMeta | null {
    const env = readClaudeHappierEnvelope(meta);
    if (!env || env.kind !== 'subagent_launch.v1') return null;
    const payload = parseSubagentLaunchV1(env.payload);
    return payload ? { payload } : null;
}
