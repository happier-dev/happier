import { resolve } from 'node:path';

import type { FileBackedTranscriptSessionLease, FileBackedTranscriptSessionStore } from '@/api/session/fileBackedTranscripts/store';
import type { RawJSONLines } from '@happier-dev/plugins-claude/agent';
import {
    readClaudeRawJsonlSessionMessages,
    resolveClaudeExternalSessionJsonlFile,
} from '@happier-dev/plugins-claude/agent/surfaces/sessions/external/providerOps';
import { getProjectPath, resolveClaudeProjectId } from '../../../utils/path';
import { acquireClaudeRawJsonlSessionStore } from '../../sessionStore';

type ClaudeScannerMainTranscriptStoreLease = Readonly<{
    lease: FileBackedTranscriptSessionLease<FileBackedTranscriptSessionStore<RawJSONLines, unknown, string | null>>;
    unsubscribe: () => void;
}>;

export function createMainTranscriptStore(params: Readonly<{
    workingDirectory: string;
    claudeConfigDir?: string | null;
    invalidate: () => void;
}>) {
    const storeLeases = new Map<string, ClaudeScannerMainTranscriptStoreLease>();
    const sessionCursors = new Map<string, string | null>();
    const resolvedProjectId = resolveClaudeProjectId(params.workingDirectory);

    function resolveCanonicalTranscriptPath(sessionId: string): string {
        return resolve(getProjectPath(params.workingDirectory, params.claudeConfigDir ?? null), `${sessionId}.jsonl`);
    }

    async function release(sessionId: string): Promise<void> {
        const existing = storeLeases.get(sessionId);
        if (!existing) return;

        storeLeases.delete(sessionId);
        try {
            existing.unsubscribe();
        } finally {
            await existing.lease.release();
        }
    }

    async function sync(sessionId: string, transcriptPath: string | null | undefined): Promise<boolean> {
        const canonicalTranscriptPath = resolveCanonicalTranscriptPath(sessionId);
        const resolvedTranscriptPath =
            typeof transcriptPath === 'string' && transcriptPath.trim().length > 0
                ? resolve(transcriptPath.trim())
                : null;
        const shouldUseStore = resolvedTranscriptPath === null || resolvedTranscriptPath === canonicalTranscriptPath;

        if (!shouldUseStore) {
            await release(sessionId);
            return false;
        }

        if (storeLeases.has(sessionId)) {
            return true;
        }

        const resolved = await resolveClaudeExternalSessionJsonlFile({
            source: {
                kind: 'claudeConfig',
                configDir: params.claudeConfigDir ?? null,
                projectId: resolvedProjectId,
            },
            env: process.env,
            remoteSessionId: sessionId,
        });
        if (!resolved || resolved.filePath !== canonicalTranscriptPath) {
            return false;
        }

        try {
            const lease = await acquireClaudeRawJsonlSessionStore({
                key: {
                    providerId: 'claude',
                    source: {
                        kind: 'claudeConfig',
                        configDir: params.claudeConfigDir ?? null,
                        projectId: resolvedProjectId,
                    },
                    remoteSessionId: sessionId,
                },
            });

            const unsubscribe = lease.store.subscribe(() => {
                params.invalidate();
            });

            storeLeases.set(sessionId, { lease, unsubscribe });
            return true;
        } catch {
            return false;
        }
    }

    function hasStoreLease(sessionId: string): boolean {
        return storeLeases.has(sessionId);
    }

    function resetSession(sessionId: string): void {
        sessionCursors.delete(sessionId);
    }

    async function cleanup(): Promise<void> {
        const entries = Array.from(storeLeases.keys());
        for (const sessionId of entries) {
            await release(sessionId);
        }
        sessionCursors.clear();
    }

    return {
        cleanup,
        hasStoreLease,
        async readNext(sessionId: string, sessionFilePath: string, maxBytes?: number, maxItems?: number) {
            const previousCursor = sessionCursors.get(sessionId) ?? null;
            const existing = storeLeases.get(sessionId);
            const read = existing
                ? await existing.lease.store.readAfter({
                    cursor: previousCursor,
                    maxBytes: maxBytes ?? 1024 * 1024,
                    maxItems: maxItems ?? 100,
                }).then((result) => ({ ...result, initialized: true }))
                : await readClaudeRawJsonlSessionMessages({
                    sessionFilePath,
                    cursor: previousCursor,
                    maxBytes,
                    maxItems,
                });

            if (read.initialized) {
                sessionCursors.set(sessionId, read.nextCursor ?? null);
            }

            return {
                ...read,
                previousCursor,
            };
        },
        release,
        resetSession,
        sync,
    };
}
