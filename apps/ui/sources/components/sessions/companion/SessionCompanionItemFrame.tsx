import * as React from 'react';
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
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { readWidgetDescriptor } from '@/components/widgets/widgetCatalog';
import type { WidgetInputBindingsV1, WidgetInstanceV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    // Flat sections separated by a hairline (lab CA): the column reads as one
    // live strip, not a stack of cards. Only the needs-you block is tinted.
    root: { paddingTop: 11, paddingBottom: 12 },
    separated: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.default },
    // Cards beside the chat keep the Board grid's gap between them.
    cardGap: { marginBottom: 10 },
    controls: { flexDirection: 'row', alignItems: 'center', gap: 2 },
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

type SessionCompanionItemFrameProps = Readonly<{
    /** The item's own accessible name, from its canonical presentation owner. */
    label: string;
    actions: readonly ItemAction[];
    /**
     * The item body. It receives this placement's controls (reorder handle and
     * item menu) and draws them at the end of its own header line, so the item
     * keeps one header and the frame adds no second title row.
     */
    children: (headerAccessory: React.ReactNode, instanceView?: SessionCompanionInstanceView) => React.ReactNode;
    /** Every item after the first sits under a hairline. */
    separated?: boolean;
    /**
     * The item draws itself in the widget frame (Plan, Board widgets, glances), which owns its own
     * hairline (plain) or card and its insets; this frame then adds no padding or hairline of its own.
     */
    flush?: 'plain' | 'card';
    testID: string;
    onLayout?: (event: LayoutChangeEvent) => void;
    /** Absent while measuring or without a current qualified Companion owner. */
    entityDrag?: SessionSurfaceEntityBinding;
    /** A direct personal widget copy (never a Board reference); absent while measuring. */
    instanceControls?: SessionCompanionInstanceControls;
}>;

/**
 * The Companion's local frame around one item.
 *
 * It owns ONLY placement-local affordances — reorder, remove-from-Companion and
 * Open on Board. Title, provenance, typed states and renderer selection stay with
 * `SessionWidgetHost` (or, for the built-in card, with the summary itself), so
 * this frame never becomes a second item shell or a second copy of the shared
 * state table.
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
    const installed = React.useMemo(() => readWidgetDescriptor(projection, instance.definition), [instance.definition, projection]);
    const candidate = useWidgetInstanceDescriptor(scope, instance, installed);
    const inputs = useWidgetInputsEditor({ instance, candidate, scope, context, audience: 'personal', setInputs, testID: props.testID });
    const title = instance.displayName ?? candidate?.title ?? props.label;
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
    const definition = useWidgetDefinitionFlows({ instance, scope, anchorRef: inputs.anchorRef, editInputs, testID: props.testID });
    // The lab order (dbind E): this copy's entries, how it sits here, About, then Remove last.
    const actions = React.useMemo<readonly ItemAction[]>(() => orderWidgetMenu({
        instance: buildWidgetInstanceActions({ editInputs, onRename: beginRename }),
        frame: props.actions.filter((action) => !isRemoval(action)),
        definition: buildWidgetDefinitionActions({ onAbout: definition.about }),
        remove: props.actions.filter(isRemoval),
    }), [beginRename, definition.about, editInputs, props.actions]);
    const view = React.useMemo<SessionCompanionInstanceView>(() => ({
        titleEditor: renaming.field,
        ...(inputs.onRepairInputs ? { onRepairInputs: inputs.onRepairInputs } : {}),
    }), [inputs.onRepairInputs, renaming.field]);
    const children = props.children;
    return (
        <>
            <ItemFrameBody {...props} label={title} actions={actions} controlsRef={inputs.anchorRef}>
                {(accessory) => children(accessory, view)}
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
            style={[props.flush ? (props.flush === 'card' ? styles.cardGap : null) : styles.root, !props.flush && props.separated ? styles.separated : null]}
            testID={props.testID}
            onLayout={event => { props.onLayout?.(event); drag.onLayout(event); }}
        >
            {props.children(accessory)}
            <SessionSurfaceEntityTargetFeedback drag={drag} testID={props.testID} />
        </View>
    );
}

/** Removing this reference (or anything destructive) stays the menu's last entry. */
function isRemoval(action: ItemAction): boolean {
    return action.id === 'remove' || action.destructive === true;
}
