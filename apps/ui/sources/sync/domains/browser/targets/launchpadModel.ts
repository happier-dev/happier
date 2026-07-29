import type { BrowserLaunchpadRow } from './suggestions';
import { buildBrowserLaunchpadRows } from './suggestions';
import type { BrowserRecentTarget } from './recents';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import type { LocalServiceLauncherSnapshot } from '@/sync/domains/local/services/launch';
import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/targets';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';

export type BrowserLaunchpadModel = Readonly<{
    rows: readonly BrowserLaunchpadRow[];
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
    recents?: readonly BrowserRecentTarget[];
    nowMs?: number;
}>): BrowserLaunchpadModel {
    return {
        rows: buildBrowserLaunchpadRows(input),
        refreshStatus: resolveRefreshStatus(input.localServicePreviewState),
        refreshError: resolveRefreshError(input.localServicePreviewState),
    };
}
