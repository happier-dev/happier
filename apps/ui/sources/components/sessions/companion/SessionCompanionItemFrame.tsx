import * as React from 'react';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SessionSurfaceEntityDragHandle, SessionSurfaceEntityTargetFeedback, useSessionSurfaceEntityDrag, type SessionSurfaceEntityBinding } from '@/components/sessions/board/SessionSurfaceEntityDrag';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import type { WidgetSetupSubmitResult } from '@/components/widgets/add/widgetSetupModel';
import { useWidgetFrameRename } from '@/components/widgets/frame/useWidgetFrameRename';
import { buildWidgetDefinitionActions, buildWidgetInstanceActions, orderWidgetMenu } from '@/components/widgets/frame/widgetFrameMenu';
import { useWidgetDefinitionFlows } from '@/components/widgets/definitions/useWidgetDefinitionFlows';
import { useWidgetInputsEditor } from '@/components/widgets/surface/useWidgetInputsEditor';
import { useWidgetInstanceDescriptor } from '@/components/widgets/surface/useWidgetInstanceDescriptor';
import { widgetProvidedContext, type WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { readWidgetDescriptor, resolveWidgetInstanceTitle } from '@/components/widgets/widgetCatalog';
import { useIsNearViewport, type NearViewportSpan, type NearViewportTracker } from '@/components/widgets/nearViewport';
import type { WidgetInputBindingsV1, WidgetInstanceV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    controls: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s2 },
}));

/**
 * A direct personal widget copy's own controls (lab `dashboards` dbind E/X): Edit inputs… and Rename
 * in its ⋯, and the card's repair line. They change this copy alone, through the Companion's owner.
 */
export type SessionCompanionInstanceControls = Readonly<{
    instance: WidgetInstanceV1;
    scope: WidgetSurfaceRefV1 | null;
    context: WidgetSurfaceContext;
    setInputs: (bindings: WidgetInputBindingsV1) => Promise<WidgetSetupSubmitResult>;
    /** `null` goes back to the widget's own name. */
    rename: (displayName: string | null) => void | Promise<void>;
}>;

/** What the copy's body draws for those controls: the rename field in its title, and the repair line. */
export type SessionCompanionInstanceView = Readonly<{
    titleEditor: React.ReactElement | null;
    onRepairInputs?: () => void;
}>;

/**
 * The room a widget body holds in the column until it is first presented. The Companion is a
 * content-height column with no declared size, so this is the one floor every widget host there
 * already uses (the Board-reference host's minimum height) rather than a second estimate.
 */
export const SESSION_COMPANION_WIDGET_BODY_MIN_HEIGHT_PX = 96;

/**
 * Whether this item's body has been presented: the column's near-viewport rule (the one Home and
 * the Board use), read from the item's own layout. A body mounts on its first presentation and then
 * stays for the life of the item, so scrolling away never remounts it or loses its state.
 */
function useCompanionBodyPresented(tracker: NearViewportTracker | undefined) {
    const [span, setSpan] = React.useState<NearViewportSpan | null>(null);
    const [retained, setRetained] = React.useState(false);
    // Once presented the item stops listening to the scroll window.
    const near = useIsNearViewport(retained ? null : tracker ?? null, span);
    if (tracker && near && !retained) setRetained(true);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { y, height } = event.nativeEvent.layout;
        setSpan((current) => current?.top === y && current.height === height ? current : { top: y, height });
    }, []);
    return { presented: !tracker || retained || near, onLayout };
}

type SessionCompanionItemFrameProps = Readonly<{
    /** The item's own accessible name, from its canonical presentation owner. */
    label: string;
    actions: readonly ItemAction[];
    /**
     * The item body. It receives this placement's controls (reorder handle and
     * item menu) and draws them at the end of its own header line, so the item
     * keeps one header and the frame adds no second title row. `bodyPresented` is false
     * until the item first scrolls into view: an executable body waits (holding
     * {@link SESSION_COMPANION_WIDGET_BODY_MIN_HEIGHT_PX}) and mounts on presentation.
     */
    children: (headerAccessory: React.ReactNode, instanceView?: SessionCompanionInstanceView, bodyPresented?: boolean) => React.ReactNode;
    testID: string;
    onLayout?: (event: LayoutChangeEvent) => void;
    /** The column's scroll window; absent where the body is always built (measuring, a lone section). */
    viewport?: NearViewportTracker;
    /** Absent while measuring or without a current qualified Companion owner. */
    entityDrag?: SessionSurfaceEntityBinding;
    /** A direct personal widget copy (never a Board reference); absent while measuring. */
    instanceControls?: SessionCompanionInstanceControls;
}>;

/**
 * The Companion's placement controls around one item; it draws no chrome.
 *
 * Every item draws itself in the one shared widget frame (`WidgetFrame`): its title, hairline or card,
 * insets, frame style and typed states. This wrapper only supplies what the placement owns — the reorder
 * handle and the item menu (drawn in that frame's header), body demand, layout reports for drag, and a
 * direct copy's rename and inputs controls — so it never becomes a second item shell or state table.
 *
 * Reorder is the pair the plan requires: this frame composes the Board's move
 * handle (pointer drag plus its keyboard staging and announcements) and the
 * overflow menu keeps the explicit Move Up/Down/First/Last entries beside it.
 */
