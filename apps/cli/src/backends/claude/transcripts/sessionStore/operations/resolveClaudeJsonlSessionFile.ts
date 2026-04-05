import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { DirectSessionsSource } from '@happier-dev/protocol';

import { resolveClaudeConfigDir } from '../../../directSessions/resolveClaudeConfigDir';

export type ResolvedClaudeJsonlSessionFile = Readonly<{
    filePath: string;
    fileRelPath: string;
    projectId: string;
}>;

function isSafePathSegment(value: string): boolean {
    if (!value) return false;
    if (value.includes('/') || value.includes('\\')) return false;
    if (value === '.' || value === '..') return false;
    return true;
}

function resolvePreferredProjectId(source: DirectSessionsSource): string | null {
    if (source.kind !== 'claudeConfig') return null;
    const raw = typeof source.projectId === 'string' ? source.projectId.trim() : '';
    if (!raw) return null;
    return isSafePathSegment(raw) ? raw : null;
}

export async function resolveClaudeJsonlSessionFile(params: Readonly<{
    source: DirectSessionsSource;
    env?: NodeJS.ProcessEnv;
    remoteSessionId: string;
}>): Promise<ResolvedClaudeJsonlSessionFile | null> {
    const env = params.env ?? process.env;
    const remoteSessionId = String(params.remoteSessionId ?? '').trim();
    if (!isSafePathSegment(remoteSessionId)) return null;

    const configDir = resolveClaudeConfigDir({ source: params.source, env });
    const projectsDir = join(configDir, 'projects');
    const preferredProjectId = resolvePreferredProjectId(params.source);

    const resolveInProject = async (projectId: string): Promise<ResolvedClaudeJsonlSessionFile | null> => {
        if (!isSafePathSegment(projectId)) return null;
        const fileRelPath = join('projects', projectId, `${remoteSessionId}.jsonl`).replace(/\\/g, '/');
        const filePath = join(projectsDir, projectId, `${remoteSessionId}.jsonl`);
        try {
            const entry = await stat(filePath);
            if (!entry.isFile()) return null;
            return { filePath, fileRelPath, projectId };
        } catch {
            return null;
        }
    };

    if (preferredProjectId) {
        const resolved = await resolveInProject(preferredProjectId);
        if (resolved) return resolved;
    }

    const projectEntries = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    let best: { resolved: ResolvedClaudeJsonlSessionFile; mtimeMs: number } | null = null;
    for (const entry of projectEntries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const projectId = typeof entry.name === 'string' ? entry.name : String(entry.name);
        if (!isSafePathSegment(projectId)) continue;
        const candidate = await resolveInProject(projectId);
        if (!candidate) continue;
        try {
            const fileEntry = await stat(candidate.filePath);
            const mtimeMs = Math.trunc(fileEntry.mtimeMs);
            if (!best || mtimeMs > best.mtimeMs) {
                best = { resolved: candidate, mtimeMs };
            }
        } catch {
            continue;
        }
    }

    return best?.resolved ?? null;
}
