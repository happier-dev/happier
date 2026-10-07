import { stat } from 'node:fs/promises';

import {
    isRecord,
} from '@happier-dev/plugin-sdk';
import {
    readJsonlFileForward,
    readJsonlFileForwardLines,
    type JsonlScannerFileSystem,
} from '@happier-dev/plugin-sdk/sessions/file-stores';

import {
    resolveClaudeJsonlSessionFile,
} from './files.js';
import type { ClaudeExternalSessionSource } from './source.js';

const TITLE_SCAN_CHUNK_MAX_BYTES = 1024 * 1024;
const TITLE_SCAN_CHUNK_MAX_ITEMS = 2_048;

export type ClaudeTitleIndexState = Readonly<{
    v: 1;
    kind: 'claude_title_index';
    device: string;
    inode: string;
    birthtimeNs: string;
    verifiedThroughBytes: number;
    mtimeNs: string;
    ctimeNs: string;
    customTitle: string | null;
    aiTitle: string | null;
    fallbackTitle: string | null;
}>;

type ClaudeTitleAccumulator = Readonly<{
    customTitle: string | null;
    aiTitle: string | null;
    fallbackTitle: string | null;
}>;

type ClaudeTranscriptIdentity = Readonly<{
    device: string;
    inode: string;
    birthtimeNs: string;
    sizeBytes: number;
    mtimeNs: string;
    ctimeNs: string;
}>;

function readTitleCandidate(value: string): string | null {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized.slice(0, 10_000) : null;
}

function coerceTextContent(content: unknown): string | null {
    if (typeof content === 'string') {
        return readTitleCandidate(content);
    }
    if (!Array.isArray(content)) return null;

    const text = content
        .map((item) => {
            return isRecord(item) && typeof item.text === 'string' ? item.text : '';
        })
        .filter((part) => part.trim().length > 0)
        .join(' ');
    return readTitleCandidate(text);
}

function readClaudeTitleIndexState(value: unknown): ClaudeTitleIndexState | null {
    if (!isRecord(value)) return null;
    if (
        value.v !== 1
        || value.kind !== 'claude_title_index'
        || typeof value.device !== 'string'
        || typeof value.inode !== 'string'
        || typeof value.birthtimeNs !== 'string'
        || !Number.isSafeInteger(value.verifiedThroughBytes)
        || (value.verifiedThroughBytes as number) < 0
        || typeof value.mtimeNs !== 'string'
        || typeof value.ctimeNs !== 'string'
        || (value.customTitle !== null && typeof value.customTitle !== 'string')
        || (value.aiTitle !== null && typeof value.aiTitle !== 'string')
        || (value.fallbackTitle !== null && typeof value.fallbackTitle !== 'string')
    ) return null;
    return Object.freeze({
        v: 1,
        kind: 'claude_title_index',
        device: value.device,
        inode: value.inode,
        birthtimeNs: value.birthtimeNs,
        verifiedThroughBytes: value.verifiedThroughBytes as number,
        mtimeNs: value.mtimeNs,
        ctimeNs: value.ctimeNs,
        customTitle: value.customTitle,
        aiTitle: value.aiTitle,
        fallbackTitle: value.fallbackTitle,
    });
}

async function readTranscriptIdentity(filePath: string): Promise<ClaudeTranscriptIdentity> {
    const current = await stat(filePath, { bigint: true });
    if (current.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Claude transcript is too large to index safely');
    }
    return Object.freeze({
        device: current.dev.toString(),
        inode: current.ino.toString(),
        birthtimeNs: current.birthtimeNs.toString(),
        sizeBytes: Number(current.size),
        mtimeNs: current.mtimeNs.toString(),
        ctimeNs: current.ctimeNs.toString(),
    });
}

function transcriptIdentitiesEqual(
    left: ClaudeTranscriptIdentity,
    right: ClaudeTranscriptIdentity,
): boolean {
    return left.device === right.device
        && left.inode === right.inode
        && left.birthtimeNs === right.birthtimeNs
        && left.sizeBytes === right.sizeBytes
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}

function readTitleAccumulatorFromState(
    state: ClaudeTitleIndexState | null,
): ClaudeTitleAccumulator {
    return Object.freeze({
        customTitle: state?.customTitle ?? null,
        aiTitle: state?.aiTitle ?? null,
        fallbackTitle: state?.fallbackTitle ?? null,
    });
}

function applyClaudeTitleRecord(
    current: ClaudeTitleAccumulator,
    value: unknown,
    remoteSessionId: string,
): ClaudeTitleAccumulator {
    if (!isRecord(value)) return current;
    if (
        value.type === 'custom-title'
        && value.sessionId === remoteSessionId
        && typeof value.customTitle === 'string'
    ) {
        return Object.freeze({
            ...current,
            customTitle: readTitleCandidate(value.customTitle),
        });
    }
    if (
        value.type === 'ai-title'
        && value.sessionId === remoteSessionId
        && typeof value.aiTitle === 'string'
    ) {
        return Object.freeze({
            ...current,
            aiTitle: readTitleCandidate(value.aiTitle),
        });
    }
    if (current.fallbackTitle !== null || value.type !== 'user') return current;
    const message = isRecord(value.message) ? value.message : null;
    const fallbackTitle = coerceTextContent(message?.content);
    return fallbackTitle === null
        ? current
        : Object.freeze({ ...current, fallbackTitle });
}

