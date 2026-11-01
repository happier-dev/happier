import { logger } from "@/ui/logger";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getProjectPath } from "./path";

export class ClaudeResumeSessionUnavailableError extends Error {
    readonly code = 'claude_resume_session_unavailable';
    readonly providerSessionId: string;

    constructor(providerSessionId: string, options?: ErrorOptions) {
        super(
            `Claude session ${providerSessionId} cannot be resumed because its transcript is unavailable. `
            + 'Happier did not start a new session because the requested operation was resume.',
            options,
        );
        this.name = 'ClaudeResumeSessionUnavailableError';
        this.providerSessionId = providerSessionId;
    }
}

export function resolveClaudeSessionTranscriptPath(
    sessionId: string,
    path: string,
    transcriptPath?: string | null,
    claudeConfigDir?: string | null,
): string {
    const explicitPath = typeof transcriptPath === 'string' ? transcriptPath.trim() : '';
    return explicitPath || join(getProjectPath(path, claudeConfigDir), `${sessionId}.jsonl`);
}

// Materialization is weaker than Session's complete-record publication proof. Keep
// this filesystem threshold shared by identity discovery and remote resume validation.
export function hasClaudeMaterializedSessionTranscript(
  sessionId: string,
  path: string,
  transcriptPath: string | null,
  configDir: string | null,
): boolean {
  const sessionFile = resolveClaudeSessionTranscriptPath(sessionId, path, transcriptPath, configDir);
  try {
    return statSync(sessionFile).size > 0;
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    // An inspection failure cannot authorize a fresh conversation or an automatic retry.
    throw new ClaudeResumeSessionUnavailableError(sessionId, { cause: error });
  }
}

export function claudeCheckSession(
    sessionId: string,
    path: string,
    transcriptPath?: string | null,
    claudeConfigDir?: string | null,
) {
    const sessionFile = resolveClaudeSessionTranscriptPath(sessionId, path, transcriptPath, claudeConfigDir);
    const sessionExists = existsSync(sessionFile);
    if (!sessionExists) {
        logger.debug(`[claudeCheckSession] Path ${sessionFile} does not exist`);
        return false;
    }

    // Check if session contains any messages with valid ID fields
    const sessionData = readFileSync(sessionFile, 'utf-8').split('\n');

    const hasGoodMessage = !!sessionData.find((v, index) => {
        if (!v.trim()) return false;  // Skip empty lines silently (not errors)

        try {
            const parsed = JSON.parse(v);
            // Accept sessions with any of these ID fields (different Claude Code versions)
            // Check for non-empty strings to handle edge cases robustly
            return (typeof parsed.uuid === 'string' && parsed.uuid.length > 0) ||        // Claude Code 2.1.x
                   (typeof parsed.messageId === 'string' && parsed.messageId.length > 0) ||   // Older Claude Code
                   (typeof parsed.leafUuid === 'string' && parsed.leafUuid.length > 0);      // Summary lines
        } catch (e) {
            // Log parse errors for debugging (following project convention)
            logger.debug(`[claudeCheckSession] Malformed JSON at line ${index + 1}:`, e);
            return false;
        }
    });

    // Log final validation result for observability
    logger.debug(`[claudeCheckSession] Session ${sessionId}: ${hasGoodMessage ? 'valid' : 'invalid'}`);

    return hasGoodMessage;
}
