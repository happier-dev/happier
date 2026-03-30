import { readFile } from 'node:fs/promises';

import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { mapCodexRolloutEventToActions } from '../localControl/rolloutMapper';
import { createCodexRolloutSemanticTracker } from '../rollout/createCodexRolloutSemanticTracker';
import { collectCodexSessionRolloutFiles, type CodexRolloutFile } from './collectCodexSessionRolloutFiles';
import { mapCodexRolloutLineToDirectMessages } from './mapCodexRolloutLineToDirectMessages';

type CodexDirectTranscriptRolloutStream = CodexRolloutFile & Readonly<{
    threadId: string;
    sidechainId: string | null;
}>;

function splitJsonlLines(content: string): readonly { startOffsetBytes: number; raw: string }[] {
    const lines: { startOffsetBytes: number; raw: string }[] = [];
    let offset = 0;
    const rawLines = content.split('\n');
    for (const rawLine of rawLines) {
        const startOffsetBytes = offset;
        offset += Buffer.byteLength(rawLine, 'utf8') + 1;
        if (!rawLine.trim()) continue;
        lines.push({ startOffsetBytes, raw: rawLine });
    }
    return lines;
}

async function discoverSpawnedThreadIdsFromFiles(files: readonly CodexRolloutFile[]): Promise<readonly string[]> {
    const discovered = new Set<string>();
    const semanticTracker = createCodexRolloutSemanticTracker();
    for (const file of files) {
        let content = '';
        try {
            content = await readFile(file.filePath, 'utf8');
        } catch {
            continue;
        }
        for (const line of splitJsonlLines(content)) {
            let value: unknown;
            try {
                value = JSON.parse(line.raw) as unknown;
            } catch {
                continue;
            }
            for (const action of mapCodexRolloutEventToActions(value, { debug: true })) {
                for (const normalizedAction of semanticTracker.consume(action)) {
                    if (normalizedAction.type !== 'subagent-spawn') continue;
                    discovered.add(normalizedAction.threadId);
                }
            }
        }
    }
    return [...discovered];
}

export async function collectCodexDirectTranscriptRolloutStreams(params: Readonly<{
    codexHome: string;
    remoteSessionId: string;
}>): Promise<readonly CodexDirectTranscriptRolloutStream[]> {
    const queue = [{ threadId: params.remoteSessionId, sidechainId: null as string | null }];
    const seenThreadIds = new Set<string>();
    const streams: CodexDirectTranscriptRolloutStream[] = [];

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (seenThreadIds.has(current.threadId)) continue;
        seenThreadIds.add(current.threadId);

        const files = await collectCodexSessionRolloutFiles({
            codexHome: params.codexHome,
            remoteSessionId: current.threadId,
        });
        if (files.length === 0) continue;

        streams.push(...files.map((file) => ({
            ...file,
            threadId: current.threadId,
            sidechainId: current.sidechainId,
        })));

        const discoveredChildThreadIds = await discoverSpawnedThreadIdsFromFiles(files);
        for (const threadId of discoveredChildThreadIds) {
            if (!seenThreadIds.has(threadId)) {
                queue.push({ threadId, sidechainId: threadId });
            }
        }
    }

    streams.sort((left, right) =>
        left.sortMs - right.sortMs
        || left.mtimeMs - right.mtimeMs
        || left.fileRelPath.localeCompare(right.fileRelPath),
    );
    return streams;
}

function compareDirectTranscriptItemsOldestFirst(left: DirectTranscriptRawMessageV1, right: DirectTranscriptRawMessageV1): number {
    if (left.createdAtMs !== right.createdAtMs) return left.createdAtMs - right.createdAtMs;
    return left.id.localeCompare(right.id);
}

export async function materializeCodexDirectTranscriptItems(params: Readonly<{
    codexHome: string;
    remoteSessionId: string;
}>): Promise<readonly DirectTranscriptRawMessageV1[]> {
    const streams = await collectCodexDirectTranscriptRolloutStreams(params);
    const items: DirectTranscriptRawMessageV1[] = [];
    const semanticTracker = createCodexRolloutSemanticTracker();

    for (const stream of streams) {
        let content = '';
        try {
            content = await readFile(stream.filePath, 'utf8');
        } catch {
            continue;
        }

        for (const line of splitJsonlLines(content)) {
            let value: unknown;
            try {
                value = JSON.parse(line.raw) as unknown;
            } catch {
                const padded = Math.max(0, Math.trunc(line.startOffsetBytes)).toString().padStart(12, '0');
                const stableId = `codex:${stream.fileRelPath}:${padded}`;
                items.push({
                    id: stableId,
                    localId: stableId,
                    createdAtMs: Math.max(0, Math.trunc(stream.sortMs)),
                    raw: {
                        role: 'agent',
                        content: {
                            type: 'output',
                            data: {
                                type: 'opaque',
                                reason: 'invalid_json',
                                source: {
                                    fileRelPath: stream.fileRelPath,
                                    lineStartOffsetBytes: line.startOffsetBytes,
                                },
                                original: line.raw,
                            },
                        },
                    },
                });
                continue;
            }
            const normalizedActions = mapCodexRolloutEventToActions(value, { debug: true })
                .flatMap((action) => semanticTracker.consume(action));
            items.push(...mapCodexRolloutLineToDirectMessages({
                fileRelPath: stream.fileRelPath,
                lineStartOffsetBytes: line.startOffsetBytes,
                lineValue: value,
                actions: normalizedActions,
                sidechainId: stream.sidechainId,
            }));
        }
    }

    items.sort(compareDirectTranscriptItemsOldestFirst);
    return items;
}
