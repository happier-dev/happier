import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import {
    migrateProjectRouteSegmentToMobileSurface,
    resolveProjectLegacyRouteSegmentFromState,
    type ProjectMobileSurface,
} from '@/components/workspaceCockpit/project/projectCockpitState';

export type ProjectRouteSegment = 'details' | 'files' | 'git';
export const PROJECT_ROUTE_ROOT_SENTINEL = '@root';
export const PROJECT_ROUTE_WORKTREE_ID_QUERY_PARAM = 'worktreeId';
export type ProjectDetailsSourceSurface = Exclude<ProjectMobileSurface, 'overview' | 'tabs'>;

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

export type ProjectRouteWorktreeSelection = Readonly<{
    requestedRootPath: string;
    requestedWorktreeId: string | null;
}>;

function normalizePersistedProjectWorktreeId(rawWorktreeId: string | null): string | null {
    if (rawWorktreeId === PROJECT_ROUTE_ROOT_SENTINEL) {
        return null;
    }
    return rawWorktreeId;
}

export function readProjectRouteWorktreeSelection(input: Readonly<{
    rawWorktreeId?: string | string[] | undefined;
    rawLegacyActiveRootPath?: string | string[] | undefined;
    defaultRootPath: string;
    persistedActiveRootPath?: string | null;
    persistedWorktreeId?: string | null;
}>): ProjectRouteWorktreeSelection {
    const routeWorktreeId = readProjectRouteStringParam(input.rawWorktreeId);
    const legacyRoutePath = readProjectRouteStringParam(input.rawLegacyActiveRootPath);
    const persistedActiveRootPath = readProjectRouteStringParam(input.persistedActiveRootPath ?? undefined);
    const persistedWorktreeId = normalizePersistedProjectWorktreeId(
        readProjectRouteStringParam(input.persistedWorktreeId ?? undefined),
    );

    if (routeWorktreeId === PROJECT_ROUTE_ROOT_SENTINEL) {
        return {
            requestedRootPath: input.defaultRootPath,
            requestedWorktreeId: null,
        };
    }
    if (routeWorktreeId) {
        if (
            persistedWorktreeId
            && persistedActiveRootPath
            && routeWorktreeId === persistedWorktreeId
            && persistedActiveRootPath !== input.defaultRootPath
        ) {
            return {
                requestedRootPath: persistedActiveRootPath,
                requestedWorktreeId: routeWorktreeId,
            };
        }
        if (legacyRoutePath && legacyRoutePath !== input.defaultRootPath) {
            return {
                requestedRootPath: legacyRoutePath,
                requestedWorktreeId: routeWorktreeId,
            };
        }
        return {
            requestedRootPath: input.defaultRootPath,
            requestedWorktreeId: routeWorktreeId,
        };
    }
    if (legacyRoutePath) {
        return {
            requestedRootPath: legacyRoutePath,
            requestedWorktreeId: persistedActiveRootPath === legacyRoutePath ? persistedWorktreeId : null,
        };
    }
    if (persistedActiveRootPath) {
        return {
            requestedRootPath: persistedActiveRootPath,
            requestedWorktreeId: persistedWorktreeId,
        };
    }
    return {
        requestedRootPath: input.defaultRootPath,
        requestedWorktreeId: null,
    };
}

export function resolveProjectRouteActiveRootParam(
    activeRootPath: string,
    defaultRootPath: string,
    activeWorktreeId?: string | null,
): string | undefined {
    if (activeRootPath === defaultRootPath) {
        return PROJECT_ROUTE_ROOT_SENTINEL;
    }
    const trimmedWorktreeId = readProjectRouteStringParam(activeWorktreeId ?? undefined);
    return trimmedWorktreeId ?? undefined;
}

export function resolveProjectRouteSelectionQuery(input: Readonly<{
    activeRootPath: string;
    defaultRootPath: string;
    activeWorktreeId?: string | null;
}>): Readonly<{
    rawWorktreeId: string | null;
    rawActiveRootPath: string | null;
}> {
    const rawWorktreeId = resolveProjectRouteActiveRootParam(
        input.activeRootPath,
        input.defaultRootPath,
        input.activeWorktreeId,
    ) ?? null;
    if (rawWorktreeId) {
        return {
            rawWorktreeId,
            rawActiveRootPath: null,
        };
    }
    const trimmedActiveRootPath = readProjectRouteStringParam(input.activeRootPath);
    if (trimmedActiveRootPath && trimmedActiveRootPath !== input.defaultRootPath) {
        return {
            rawWorktreeId: null,
            rawActiveRootPath: trimmedActiveRootPath,
        };
    }
    return {
        rawWorktreeId: null,
        rawActiveRootPath: null,
    };
}

export function normalizeProjectDetailsSourceSurface(value: unknown): ProjectDetailsSourceSurface | null {
    const raw = Array.isArray(value) ? value[0] : value;
    const normalized = typeof raw === 'string' ? raw.trim() : '';
    if (
        normalized === 'browse'
        || normalized === 'git'
        || normalized === 'terminal'
        || normalized === 'browser'
        || normalized === 'services'
    ) {
        return normalized;
    }
    return null;
}

export function buildProjectRouteHref(input: Readonly<{
    workspaceRefId: string;
    segment?: ProjectRouteSegment;
    activeRootPath: string;
    defaultRootPath: string;
    activeWorktreeId?: string | null;
    showWorktrees?: boolean;
    sourceSurface?: ProjectDetailsSourceSurface | null;
}>): string {
    const basePath = input.segment
        ? `/projects/${encodeURIComponent(input.workspaceRefId)}/${input.segment}`
        : `/projects/${encodeURIComponent(input.workspaceRefId)}`;
    const activeRootParam = resolveProjectRouteActiveRootParam(
        input.activeRootPath,
        input.defaultRootPath,
        input.activeWorktreeId,
    );
    const queryParams = new URLSearchParams();
    if (activeRootParam) {
        queryParams.set(PROJECT_ROUTE_WORKTREE_ID_QUERY_PARAM, activeRootParam);
    }
    if (input.showWorktrees === true) {
        queryParams.set('showWorktrees', '1');
    }
    if (input.segment === 'details' && input.sourceSurface) {
        queryParams.set('sourceSurface', input.sourceSurface);
    }
    const query = queryParams.toString();
    if (!query) return basePath;
    return `${basePath}?${query}`;
}

export function replaceProjectRouteSelection(input: Readonly<{
    router: { replace: (href: string) => void };
    workspaceRefId: string;
    segment?: ProjectRouteSegment;
    activeRootPath: string;
    defaultRootPath: string;
    activeWorktreeId?: string | null;
    showWorktrees?: boolean;
}>): void {
    input.router.replace(buildProjectRouteHref({
        workspaceRefId: input.workspaceRefId,
        segment: input.segment,
        activeRootPath: input.activeRootPath,
        defaultRootPath: input.defaultRootPath,
        activeWorktreeId: input.activeWorktreeId,
        showWorktrees: input.showWorktrees,
    }));
}

export { migrateProjectRouteSegmentToMobileSurface, type ProjectMobileSurface };

export function resolveProjectRouteSegment(
    activeTabId: string | null | undefined,
    persistedSegment?: string | null,
): ProjectRouteSegment {
    return resolveProjectLegacyRouteSegmentFromState(activeTabId, readProjectRouteStringParam(persistedSegment ?? undefined));
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
