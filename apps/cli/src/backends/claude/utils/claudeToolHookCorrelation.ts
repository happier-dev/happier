import { deepEqual } from '@/utils/deterministicJson';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import { open as openFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { logger } from '@/ui/logger';

import { isClaudeSidechainRuntimeEvidence, isSidechainSessionHook } from './sessionHookAttribution';
import type { PermissionHookData, SessionHookData } from './startHookServer';

const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Live provider tool facts shared by native prompts and the legacy permission bridge. */
export class ClaudeToolHookCorrelation {
    private readonly toolHooks = new Map<string, SessionHookData>();

    observePreToolUse(data: SessionHookData): void {
        if (isSidechainSessionHook(data) || (data.hook_event_name ?? data.hookEventName) !== 'PreToolUse') return;
        const id = readNonBlankOpaqueIdentifier(data.tool_use_id ?? data.toolUseId);
        if (id) this.toolHooks.set(id, data);
    }

    findToolUseId(params: Readonly<{ sessionId: string; toolName: string; toolInput: unknown }>): string | null {
        const matching = this.findToolUseIds(params);
        return matching.length === 1 ? matching[0]! : null;
    }

    private findToolUseIds(params: Readonly<{ sessionId: string; toolName: string; toolInput: unknown }>): string[] {
        return [...this.toolHooks.entries()].filter(([, hook]) => (
            (hook.session_id ?? hook.sessionId) === params.sessionId
            && (hook.tool_name ?? hook.toolName) === params.toolName
            && deepEqual(hook.tool_input ?? hook.toolInput, params.toolInput)
        )).map(([id]) => id);
    }

    async resolvePermissionRequestId(data: PermissionHookData, context: Readonly<{
        sessionId: string | null;
        transcriptPath: string | null;
    }>): Promise<string | null> {
        const explicit = readNonBlankOpaqueIdentifier(data.tool_use_id ?? data.toolUseId);
        if (explicit) return explicit;
        // A headless agent must never borrow either live or historical primary-tool identity.
        if (isSidechainSessionHook(data)) return null;
        const sessionId = data.session_id ?? data.sessionId ?? context.sessionId;
        const toolName = data.tool_name ?? data.toolName;
        const toolInput = data.tool_input !== undefined ? data.tool_input : data.toolInput ?? {};
        if (typeof toolName !== 'string') return null;
        if (typeof sessionId === 'string') {
            const matching = this.findToolUseIds({ sessionId, toolName, toolInput });
            if (matching.length === 1) return matching[0]!;
            if (matching.length > 1) {
                logger.infoFile('[claude-tool-hooks] Permission identity is ambiguous among live tool hooks', { sessionId, toolName });
                return null;
            }
        }
        const transcriptPath = String(context.transcriptPath?.trim() || data.transcript_path || data.transcriptPath || '').trim();
        if (!transcriptPath || transcriptPath.length > 4096) {
            logger.infoFile('[claude-tool-hooks] Permission has no exact tool identity or usable transcript path', { sessionId, toolName });
            return null;
        }
        const fileName = basename(transcriptPath).toLowerCase();
        if (!(fileName.endsWith('.jsonl') || fileName.endsWith('.json'))) {
            logger.infoFile('[claude-tool-hooks] Permission identity recovery cannot use the supplied transcript format', { sessionId, toolName });
            return null;
        }
        try {
            const file = await openFile(transcriptPath, 'r');
            try {
                const { size } = await file.stat();
                if (size <= 0) return null;
                const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
                const buffer = Buffer.alloc(Math.min(size, TRANSCRIPT_TAIL_BYTES));
                const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
                const candidates = new Set<string>();
                const completed = new Set<string>();
                for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
                    let value: unknown;
                    try { value = JSON.parse(line); } catch { continue; }
                    const row = readRecord(value);
                    if (!row || isClaudeSidechainRuntimeEvidence(row)) continue;
                    const rowSessionId = row.sessionId ?? row.session_id;
                    if (typeof rowSessionId === 'string' && typeof sessionId === 'string' && rowSessionId !== sessionId) continue;
                    const content = readRecord(row.message)?.content;
                    if (!Array.isArray(content)) continue;
                    for (const value of content) {
                        const block = readRecord(value);
                        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') completed.add(block.tool_use_id);
                        if (block?.type === 'tool_use' && block.name === toolName && deepEqual(block.input, toolInput)) {
                            const id = readNonBlankOpaqueIdentifier(block.id);
                            if (id) candidates.add(id);
                        }
                    }
                }
                const unresolved = [...candidates].filter((id) => !completed.has(id));
                if (unresolved.length !== 1) logger.infoFile('[claude-tool-hooks] Transcript has no unique unresolved permission tool identity', {
                    sessionId, toolName, unresolvedCount: unresolved.length,
                });
                return unresolved.length === 1 ? unresolved[0]! : null;
            } finally { await file.close(); }
        } catch (error) {
            logger.infoFile('[claude-tool-hooks] Failed to recover permission tool identity from transcript', { sessionId, toolName, error });
            return null;
        }
    }

    get(toolUseId: string): SessionHookData | undefined { return this.toolHooks.get(toolUseId); }
    delete(toolUseId: string): void { this.toolHooks.delete(toolUseId); }
    clear(): void { this.toolHooks.clear(); }
}
