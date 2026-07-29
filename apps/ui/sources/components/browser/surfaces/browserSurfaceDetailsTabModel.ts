import { BrowserViewTargetV1Schema, type BrowserViewTargetV1 } from '@happier-dev/protocol';

import type { DetailsTab, DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import type { DetailsTabPresentation } from '@/components/appShell/panes/details/workspace/DetailsTabStrip';
import { resolveBrowserViewIdForTarget } from '@/sync/domains/browser/store';
import { t } from '@/text';

export const BROWSER_LAUNCHPAD_DETAILS_TAB_KEY = 'browser:launchpad';

/**
 * The kind-agnostic details-workspace engine hosts the browser as just another tab. A
 * `browser-view` tab carries ONLY the workspace seam (`browserSessionId`, `viewId`, `target`);
 * the live per-view CONTENT lifecycle lives in the browser store, while the workspace owns tab
 * order/active/open/close/pin/split/keep-mounted. This collapses the prior two-tab-levels
 * structure (a launchpad tab containing a bespoke inner browser tab strip) onto one engine.
 *
 * The launchpad (new-tab page) is the SAME `browser-view` tab kind carrying a launchpad resource
 * (`mode: 'launchpad'`, no `viewId`/`target`), so the browser surface has exactly one tab kind and
 * one renderer — there is no second `browserSurface` tab path.
 */
export const BROWSER_VIEW_DETAILS_TAB_KIND = 'browser-view';

function normalizeBrowserSurfaceSessionIdPart(value: string): string {
    const normalized = value.trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    return normalized || 'unknown';
}

export function createBrowserSurfaceSessionId(parts: readonly string[]): string {
    return `browser_surface:${parts.map(normalizeBrowserSurfaceSessionIdPart).join(':')}`;
}

function browserTargetSessionPart(target: BrowserViewTargetV1): string | null {
    return 'sessionId' in target && typeof target.sessionId === 'string' && target.sessionId.trim().length > 0
        ? target.sessionId
        : null;
}

export function resolveBrowserTargetSurfaceSessionId(
    scope: string,
    target: BrowserViewTargetV1,
): string {
    return createBrowserSurfaceSessionId([
        scope,
        target.kind,
        ...(browserTargetSessionPart(target) ? [browserTargetSessionPart(target) as string] : []),
        target.targetId,
    ]);
}

/**
 * The workspace `resource` for the launchpad (new-tab) `browser-view` tab. It carries no per-view
 * identity — only the deterministic `browserSessionId` the surface host seeds an empty view under.
 * Distinguished from a single-view resource by `mode: 'launchpad'`.
 */
export type BrowserViewLaunchpadResource = Readonly<{
    kind: 'browser-view';
    mode: 'launchpad';
    browserSessionId: string;
}>;

export function createBrowserLaunchpadDetailsTab(): DetailsTab {
    return {
        key: BROWSER_LAUNCHPAD_DETAILS_TAB_KEY,
        kind: BROWSER_VIEW_DETAILS_TAB_KIND,
        title: t('browserSurface.title'),
        resource: {
            kind: 'browser-view',
            mode: 'launchpad',
            browserSessionId: createBrowserSurfaceSessionId(['details', BROWSER_LAUNCHPAD_DETAILS_TAB_KEY]),
        } satisfies BrowserViewLaunchpadResource,
    };
}

/**
 * Narrow an unknown workspace `resource` to a {@link BrowserViewLaunchpadResource}. Returns `null`
 * for single-view `browser-view` resources so the renderer can branch launchpad vs. single-view.
 */
export function readBrowserViewLaunchpadResource(value: unknown): BrowserViewLaunchpadResource | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const resource = value as Partial<BrowserViewLaunchpadResource>;
    if (resource.kind !== 'browser-view' || resource.mode !== 'launchpad') {
        return null;
    }
    if (typeof resource.browserSessionId !== 'string' || resource.browserSessionId.trim().length === 0) {
        return null;
    }
    return {
        kind: 'browser-view',
        mode: 'launchpad',
        browserSessionId: resource.browserSessionId,
    };
}

/**
 * The workspace `resource` for a single-view `browser-view` tab. The workspace stays kind-agnostic
 * (`resource: unknown`); this is the typed seam the browser renderer reads back. It deliberately
 * holds NO ordering/active state — those are the workspace's; only per-view content identity.
 */
