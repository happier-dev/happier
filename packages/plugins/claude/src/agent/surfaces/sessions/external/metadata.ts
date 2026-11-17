import { open, stat } from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import { projectExternalSessionCandidateTitle, readSessionInputPromptUserTextV1 } from '@happier-dev/plugin-sdk/sessions/external';

import {
    isPluginError,
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
    cwd: string | null;
}>;

export type ClaudeTitleAccumulator = Readonly<{
    customTitle: string | null;
    aiTitle: string | null;
    fallbackTitle: string | null;
    customTitleSeen?: boolean;
    aiTitleSeen?: boolean;
}>;

type ClaudeTranscriptIdentity = Readonly<{
    device: string;
    inode: string;
    birthtimeNs: string;
    sizeBytes: number;
    mtimeNs: string;
    ctimeNs: string;
}>;

// Only raw JSONL pages are shared: fallback-title interpretation belongs to each
// invocation's prompt-reader context. The host index remains the only persisted cache.
const titlePagesInFlight = new Map<string, ReturnType<typeof readJsonlFileForwardLines>>();

async function readClaudeTitlePage(
    filePath: string,
    offsetBytes: number,
    identity: ClaudeTranscriptIdentity,
    fileSystem: JsonlScannerFileSystem | undefined,
): ReturnType<typeof readJsonlFileForwardLines> {
    const readPage = () => readJsonlFileForwardLines({
        filePath,
        offsetBytes,
        maxBytes: TITLE_SCAN_CHUNK_MAX_BYTES,
        maxItems: TITLE_SCAN_CHUNK_MAX_ITEMS,
        fileSystem,
    });
    // An explicit filesystem can describe a different source at the same path.
    if (fileSystem) return await readPage();
    const key = JSON.stringify([filePath, identity, offsetBytes]);
    const pending = titlePagesInFlight.get(key);
    if (pending) return await pending;
    const started = readPage();
    titlePagesInFlight.set(key, started);
    try {
        return await started;
    } finally {
        titlePagesInFlight.delete(key);
    }
}

function readTitleCandidate(value: string): string | null {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized.slice(0, 10_000) : null;
}

function readWorkingDirectory(value: unknown): string | null {
    const cwd = isRecord(value) && typeof value.cwd === 'string' ? value.cwd.trim() : '';
    return cwd || null;
}

function coerceTextContent(content: unknown): string | null {
    if (typeof content === 'string') {
        return readTitleCandidate(projectExternalSessionCandidateTitle(readSessionInputPromptUserTextV1(content), { source: 'prompt' }));
    }
    if (!Array.isArray(content)) return null;

    const text = content
        .map((item) => {
            return isRecord(item) && typeof item.text === 'string' ? item.text : '';
        })
        .filter((part) => part.trim().length > 0)
        .join(' ');
    return readTitleCandidate(projectExternalSessionCandidateTitle(readSessionInputPromptUserTextV1(text), { source: 'prompt' }));
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
        // A title-only checkpoint has no cwd knowledge and must be re-derived.
        || (value.cwd !== null && typeof value.cwd !== 'string')
    ) return null;
    // Older checkpoints treated a host prompt echo as the first user title.
    // Re-derive it from the same native file, including the unchanged-EOF path.
    if (typeof value.fallbackTitle === 'string'
        && coerceTextContent(value.fallbackTitle) !== value.fallbackTitle) return null;
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
        cwd: value.cwd,
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

export function applyClaudeTitleRecord(
    current: ClaudeTitleAccumulator,
    value: unknown,
    remoteSessionId: string,
    direction: 'forward' | 'backward' = 'forward',
): ClaudeTitleAccumulator {
    if (!isRecord(value)) return current;
    if (
        value.type === 'custom-title'
        && value.sessionId === remoteSessionId
        && typeof value.customTitle === 'string'
    ) {
        return Object.freeze({
            ...current,
            customTitle: direction === 'backward' && current.customTitleSeen ? current.customTitle : readTitleCandidate(value.customTitle),
            ...(direction === 'backward' ? { customTitleSeen: true } : {}),
        });
    }
    if (
        value.type === 'ai-title'
        && value.sessionId === remoteSessionId
        && typeof value.aiTitle === 'string'
    ) {
        return Object.freeze({
            ...current,
            aiTitle: direction === 'backward' && current.aiTitleSeen ? current.aiTitle : readTitleCandidate(value.aiTitle),
            ...(direction === 'backward' ? { aiTitleSeen: true } : {}),
        });
    }
    if ((direction === 'forward' && current.fallbackTitle !== null) || value.type !== 'user') return current;
    const message = isRecord(value.message) ? value.message : null;
    const fallbackTitle = coerceTextContent(message?.content);
    return fallbackTitle === null
        ? current
        : Object.freeze({ ...current, fallbackTitle });
}

