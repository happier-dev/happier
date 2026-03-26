import {
    machineFilesystemListDirectory,
    machineFilesystemListRoots,
} from '@/sync/ops/machineFileBrowser';

import { sortDirectoryEntries } from './sortDirectoryEntries';
import { warmInFlight } from './warmInFlight';

export type MachineFileBrowserRoot = Readonly<{
    id: string;
    label: string;
    path: string;
}>;

export type MachineFileBrowserEntry = Readonly<{
    name: string;
    path: string;
    type: 'file' | 'directory';
    sizeBytes?: number;
    modifiedMs?: number;
}>;

type ListMachineFileBrowserRootsResult =
    | { ok: true; roots: MachineFileBrowserRoot[] }
    | { ok: false; error: string };

type ListMachineFileBrowserDirectoryEntriesResult =
    | { ok: true; entries: MachineFileBrowserEntry[]; truncated: boolean }
    | { ok: false; error: string };

type CachedDirectoryEntries = Readonly<{
    entries: MachineFileBrowserEntry[];
    truncated: boolean;
}>;

const rootsCache = new Map<string, MachineFileBrowserRoot[]>();
const directoryEntriesCache = new Map<string, CachedDirectoryEntries>();
const rootsWarmInFlight = new Map<string, Promise<ListMachineFileBrowserRootsResult>>();
const directoryWarmInFlight = new Map<string, Promise<ListMachineFileBrowserDirectoryEntriesResult>>();

function getRootsCacheKey(machineId: string, serverId?: string | null): string {
    return `${serverId ?? ''}:${machineId}`;
}

function getDirectoryCacheKey(machineId: string, directoryPath: string, includeFiles: boolean, serverId?: string | null): string {
    return `${serverId ?? ''}:${machineId}:${includeFiles ? 'all' : 'dirs'}:${directoryPath}`;
}

function readMachineIdFromRootsCacheKey(key: string): string {
    return key.split(':', 2)[1] ?? '';
}

function readMachineIdFromDirectoryCacheKey(key: string): string {
    return key.split(':', 3)[1] ?? '';
}

export function getCachedMachineFileBrowserRoots(input: { machineId: string; serverId?: string | null }): MachineFileBrowserRoot[] | null {
    const cached = rootsCache.get(getRootsCacheKey(input.machineId, input.serverId));
    return cached ? cached.slice() : null;
}

export function clearCachedMachineFileBrowserRoots(input: { machineId: string; serverId?: string | null }): void {
    if (typeof input.serverId === 'string' || input.serverId === null) {
        const key = getRootsCacheKey(input.machineId, input.serverId);
        rootsCache.delete(key);
        rootsWarmInFlight.delete(key);
        return;
    }
    for (const key of rootsCache.keys()) {
        if (readMachineIdFromRootsCacheKey(key) === input.machineId) {
            rootsCache.delete(key);
        }
    }
    for (const key of rootsWarmInFlight.keys()) {
        if (readMachineIdFromRootsCacheKey(key) === input.machineId) {
            rootsWarmInFlight.delete(key);
        }
    }
}

export function getCachedMachineFileBrowserEntries(input: {
    machineId: string;
    directoryPath: string;
    includeFiles?: boolean;
    serverId?: string | null;
}): MachineFileBrowserEntry[] | null {
    const key = getDirectoryCacheKey(input.machineId, input.directoryPath, input.includeFiles !== false, input.serverId);
    const cached = directoryEntriesCache.get(key);
    return cached ? cached.entries.slice() : null;
}

export function getCachedMachineFileBrowserDirectoryMetadata(input: {
    machineId: string;
    directoryPath: string;
    includeFiles?: boolean;
    serverId?: string | null;
}): Readonly<{ truncated: boolean }> | null {
    const key = getDirectoryCacheKey(input.machineId, input.directoryPath, input.includeFiles !== false, input.serverId);
    const cached = directoryEntriesCache.get(key);
    return cached ? { truncated: cached.truncated } : null;
}

export function clearCachedMachineFileBrowserEntries(input: {
    machineId: string;
    directoryPath?: string | null;
    serverId?: string | null;
}): void {
    const serverPrefix = typeof input.serverId === 'string' || input.serverId === null ? `${input.serverId ?? ''}:${input.machineId}:` : null;
    const directoryPath = typeof input.directoryPath === 'string' ? input.directoryPath : null;
    if (directoryPath != null) {
        for (const key of [...directoryEntriesCache.keys()]) {
            const matchesScope = serverPrefix ? key.startsWith(serverPrefix) : readMachineIdFromDirectoryCacheKey(key) === input.machineId;
            if (matchesScope && key.endsWith(`:${directoryPath}`)) {
                directoryEntriesCache.delete(key);
                directoryWarmInFlight.delete(key);
            }
        }
        return;
    }

    for (const key of directoryEntriesCache.keys()) {
        const matchesScope = serverPrefix ? key.startsWith(serverPrefix) : readMachineIdFromDirectoryCacheKey(key) === input.machineId;
        if (matchesScope) {
            directoryEntriesCache.delete(key);
        }
    }
    for (const key of directoryWarmInFlight.keys()) {
        const matchesScope = serverPrefix ? key.startsWith(serverPrefix) : readMachineIdFromDirectoryCacheKey(key) === input.machineId;
        if (matchesScope) {
            directoryWarmInFlight.delete(key);
        }
    }
}

