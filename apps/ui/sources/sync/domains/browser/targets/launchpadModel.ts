import type { BrowserLaunchpadRow } from './suggestions';
import { buildBrowserLaunchpadRows } from './suggestions';
import type { BrowserRecentTarget } from './recents';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import type { LocalServiceLauncherSnapshot, LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/targets';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';

export type BrowserLaunchpadModel = Readonly<{
    rows: readonly BrowserLaunchpadRow[];
    /** The same admitted Services feed, before the launchpad's running-only presentation. */
    localServiceTargets: readonly LocalServiceLaunchTarget[];
    refreshStatus: 'idle' | 'refreshing' | 'error';
    refreshError: string | null;
}>;

/** The Services read that supplies the launchpad's rows: until its first snapshot lands, its status is the launchpad's. */
export type BrowserLaunchpadLauncherRefresh = Readonly<{
    status: 'idle' | 'refreshing' | 'error';
    error: string | null;
}>;

function resolveRefreshStatus(
    state: LocalServicePreviewState | null | undefined,
    firstLauncherRead: BrowserLaunchpadLauncherRefresh | null,
): BrowserLaunchpadModel['refreshStatus'] {
    if (firstLauncherRead && firstLauncherRead.status !== 'idle') return firstLauncherRead.status;
    if (!state) return 'idle';
    return state.refreshState;
}

function resolveRefreshError(
    state: LocalServicePreviewState | null | undefined,
    firstLauncherRead: BrowserLaunchpadLauncherRefresh | null,
): string | null {
    if (firstLauncherRead?.status === 'error') return firstLauncherRead.error ?? 'local_service_launcher_refresh_failed';
    return state?.refreshState === 'error' ? 'local_service_preview_refresh_failed' : null;
}

export function buildBrowserLaunchpadModel(input: Readonly<{
    launcherSnapshot?: LocalServiceLauncherSnapshot | null;
    launcherRefresh?: BrowserLaunchpadLauncherRefresh | null;
    localServicePreviewState?: LocalServicePreviewState | null;
    pluginBrowserProjection?: PluginBrowserProjectionModel | null;
    pluginBrowserPolicyContext?: PluginUiPolicyEvaluationContext;
    localizePluginText?: PluginLocalizedTextResolver;
    recents?: readonly BrowserRecentTarget[];
    nowMs?: number;
}>): BrowserLaunchpadModel {
    // Before the first Services snapshot there is no inventory to call empty: that read is the launchpad's state.
    // Later re-reads keep the known rows quiet; only the preview refresh speaks over them.
    const firstLauncherRead = input.launcherSnapshot ? null : input.launcherRefresh ?? null;
    return {
        rows: buildBrowserLaunchpadRows(input),
        localServiceTargets: input.launcherSnapshot?.targets ?? EMPTY_SERVICE_TARGETS,
        refreshStatus: resolveRefreshStatus(input.localServicePreviewState, firstLauncherRead),
        refreshError: resolveRefreshError(input.localServicePreviewState, firstLauncherRead),
    };
}

const EMPTY_SERVICE_TARGETS: readonly LocalServiceLaunchTarget[] = Object.freeze([]);
