import { BOT_TEMPLATE_EDITOR_DESTINATION } from '@/components/sessions/bots/templates/botTemplateEditorDestination';
import { buildDetailsWorkspaceStateView } from '../details/workspace/detailsWorkspaceSelectors';
import type { PaneScopeState } from './appPaneReducer';

/** Contextual editors occupy the side column on open, reselection and restoration. */
export function placeDetailsInSideColumn(scope: PaneScopeState, start = false): PaneScopeState {
    if (!scope.right.isOpen || !scope.details.isOpen) return scope;
    const view = buildDetailsWorkspaceStateView(scope.details);
    const active = view.tabs.find(tab => tab.key === view.activeTabKey);
    if (!start && (scope.details.overlay || active?.kind !== BOT_TEMPLATE_EDITOR_DESTINATION)) return scope;
    return { ...scope, right: { ...scope.right, isOpen: false } };
}