export function resolveClaudeTitle(accumulator: ClaudeTitleAccumulator): string | null {
    return accumulator.customTitle
        ?? accumulator.aiTitle
        ?? accumulator.fallbackTitle;
}

// Forward-scanner parity: a record that cannot complete within this allowance
// fails the title read instead of being skipped.
const TITLE_RECORD_MAX_BYTES = 8 * 1024 * 1024;
const TITLE_RECORD_NEEDLES = [Buffer.from('"custom-title"'), Buffer.from('"ai-title"')];
const titleChunksInFlight = new Map<string, Promise<Buffer>>();

type ClaudeTitleTailScan = Readonly<{
    accumulator: ClaudeTitleAccumulator;
    verifiedThroughBytes: number;
    stoppedAtIncompleteTail: boolean;
}>;

const MALFORMED_UTF8 = Symbol('malformed_utf8');

function parseTitleLine(line: Buffer): unknown {
    // The forward scanner drops a malformed UTF-8 line with a diagnostic.
    if (!isUtf8(line)) return MALFORMED_UTF8;
    const raw = line.toString('utf8').trim();
    if (raw.length === 0) return undefined;
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        return null;
    }
}

/**
 * Title choice is custom title, then AI title (the last of each wins), then the
 * first user text. The last records of both kinds are found from the end; only
 * lines carrying a title record type are parsed. The body is skipped once both
 * kinds are seen, and a transcript lacking either is still scanned to its
 * start, so absence keeps today's choice. Claude's writer emits the record type
 * as a plain JSON string, which is what the byte probe matches.
 */
async function scanClaudeTitleTail(params: Readonly<{
    filePath: string;
    remoteSessionId: string;
    identity: ClaudeTranscriptIdentity;
    fileSystem: JsonlScannerFileSystem | undefined;
}>): Promise<ClaudeTitleTailScan> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    const readRaw = async (position: number, length: number): Promise<Buffer> => {
        if (params.fileSystem) return await params.fileSystem.read(params.filePath, position, length);
        handle ??= await open(params.filePath, 'r');
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        return buffer.subarray(0, bytesRead);
    };
    const readChunk = async (position: number, length: number): Promise<Buffer> => {
        // An explicit filesystem can describe a different source at the same path.
        if (params.fileSystem) return await readRaw(position, length);
        const key = JSON.stringify([params.filePath, params.identity, position, length]);
        const pending = titleChunksInFlight.get(key);
        if (pending) return await pending;
        const started = readRaw(position, length);
        titleChunksInFlight.set(key, started);
        try {
            return await started;
        } finally {
            titleChunksInFlight.delete(key);
        }
    };
    try {
        let accumulator: ClaudeTitleAccumulator = Object.freeze({ customTitle: null, aiTitle: null, fallbackTitle: null });
        let verifiedThroughBytes = params.identity.sizeBytes;
        let stoppedAtIncompleteTail = false;
        let end = params.identity.sizeBytes;
        // Bytes after the newest newline seen so far, waiting for their line start.
        let carry: Buffer = Buffer.alloc(0);
        let finalLine = true;
        const applyLine = (line: Buffer, startOffsetBytes: number) => {
            if (finalLine) {
                finalLine = false;
                const value = parseTitleLine(line);
                // An unterminated final record is still being written.
                if (value === null && startOffsetBytes + line.length === params.identity.sizeBytes
                    && line.toString('utf8').trim() !== 'null') {
                    verifiedThroughBytes = startOffsetBytes;
                    stoppedAtIncompleteTail = true;
                    return;
                }
                if (value !== undefined && value !== MALFORMED_UTF8) {
                    accumulator = applyClaudeTitleRecord(accumulator, value, params.remoteSessionId, 'backward');
                }
                return;
            }
            if (line.length >= TITLE_RECORD_MAX_BYTES) throw new Error('Claude transcript title record exceeds the read allowance');
            if (!TITLE_RECORD_NEEDLES.some(needle => line.includes(needle))) return;
            const value = parseTitleLine(line);
            if (value !== undefined && value !== MALFORMED_UTF8) {
                accumulator = applyClaudeTitleRecord(accumulator, value, params.remoteSessionId, 'backward');
            }
        };
        const done = () => accumulator.customTitleSeen === true && accumulator.aiTitleSeen === true;
        while (end > 0 && !done()) {
            const length = Math.min(TITLE_SCAN_CHUNK_MAX_BYTES, end);
            const start = end - length;
            const chunk = await readChunk(start, length);
            if (chunk.length !== length) throw new Error('Claude transcript changed while indexing its title');
            const bytes = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
            let lineEnd = bytes.length;
            for (let index = bytes.lastIndexOf(0x0a, lineEnd - 1); index >= 0 && !done();
                index = index > 0 ? bytes.lastIndexOf(0x0a, index - 1) : -1) {
                const isTrailingNewline = finalLine && index === bytes.length - 1 && start + bytes.length === params.identity.sizeBytes;
                if (isTrailingNewline) {
                    // A terminated final record is complete; it is just a line.
                    finalLine = false;
                } else {
                    applyLine(bytes.subarray(index + 1, lineEnd), start + index + 1);
                }
                lineEnd = index;
            }
            carry = bytes.subarray(0, lineEnd);
            if (carry.length >= TITLE_RECORD_MAX_BYTES && start > 0) {
                throw new Error('Claude transcript title record exceeds the read allowance');
            }
            end = start;
        }
        if (end === 0 && carry.length > 0 && !done()) applyLine(carry, 0);
        return { accumulator, verifiedThroughBytes, stoppedAtIncompleteTail };
    } finally {
        await handle?.close();
    }
}

