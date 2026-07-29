import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { PluginError } from '@happier-dev/plugin-sdk';
import { readLinkedExternalSessionV1FromMetadata } from '@happier-dev/plugin-sdk/experimental/sessions';

import { getClaudeProjectPath, resolveClaudeConfigDirOverride, resolveClaudeProjectId } from './path.js';
import {
    ClaudeSessionBundleSchema,
    type ClaudeSessionBundle,
    type ImportedClaudeSessionHandoffBundle,
} from './types.js';

function resolveExternalSessionSourceTranscriptPath(params: Readonly<{
    metadata: Record<string, unknown>;
    remoteSessionId: string;
}>): string | null {
    const externalSession = readLinkedExternalSessionV1FromMetadata(params.metadata);
    if (externalSession?.agentId !== 'claude') {
        return null;
    }
    const source = externalSession.source;
    if (source.kind !== 'claudeConfig') {
        return null;
    }
    const configDir = typeof source.configDir === 'string' ? source.configDir.trim() : '';
    const projectId = typeof source.projectId === 'string' ? source.projectId.trim() : '';
    if (!configDir || !projectId) {
        return null;
    }
    return resolveClaudeTranscriptPath(join(configDir, 'projects', projectId), params.remoteSessionId);
}

function resolveTranscriptPath(params: Readonly<{
    metadata: Record<string, unknown>;
    remoteSessionId: string;
    env: NodeJS.ProcessEnv;
}>): string {
    const externalSessionTranscriptPath = resolveExternalSessionSourceTranscriptPath(params);
    if (externalSessionTranscriptPath) return externalSessionTranscriptPath;

    const workingDirectory = typeof params.metadata.path === 'string' ? params.metadata.path.trim() : '';
    if (!workingDirectory) {
        throw new Error('Missing Claude working directory for handoff export');
    }

    return resolveClaudeTranscriptPath(
        getClaudeProjectPath(workingDirectory, resolveClaudeConfigDirOverride(params.env)),
        params.remoteSessionId,
    );
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
    metadata: Record<string, unknown>;
    remoteSessionId: string;
    env: NodeJS.ProcessEnv;
}>): Promise<string> {
    const candidatePaths = [resolveExternalSessionSourceTranscriptPath(params)]
        .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);

    for (const candidatePath of candidatePaths) {
        if (await fileExists(candidatePath)) {
            return candidatePath;
        }
    }

    const fakeTranscriptLog = [
        params.env.HAPPIER_E2E_FAKE_CLAUDE_LOG,
        params.env.HAPPY_E2E_FAKE_CLAUDE_LOG,
    ].find((value) => typeof value === 'string' && value.trim().length > 0);
    if (typeof fakeTranscriptLog === 'string' && (await fileExists(fakeTranscriptLog))) {
        return fakeTranscriptLog;
    }

    const resolved = resolveTranscriptPath(params);
    if (resolved && (await fileExists(resolved))) {
        return resolved;
    }

    return resolved;
}

function resolveClaudeTranscriptPath(projectDir: string, remoteSessionId: string): string {
    if (!remoteSessionId || remoteSessionId.includes('/') || remoteSessionId.includes('\\')) {
        throw new Error(`Invalid remoteSessionId for Claude handoff: ${remoteSessionId}`);
    }
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
}>): Promise<'absent' | 'identical'> {
    await assertExistingClaudeProjectParentsAreSafe(params);

    let entry;
    try {
        entry = await lstat(params.transcriptPath);
    } catch (error) {
        if (readErrorCode(error) === 'ENOENT') {
            return 'absent';
        }
        throw targetIdentityConflict();
    }
    if (!entry.isFile()) {
        throw targetIdentityConflict();
    }

    let existingTranscript: Buffer;
    try {
        existingTranscript = await readFile(params.transcriptPath);
    } catch {
        throw targetIdentityConflict();
    }

    let entryAfterRead;
    try {
        entryAfterRead = await lstat(params.transcriptPath);
    } catch {
        throw targetIdentityConflict();
    }
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
}>): Promise<void> {
    // The configured Claude directory is the caller-selected trust root and may itself be a
    // deliberate symlink. Descendants are native handoff-owned paths and must be real directories.
    const configRoot = resolve(params.configDir);
    const resolvedProjectDir = resolve(params.projectDir);
    const projectRelativePath = relative(configRoot, resolvedProjectDir);
    if (
        projectRelativePath === '..'
        || projectRelativePath.startsWith(`..${sep}`)
        || isAbsolute(projectRelativePath)
    ) {
        throw targetIdentityConflict();
    }

    let currentPath = configRoot;
    for (const segment of projectRelativePath.split(sep)) {
        if (!segment) continue;
        currentPath = join(currentPath, segment);
        try {
            const entry = await lstat(currentPath);
            if (!entry.isDirectory()) {
                throw targetIdentityConflict();
            }
        } catch (error) {
            if (error instanceof PluginError) {
                throw error;
            }
            if (readErrorCode(error) === 'ENOENT') {
                return;
            }
            throw targetIdentityConflict();
        }
    }
}

async function createClaudeTranscriptIfAbsent(params: Readonly<{
    configDir: string;
    projectDir: string;
    transcriptPath: string;
    transcript: Buffer;
}>): Promise<void> {
    const targetState = await preflightClaudeTranscriptTarget(params);
    if (targetState === 'identical') {
        return;
    }

    await mkdir(params.projectDir, { recursive: true });
    await assertExistingClaudeProjectParentsAreSafe(params);
    try {
        await writeFile(params.transcriptPath, params.transcript, { flag: 'wx' });
    } catch (error) {
        const racedTargetState = await preflightClaudeTranscriptTarget(params);
        if (racedTargetState === 'identical') {
            return;
        }
        throw error;
    }
}

export async function exportClaudeSessionBundle(params: Readonly<{
    metadata: Record<string, unknown>;
    remoteSessionId: string;
    env: NodeJS.ProcessEnv;
}>): Promise<ClaudeSessionBundle> {
    const transcriptPath = await resolveReadableTranscriptPath(params);
    const transcript = await readFile(transcriptPath, 'utf8');
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
    sessionStorageMode?: 'direct' | 'persisted';
}>): Promise<ImportedClaudeSessionHandoffBundle> {
    const bundle = ClaudeSessionBundleSchema.parse(params.bundle);
    const explicitClaudeConfigDir = resolveClaudeConfigDirOverride(params.env);
    const resolvedClaudeConfigDir = explicitClaudeConfigDir ?? join(homedir(), '.claude');
    const projectId = resolveClaudeProjectId(params.targetPath);
    const projectDir = getClaudeProjectPath(params.targetPath, resolvedClaudeConfigDir);
    const transcriptPath = resolveClaudeTranscriptPath(projectDir, bundle.remoteSessionId);

    const transcript = Buffer.from(bundle.transcriptBase64, 'base64');
    await createClaudeTranscriptIfAbsent({
        configDir: resolvedClaudeConfigDir,
        projectDir,
        transcriptPath,
        transcript,
    });

    return {
        remoteSessionId: bundle.remoteSessionId,
        directSource: {
            kind: 'claudeConfig',
            configDir: resolvedClaudeConfigDir,
            projectId,
        },
        resume: {
            directory: params.targetPath,
            agent: 'claude',
            resume: bundle.remoteSessionId,
            environmentVariables: {
                CLAUDE_CONFIG_DIR: resolvedClaudeConfigDir,
            },
            transcriptStorage: params.sessionStorageMode === 'persisted' ? 'persisted' : 'direct',
            approvedNewDirectoryCreation: true,
        },
    };
}
