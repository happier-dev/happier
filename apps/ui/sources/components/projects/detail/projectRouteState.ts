import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';

export type ProjectRouteSegment = 'details' | 'files' | 'git';

export function readProjectRouteStringParam(raw: string | string[] | undefined): string | null {
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (Array.isArray(raw)) {
        const first = raw.find((value) => typeof value === 'string' && value.trim().length > 0);
        return typeof first === 'string' ? first.trim() : null;
    }
    return null;
}

export function readProjectRouteActiveRootPath(
    rawActiveRootPath: string | string[] | undefined,
    defaultRootPath: string,
    persistedActiveRootPath?: string | null,
): string {
    return readProjectRouteStringParam(rawActiveRootPath)
        ?? readProjectRouteStringParam(persistedActiveRootPath ?? undefined)
        ?? defaultRootPath;
}

export function resolveProjectRouteActiveRootParam(
    activeRootPath: string,
    defaultRootPath: string,
): string | undefined {
    return activeRootPath === defaultRootPath ? undefined : activeRootPath;
}

export function buildProjectRouteHref(input: Readonly<{
    workspaceRefId: string;
    segment?: ProjectRouteSegment;
    activeRootPath: string;
    defaultRootPath: string;
    showWorktrees?: boolean;
}>): string {
    const basePath = input.segment
        ? `/projects/${encodeURIComponent(input.workspaceRefId)}/${input.segment}`
        : `/projects/${encodeURIComponent(input.workspaceRefId)}`;
    const activeRootParam = resolveProjectRouteActiveRootParam(input.activeRootPath, input.defaultRootPath);
    const queryParams = new URLSearchParams();
    if (activeRootParam) {
        queryParams.set('activeRootPath', activeRootParam);
    }
    if (input.showWorktrees === true) {
        queryParams.set('showWorktrees', '1');
    }
    const query = queryParams.toString();
    if (!query) return basePath;
    return `${basePath}?${query}`;
}

export function resolveProjectRouteSegment(
    activeTabId: string | null | undefined,
    persistedSegment?: string | null,
): ProjectRouteSegment {
    if (activeTabId === 'git' || activeTabId === 'files') {
        return activeTabId;
    }
    if (persistedSegment === 'git' || persistedSegment === 'files' || persistedSegment === 'details') {
        return persistedSegment;
    }
    return 'files';
}

function resolvePathBasename(rawPath: string): string | null {
    const trimmed = String(rawPath ?? '').trim().replace(/[\\/]+$/, '');
    if (!trimmed) return null;
    const parts = trimmed.split(/[/\\]/g).filter(Boolean);
    return parts.at(-1) ?? null;
}

export function resolveProjectRouteHeaderTitle(workspaceRef: WorkspaceRefV1, activeRootPath: string): string {
    const baseTitle = resolveWorkspaceRefDisplayName(workspaceRef);
    if (activeRootPath === workspaceRef.rootPath) {
        return baseTitle;
    }

    const worktreeLabel = resolvePathBasename(activeRootPath);
    if (!worktreeLabel) {
        return baseTitle;
    }
    return `${baseTitle} · ${worktreeLabel}`;
}