function setCachedMachineFileBrowserRoots(input: {
    machineId: string;
    serverId?: string | null;
    roots: MachineFileBrowserRoot[];
}): void {
    rootsCache.set(getRootsCacheKey(input.machineId, input.serverId), input.roots.slice());
}

function setCachedMachineFileBrowserEntries(input: {
    machineId: string;
    directoryPath: string;
    includeFiles: boolean;
    serverId?: string | null;
    entries: MachineFileBrowserEntry[];
    truncated: boolean;
}): void {
    directoryEntriesCache.set(
        getDirectoryCacheKey(input.machineId, input.directoryPath, input.includeFiles, input.serverId),
        {
            entries: input.entries.slice(),
            truncated: input.truncated,
        },
    );
}

export async function listMachineFileBrowserRoots(input: {
    machineId: string;
    serverId?: string | null;
}): Promise<ListMachineFileBrowserRootsResult> {
    const response = await machineFilesystemListRoots(input.machineId, { serverId: input.serverId });
    if (!response.ok) {
        const error = typeof response.error === 'string' ? response.error.trim() : '';
        return { ok: false, error: error || 'unknown_error' };
    }

    const roots = response.roots
        .filter((root): root is MachineFileBrowserRoot => {
            return !!root
                && typeof root.id === 'string'
                && typeof root.label === 'string'
                && typeof root.path === 'string'
                && root.id.trim().length > 0
                && root.label.trim().length > 0
                && root.path.trim().length > 0;
        })
        .map((root) => ({
            id: root.id.trim(),
            label: root.label.trim(),
            path: root.path.trim(),
        }));

    setCachedMachineFileBrowserRoots({ machineId: input.machineId, serverId: input.serverId, roots });
    return { ok: true, roots };
}

export async function warmMachineFileBrowserRoots(input: {
    machineId: string;
    serverId?: string | null;
}): Promise<ListMachineFileBrowserRootsResult> {
    const cached = getCachedMachineFileBrowserRoots(input);
    if (cached) return { ok: true, roots: cached };

    const key = getRootsCacheKey(input.machineId, input.serverId);
    return await warmInFlight(rootsWarmInFlight, key, async () => await listMachineFileBrowserRoots(input));
}

export async function listMachineFileBrowserDirectoryEntries(input: {
        machineId: string;
        directoryPath: string;
        includeFiles: boolean;
        serverId?: string | null;
}): Promise<ListMachineFileBrowserDirectoryEntriesResult> {
    const response = await machineFilesystemListDirectory(input.machineId, {
        path: input.directoryPath,
        includeFiles: input.includeFiles,
    }, { serverId: input.serverId });

    if (!response.ok) {
        const error = typeof response.error === 'string' ? response.error.trim() : '';
        return { ok: false, error: error || 'unknown_error' };
    }

    const entries = sortDirectoryEntries(response.entries.flatMap((entry) => {
        if (!entry || typeof entry.name !== 'string' || typeof entry.path !== 'string') return [];
        const rawName = entry.name.trim();
        const rawPath = entry.path.trim();
        if (!rawName || !rawPath) return [];
        if (entry.type !== 'file' && entry.type !== 'directory') return [];
        return [{
            name: rawName,
            path: rawPath,
            type: entry.type,
            sizeBytes: typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size >= 0 ? Math.floor(entry.size) : undefined,
            modifiedMs: typeof entry.modified === 'number' && Number.isFinite(entry.modified) && entry.modified >= 0 ? Math.floor(entry.modified) : undefined,
        } satisfies MachineFileBrowserEntry];
    }));

    setCachedMachineFileBrowserEntries({
        machineId: input.machineId,
        serverId: input.serverId,
        directoryPath: input.directoryPath,
        includeFiles: input.includeFiles,
        entries,
        truncated: response.truncated === true,
    });
    return { ok: true, entries, truncated: response.truncated === true };
}

export async function warmMachineFileBrowserDirectoryCache(input: {
    machineId: string;
    directoryPath: string;
    includeFiles: boolean;
    serverId?: string | null;
}): Promise<ListMachineFileBrowserDirectoryEntriesResult> {
    const cachedEntries = getCachedMachineFileBrowserEntries(input);
    const cachedMetadata = getCachedMachineFileBrowserDirectoryMetadata(input);
    if (cachedEntries) {
        return { ok: true, entries: cachedEntries, truncated: cachedMetadata?.truncated === true };
    }

    const key = getDirectoryCacheKey(input.machineId, input.directoryPath, input.includeFiles, input.serverId);
    return await warmInFlight(directoryWarmInFlight, key, async () => await listMachineFileBrowserDirectoryEntries(input));
}
