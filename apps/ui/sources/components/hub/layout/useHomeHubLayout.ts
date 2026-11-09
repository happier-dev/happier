import * as React from 'react';
import type { HomeHubLayoutIntent } from '@happier-dev/protocol/home';
import type { UiSurfaceNetworkRequestV1 } from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlCapabilitiesV1';
import { isSameWidgetDefinitionV1, widgetCandidateDefinitionV1, flattenWidgetLayoutWidgetsV1, type WidgetLayoutItemV1, type WidgetLayoutGroupV1, type WidgetInstanceV1, type WidgetInputBindingsV1, type WidgetSizeV1 } from '@happier-dev/protocol/widgets';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { applyHomeHubLayoutIntent, resolveHomeHubLayout, listHiddenHomeSetupSteps, HOME_HUB_BUILTIN_DEFINITIONS, type HomeHubSection } from './homeHubLayout';
import { useHomeWidgetCandidates } from './useHomeWidgetCandidates';
import { useHomeHubArtifactLayout } from './useHomeHubArtifactLayout';
import { useWidgetInstanceDescriptors } from '@/components/widgets/surface/useWidgetInstanceDescriptor';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { publishPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

export type HomeHubLayout = Readonly<{
    order: readonly string[];
    items: readonly WidgetLayoutItemV1[];
    sections: readonly HomeHubSection<WidgetCandidate>[];
    available: readonly WidgetCandidate[];
    isDefault: boolean;
    hiddenSetupStepCount: number;
    status: 'loading' | 'ready' | 'error';
    hasSnapshot: boolean;
    errorCode?: string;
    retry: () => Promise<void>;
    canCancelFailedIntent: boolean;
    cancelFailedIntent: () => void;
    move: (id: string, step: -1 | 1) => Promise<void>;
    moveTo: (id: string, position: Extract<HomeHubLayoutIntent, { kind: 'move_to' }>['position']) => Promise<void>;
    /** The same reducer and projection as the saved move; includes mandatory, non-hideable rows. */
    projectMove: (id: string, position: Extract<HomeHubLayoutIntent, { kind: 'move_to' }>['position']) => readonly string[];
    reorder: (orderedIds: readonly string[]) => Promise<void>;
    setHidden: (id: string, hidden: boolean) => Promise<void>;
    setFrameStyle: (id: string, style: 'card' | 'plain' | null) => Promise<void>;
    showHiddenSetupSteps: () => Promise<void>;
    reset: () => Promise<void>;
    /** Adds a copy at the end of Home, or into a group (its empty slot) when `groupId` is given. */
    addInstance: (instance: WidgetInstanceV1, size?: WidgetSizeV1, groupId?: string) => Promise<void>;
    remove: (instanceId: string) => Promise<void>;
    rename: (instanceId: string, displayName?: string) => Promise<void>;
    setInputs: (instanceId: string, bindings: WidgetInputBindingsV1) => Promise<void>;
    setSize: (instanceId: string, size: WidgetSizeV1) => Promise<void>;
    /** An HTML copy's network access, through the universal `widgets.item.network.set`. */
    setNetwork: (instanceId: string, network: UiSurfaceNetworkRequestV1) => Promise<void>;
    createGroup: (groupId: string, instanceIds: readonly string[]) => Promise<void>;
    ungroup: (instanceId: string) => Promise<void>;
    setGroup: (instanceId: string, options: Pick<Partial<WidgetLayoutGroupV1>, 'width' | 'dividers'>) => Promise<void>;
    setGroupInputs: (instanceId: string, bindings: WidgetInputBindingsV1) => Promise<void>;
    moveItem: (instanceId: string, toIndex: number, groupId?: string | null) => Promise<void>;
}>;
/** Projection only: acknowledged Account Artifact layout plus stable, unpersisted defaults. */
export function useHomeHubLayout(): HomeHubLayout {
    const state = useHomeHubArtifactLayout();
    const widgets = useHomeWidgetCandidates();
    const layout = state.layout;
    const scope = useActiveServerAccountScope();
    const instances = React.useMemo(() => flattenWidgetLayoutWidgetsV1(layout.items).map(item => item.instance), [layout.items]);
    const descriptors = useWidgetInstanceDescriptors(scope, instances, widgets);
    const layoutWidgets = React.useMemo(() => {
        const next = [...widgets];
        for (const descriptor of descriptors) if (descriptor && !next.some(widget =>
            isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(widget), widgetCandidateDefinitionV1(descriptor)))) next.push(descriptor);
        return next;
    }, [widgets, descriptors]);
    const resolved = React.useMemo(() => resolveHomeHubLayout(layout, HOME_HUB_BUILTIN_DEFINITIONS, layoutWidgets), [layout, layoutWidgets]);
    const write = state.dispatch;
    const noticeKey = scope ? `home-layout-write:${serverAccountScopeKeySuffix(scope)}` : null;
    React.useEffect(() => {
        if (noticeKey && state.status === 'ready') retirePresentationNotice(noticeKey);
    }, [noticeKey, state.status]);
    const notifyFailure = React.useCallback(function notifyFailure(error: unknown) {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!noticeKey || !lifetime?.isCurrent() || !areServerAccountScopesEqual(lifetime.scope, scope)) return;
        publishPresentationNotice({ key: noticeKey, severity: 'error',
            message: resolveActionExecutionErrorMessage(error, t('widgetAdd.saveFailed')),
            // Retry stays with the captured Account queue; a failed Retry restores its dismissed notice.
            undo: { label: t('common.retry'), run: () => { void state.retry({ rethrow: true }).catch(notifyFailure); } },
        });
    }, [noticeKey, scope, state.retry]);
    const dispatch = React.useCallback(async (intent: HomeHubLayoutIntent) => {
        try { await write(intent, { rethrow: true }); }
        catch (error) {
            notifyFailure(error);
            throw error;
        }
    }, [notifyFailure, write]);
    return React.useMemo(() => ({
        items: state.hasSnapshot ? resolved.sections.flatMap<WidgetLayoutItemV1>(section => section.kind === 'builtin' ? [] : section.kind === 'group' ? [section.group]
            : [{ kind: 'widget' as const, instance: section.instance, size: section.size, ...(section.frameStyle ? { frameStyle: section.frameStyle } : {}) }]) : [],
        order: state.hasSnapshot ? resolved.order : [], sections: state.hasSnapshot ? resolved.sections : [], available: resolved.available,
        isDefault: layout.order.length === 0 && layout.hidden.length === 0 && layout.items.length === 0 && !layout.sections,
        hiddenSetupStepCount: listHiddenHomeSetupSteps(layout).length,
        status: state.status, hasSnapshot: state.hasSnapshot, ...(state.errorCode ? { errorCode: state.errorCode } : {}), retry: state.retry,
        canCancelFailedIntent: Boolean(state.failedIntent), cancelFailedIntent: state.cancelFailedIntent,
        move: (sectionId, step) => dispatch({ kind: 'move', sectionId, step }),
        moveTo: (sectionId, position) => dispatch({ kind: 'move_to', sectionId, position }),
        projectMove: (sectionId, position) => resolveHomeHubLayout(
            applyHomeHubLayoutIntent(layout, HOME_HUB_BUILTIN_DEFINITIONS, layoutWidgets, { kind: 'move_to', sectionId, position }),
            HOME_HUB_BUILTIN_DEFINITIONS, layoutWidgets).sections.map(section => section.id),
        reorder: sectionIds => dispatch({ kind: 'reorder', sectionIds: [...sectionIds] }),
        setHidden: (sectionId, hidden) => dispatch({ kind: 'visibility', sectionId, hidden }),
        setFrameStyle: (sectionId, frameStyle) => dispatch({ kind: 'frameStyle', sectionId, frameStyle }),
        showHiddenSetupSteps: () => dispatch({ kind: 'restore_setup' }),
        reset: () => dispatch({ kind: 'reset' }),
        addInstance: (instance, size, groupId) => dispatch({ kind: 'widget_add', instance, ...(size ? { size } : {}), ...(groupId ? { groupId } : {}) }),
        remove: instanceId => dispatch({ kind: 'remove', instanceId }),
        rename: (instanceId, displayName) => dispatch({ kind: 'rename', instanceId, displayName: displayName ?? null }),
        setInputs: (instanceId, bindings) => dispatch({ kind: 'widget_inputs', instanceId, bindings }),
        setSize: (instanceId, size) => dispatch({ kind: 'widget_size', instanceId, size }),
        setNetwork: (instanceId, network) => dispatch({ kind: 'network', instanceId, network }),
        createGroup: (groupId, instanceIds) => dispatch({ kind: 'group_create', groupId, instanceIds: [...instanceIds] }),
        ungroup: instanceId => dispatch({ kind: 'group_ungroup', instanceId }),
        setGroup: (instanceId, options) => dispatch({ kind: 'group_set', instanceId, ...options }),
        setGroupInputs: (instanceId, bindings) => dispatch({ kind: 'group_inputs', instanceId, bindings }),
        moveItem: (instanceId, toIndex, groupId) => dispatch({ kind: 'move', instanceId, toIndex, ...(groupId === undefined ? {} : { groupId }) }),
    }), [dispatch, layout, layoutWidgets, resolved, state.cancelFailedIntent, state.errorCode, state.failedIntent, state.hasSnapshot, state.retry, state.status]);
}
