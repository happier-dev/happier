import { existsSync } from 'fs';
import { join } from 'path';

import type {
    ScmWorkingEntry,
    ScmWorkingSnapshot,
} from '@happier-dev/protocol';
import type { ScmRepoDetection } from '../../types';
import { runScmCommand } from '../../runtime';

import { createSaplingCapabilities } from './capabilities';
import { parseSaplingStatusLine } from './statusParser';

export async function detectSaplingRepo(input: { cwd: string }): Promise<ScmRepoDetection> {
    const root = await runScmCommand({
        bin: 'sl',
        cwd: input.cwd,
        args: ['root'],
        timeoutMs: 5000,
    });
    if (!root.success) {
        return {
            isRepo: false,
            rootPath: null,
            mode: null,
        };
    }

    const rootPath = root.stdout.trim();
    const mode = existsSync(join(rootPath, '.sl')) ? '.sl' : '.git';
    return {
        isRepo: true,
        rootPath,
        mode,
    };
}

export async function getSaplingHead(cwd: string): Promise<string | null> {
    const current = await runScmCommand({
        bin: 'sl',
        cwd,
        args: ['whereami'],
        timeoutMs: 5000,
    });
    if (!current.success) return null;
    const value = current.stdout.trim();
    if (!value || /^0+$/.test(value)) return null;
    return value;
}

function parseSaplingResolveList(rawOutput: string): Set<string> {
    const unresolved = new Set<string>();
    for (const rawLine of rawOutput.split(/\r?\n/g)) {
        const line = rawLine.trimEnd();
        if (!line.startsWith('U ')) continue;
        const path = line.slice(2);
        if (!path) continue;
        unresolved.add(path);
    }
    return unresolved;
}

function buildSnapshotEntries(
    statusEntries: ReturnType<typeof parseSaplingStatusLine>[],
    unresolvedPaths: Set<string>
): ScmWorkingEntry[] {
    const entriesByPath = new Map<string, ScmWorkingEntry>();
    for (const statusEntry of statusEntries) {
        if (!statusEntry) continue;
        const isConflicted = unresolvedPaths.has(statusEntry.path);
        entriesByPath.set(statusEntry.path, {
            path: statusEntry.path,
            previousPath: null,
            kind: isConflicted ? 'conflicted' : statusEntry.kind,
            includeStatus: ' ',
            pendingStatus: isConflicted ? 'U' : statusEntry.pendingStatus,
            hasIncludedDelta: false,
            hasPendingDelta: true,
            stats: {
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
                isBinary: false,
            },
        });
    }

    for (const path of unresolvedPaths) {
        if (entriesByPath.has(path)) continue;
        entriesByPath.set(path, {
            path,
            previousPath: null,
            kind: 'conflicted',
            includeStatus: ' ',
            pendingStatus: 'U',
            hasIncludedDelta: false,
            hasPendingDelta: true,
            stats: {
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
                isBinary: false,
            },
        });
    }

    return Array.from(entriesByPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}

export async function getSaplingSnapshot(input: {
    cwd: string;
    projectKey: string;
    detection: ScmRepoDetection;
}): Promise<ScmWorkingSnapshot> {
    const status = await runScmCommand({
        bin: 'sl',
        cwd: input.cwd,
        args: ['status', '--root-relative'],
        timeoutMs: 10_000,
    });
    if (!status.success) {
        const message = status.stderr.trim() || 'Failed to read sapling status';
        throw new Error(message);
    }
    const statusEntries = status.stdout
        .split(/\r?\n/g)
        .map(parseSaplingStatusLine)
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    const resolveList = await runScmCommand({
        bin: 'sl',
        cwd: input.cwd,
        args: ['resolve', '--list'],
        timeoutMs: 5000,
    });
    const unresolvedPaths = resolveList.success ? parseSaplingResolveList(resolveList.stdout) : new Set<string>();
    const entries = buildSnapshotEntries(statusEntries, unresolvedPaths);
    const head = await getSaplingHead(input.cwd);

    return {
        projectKey: input.projectKey,
        fetchedAt: Date.now(),
        repo: {
            isRepo: true,
            rootPath: input.detection.rootPath,
            backendId: 'sapling',
            mode: input.detection.mode,
        },
        capabilities: createSaplingCapabilities(),
        branch: {
            head,
            upstream: null,
            ahead: 0,
            behind: 0,
            detached: false,
        },
        hasConflicts: unresolvedPaths.size > 0 || entries.some((entry) => entry.kind === 'conflicted'),
        entries,
        totals: {
            includedFiles: 0,
            pendingFiles: entries.length,
            untrackedFiles: entries.filter((entry) => entry.kind === 'untracked').length,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
    };
}
