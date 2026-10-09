import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { FILE_TARGET_ANCHOR_PARAM_KEYS, parseSessionFileDeepLinkAnchor, serializeFileTargetAnchor, type FileTargetAnchor } from '@/utils/url/sessionFileDeepLink';
import type { PaneDetailsStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { buildActiveDetailsRouteParams, parseSessionPaneUrlState, serializeSessionPaneUrlState,
    SESSION_PANE_URL_PARAM_KEYS, type SessionPaneUrlDetailsTarget } from '@/components/sessions/panes/url/sessionPaneUrlState';
import type { ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { StoredPluginUiNewSessionSeedOriginV1Schema, type PluginUiNewSessionSeedOriginV1 } from '@happier-dev/protocol/plugins/ui';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveWorkspaceRefByAddress } from '@/sync/domains/workspaces/workspaceRefs';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { readProjectWorkspaceRefs } from '@/sync/store/domains/projectAccountRows';

import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import {
    resolveProjectMobileSurfaceIntent,
    resolveProjectRoutePathForSurface,
    type ProjectPageV1,
    type ProjectRouteContext,
    type ProjectMobileSurface,
} from '@/components/workspaceCockpit/project/projectCockpitState';

export type ProjectFileRouteTarget = Readonly<{ kind: 'file'; path: string; anchor?: FileTargetAnchor; anchorSource?: ReviewCommentSource }>;

export function readProjectSelectedRouteResource(details: Pick<PaneDetailsStateView, 'isOpen' | 'tabs' | 'activeTabKey'> | null | undefined) {
    if (!details?.isOpen) return undefined;
    const resource = parseSessionPaneUrlState(buildActiveDetailsRouteParams(details.tabs, details.activeTabKey))?.details;
    return resource?.kind === 'file' || resource?.kind === 'commit' ? resource : undefined;
}

export function readProjectFileRouteTarget(params: Readonly<Record<string, unknown>>): ProjectFileRouteTarget | null {
    const raw = params.initialFile;
    const path = typeof raw === 'string' ? raw : Array.isArray(raw)
        ? raw.find((value): value is string => typeof value === 'string' && value.length > 0) : null;
    if (!path) return null;
    const parsed = parseSessionFileDeepLinkAnchor({ ...params, path });
    return { kind: 'file', path, ...(parsed ? { anchor: parsed.anchor } : {}), ...(parsed?.source === 'diff' ? { anchorSource: parsed.source } : {}) };
}

export { PROJECT_PAGES, type ProjectPageV1 } from '@/components/workspaceCockpit/project/projectCockpitState';
export type ProjectRouteSegment = ProjectPageV1;
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

/** Unlike the visual selection reader, an execution target cannot guess a root from a worktree id. */
export function readProjectRouteCheckoutRootPath(input: Parameters<typeof readProjectRouteWorktreeSelection>[0]): string | null {
    const selected = readProjectRouteWorktreeSelection(input);
    if (selected.requestedWorktreeId && selected.requestedRootPath === input.defaultRootPath) {
        const explicitRoot = readProjectRouteStringParam(input.rawLegacyActiveRootPath);
        const persistedRoot = readProjectRouteStringParam(input.persistedActiveRootPath ?? undefined);
        const persistedId = readProjectRouteStringParam(input.persistedWorktreeId ?? undefined);
        if (!explicitRoot && !(persistedRoot && persistedId === selected.requestedWorktreeId)) return null;
    }
    return selected.requestedRootPath;
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
    surface?: ProjectMobileSurface;
    activeRootPath: string;
    defaultRootPath: string;
    activeWorktreeId?: string | null;
    showWorktrees?: boolean;
    sourceSurface?: ProjectDetailsSourceSurface | null;
    initialResource?: ProjectFileRouteTarget | Readonly<{ kind: 'commit'; sha: string }> | null;
    /** A newly selected Details destination replaces the old Details and initial-resource intent. */
    details?: SessionPaneUrlDetailsTarget | null;
}> & ProjectRouteContext): string {
    const resourceParams: Record<string, string> = {};
    if (input.showWorktrees) resourceParams.showWorktrees = '1';
    const routeParams = { ...input.routeParams };
    if (input.showWorktrees === false) delete routeParams.showWorktrees;
    if (input.sourceSurface) resourceParams.sourceSurface = input.sourceSurface;
    if (input.initialResource !== undefined || input.details !== undefined) {
        delete routeParams.initialFile;
        delete routeParams.initialCommit;
        for (const key of FILE_TARGET_ANCHOR_PARAM_KEYS) delete routeParams[key];
    }
    if (input.details !== undefined) {
        for (const key of SESSION_PANE_URL_PARAM_KEYS) {
            if (key !== 'right' && key !== 'bottom') delete routeParams[key];
        }
        Object.assign(resourceParams, serializeSessionPaneUrlState(input.details ? { details: input.details } : {}));
    }
    if (input.initialResource && input.details === undefined) {
        resourceParams[input.initialResource.kind === 'file' ? 'initialFile' : 'initialCommit'] =
            input.initialResource.kind === 'file' ? input.initialResource.path : input.initialResource.sha;
        if (input.initialResource.kind === 'file' && input.initialResource.anchor) {
            Object.assign(resourceParams, serializeFileTargetAnchor(input.initialResource.anchor, input.initialResource.anchorSource));
        }
    }
    return resolveProjectRoutePathForSurface({
        ...input,
        page: input.segment ?? 'overview',
        surface: input.surface ?? input.segment ?? 'overview',
        ...(input.details !== undefined ? { comparisonId: input.details?.kind === 'scmReview' ? input.details.comparison?.comparisonId ?? null : null } : {}),
        ...resolveProjectRouteSelectionQuery(input),
        routeParams: { ...routeParams, ...resourceParams },
    });
}

