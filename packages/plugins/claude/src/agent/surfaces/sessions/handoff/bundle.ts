import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
    const externalSession = params.metadata.externalSessionV1;
    if (!externalSession || typeof externalSession !== 'object' || Array.isArray(externalSession)) {
        return null;
    }
    const source = (externalSession as { source?: unknown }).source;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        return null;
    }
    const kind = typeof (source as { kind?: unknown }).kind === 'string' ? String((source as { kind?: string }).kind) : '';
    if (kind !== 'claudeConfig') {
        return null;
    }
    const configDir = typeof (source as { configDir?: unknown }).configDir === 'string'
        ? String((source as { configDir?: string }).configDir).trim()
        : '';
    const projectId = typeof (source as { projectId?: unknown }).projectId === 'string'
        ? String((source as { projectId?: string }).projectId).trim()
        : '';
    if (!configDir || !projectId) {
        return null;
    }
    return join(configDir, 'projects', projectId, `${params.remoteSessionId}.jsonl`);
}

function resolveTranscriptPath(params: Readonly<{
    metadata: Record<string, unknown>;
    remoteSessionId: string;
    env: NodeJS.ProcessEnv;
}>): string {
    const externalSessionTranscriptPath = resolveExternalSessionSourceTranscriptPath(params);
    if (externalSessionTranscriptPath) return externalSessionTranscriptPath;

    const explicit = typeof params.metadata.claudeTranscriptPath === 'string' ? params.metadata.claudeTranscriptPath.trim() : '';
    if (explicit) return explicit;

    const workingDirectory = typeof params.metadata.path === 'string' ? params.metadata.path.trim() : '';
    if (!workingDirectory) {
        throw new Error('Missing Claude working directory for handoff export');
    }

    return join(getClaudeProjectPath(workingDirectory, resolveClaudeConfigDirOverride(params.env)), `${params.remoteSessionId}.jsonl`);
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
    const candidatePaths = [
        resolveExternalSessionSourceTranscriptPath(params),
        typeof params.metadata.claudeTranscriptPath === 'string' ? params.metadata.claudeTranscriptPath.trim() : '',
    ]
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
    await mkdir(projectDir, { recursive: true });

    const transcript = Buffer.from(bundle.transcriptBase64, 'base64').toString('utf8');
    await writeFile(transcriptPath, transcript, 'utf8');

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
