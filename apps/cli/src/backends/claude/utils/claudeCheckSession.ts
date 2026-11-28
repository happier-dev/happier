import { logger } from "@/ui/logger";
import { constants as bufferConstants } from "node:buffer";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
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

    const fd = openSync(sessionFile, 'r');
    let hasGoodMessage = false;
    try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        const decoder = new StringDecoder('utf8');
        let line: string | null = '';
        let lineNumber = 1;
        while (!hasGoodMessage) {
            const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
            const parts = (bytesRead === 0 ? decoder.end() : decoder.write(buffer.subarray(0, bytesRead))).split('\n');
            for (const [index, part] of parts.entries()) {
                if (line !== null) {
                    if (line.length + part.length <= bufferConstants.MAX_STRING_LENGTH) {
                        line += part;
                    } else {
                        logger.debug(`[claudeCheckSession] JSONL record exceeds Node's string limit at line ${lineNumber}`);
                        line = null; // Discard through the next newline, including across chunks.
                    }
                }
                if (index === parts.length - 1 && bytesRead !== 0) break;
                if (line !== null && hasClaudeTranscriptMessageId(line, lineNumber)) {
                    hasGoodMessage = true;
                    break;
                }
                line = '';
                lineNumber += 1;
            }
            if (bytesRead === 0) break;
        }
    } finally {
        closeSync(fd);
    }

    // Log final validation result for observability
    logger.debug(`[claudeCheckSession] Session ${sessionId}: ${hasGoodMessage ? 'valid' : 'invalid'}`);

    return hasGoodMessage;
}

function hasClaudeTranscriptMessageId(line: string, lineNumber: number): boolean {
    if (!line.trim()) return false;

    try {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== 'object') return false;
        // Current Claude Code, older Claude Code, and summary records respectively.
        return (['uuid', 'messageId', 'leafUuid'] as const).some((key) => {
            const id = (parsed as Record<string, unknown>)[key];
            return typeof id === 'string' && id.length > 0;
        });
    } catch (error) {
        logger.debug(`[claudeCheckSession] Malformed JSON at line ${lineNumber}:`, error);
        return false;
    }
}
