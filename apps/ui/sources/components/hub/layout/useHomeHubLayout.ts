import * as React from 'react';
import type { HomeHubLayoutIntent } from '@happier-dev/protocol/home';
import { isSameWidgetDefinitionV1, widgetCandidateDefinitionV1, type WidgetInstanceV1, type WidgetInputBindingsV1, type WidgetSizeV1 } from '@happier-dev/protocol/widgets';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { resolveHomeHubLayout, listHiddenHomeSetupSteps, HOME_HUB_BUILTIN_DEFINITIONS, type HomeHubSection } from './homeHubLayout';
import { useHomeWidgetCandidates } from './useHomeWidgetCandidates';
import { useHomeHubArtifactLayout } from './useHomeHubArtifactLayout';
import { useWidgetInstanceDescriptors } from '@/components/widgets/surface/useWidgetInstanceDescriptor';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';

export type HomeHubLayout = Readonly<{
    sections: readonly HomeHubSection<WidgetCandidate>[];
    available: readonly WidgetCandidate[];
    isDefault: boolean;
    hiddenSetupStepCount: number;
    status: 'loading' | 'ready' | 'error';
    errorCode?: string;
    retry: () => Promise<void>;
    canCancelFailedIntent: boolean;
    cancelFailedIntent: () => void;
    move: (id: string, step: -1 | 1) => Promise<void>;
    moveTo: (id: string, position: Extract<HomeHubLayoutIntent, { kind: 'move_to' }>['position']) => Promise<void>;
    reorder: (orderedIds: readonly string[]) => Promise<void>;
    setHidden: (id: string, hidden: boolean) => Promise<void>;
    setFrameStyle: (id: string, style: 'card' | 'plain' | null) => Promise<void>;
    showHiddenSetupSteps: () => Promise<void>;
    reset: () => Promise<void>;
    addInstance: (instance: WidgetInstanceV1, size?: WidgetSizeV1) => Promise<void>;
    remove: (instanceId: string) => Promise<void>;
    rename: (instanceId: string, displayName?: string) => Promise<void>;
    setInputs: (instanceId: string, bindings: WidgetInputBindingsV1) => Promise<void>;
    setSize: (instanceId: string, size: WidgetSizeV1) => Promise<void>;
}>;
/** Projection only: acknowledged Account Artifact layout plus stable, unpersisted defaults. */
export function useHomeHubLayout(): HomeHubLayout {
    const state = useHomeHubArtifactLayout();
    const widgets = useHomeWidgetCandidates();
    const layout = state.layout;
    const scope = useActiveServerAccountScope();
    const descriptors = useWidgetInstanceDescriptors(scope, layout.instances, widgets);
    const layoutWidgets = React.useMemo(() => {
        const next = [...widgets];
        for (const descriptor of descriptors) if (descriptor && !next.some(widget =>
            isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(widget), widgetCandidateDefinitionV1(descriptor)))) next.push(descriptor);
        return next;
    }, [widgets, descriptors]);
    const resolved = React.useMemo(() => resolveHomeHubLayout(layout, HOME_HUB_BUILTIN_DEFINITIONS, layoutWidgets), [layout, layoutWidgets]);
    const write = state.dispatch;
    const dispatch = React.useCallback((intent: HomeHubLayoutIntent) => write(intent, { rethrow: true }), [write]);
    return React.useMemo(() => ({
        sections: resolved.sections, available: resolved.available,
        isDefault: layout.order.length === 0 && layout.hidden.length === 0 && layout.instances.length === 0 && !layout.sections,
        hiddenSetupStepCount: listHiddenHomeSetupSteps(layout).length,
        status: state.status, ...(state.errorCode ? { errorCode: state.errorCode } : {}), retry: state.retry,
        canCancelFailedIntent: Boolean(state.failedIntent), cancelFailedIntent: state.cancelFailedIntent,
        move: (sectionId, step) => dispatch({ kind: 'move', sectionId, step }),
        moveTo: (sectionId, position) => dispatch({ kind: 'move_to', sectionId, position }),
        reorder: sectionIds => dispatch({ kind: 'reorder', sectionIds: [...sectionIds] }),
        setHidden: (sectionId, hidden) => dispatch({ kind: 'visibility', sectionId, hidden }),
        setFrameStyle: (sectionId, frameStyle) => dispatch({ kind: 'frameStyle', sectionId, frameStyle }),
        showHiddenSetupSteps: () => dispatch({ kind: 'restore_setup' }),
        reset: () => dispatch({ kind: 'reset' }),
        addInstance: (instance, size) => dispatch({ kind: 'widget_add', instance, ...(size ? { size } : {}) }),
        remove: instanceId => dispatch({ kind: 'widget_remove', instanceId }),
        rename: (instanceId, displayName) => dispatch({ kind: 'widget_rename', instanceId, ...(displayName ? { displayName } : {}) }),
        setInputs: (instanceId, bindings) => dispatch({ kind: 'widget_inputs', instanceId, bindings }),
        setSize: (instanceId, size) => dispatch({ kind: 'widget_size', instanceId, size }),
    }), [dispatch, layout, resolved, state.cancelFailedIntent, state.errorCode, state.failedIntent, state.retry, state.status]);
}
