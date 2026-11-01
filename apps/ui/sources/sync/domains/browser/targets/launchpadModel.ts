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

function resolveRefreshStatus(
    state: LocalServicePreviewState | null | undefined,
): BrowserLaunchpadModel['refreshStatus'] {
    if (!state) return 'idle';
    return state.refreshState;
}

function resolveRefreshError(
    state: LocalServicePreviewState | null | undefined,
): string | null {
    return state?.refreshState === 'error' ? 'local_service_preview_refresh_failed' : null;
}

export function buildBrowserLaunchpadModel(input: Readonly<{
    launcherSnapshot?: LocalServiceLauncherSnapshot | null;
    localServicePreviewState?: LocalServicePreviewState | null;
    pluginBrowserProjection?: PluginBrowserProjectionModel | null;
    pluginBrowserPolicyContext?: PluginUiPolicyEvaluationContext;
    localizePluginText?: PluginLocalizedTextResolver;
    recents?: readonly BrowserRecentTarget[];
    nowMs?: number;
}>): BrowserLaunchpadModel {
    return {
        rows: buildBrowserLaunchpadRows(input),
        localServiceTargets: input.launcherSnapshot?.targets ?? EMPTY_SERVICE_TARGETS,
        refreshStatus: resolveRefreshStatus(input.localServicePreviewState),
        refreshError: resolveRefreshError(input.localServicePreviewState),
    };
}

const EMPTY_SERVICE_TARGETS: readonly LocalServiceLaunchTarget[] = Object.freeze([]);
