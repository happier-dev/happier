import { randomUUID } from 'node:crypto';
import { access, link, lstat, mkdir, open, stat, unlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import { isCanonicalAbsolutePathInsideRoot } from '@happier-dev/plugin-sdk/fs';
import type { HandoffExportSessionMetadata } from '@happier-dev/plugin-sdk/agents/runtime';

import { resolveClaudeConfigDir } from '../../../environment.js';
import { resolveClaudeJsonlSessionFile } from '../external/files.js';
import type { ClaudeExternalSessionSource } from '../external/source.js';
import { getClaudeProjectPath, resolveClaudeProjectId } from './path.js';
import {
    ClaudeSessionBundleSchema,
    type ClaudeHandoffBundleFile,
    type ClaudeSessionBundle,
    type ImportedClaudeSessionHandoffBundle,
} from './types.js';

type ClaudeTranscriptContent = Buffer | ClaudeHandoffBundleFile;
const HANDOFF_COPY_CHUNK_BYTES = 1024 * 1024;
type ClaudeTranscriptReader = (offsetBytes: number, buffer: Buffer) => Promise<number>;

function transcriptSize(content: ClaudeTranscriptContent): number {
    return Buffer.isBuffer(content) ? content.length : content.sizeBytes;
}

async function withTranscriptReader<TResult>(
    content: ClaudeTranscriptContent,
    effect: (reader: ClaudeTranscriptReader) => Promise<TResult>,
): Promise<TResult> {
    if (Buffer.isBuffer(content)) {
        return await effect(async (offsetBytes, buffer) => {
            const bytes = Math.min(buffer.length, Math.max(0, content.length - offsetBytes));
            content.copy(buffer, 0, offsetBytes, offsetBytes + bytes);
            return bytes;
        });
    }
    const source = await open(content.filePath, 'r');
    try {
        return await effect(async (offsetBytes, buffer) => {
            const bytes = Math.min(buffer.length, Math.max(0, content.sizeBytes - offsetBytes));
            if (bytes === 0) return 0;
            return (await source.read(buffer, 0, bytes, content.offsetBytes + offsetBytes)).bytesRead;
        });
    } finally {
        await source.close();
    }
}

async function transcriptEqualsFile(content: ClaudeTranscriptContent, filePath: string): Promise<boolean> {
    const entry = await lstat(filePath);
    if (!entry.isFile() || entry.size !== transcriptSize(content)) return false;
    const existing = await open(filePath, 'r');
    try {
        return await withTranscriptReader(content, async (readTranscriptChunk) => {
            const sourceBuffer = Buffer.allocUnsafe(HANDOFF_COPY_CHUNK_BYTES);
            const existingBuffer = Buffer.allocUnsafe(HANDOFF_COPY_CHUNK_BYTES);
            for (let offset = 0; offset < entry.size; offset += HANDOFF_COPY_CHUNK_BYTES) {
                const requested = Math.min(HANDOFF_COPY_CHUNK_BYTES, entry.size - offset);
                const [sourceBytes, existingRead] = await Promise.all([
                    readTranscriptChunk(offset, sourceBuffer),
                    existing.read(existingBuffer, 0, requested, offset),
                ]);
                if (
                    sourceBytes !== requested
                    || existingRead.bytesRead !== requested
                    || !sourceBuffer.subarray(0, requested).equals(existingBuffer.subarray(0, requested))
                ) return false;
            }
            return true;
        });
    } finally {
        await existing.close();
    }
}

async function writeTranscript(target: Awaited<ReturnType<typeof open>>, content: ClaudeTranscriptContent): Promise<void> {
    await withTranscriptReader(content, async (readTranscriptChunk) => {
        const buffer = Buffer.allocUnsafe(HANDOFF_COPY_CHUNK_BYTES);
        const size = transcriptSize(content);
        for (let offset = 0; offset < size; offset += HANDOFF_COPY_CHUNK_BYTES) {
            const bytesRead = await readTranscriptChunk(offset, buffer);
            if (bytesRead === 0) throw new Error('Invalid session handoff transfer payload');
            await target.write(buffer.subarray(0, bytesRead));
        }
    });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
        ? signal.reason
        : new Error('Claude handoff operation was cancelled');
}

/**
 * The linked source as this leaf may act on it: a `claudeConfig` source that
 * actually names a config root and/or a project. A source naming neither is
 * indistinguishable from having no source at all, so it stays on the
 * environment-derived path rather than widening the search across every project
 * of the environment root.
 */
function resolveExternalSessionSource(params: Readonly<{
    metadata: HandoffExportSessionMetadata;
}>): ClaudeExternalSessionSource | null {
    const source = params.metadata.externalSessionSource;
    if (source?.kind !== 'claudeConfig') {
        return null;
    }
    const configDir = typeof source.configDir === 'string' ? source.configDir.trim() : '';
    const projectId = typeof source.projectId === 'string' ? source.projectId.trim() : '';
    if (!configDir && !projectId) {
        return null;
    }
    return {
        kind: 'claudeConfig',
        ...(configDir ? { configDir } : {}),
        ...(projectId ? { projectId } : {}),
    };
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function resolveReadableTranscriptPath(params: Readonly<{
    metadata: HandoffExportSessionMetadata;
    remoteSessionId: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
}>): Promise<string> {
    assertSafeClaudeHandoffRemoteSessionId(params.remoteSessionId);

    // An explicit linked source is EXCLUSIVE custody, not a ranked preference.
    // The session id alone does not identify bytes: the same id can exist under
    // a second Claude config root, so continuing to the environment-derived
    // project after a linked miss lets an unrelated root's same-id transcript be
    // exported as this session's -- while the bundle still describes the linked
    // source. A linked source that cannot produce the transcript is a typed
    // export failure, never a substituted source. The environment-derived path
    // is the authority only when the session carries no linked source at all.
    const linkedSource = resolveExternalSessionSource(params);
    if (linkedSource) {
        const linked = await resolveClaudeJsonlSessionFile({
            source: linkedSource,
            env: params.env,
            remoteSessionId: params.remoteSessionId,
            ...(params.signal ? { signal: params.signal } : {}),
        });
        if (linked) return linked.filePath;
        throw new Error(
            `Claude handoff transcript for ${params.remoteSessionId} is unavailable or unauthorized in its linked source`,
        );
    }

    const fakeTranscriptLog = [
        params.env.HAPPIER_E2E_FAKE_CLAUDE_LOG,
        params.env.HAPPY_E2E_FAKE_CLAUDE_LOG,
    ].find((value) => typeof value === 'string' && value.trim().length > 0);
    if (typeof fakeTranscriptLog === 'string' && (await fileExists(fakeTranscriptLog))) {
        return fakeTranscriptLog;
    }

    const workingDirectory = typeof params.metadata.path === 'string' ? params.metadata.path.trim() : '';
    if (!workingDirectory) {
        throw new Error('Missing Claude working directory for handoff export');
    }
    const derived = await resolveClaudeJsonlSessionFile({
        source: {
            kind: 'claudeConfig',
            configDir: resolveClaudeConfigDir(params.env),
            projectId: resolveClaudeProjectId(workingDirectory),
        },
        env: params.env,
        remoteSessionId: params.remoteSessionId,
        ...(params.signal ? { signal: params.signal } : {}),
    });
    if (derived) return derived.filePath;

    throw new Error(
        `Claude handoff transcript for ${params.remoteSessionId} is unavailable or unauthorized`,
    );
}

function assertSafeClaudeHandoffRemoteSessionId(remoteSessionId: string): void {
    if (!remoteSessionId || remoteSessionId.includes('/') || remoteSessionId.includes('\\')) {
        throw new Error(`Invalid remoteSessionId for Claude handoff: ${remoteSessionId}`);
    }
}

function resolveClaudeTranscriptPath(projectDir: string, remoteSessionId: string): string {
    assertSafeClaudeHandoffRemoteSessionId(remoteSessionId);
    return join(projectDir, `${remoteSessionId}.jsonl`);
}

function readErrorCode(error: unknown): string | null {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && typeof error.code === 'string'
        ? error.code
        : null;
}

function targetIdentityConflict(): PluginError {
    return new PluginError({
        code: 'target_identity_conflict',
        message: 'Claude handoff target conflicts with the existing native session',
        retryable: false,
    });
}

async function preflightClaudeTranscriptTarget(params: Readonly<{
    configDir: string;
    projectDir: string;
    transcriptPath: string;
    transcript: ClaudeTranscriptContent;
    signal?: AbortSignal;
}>): Promise<'absent' | 'identical'> {
    throwIfAborted(params.signal);
    await assertExistingClaudeProjectParentsAreSafe(params);
    throwIfAborted(params.signal);

    let entry;
    try {
        entry = await lstat(params.transcriptPath);
    } catch (error) {
        if (readErrorCode(error) === 'ENOENT') {
            return 'absent';
        }
        throw targetIdentityConflict();
    }
    throwIfAborted(params.signal);
    if (!entry.isFile()) {
        throw targetIdentityConflict();
    }

    try {
        if (!await transcriptEqualsFile(params.transcript, params.transcriptPath)) {
            throw targetIdentityConflict();
        }
    } catch {
        throw targetIdentityConflict();
    }
    throwIfAborted(params.signal);

    let entryAfterRead;
    try {
        entryAfterRead = await lstat(params.transcriptPath);
    } catch {
        throw targetIdentityConflict();
    }
    throwIfAborted(params.signal);
    if (!entryAfterRead.isFile() || !isSameFileIdentity(entry, entryAfterRead)) {
        throw targetIdentityConflict();
    }
    return 'identical';
}

function isSameFileIdentity(before: Awaited<ReturnType<typeof lstat>>, after: Awaited<ReturnType<typeof lstat>>): boolean {
    return before.dev === after.dev
        && before.ino === after.ino
        && before.size === after.size
        && before.mtimeMs === after.mtimeMs;
}

async function assertExistingClaudeProjectParentsAreSafe(params: Readonly<{
    configDir: string;
    projectDir: string;
    signal?: AbortSignal;
}>): Promise<void> {
    // The configured Claude directory is the caller-selected trust root and may itself be a
    // deliberate symlink. Descendants are native handoff-owned paths and must be real directories.
    const configRoot = resolve(params.configDir);
    const resolvedProjectDir = resolve(params.projectDir);
    const projectRelativePath = relative(configRoot, resolvedProjectDir);
    if (!isCanonicalAbsolutePathInsideRoot(configRoot, resolvedProjectDir)) {
        throw targetIdentityConflict();
    }

    let currentPath = configRoot;
    for (const segment of projectRelativePath.split(sep)) {
        throwIfAborted(params.signal);
        if (!segment) continue;
        currentPath = join(currentPath, segment);
        let entry: Awaited<ReturnType<typeof lstat>>;
        try {
            entry = await lstat(currentPath);
        } catch (error) {
            if (isPluginError(error)) {
                throw error;
            }
            if (readErrorCode(error) === 'ENOENT') {
                return;
            }
            throw targetIdentityConflict();
        }
        throwIfAborted(params.signal);
        if (!entry.isDirectory()) {
            throw targetIdentityConflict();
        }
    }
}

async function createClaudeTranscriptIfAbsent(params: Readonly<{
    configDir: string;
    projectDir: string;
    transcriptPath: string;
    transcript: ClaudeTranscriptContent;
    signal?: AbortSignal;
}>): Promise<void> {
    throwIfAborted(params.signal);
    const targetState = await preflightClaudeTranscriptTarget(params);
    throwIfAborted(params.signal);
    if (targetState === 'identical') {
        return;
    }

    throwIfAborted(params.signal);
    await mkdir(params.projectDir, { recursive: true });
    throwIfAborted(params.signal);
    await assertExistingClaudeProjectParentsAreSafe(params);
    throwIfAborted(params.signal);
    const temporaryPath = join(params.projectDir, `.happier-import-${randomUUID()}.tmp`);
    let temporaryCreated = false;
    try {
        throwIfAborted(params.signal);
        const temporaryFile = await open(temporaryPath, 'wx');
        temporaryCreated = true;
        try {
            throwIfAborted(params.signal);
            await writeTranscript(temporaryFile, params.transcript);
            throwIfAborted(params.signal);
        } finally {
            await temporaryFile.close();
        }
        throwIfAborted(params.signal);
        try {
            await link(temporaryPath, params.transcriptPath);
        } catch (error) {
            const racedTargetState = await preflightClaudeTranscriptTarget(params);
            if (racedTargetState === 'identical') {
                return;
            }
            throw error;
        }
        throwIfAborted(params.signal);
    } finally {
        if (temporaryCreated) {
            await unlink(temporaryPath).catch(() => undefined);
        }
    }
}

export async function exportClaudeSessionBundle(params: Readonly<{
    metadata: HandoffExportSessionMetadata;
    remoteSessionId: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
}>): Promise<ClaudeSessionBundle> {
    throwIfAborted(params.signal);
    const transcriptPath = await resolveReadableTranscriptPath(params);
    throwIfAborted(params.signal);
    const transcriptStats = await stat(transcriptPath);
    throwIfAborted(params.signal);
    return {
        agentId: 'claude',
        remoteSessionId: params.remoteSessionId,
        transcriptFile: {
            t: 'happier.handoff.file.v1',
            filePath: transcriptPath,
            offsetBytes: 0,
            sizeBytes: transcriptStats.size,
        },
    };
}

export async function importClaudeSessionBundle(params: Readonly<{
    bundle: unknown;
    targetPath: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
}>): Promise<ImportedClaudeSessionHandoffBundle> {
    throwIfAborted(params.signal);
    const parsedBundle = ClaudeSessionBundleSchema.parse(params.bundle);
    const bundle: ClaudeSessionBundle = parsedBundle.transcriptFile
        ? {
            agentId: 'claude',
            remoteSessionId: parsedBundle.remoteSessionId,
            transcriptFile: parsedBundle.transcriptFile,
        }
        : {
            agentId: 'claude',
            remoteSessionId: parsedBundle.remoteSessionId,
            transcriptBase64: parsedBundle.transcriptBase64 ?? '',
        };
    const resolvedClaudeConfigDir = resolveClaudeConfigDir(params.env);
    const projectId = resolveClaudeProjectId(params.targetPath);
    const projectDir = getClaudeProjectPath(params.targetPath, resolvedClaudeConfigDir);
    const transcriptPath = resolveClaudeTranscriptPath(projectDir, bundle.remoteSessionId);

    const transcript = bundle.transcriptFile ?? Buffer.from(bundle.transcriptBase64 ?? '', 'base64');
    await createClaudeTranscriptIfAbsent({
        configDir: resolvedClaudeConfigDir,
        projectDir,
        transcriptPath,
        transcript,
        signal: params.signal,
    });
    throwIfAborted(params.signal);

    return {
        providerSessionId: bundle.remoteSessionId,
        directSource: {
            kind: 'claudeConfig',
            configDir: resolvedClaudeConfigDir,
            projectId,
        },
        launch: {
            directory: params.targetPath,
            environmentVariables: {
                CLAUDE_CONFIG_DIR: resolvedClaudeConfigDir,
            },
        },
    };
}