export type BrowserViewDetailsResource = Readonly<{
    kind: 'browser-view';
    browserSessionId: string;
    viewId: string;
    target: BrowserViewTargetV1;
}>;

/**
 * Build a single-view `browser-view` workspace tab from a target. `key` is stable per
 * target+session so re-opening the same target focuses the existing workspace tab (via the
 * reducer's `findGroupIdByTabKey` path) instead of duplicating it. Callers may override
 * `browserSessionId` / `viewId` for scoped (mobile) mounts; otherwise the canonical details
 * identity is used so the tab's `viewId` matches the content record the opener seeds via
 * `openBrowserTarget`.
 */
export function createBrowserViewDetailsTab(params: Readonly<{
    target: BrowserViewTargetV1;
    browserSessionId?: string;
    viewId?: string;
    scope?: string;
}>): DetailsTab {
    const scopePart = params.scope ?? 'details';
    const browserSessionId = params.browserSessionId
        ?? resolveBrowserTargetSurfaceSessionId(scopePart, params.target);
    const viewId = params.viewId ?? resolveBrowserViewIdForTarget(params.target);
    const title = params.target.display?.title
        ?? params.target.display?.addressLabel
        ?? t('browserSurface.title');
    return {
        key: `${BROWSER_VIEW_DETAILS_TAB_KIND}:${browserSessionId}:${viewId}`,
        kind: BROWSER_VIEW_DETAILS_TAB_KIND,
        title,
        resource: {
            kind: 'browser-view',
            browserSessionId,
            viewId,
            target: params.target,
        } satisfies BrowserViewDetailsResource,
    };
}

/**
 * Narrow an unknown workspace `resource` to a single-view {@link BrowserViewDetailsResource}.
 * Returns `null` for the launchpad `browser-view` resource (which carries no `viewId`/`target`) so
 * the single-view renderer never collides with the launchpad empty-state.
 */
export function readBrowserViewDetailsResource(value: unknown): BrowserViewDetailsResource | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const resource = value as Partial<BrowserViewDetailsResource>;
    if (resource.kind !== 'browser-view') {
        return null;
    }
    if (typeof resource.browserSessionId !== 'string' || typeof resource.viewId !== 'string') {
        return null;
    }
    const parsedTarget = BrowserViewTargetV1Schema.safeParse(resource.target);
    if (!parsedTarget.success) {
        return null;
    }
    return {
        kind: 'browser-view',
        browserSessionId: resource.browserSessionId,
        viewId: resource.viewId,
        target: parsedTarget.data,
    };
}

/**
 * A live, per-view favicon/loading snapshot a surface can expose for its `browser-view` tabs.
 * Keyed lookup is by the tab resource's `viewId`; absence means "no live signal yet".
 */
export type BrowserViewTabLivePresentation = Readonly<{
    faviconUrl?: string | null;
    isLoading?: boolean;
}>;

/**
 * Resolve the canonical details-strip leading-glyph presentation for a `browser-view` tab: a
 * spinner while the view is loading, then its favicon, falling back to the per-kind icon (the
 * strip handles that fallback when this returns a slot with no favicon). This is the single seam
 * the browser surface supplies to {@link DetailsTabStrip}'s `resolveTabPresentation`, so the
 * browser participates in the shared tab chrome rather than shipping its own strip.
 *
 * The launchpad (new-tab) tab is intentionally NOT a browser view — it keeps its per-kind home
 * icon — so this returns `null` for it. For a single-view tab the optional `getLivePresentation`
 * lookup (keyed by the resource `viewId`) supplies the live favicon/loading when the surface has
 * it; with no live signal the slot is empty and the strip renders the globe icon.
 */
export function resolveBrowserTabPresentation(
    tab: DetailsTabState,
    getLivePresentation?: (viewId: string) => BrowserViewTabLivePresentation | null | undefined,
): DetailsTabPresentation | null {
    if (tab.kind !== BROWSER_VIEW_DETAILS_TAB_KIND) {
        return null;
    }
    const resource = readBrowserViewDetailsResource(tab.resource);
    if (!resource) {
        // Launchpad (or any non-single-view browser-view tab): no favicon/spinner slot.
        return null;
    }
    const live = getLivePresentation?.(resource.viewId) ?? null;
    return {
        faviconUrl: live?.faviconUrl ?? null,
        isLoading: live?.isLoading ?? false,
    };
}
