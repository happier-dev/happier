import type { PluginContributionRef } from '@happier-dev/plugin-sdk';
import type {
    ForgeReleaseMountedCommandV1, ForgeReleaseMountedIntentOperationV1, ForgeReleaseMountedIntentResultV1, ForgeReleaseOperationIdV1,
} from '@happier-dev/triage-protocol/releases/v1';
import { GITHUB_RELEASE_ACTION_IDS_V1 } from '../../releases/contracts.js';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import type { ReleaseEditorV1 } from './editor.js';

export const GITHUB_RELEASE_ACTION_REFS_V1 = Object.freeze(Object.fromEntries(Object.entries(GITHUB_RELEASE_ACTION_IDS_V1)
    .map(([operation, localId]) => [operation, { pluginId: GITHUB_PLUGIN_ID, localId }]))) as Readonly<Record<ForgeReleaseOperationIdV1, PluginContributionRef>>;

/** The Collection supplies its controlled values; there is no parallel page/filter/selection store. */
export function createReleasePageActionHandlerV1(options: Readonly<{
    getEditor(): ReleaseEditorV1 | null;
    setSearch(query: string): void; setFilter(state: 'all' | 'published' | 'drafts' | 'prereleases'): void;
    selectRelease(releaseId: string, signal: AbortSignal): Promise<boolean>;
    /** Expanded: the release as the page (Open as page); collapsed: back to the details pane (Return). */
    setExpanded(releaseId: string, value: boolean, signal: AbortSignal): Promise<boolean>;
    loadMore(resource: 'list' | 'detail' | 'assets', signal: AbortSignal): Promise<boolean>;
    /** The page's operandless controls, through the same path and guards as the person's buttons. */
    command(command: ForgeReleaseMountedCommandV1, signal: AbortSignal): Promise<ForgeReleaseMountedIntentResultV1>;
}>) {
    return async (operation: ForgeReleaseMountedIntentOperationV1, signal: AbortSignal): Promise<ForgeReleaseMountedIntentResultV1> => {
        if (signal.aborted) return { status: 'unavailable' };
        switch (operation.kind) {
            case 'setSearch': options.setSearch(operation.query); return { status: 'applied' };
            case 'setFilter': options.setFilter(operation.state); return { status: 'applied' };
            case 'selectRelease': return { status: await options.selectRelease(operation.releaseId, signal) ? 'applied' : 'rejected' };
            case 'setExpanded': return { status: await options.setExpanded(operation.releaseId, operation.value, signal) ? 'applied' : 'rejected' };
            case 'command': return options.command(operation.command, signal);
            case 'loadMore': return { status: await options.loadMore(operation.resource, signal) ? 'applied' : 'unavailable' };
            default: return options.getEditor()?.invoke(operation) ?? { status: 'unavailable' };
        }
    };
}
