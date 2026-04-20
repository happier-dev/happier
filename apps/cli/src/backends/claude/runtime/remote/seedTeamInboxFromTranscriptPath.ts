import { join } from 'node:path';

import type { RawJSONLines } from '@/backends/claude/contracts/rawJsonLines';
import { readClaudeSessionJsonlMessages } from '@/backends/claude/utils/readClaudeSessionJsonlMessages';
import { getProjectPath } from '@/backends/claude/utils/path';

type ClaudeRemoteTeamInboxBridge = Readonly<{
    observe: (message: RawJSONLines) => void;
    syncAll: () => Promise<void>;
}>;

export async function seedClaudeRemoteTeamInboxFromTranscriptPath(params: Readonly<{
    sessionId: string | null;
    transcriptPath: string | null;
    sessionPath: string;
    claudeConfigDir: string | null;
    teamInboxBridge: ClaudeRemoteTeamInboxBridge;
    seededSessionIds: Set<string>;
}>): Promise<void> {
    const sid = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
    if (!sid) return;
    if (params.seededSessionIds.has(sid)) return;

    const resolvedTranscriptPath = (() => {
        const direct = typeof params.transcriptPath === 'string' ? params.transcriptPath.trim() : '';
        if (direct.length > 0) return direct;
        try {
            const projectDir = getProjectPath(params.sessionPath, params.claudeConfigDir);
            return join(projectDir, `${sid}.jsonl`);
        } catch {
            return '';
        }
    })();
    if (!resolvedTranscriptPath) return;

    params.seededSessionIds.add(sid);
    try {
        const messages = await readClaudeSessionJsonlMessages({
            sessionFilePath: resolvedTranscriptPath,
            logLabel: 'CLAUDE_TEAM_INBOX_SEED',
        });
        for (const message of messages) {
            try {
                params.teamInboxBridge.observe(message);
            } catch {
                // ignore malformed history lines
            }
        }
        await params.teamInboxBridge.syncAll();
    } catch {
        // ignore
    }
}
