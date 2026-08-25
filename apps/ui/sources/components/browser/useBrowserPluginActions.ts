import * as React from 'react';
import type { BrowserPlatformV1 } from '@happier-dev/protocol';

import {
    resolvePluginUiClientActionRegistration,
    usePluginUiClientExecutableRegistrationRevision,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import {
    selectPluginBrowserActionsForPlacement,
    selectPluginBrowserToolbarActions,
    type PluginBrowserActionProjection,
    type PluginBrowserProjectionModel,
} from '@/sync/domains/plugins/browser/actions';
import {
    createPluginUiPolicyEvaluationContext,
    type PluginUiPolicyEvaluationContext,
} from '@/sync/domains/plugins/ui/policy';
import {
    createPluginUiProjectedActionResolver,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';

/**
 * The plugin-contributed browser actions for the active view, resolved once per placement.
 *
 * All three placements share the same policy context, the same client-registration filter and the
 * same invoke path, so they belong together rather than as three near-identical memos inline in the
 * shell. This hook only *selects* — the catalog, policy and registration owners it calls are
 * unchanged.
 */
/** The policy evaluator's own mode vocabulary, so the two can never drift apart. */
type PluginUiPolicyProfileMode = NonNullable<PluginUiPolicyEvaluationContext['profileMode']>;

export type BrowserPluginActions = Readonly<{
    policyContext: PluginUiPolicyEvaluationContext;
    toolbarActions: readonly PluginBrowserActionProjection[];
    detailsPanelActions: readonly PluginBrowserActionProjection[];
    contextMenuActions: readonly PluginBrowserActionProjection[];
    invokeAction: (action: PluginBrowserActionProjection) => void;
}>;

export function useBrowserPluginActions(input: Readonly<{
    platform: BrowserPlatformV1;
    /**
     * The profile's storage mode. A plugin-owned profile has no policy mode of its own — the policy
     * context reads `undefined` for it rather than a fourth mode the evaluator does not know.
     */
    profileStorageMode?: PluginUiPolicyProfileMode | 'plugin';
    policyContext?: PluginUiPolicyEvaluationContext;
    uiProjection?: PluginUiProjectionModel | null;
    browserProjection?: PluginBrowserProjectionModel | null;
    activeView: BrowserControlViewState | null;
    onAction?: (
        action: PluginBrowserActionProjection,
        context: Readonly<{
            browserSessionId: string;
            viewId: string;
            targetId: string;
            currentUrl?: string;
        }>,
    ) => void;
}>): BrowserPluginActions {
    const { activeView, browserProjection, onAction, platform, profileStorageMode, uiProjection } = input;
    const targetId = activeView?.target.targetId;

    const policyContext = React.useMemo(
        () => createPluginUiPolicyEvaluationContext(
            {
                platform,
                profileMode: profileStorageMode === 'plugin' ? undefined : profileStorageMode,
            },
            input.policyContext,
        ),
        [input.policyContext, platform, profileStorageMode],
    );

    const clientExecutableRegistrationRevision = usePluginUiClientExecutableRegistrationRevision();
    const resolveContributedAction = React.useMemo(
        () => createPluginUiProjectedActionResolver(uiProjection?.actionsById),
        [uiProjection?.actionsById],
    );
    // A client-executed action whose executable is not registered for THIS projection generation
    // cannot run; offering it would be a control with no outcome. Server-executed actions and
    // unresolvable ids pass through untouched.
    const hasCurrentClientActionRegistration = React.useCallback((
        browserAction: PluginBrowserActionProjection,
    ): boolean => {
        const action = resolveContributedAction(browserAction.actionIdentity);
        if (!action || action.execution.target !== 'client') return true;
        const projectionGeneration = uiProjection?.generation;
        return typeof projectionGeneration === 'number'
            && resolvePluginUiClientActionRegistration({
                action,
                projectionGeneration,
                platform: resolvePluginUiClientExecutablePlatform(),
            }) !== null;
    }, [uiProjection?.generation, resolveContributedAction]);

    const toolbarActions = React.useMemo(
        () => selectPluginBrowserToolbarActions({
            projection: browserProjection,
            targetId,
            policyContext,
        }).filter(hasCurrentClientActionRegistration),
        [
            browserProjection,
            clientExecutableRegistrationRevision,
            hasCurrentClientActionRegistration,
            policyContext,
            targetId,
        ],
    );
    const detailsPanelActions = React.useMemo(
        () => selectPluginBrowserActionsForPlacement({
            projection: browserProjection,
            targetId,
            placement: 'detailsPanel',
            policyContext,
        }).filter(hasCurrentClientActionRegistration),
        [
            browserProjection,
            clientExecutableRegistrationRevision,
            hasCurrentClientActionRegistration,
            policyContext,
            targetId,
        ],
    );
    const contextMenuActions = React.useMemo(
        () => selectPluginBrowserActionsForPlacement({
            projection: browserProjection,
            targetId,
            placement: 'contextMenu',
            policyContext,
        }).filter(hasCurrentClientActionRegistration),
        [
            browserProjection,
            clientExecutableRegistrationRevision,
            hasCurrentClientActionRegistration,
            policyContext,
            targetId,
        ],
    );

    const invokeAction = React.useCallback((action: PluginBrowserActionProjection) => {
        if (!activeView || !onAction) return;
        const currentUrl = activeView.pendingUrl ?? activeView.currentUrl ?? undefined;
        onAction(action, {
            browserSessionId: activeView.browserSessionId,
            viewId: activeView.viewId,
            targetId: activeView.target.targetId,
            ...(currentUrl ? { currentUrl } : {}),
        });
    }, [activeView, onAction]);

    // The bundle is memoized because consumers depend on it as ONE value (the overflow-menu memo
    // takes `plugins`, not five fields). A fresh object literal per render would invalidate every
    // one of them on every render, which is the churn `apps/ui/AGENTS.md` asks us to avoid.
    return React.useMemo(
        () => ({ policyContext, toolbarActions, detailsPanelActions, contextMenuActions, invokeAction }),
        [contextMenuActions, detailsPanelActions, invokeAction, policyContext, toolbarActions],
    );
}
