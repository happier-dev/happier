import * as React from 'react';
import { resolveDetailNavigationItems, type DetailPageNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { selectPresentedDetailNavigationItem, usePresentedDetailNavigation } from '@/components/appShell/rightSidebar/usePresentedDetailNavigation';
import type { PaneMainColumnState } from '@/components/appShell/panes/mainColumn/usePaneMainColumn';
import type { ShellColumnActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useCurrentUiContextLocalCommands, type CurrentUiContextLocalCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { WorkflowCockpitTabBar } from './WorkflowNavigationViews';

export type WorkflowPageKind = 'workflowEditor' | 'workflowRun';
export function workflowNavigationAddress(pageKind: WorkflowPageKind, device: 'desktop' | 'phone', section: 'pages' | 'companions' = 'pages') {
    return device === 'phone' ? { pageKind, device, section: 'items' as const } : { pageKind, device, section };
}
export type WorkflowNavigationModel = Readonly<{
    pageKind: WorkflowPageKind; identity: string; scope: ServerAccountScope | null;
    items: readonly DetailPageNavigationItem[]; activeId: string; sideId: string | null; sideIds: readonly string[];
    readColumn: (column: 'main' | 'side') => ShellColumnActionOwner;
}>;

/** Adapts the existing controlled page and pane owners; it owns no draft, run, or selection state. */
export function useWorkflowNavigation(input: Readonly<{
    pageKind: WorkflowPageKind; identity: string; scope: ServerAccountScope | null;
    activeId: string; phone: boolean; presented: boolean;
    agentAvailable?: boolean;
    selectPage: (id: string) => void;
    companion?: Readonly<{ activeId: string | null; activeIds?: readonly string[]; select: (id: string) => void; close: () => void }>;
}>) {
    const sideId = input.companion?.activeId ?? null;
    const sideIds = React.useMemo(() => input.companion?.activeIds ?? (sideId ? [sideId] : []), [input.companion?.activeIds, sideId]);
    const locale = usePreferredLanguage();
    const items = React.useMemo(() => resolveDetailNavigationItems({ scope: input.pageKind,
        agentAvailable: input.agentAvailable }),
    [input.pageKind, input.agentAvailable, locale]);
    const mainControls = React.useRef<PaneMainColumnState | null>(null);
    const onMainColumnControlsChange = React.useCallback((controls: PaneMainColumnState | null) => { mainControls.current = controls; }, []);
    const navigation = usePresentedDetailNavigation({ pageKind: input.pageKind, identity: input.identity,
        scope: input.scope, items, activeId: input.activeId, phone: input.phone, presented: input.presented,
        title: t('workflows.title'), selectPage: input.selectPage, companion: input.companion, mainControls,
        chromeRevision: sideIds,
        phoneChrome: execute => {
            const props = { model, onSelect: (id: string) => selectPresentedDetailNavigationItem(execute, model, id) };
            return { node: <WorkflowCockpitTabBar {...props} />, systemModel: { kind: 'workflowCockpit', props } };
        },
        // Run invocation inspection remains the DetailsPaneHost's selected-detail owner.
        registerSide: Boolean(input.companion) });
    const model = React.useMemo<WorkflowNavigationModel>(() => ({ ...navigation.model,
        pageKind: input.pageKind, sideId, sideIds }), [navigation.model, input.pageKind, sideId, sideIds]);
    const { execute, executeForCaller, binding } = useMountedActionExecution(input.scope);
    const execution = React.useMemo(() => ({ execute, executeForCaller, binding }), [execute, executeForCaller, binding]);
    const commands = React.useMemo<readonly CurrentUiContextLocalCommand[]>(() => !input.presented ? []
        : ([['main', navigation.pages], ['side', input.companion ? navigation.companions : []]] as const)
            .flatMap(([column, entries]) => entries.filter(item => !item.disabledReason).map(item => ({
                key: `workflow.navigation:${column}:${item.id}`,
                title: item.title,
                invoke: async (_value, _context, invocation) => (await invocation.execute(execution,
                    'shell.column.set', { column, visible: true, tab: item.id },
                    { executorOptions: { scopeActionOwner: { kind: 'shell.column', column,
                        read: () => model.readColumn(column) } } })).ok,
            }))),
    [input.presented, Boolean(input.companion), navigation.pages, navigation.companions, execution, model.readColumn]);
    useCurrentUiContextLocalCommands(commands, { contextKey: input.identity });
    // Equal navigation facts keep one identity, so a page edit (a Workflow name keystroke) leaves its tabs still.
    return React.useMemo(() => ({ model, pages: navigation.pages, companions: navigation.companions,
        placements: navigation.placements, onMainColumnControlsChange }),
    [model, navigation.pages, navigation.companions, navigation.placements, onMainColumnControlsChange]);
}

export const selectWorkflowNavigationItem = selectPresentedDetailNavigationItem;