function resolveTitle(accumulator: ClaudeTitleAccumulator): string | null {
    return accumulator.customTitle
        ?? accumulator.aiTitle
        ?? accumulator.fallbackTitle;
}

/**
 * Claude owns title semantics; the host candidate index owns persistence. A
 * matching state resumes at the verified byte boundary of the same transcript
 * inode, while a replacement, truncation, or same-size rewrite cold-scans. The
 * suffix path relies on Claude's observed append-only JSONL writer contract.
 */
export async function readClaudeJsonlSessionTitleWithIndex(params: Readonly<{
    filePath: string;
    remoteSessionId: string;
    previousState?: unknown;
    fileSystem?: JsonlScannerFileSystem;
}>): Promise<Readonly<{
    title: string | null;
    indexState: ClaudeTitleIndexState;
}>> {
    let previousState = readClaudeTitleIndexState(params.previousState);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = await readTranscriptIdentity(params.filePath);
        const sameFile = previousState !== null
            && previousState.device === before.device
            && previousState.inode === before.inode
            && previousState.birthtimeNs === before.birthtimeNs;
        const unchanged = previousState !== null
            && sameFile
            && previousState.verifiedThroughBytes === before.sizeBytes
            && previousState.mtimeNs === before.mtimeNs
            && previousState.ctimeNs === before.ctimeNs;
        if (unchanged && previousState) {
            return Object.freeze({
                title: resolveTitle(previousState),
                indexState: previousState,
            });
        }

        const canResume = previousState !== null
            && sameFile
            && previousState.verifiedThroughBytes < before.sizeBytes;
        let offsetBytes = canResume && previousState ? previousState.verifiedThroughBytes : 0;
        let accumulator = readTitleAccumulatorFromState(canResume ? previousState : null);
        let stoppedAtIncompleteTail = false;
        while (offsetBytes < before.sizeBytes) {
            const page = await readJsonlFileForwardLines({
                filePath: params.filePath,
                offsetBytes,
                maxBytes: TITLE_SCAN_CHUNK_MAX_BYTES,
                maxItems: TITLE_SCAN_CHUNK_MAX_ITEMS,
                fileSystem: params.fileSystem,
            });
            for (const line of page.items) {
                if (
                    line.value === null
                    && line.rawLine !== 'null'
                    && line.endOffsetBytes === before.sizeBytes
                ) {
                    offsetBytes = line.startOffsetBytes;
                    stoppedAtIncompleteTail = true;
                    break;
                }
                accumulator = applyClaudeTitleRecord(
                    accumulator,
                    line.value,
                    params.remoteSessionId,
                );
            }
            if (stoppedAtIncompleteTail) break;
            if (page.truncated || page.nextOffsetBytes <= offsetBytes) {
                throw new Error('Claude transcript title scan did not advance');
            }
            offsetBytes = page.nextOffsetBytes;
            if (page.reachedEnd) break;
        }

        const after = await readTranscriptIdentity(params.filePath);
        if (
            transcriptIdentitiesEqual(before, after)
            && (
                offsetBytes === after.sizeBytes
                || (stoppedAtIncompleteTail && offsetBytes < after.sizeBytes)
            )
        ) {
            const indexState: ClaudeTitleIndexState = Object.freeze({
                v: 1,
                kind: 'claude_title_index',
                device: after.device,
                inode: after.inode,
                birthtimeNs: after.birthtimeNs,
                verifiedThroughBytes: offsetBytes,
                mtimeNs: after.mtimeNs,
                ctimeNs: after.ctimeNs,
                customTitle: accumulator.customTitle,
                aiTitle: accumulator.aiTitle,
                fallbackTitle: accumulator.fallbackTitle,
            });
            return Object.freeze({
                title: resolveTitle(indexState),
                indexState,
            });
        }
        previousState = null;
    }
    throw new Error('Claude transcript changed while indexing its title');
}

export async function readClaudeJsonlSessionTitle(filePath: string): Promise<string | null> {
    const remoteSessionId = filePath.split(/[\\/]/).at(-1)?.replace(/\.jsonl$/, '') ?? '';
    return (await readClaudeJsonlSessionTitleWithIndex({ filePath, remoteSessionId })).title;
}

export async function readClaudeJsonlSessionWorkingDirectory(params: Readonly<{
    source: ClaudeExternalSessionSource;
    remoteSessionId: string;
    env: NodeJS.ProcessEnv;
}>): Promise<string | null> {
    const resolved = await resolveClaudeJsonlSessionFile(params);
    if (!resolved) return null;
    let offsetBytes = 0;
    while (true) {
        const page = await readJsonlFileForward({
            filePath: resolved.filePath,
            offsetBytes,
            maxBytes: TITLE_SCAN_CHUNK_MAX_BYTES,
            maxItems: TITLE_SCAN_CHUNK_MAX_ITEMS,
        });
        for (const line of page.items) {
            const cwd = isRecord(line.value) && typeof line.value.cwd === 'string'
                ? line.value.cwd.trim()
                : '';
            if (cwd) return cwd;
        }
        if (page.reachedEnd || page.nextOffsetBytes <= offsetBytes) return null;
        offsetBytes = page.nextOffsetBytes;
    }
}
