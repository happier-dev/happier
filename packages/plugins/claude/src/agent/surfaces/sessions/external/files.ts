import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExternalSessionsSource } from '@happier-dev/plugin-sdk/sessions';

import { resolveClaudeConfigDir } from './source.js';

export type ResolvedClaudeJsonlSessionFile = Readonly<{
    filePath: string;
    fileRelPath: string;
    projectId: string;
}>;

export type DiscoveredClaudeJsonlSession = Readonly<{
    remoteSessionId: string;
    projectId: string;
    filePath: string;
    updatedAtMs: number;
}>;

export function isSafeClaudeJsonlPathSegment(value: string): boolean {
    if (!value) return false;
    if (value.includes('/') || value.includes('\\')) return false;
    return value !== '.' && value !== '..';
}

function resolvePreferredProjectId(source: ExternalSessionsSource): string | null {
    if (source.kind !== 'claudeConfig') return null;
    const projectId = typeof source.projectId === 'string' ? source.projectId.trim() : '';
    return isSafeClaudeJsonlPathSegment(projectId) ? projectId : null;
}

export async function resolveClaudeJsonlSessionFile(params: Readonly<{
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
    remoteSessionId: string;
}>): Promise<ResolvedClaudeJsonlSessionFile | null> {
    const remoteSessionId = String(params.remoteSessionId ?? '').trim();
    if (!isSafeClaudeJsonlPathSegment(remoteSessionId)) return null;

    const configDir = resolveClaudeConfigDir({ source: params.source, env: params.env });
    const projectsDir = join(configDir, 'projects');
    const preferredProjectId = resolvePreferredProjectId(params.source);

    const resolveInProject = async (projectId: string): Promise<ResolvedClaudeJsonlSessionFile | null> => {
        if (!isSafeClaudeJsonlPathSegment(projectId)) return null;
        const filePath = join(projectsDir, projectId, `${remoteSessionId}.jsonl`);
        try {
            const entry = await stat(filePath);
            if (!entry.isFile()) return null;
            return {
                filePath,
                fileRelPath: join('projects', projectId, `${remoteSessionId}.jsonl`).replace(/\\/g, '/'),
                projectId,
            };
        } catch {
            return null;
        }
    };

    if (preferredProjectId) {
        const resolved = await resolveInProject(preferredProjectId);
        if (resolved) return resolved;
    }

    const projectEntries = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    let newest: Readonly<{ resolved: ResolvedClaudeJsonlSessionFile; updatedAtMs: number }> | null = null;
    for (const entry of projectEntries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const projectId = typeof entry.name === 'string' ? entry.name : String(entry.name);
        const resolved = await resolveInProject(projectId);
        if (!resolved) continue;
        try {
            const file = await stat(resolved.filePath);
            const updatedAtMs = Math.trunc(file.mtimeMs);
            if (!newest || updatedAtMs > newest.updatedAtMs) {
                newest = { resolved, updatedAtMs };
            }
        } catch {
            continue;
        }
    }
    return newest?.resolved ?? null;
}

export async function findClaudeJsonlSessionsById(params: Readonly<{
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
    remoteSessionId: string;
}>): Promise<readonly DiscoveredClaudeJsonlSession[]> {
    const remoteSessionId = String(params.remoteSessionId ?? '').trim();
    if (!isSafeClaudeJsonlPathSegment(remoteSessionId)) return [];

    const configDir = resolveClaudeConfigDir({ source: params.source, env: params.env });
    const projectsDir = join(configDir, 'projects');
    const preferredProjectId = resolvePreferredProjectId(params.source);

    const resolveInProject = async (projectId: string): Promise<DiscoveredClaudeJsonlSession | null> => {
        if (!isSafeClaudeJsonlPathSegment(projectId)) return null;
        const filePath = join(projectsDir, projectId, `${remoteSessionId}.jsonl`);
        try {
            const file = await stat(filePath);
            if (!file.isFile()) return null;
            return {
                remoteSessionId,
                projectId,
                filePath,
                updatedAtMs: Math.trunc(file.mtimeMs),
            };
        } catch {
            return null;
        }
    };

    if (preferredProjectId) {
        const resolved = await resolveInProject(preferredProjectId);
        return resolved ? [resolved] : [];
    }

    const projectEntries = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    const matches: DiscoveredClaudeJsonlSession[] = [];
    for (const entry of projectEntries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const projectId = typeof entry.name === 'string' ? entry.name : String(entry.name);
        const resolved = await resolveInProject(projectId);
        if (resolved) matches.push(resolved);
    }

    return matches.sort(
        (a, b) =>
            b.updatedAtMs - a.updatedAtMs
            || a.projectId.localeCompare(b.projectId),
    );
}

export async function discoverClaudeJsonlSessions(params: Readonly<{
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
}>): Promise<readonly DiscoveredClaudeJsonlSession[]> {
    const configDir = resolveClaudeConfigDir({ source: params.source, env: params.env });
    const projectsDir = join(configDir, 'projects');
    const projectEntries = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    const sessions: DiscoveredClaudeJsonlSession[] = [];

    for (const projectEntry of projectEntries) {
        if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) continue;
        const projectId = typeof projectEntry.name === 'string' ? projectEntry.name : String(projectEntry.name);
        if (!isSafeClaudeJsonlPathSegment(projectId)) continue;
        const projectPath = join(projectsDir, projectId);
        const sessionEntries = await readdir(projectPath, { withFileTypes: true }).catch(() => []);
        for (const sessionEntry of sessionEntries) {
            if (!sessionEntry.isFile() || sessionEntry.isSymbolicLink()) continue;
            const name = typeof sessionEntry.name === 'string' ? sessionEntry.name : String(sessionEntry.name);
            if (!name.endsWith('.jsonl')) continue;
            const remoteSessionId = name.slice(0, -'.jsonl'.length);
            if (!isSafeClaudeJsonlPathSegment(remoteSessionId)) continue;
            const filePath = join(projectPath, name);
            try {
                const file = await stat(filePath);
                if (!file.isFile()) continue;
                sessions.push({
                    remoteSessionId,
                    projectId,
                    filePath,
                    updatedAtMs: Math.trunc(file.mtimeMs),
                });
            } catch {
                continue;
            }
        }
    }

    return sessions.sort(
        (a, b) =>
            b.updatedAtMs - a.updatedAtMs
            || a.remoteSessionId.localeCompare(b.remoteSessionId)
            || a.projectId.localeCompare(b.projectId),
    );
}
