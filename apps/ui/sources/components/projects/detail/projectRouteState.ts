import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { parseSessionFileDeepLinkAnchor, serializeFileTargetAnchor, type FileTargetAnchor } from '@/utils/url/sessionFileDeepLink';
import type { ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import {
    migrateProjectRouteSegmentToMobileSurface,
    resolveProjectMobileSurfaceIntent,
    resolveProjectLegacyRouteSegmentFromState,
    resolveProjectRoutePathForSurface,
    type ProjectMobileSurface,
} from '@/components/workspaceCockpit/project/projectCockpitState';

export type ProjectFileRouteTarget = Readonly<{ kind: 'file'; path: string; anchor?: FileTargetAnchor; anchorSource?: ReviewCommentSource }>;

export function readProjectFileRouteTarget(params: Readonly<Record<string, unknown>>): ProjectFileRouteTarget | null {
    const path = readProjectRouteStringParam(typeof params.initialFile === 'string' || Array.isArray(params.initialFile) ? params.initialFile : undefined);
    if (!path) return null;
    const parsed = parseSessionFileDeepLinkAnchor({ ...params, path });
    return { kind: 'file', path, ...(parsed ? { anchor: parsed.anchor } : {}), ...(parsed?.source === 'diff' ? { anchorSource: parsed.source } : {}) };
}

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

export function resolveProjectCockpitIndexRedirectHref(input: Readonly<{
    workspaceRefId: string;
    surface: ProjectMobileSurface;
    explicitMobileSurfaceHint: string | null;
    requestedRootPath: string | null;
    requestedWorktreeId: string | null;
    activeRootPath: string;
    defaultRootPath: string;
    activeWorktreeId: string | null;
}>): string | null {
    const selectionQuery = resolveProjectRouteSelectionQuery(input);
    const canonicalHref = resolveProjectRoutePathForSurface({
        workspaceRefId: input.workspaceRefId,
        surface: input.surface,
        ...selectionQuery,
    });
    const indexPathname = resolveProjectRoutePathForSurface({
        workspaceRefId: input.workspaceRefId,
        surface: 'overview',
    }).split('?', 1)[0];
    const surfaceNeedsRedirect = canonicalHref.split('?', 1)[0] !== indexPathname
        || (input.surface !== 'overview' && input.explicitMobileSurfaceHint !== input.surface);
    const shouldCanonicalize = surfaceNeedsRedirect
        || input.requestedRootPath !== input.activeRootPath
        || (input.requestedWorktreeId ?? PROJECT_ROUTE_ROOT_SENTINEL) !== (selectionQuery.rawWorktreeId ?? PROJECT_ROUTE_ROOT_SENTINEL);
    return shouldCanonicalize ? canonicalHref : null;
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
    initialResource?: ProjectFileRouteTarget | Readonly<{ kind: 'commit'; sha: string }>;
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
    if (input.initialResource) {
        queryParams.set(input.initialResource.kind === 'file' ? 'initialFile' : 'initialCommit',
            input.initialResource.kind === 'file' ? input.initialResource.path : input.initialResource.sha);
        if (input.initialResource.kind === 'file' && input.initialResource.anchor) {
            for (const [key, value] of Object.entries(serializeFileTargetAnchor(input.initialResource.anchor, input.initialResource.anchorSource))) queryParams.set(key, value);
        }
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

/**
 * Canonical policy for opening an existing project from a list-like surface.
 * It preserves the last project surface and worktree on phones; wider layouts
 * keep the project root as their stable entry point.
 */
export function resolveProjectOpenHref(input: Readonly<{
    workspaceRef: WorkspaceRefV1;
    deviceType: 'phone' | 'tablet';
    cockpitEnabled: boolean;
    rememberedRightTabId?: string | null;
    persistedMobileSurface?: string | null;
    persistedActiveRootPath?: string | null;
    persistedWorktreeId?: string | null;
}>): string {
    if (input.deviceType !== 'phone') {
        return `/projects/${encodeURIComponent(input.workspaceRef.id)}`;
    }

    const activeRootPath = readProjectRouteStringParam(input.persistedActiveRootPath ?? undefined)
        ?? input.workspaceRef.rootPath;
    const activeWorktreeId = readProjectRouteStringParam(input.persistedWorktreeId ?? undefined);
    if (input.cockpitEnabled) {
        return resolveProjectRoutePathForSurface({
            workspaceRefId: input.workspaceRef.id,
            surface: resolveProjectMobileSurfaceIntent({
                routeKind: 'index',
                activeRightTabId: input.rememberedRightTabId,
                persistedSurface: input.persistedMobileSurface,
            }),
            ...resolveProjectRouteSelectionQuery({
                activeRootPath,
                defaultRootPath: input.workspaceRef.rootPath,
                activeWorktreeId,
            }),
        });
    }

    return buildProjectRouteHref({
        workspaceRefId: input.workspaceRef.id,
        segment: resolveProjectRouteSegment(
            input.rememberedRightTabId,
            input.persistedMobileSurface,
        ),
        activeRootPath,
        defaultRootPath: input.workspaceRef.rootPath,
        activeWorktreeId,
    });
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
