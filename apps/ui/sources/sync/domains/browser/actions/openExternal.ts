import type { BrowserControlViewState } from '../control/state';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch/types';
import { buildLocalServiceRows } from '@/sync/domains/local/services/serviceRow';
import { selectServiceForEndedPreview, type BrowserLaunchpadRow } from '../targets';
import { selectLocalServicePreviewByBrowserTarget, type LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import { acquireServerPreviewAccess, type ServerPreviewAccessResult } from '@/sync/domains/local/services/preview/nativeDirectAccess';
import { resolveLocalServicePreviewExternalUrl, resolveLocalServicePreviewServerUrl } from '@/sync/domains/local/services/preview/url';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';
import { isDaemonAuthoritativeBrowserView } from '../control/commands';

/** A managed page on the Machine's own localhost: this device's browser would open its own instead. */
function isMachineLocalAddress(view: BrowserControlViewState): boolean {
    if (view.target.kind !== 'externalUrl' || !isDaemonAuthoritativeBrowserView(view)) return false;
    try {
        return isLoopbackHostname(new URL(view.pendingUrl ?? view.currentUrl ?? view.target.url).hostname);
    } catch {
        return false;
    }
}

export type BrowserOpenExternalAvailability = Readonly<
    | { enabled: true }
    // The stopped Service by name, so the refusal says it in the ended card's words.
    | { enabled: false; reasonCode: 'service_stopped'; serviceName?: string }
    | { enabled: false; reasonCode: 'preview_ended' | 'service_failed' | 'browser_view_unavailable' }
>;

type BrowserOpenExternalFacts = Readonly<{
    view: BrowserControlViewState | null | undefined;
    localServiceTargets?: readonly LocalServiceLaunchTarget[];
    launchpadRows?: readonly BrowserLaunchpadRow[];
    previewState?: LocalServicePreviewState | null;
}>;

export type BrowserOpenExternalUrlResult = ServerPreviewAccessResult
    | Readonly<{ ok: false; reasonCode: 'service_stopped' | 'service_failed' | 'browser_view_unavailable' }>;

/** The menu and admitted Action read the same current Service and preview facts. */
export function selectBrowserOpenExternalAvailability(input: BrowserOpenExternalFacts): BrowserOpenExternalAvailability {
    const { view } = input;
    if (!view || (view.target.kind !== 'externalUrl' && view.target.kind !== 'localServicePreview')) {
        return { enabled: false, reasonCode: 'browser_view_unavailable' };
    }
    if (view.target.kind === 'externalUrl') {
        return isMachineLocalAddress(view) ? { enabled: false, reasonCode: 'browser_view_unavailable' } : { enabled: true };
    }
    const service = selectServiceForEndedPreview(input.localServiceTargets ?? [], view.target)
        ?? selectServiceForEndedPreview(input.launchpadRows?.flatMap(row => row.serviceRow ? [row.serviceRow.target] : []) ?? [], view.target);
    const serviceRow = service ? buildLocalServiceRows({ inventoryRows: [], launchTargets: [service],
        sessionId: view.target.sessionId ?? null, scope: 'workspace' })[0] : null;
    if (serviceRow?.status === 'stopped') {
        const serviceName = service?.title.trim();
        return { enabled: false, reasonCode: 'service_stopped', ...(serviceName ? { serviceName } : {}) };
    }
    if (serviceRow?.status === 'failed') return { enabled: false, reasonCode: 'service_failed' };
    const preview = input.previewState ? selectLocalServicePreviewByBrowserTarget(input.previewState, view.target) : null;
    // Absence from a cold feed is not revocation. The incumbent lifecycle supplies the ended fact;
    // a current registration can restore access, which still requires admission on invocation.
    if (view.lastError === 'preview_ended' && !preview) return { enabled: false, reasonCode: 'preview_ended' };
    return { enabled: true };
}

/** A native preview listener belongs to its view lease and is never an OS-browser destination. */
export async function resolveBrowserOpenExternalUrl(input: BrowserOpenExternalFacts & Readonly<{
    scope: ServerAccountScope;
    serverId?: string | null;
    signal?: AbortSignal;
}>): Promise<BrowserOpenExternalUrlResult> {
    const availability = selectBrowserOpenExternalAvailability(input);
    if (!availability.enabled) return { ok: false, reasonCode: availability.reasonCode };
    const { view } = input;
    if (!view || view.target.kind !== 'localServicePreview') return { ok: false, reasonCode: 'browser_view_unavailable' };
    const preview = input.previewState ? selectLocalServicePreviewByBrowserTarget(input.previewState, view.target) : null;
    const access = await acquireServerPreviewAccess({ previewId: preview?.previewId ?? view.target.targetId,
        machineId: view.target.machineId, serverId: input.serverId ?? input.scope.serverId,
        scope: input.scope, signal: input.signal });
    if (!access.ok) return access;
    const currentUrl = view.pendingUrl ?? view.currentUrl;
    if (!currentUrl) return access;
    const externalUrl = view.loadingState !== 'failed' && preview?.accessUrl
        ? resolveLocalServicePreviewExternalUrl(currentUrl, preview.accessUrl, view.target.display?.addressLabel) : null;
    if (externalUrl) return { ok: true, url: externalUrl };
    return { ok: true, url: resolveLocalServicePreviewServerUrl(currentUrl, access.url) };
}