export const SessionCompanionItemFrame = React.memo(function SessionCompanionItemFrame(props: SessionCompanionItemFrameProps) {
    // An item's kind never changes under its key, so this picks one frame for its lifetime.
    return props.instanceControls
        ? <InstanceItemFrame {...props} controls={props.instanceControls} />
        : <ItemFrameBody {...props} />;
});

function InstanceItemFrame(props: SessionCompanionItemFrameProps & Readonly<{ controls: SessionCompanionInstanceControls }>) {
    const { instance, scope, context, setInputs, rename } = props.controls;
    const projection = useAppShellPluginUiProjection().pluginUiProjection;
    const localize = usePluginLocalizedTextResolver({ projection });
    const installed = React.useMemo(() => readWidgetDescriptor(projection, instance.definition, instance.displayName ? undefined : localize),
        [instance.definition, instance.displayName, projection, localize]);
    const candidate = useWidgetInstanceDescriptor(scope, instance, installed);
    const inputs = useWidgetInputsEditor({ instance, candidate, scope, context, audience: 'personal', setInputs, testID: props.testID });
    const title = resolveWidgetInstanceTitle(instance, candidate, { fallbackTitle: props.label });
    // Rename stays optional (lab dbind N1): an empty name, or the widget's own, goes back to it.
    const renaming = useWidgetFrameRename({
        title,
        testID: props.testID,
        onRename: (next) => {
            const displayName = next.length > 0 && next !== candidate?.title ? next : null;
            if (displayName !== (instance.displayName ?? null)) return rename(displayName);
        },
    });
    const editInputs = inputs.editInputs;
    const beginRename = renaming.begin;
    const definition = useWidgetDefinitionFlows({ instance, scope, providedContext: widgetProvidedContext(context), anchorRef: inputs.anchorRef, editInputs, testID: props.testID });
    // The lab order (dbind E): this copy's entries, how it sits here, About, then Remove last.
    const actions = React.useMemo<readonly ItemAction[]>(() => orderWidgetMenu({
        instance: buildWidgetInstanceActions({ editInputs, onRename: beginRename }),
        frame: props.actions.filter((action) => !isRemoval(action)),
        definition: buildWidgetDefinitionActions({ onAbout: definition.about, onAddTo: definition.addTo }),
        remove: props.actions.filter(isRemoval),
    }), [beginRename, definition.about, definition.addTo, editInputs, props.actions]);
    const view = React.useMemo<SessionCompanionInstanceView>(() => ({
        titleEditor: renaming.field,
        ...(inputs.onRepairInputs ? { onRepairInputs: inputs.onRepairInputs } : {}),
    }), [inputs.onRepairInputs, renaming.field]);
    const children = props.children;
    return (
        <>
            <ItemFrameBody {...props} label={title} actions={actions} controlsRef={inputs.anchorRef}>
                {(accessory, _view, bodyPresented) => children(accessory, view, bodyPresented)}
            </ItemFrameBody>
            {inputs.popover}
            {definition.panel}
        </>
    );
}

function ItemFrameBody(props: SessionCompanionItemFrameProps & Readonly<{
    /** Edit inputs anchors at the ⋯. */
    controlsRef?: React.RefObject<View | null>;
}>) {
    const styles = stylesheet;
    const actions = React.useMemo(() => [...props.actions], [props.actions]);
    const drag = useSessionSurfaceEntityDrag(props.entityDrag ?? null);
    const demand = useCompanionBodyPresented(props.viewport);
    const accessory = props.entityDrag || actions.length > 0 ? (
        <View style={styles.controls} ref={props.controlsRef} collapsable={false}>
            {props.entityDrag ? <SessionSurfaceEntityDragHandle drag={drag} title={props.label} testID={`${props.testID}-move-handle`} /> : null}
            {actions.length > 0 ? (
                <ItemRowActions
                    title={props.label}
                    actions={actions}
                    // One overflow control keeps the item quiet; hover is never
                    // the only way to reach these on touch or with a keyboard.
                    compactThreshold={Number.POSITIVE_INFINITY}
                    overflowTriggerTestID={`${props.testID}-actions`}
                    overflowTriggerAccessibilityLabel={t('sessionBoard.companion.actions.itemMenuA11y', {
                        title: props.label,
                    })}
                    iconSize={16}
                    gap={6}
                />
            ) : null}
        </View>
    ) : null;

    return (
        <View ref={drag.ref} collapsable={false}
            testID={props.testID}
            onLayout={event => { demand.onLayout(event); props.onLayout?.(event); drag.onLayout(event); }}
        >
            {props.children(accessory, undefined, demand.presented)}
            <SessionSurfaceEntityTargetFeedback drag={drag} testID={props.testID} />
        </View>
    );
}

/** Removing this reference (or anything destructive) stays the menu's last entry. */
function isRemoval(action: ItemAction): boolean {
    return action.id === 'remove' || action.destructive === true;
}