/**
 * Claude owns title and cwd semantics; the host candidate index owns persistence. A
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
    cwd: string | null;
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
                title: resolveClaudeTitle(previousState),
                cwd: previousState.cwd,
                indexState: previousState,
            });
        }

        const canResume = previousState !== null
            && sameFile
            && previousState.verifiedThroughBytes < before.sizeBytes;
        let offsetBytes = canResume && previousState ? previousState.verifiedThroughBytes : 0;
        let accumulator = readTitleAccumulatorFromState(canResume ? previousState : null);
        let cwd = canResume && previousState ? previousState.cwd : null;
        let stoppedAtIncompleteTail = false;
        if (canResume) {
            while (offsetBytes < before.sizeBytes) {
                const page = await readClaudeTitlePage(
                    params.filePath,
                    offsetBytes,
                    before,
                    params.fileSystem,
                );
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
                    cwd ??= readWorkingDirectory(line.value);
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
        } else {
            const tail = await scanClaudeTitleTail({
                filePath: params.filePath,
                remoteSessionId: params.remoteSessionId,
                identity: before,
                fileSystem: params.fileSystem,
            });
            // The first user text and working directory come from the head.
            let head: ClaudeTitleAccumulator = Object.freeze({ customTitle: null, aiTitle: null, fallbackTitle: null });
            let headOffsetBytes = 0;
            headScan: while (headOffsetBytes < tail.verifiedThroughBytes && (head.fallbackTitle === null || cwd === null)) {
                const page = await readClaudeTitlePage(params.filePath, headOffsetBytes, before, params.fileSystem);
                for (const line of page.items) {
                    if (line.startOffsetBytes >= tail.verifiedThroughBytes) break headScan;
                    cwd ??= readWorkingDirectory(line.value);
                    head = applyClaudeTitleRecord(head, line.value, params.remoteSessionId);
                    if (head.fallbackTitle !== null && cwd !== null) break headScan;
                }
                if (page.truncated || page.nextOffsetBytes <= headOffsetBytes) {
                    throw new Error('Claude transcript title scan did not advance');
                }
                headOffsetBytes = page.nextOffsetBytes;
                if (page.reachedEnd) break;
            }
            accumulator = Object.freeze({
                customTitle: tail.accumulator.customTitle,
                aiTitle: tail.accumulator.aiTitle,
                fallbackTitle: head.fallbackTitle,
            });
            offsetBytes = tail.verifiedThroughBytes;
            stoppedAtIncompleteTail = tail.stoppedAtIncompleteTail;
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
                cwd,
            });
            return Object.freeze({
                title: resolveClaudeTitle(indexState),
                cwd: indexState.cwd,
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
        }).catch((error: unknown) => {
            if (!isPluginError(error) || error.code !== 'JSONL_RECORD_TOO_LARGE') throw error;
            console.warn(`[claude] Working-directory scan stopped: ${error.message}`);
            return null;
        });
        if (!page) return null;
        for (const line of page.items) {
            const cwd = readWorkingDirectory(line.value);
            if (cwd) return cwd;
        }
        if (page.reachedEnd || page.nextOffsetBytes <= offsetBytes) return null;
        offsetBytes = page.nextOffsetBytes;
    }
}