export function replaceProjectRouteSelection(input: Parameters<typeof buildProjectRouteHref>[0] & Readonly<{
    router: { replace: (href: string) => void };
}>): void {
    input.router.replace(buildProjectRouteHref(input));
}

export { type ProjectMobileSurface };

export function resolveProjectOpenHref(input: Readonly<{
    workspaceRef: WorkspaceRefV1;
    deviceType: 'phone' | 'tablet';
    cockpitEnabled: boolean;
    rememberedRightTabId?: string | null;
    persistedMobileSurface?: string | null;
    persistedActiveRootPath?: string | null;
    persistedWorktreeId?: string | null;
}>): string {
    const activeRootPath = readProjectRouteStringParam(input.persistedActiveRootPath ?? undefined) ?? input.workspaceRef.rootPath;
    const surface = input.deviceType === 'phone' ? resolveProjectMobileSurfaceIntent({
        routeKind: 'index', activeRightTabId: input.rememberedRightTabId, persistedSurface: input.persistedMobileSurface,
    }) : 'overview';
    return resolveProjectRoutePathForSurface({
        workspaceRefId: input.workspaceRef.id, serverId: input.workspaceRef.serverId, surface,
        ...resolveProjectRouteSelectionQuery({ activeRootPath, defaultRootPath: input.workspaceRef.rootPath,
            activeWorktreeId: input.persistedWorktreeId }),
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

export type ProjectAuthoringReturn =
    | Readonly<{ kind: 'ready'; origin: PluginUiNewSessionSeedOriginV1; workspaceRef: WorkspaceRefV1; href: string }>
    | Readonly<{ kind: 'unavailable'; reason: 'origin_invalid' | 'scope_unavailable' | 'workspace_unavailable' }>;

/** Original provenance is qualified independently of the Session's editable launch target. */
export function resolveProjectAuthoringReturn(origin: unknown, input: Readonly<{
    scope: ServerAccountScope | null;
    workspaceRefs: readonly WorkspaceRefV1[];
}>): ProjectAuthoringReturn {
    const parsed = StoredPluginUiNewSessionSeedOriginV1Schema.safeParse(origin);
    if (!parsed.success) return { kind: 'unavailable', reason: 'origin_invalid' };
    const captured = parsed.data;
    if (!input.scope || input.scope.accountId !== captured.accountId
        || !areServerProfileIdentifiersEquivalent(input.scope.serverId, captured.workspace.serverId)) {
        return { kind: 'unavailable', reason: 'scope_unavailable' };
    }
    const workspace = resolveWorkspaceRefByAddress(input.workspaceRefs, captured.workspace);
    if (workspace.kind !== 'resolved') return { kind: 'unavailable', reason: 'workspace_unavailable' };
    return {
        kind: 'ready', origin: captured, workspaceRef: workspace.ref,
        href: buildProjectRouteHref({
            workspaceRefId: workspace.ref.id,
            serverId: workspace.ref.serverId,
            segment: captured.page,
            activeRootPath: captured.workspace.rootPath,
            defaultRootPath: workspace.ref.rootPath,
            ...(captured.comparisonId ? { comparisonId: captured.comparisonId } : {}),
        }),
    };
}

/** Read only the registered private work field, never infer origin from machine/path. */
export function readProjectSessionAuthoringOrigin(metadata: unknown): PluginUiNewSessionSeedOriginV1 | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !('work' in metadata)) return null;
    const work = metadata.work;
    if (!work || typeof work !== 'object' || Array.isArray(work) || !('authoringOriginV1' in work)) return null;
    const parsed = StoredPluginUiNewSessionSeedOriginV1Schema.safeParse(work.authoringOriginV1);
    return parsed.success ? parsed.data : null;
}

export function resolveCurrentProjectAuthoringReturn(origin: unknown): ProjectAuthoringReturn {
    const lifetime = captureActiveServerAccountScopeLifetime();
    const state = readRegisteredStorageState();
    return resolveProjectAuthoringReturn(origin, {
        scope: lifetime?.isCurrent() ? lifetime.scope : null,
        workspaceRefs: state ? readProjectWorkspaceRefs(state) : [],
    });
}

/** The page and semantic Host API share this admission; no raw route is accepted. */
export function admitProjectAuthoringOrigin(origin: PluginUiNewSessionSeedOriginV1, scope: ServerAccountScope): boolean {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime?.isCurrent() || lifetime.scope.accountId !== scope.accountId
        || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, scope.serverId)) return false;
    return resolveCurrentProjectAuthoringReturn(origin).kind === 'ready';
}
