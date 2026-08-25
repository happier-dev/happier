import { randomUUID } from 'node:crypto';
import { access, link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
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
    type ClaudeSessionBundle,
    type ImportedClaudeSessionHandoffBundle,
} from './types.js';

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
    transcript: Buffer;
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

    let existingTranscript: Buffer;
    try {
        existingTranscript = await readFile(params.transcriptPath);
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
    if (!existingTranscript.equals(params.transcript)) {
        throw targetIdentityConflict();
    }
    return 'identical';
}

function isSameFileIdentity(before: Awaited<ReturnType<typeof lstat>>, after: Awaited<ReturnType<typeof lstat>>): boolean {
    return before.dev === after.dev
        && before.ino === after.ino
        && before.size === after.size
        && before.mtimeMs === after.mtimeMs
        && before.ctimeMs === after.ctimeMs;
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
    transcript: Buffer;
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
            await temporaryFile.writeFile(params.transcript);
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
    const transcript = await readFile(transcriptPath, 'utf8');
    throwIfAborted(params.signal);
    return {
        agentId: 'claude',
        remoteSessionId: params.remoteSessionId,
        transcriptBase64: Buffer.from(transcript, 'utf8').toString('base64'),
    };
}

export async function importClaudeSessionBundle(params: Readonly<{
    bundle: unknown;
    targetPath: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
}>): Promise<ImportedClaudeSessionHandoffBundle> {
    throwIfAborted(params.signal);
    const bundle = ClaudeSessionBundleSchema.parse(params.bundle);
    const resolvedClaudeConfigDir = resolveClaudeConfigDir(params.env);
    const projectId = resolveClaudeProjectId(params.targetPath);
    const projectDir = getClaudeProjectPath(params.targetPath, resolvedClaudeConfigDir);
    const transcriptPath = resolveClaudeTranscriptPath(projectDir, bundle.remoteSessionId);

    const transcript = Buffer.from(bundle.transcriptBase64, 'base64');
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
