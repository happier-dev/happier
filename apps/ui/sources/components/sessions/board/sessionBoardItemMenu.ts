import {
    SessionBoardItemWidthSchema,
    type SessionBoardItemWidth,
    type SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';

import type { ItemAction } from '@/components/ui/lists/itemActions';
import type { WidgetFrameStyle } from '@/components/widgets/frame/WidgetFrame';
import { buildWidgetDefinitionActions, buildWidgetFrameStyleActions, buildWidgetSizeActions } from '@/components/widgets/frame/widgetFrameMenu';
import type { WidgetSizeControl } from '@/components/widgets/frame/WidgetSizeControl';
import { t } from '@/text';

import type { SessionWidgetDensity } from './SessionWidgetHost';
import { resolveFitContentHeight } from './sessionBoardItemHeight';
import { isSessionBoardItemEditableInPlace } from './sessionBoardItemPresentation';
import { canPromoteSessionWidgetDefinitionSourceV1 } from '@happier-dev/protocol/widgets/widgetDefinitionPromotionV1';
import { readSessionVisualNetworkChoice } from './sessionBoardVisualNetwork';

/**
 * The widget card's reachable operations, in one place.
 *
 * Built the same way the Companion builds its own item menu: every entry exists
 * only because its handler was supplied, so a control never appears without a
 * producer behind it. Applied choices announce as SELECTED rather than disabled —
 * a valid value that is already in effect is chosen, not unavailable.
 *
 * Order is the hierarchy. Reading and editing come first, then movement, then
 * geometry, and destruction is last and marked destructive, so the menu never
 * puts a shared deletion where the pointer comes to rest.
 */

export type SessionBoardItemMenuInput = Readonly<{
    density: SessionWidgetDensity;
    /** Lane 04 `editSessionRecords`. Without it the card is readable and nothing more. */
    canEdit: boolean;
    /** `null` while the record is not openable; only a ready item has operations. */
    item: SessionSurfaceItemV1 | null;
    /** The placement's current semantic width, announced as the selected value. */
    width?: SessionBoardItemWidth | undefined;
    onReadFull?: (() => void) | undefined;
    onEdit?: (() => void) | undefined;
    /** Starts the inline title editor. Present so rename is not pointer-only. */
    onRename?: (() => void) | undefined;
    /** A configured widget's Edit inputs… (lab dbind E): this copy only; the line repeats its binding. */
    editInputs?: Readonly<{ onPress: () => void; binding: string | null }> | undefined;
    /** The widget definition flows this card offers (About, Save as your widget, Post a snapshot). */
    definition?: Readonly<{ onAbout?: (() => void) | undefined; onAddTo?: (() => void) | undefined; onSaveAsYours?: (() => void) | undefined; onPostSnapshot?: (() => void) | undefined }>;
    /** Opens the Network access flow of an HTML visual. Editors only; present only when the controller can save it. */
    onEditNetwork?: (() => void) | undefined;
    visualCopy?: Readonly<{ onSaveArtifact?: (() => void) | undefined; onShare?: (() => void) | undefined;
        /** An independent copy of this exact revision in another Session (any source kind). */
        onCopyToSession?: (() => void) | undefined }>;
    onMove?: ((direction: 'before' | 'after') => void) | undefined;
    canMoveBefore?: boolean | undefined;
    canMoveAfter?: boolean | undefined;
    moveDestinations?: readonly Readonly<{ id: string; title: string }>[] | undefined;
    onMoveToView?: ((viewId: string) => void) | undefined;
    onResize?: ((width: SessionBoardItemWidth) => void) | undefined;
    sizeControl?: WidgetSizeControl;
    /** Ephemeral renderer measurement used only to choose an allowed semantic fallback. */
    reportedHeight?: number | null | undefined;
    onSetHeight?: ((height: SessionSurfaceItemV1['height']) => void) | undefined;
    /** Viewer-local placement only; it never mutates or duplicates the shared item. */
    onAddToCompanion?: (() => void) | undefined;
    /** Viewer-local inverse of `onAddToCompanion`; deliberately non-destructive. */
    onRemoveFromCompanion?: (() => void) | undefined;
    /** Adds a Board placement for an item shown outside the Board (a reply): the same item, never a copy. */
    onPinToBoard?: (() => void) | undefined;
    /** Drops this view's placement. The shared record survives. */
    onUnpin?: (() => void) | undefined;
    /** Deletes the shared record and every placement, through the shared Action. */
    onRemove?: (() => void) | undefined;
    /**
     * A reply's Board facts (placement, revisions) are still loading for a viewer who may edit. The rows this
     * item predicts (Pin, Edit, Network access…, Delete) are drawn in their final place, disabled until their
     * handlers arrive, so nothing is inserted under the pointer. Compact density only.
     */
    boardFactsPending?: boolean | undefined;
    /**
     * This placement's frame override, shared with everyone (stored with the Board layout, like
     * width): Show/Hide frame and the way back to the Board's Appearance default. Editors only.
     */
    frame?: Readonly<{
        surfaceDefault: WidgetFrameStyle;
        override: WidgetFrameStyle | null | undefined;
        onSet: (style: WidgetFrameStyle | null) => void;
    }> | undefined;
}>;

export function buildSessionBoardItemActions(input: SessionBoardItemMenuInput): ItemAction[] {
    const item = input.item;
    if (input.density === 'preview' || !item) return [];

    const actions: ItemAction[] = [];
    const contentGroup = { id: 'content', title: t('sessionBoard.item.menuGroups.content') } as const;
    const movementGroup = { id: 'movement', title: t('sessionBoard.item.menuGroups.movement') } as const;
    const geometryGroup = { id: 'geometry', title: t('sessionBoard.item.menuGroups.geometry') } as const;
    const destructiveGroup = { id: 'destructive', title: t('sessionBoard.item.menuGroups.destructive') } as const;

    // A long or read-only note is never solved by clipping: the canonical
    // full-content route stays reachable from every density.
    if (input.onReadFull && item.source.kind === 'declarative') {
        actions.push({
            id: 'read-full',
            title: t('sessionBoard.item.actions.readFull'),
            icon: 'article',
            group: contentGroup,
            onPress: input.onReadFull,
        });
    }

    // Companion placement is a readable viewer-local action, not a Board edit.
    // Keep it before the edit-access return so collaborators who may read this
    // item can still keep it beside Chat without gaining record mutation rights.
    if (input.onRemoveFromCompanion) {
        actions.push({
            id: 'remove-from-companion',
            title: t('sessionBoard.companion.actions.removeFromCompanion'),
            icon: 'stack-simple',
            group: contentGroup,
            onPress: input.onRemoveFromCompanion,
        });
    } else if (input.onAddToCompanion) {
        actions.push({
            id: 'add-to-companion',
            title: t('sessionBoard.companion.actions.addToCompanion'),
            icon: 'stack-simple',
            group: contentGroup,
            onPress: input.onAddToCompanion,
        });
    }

    // Pin is a placement of this same item through the Board's layout owner, so it sits with the
    // other places the item can be shown, before the copies that cross to the Account.
    const pending = input.boardFactsPending === true && input.density !== 'full';
    if (input.onPinToBoard || pending) {
        actions.push({
            id: 'pin-to-board',
            title: t('sessionBoard.item.actions.pinToBoard'),
            icon: 'push-pin',
            group: contentGroup,
            ...(input.onPinToBoard ? { onPress: input.onPinToBoard } : { disabled: true }),
        });
    }

    // About and Save as your widget only read the item; Post a snapshot is offered only to an editor
    // by its producer. All three reach readers of this Session alike.
    const promotable = canPromoteSessionWidgetDefinitionSourceV1(item.source);
    actions.push(...buildWidgetDefinitionActions({ ...input.definition,
        ...(!promotable ? { onAddTo: undefined, onSaveAsYours: undefined } : {}), group: contentGroup }));
    if (input.visualCopy?.onSaveArtifact) actions.push({ id: 'saveArtifact', title: t('widgetDefinition.visualSaveMenu'),
        icon: 'floppy-disk', group: contentGroup, onPress: input.visualCopy.onSaveArtifact });
    if (input.visualCopy?.onCopyToSession) actions.push({ id: 'copyToSession', title: t('widgetDefinition.visualCopyToSessionMenu'),
        icon: 'copy', group: contentGroup, onPress: input.visualCopy.onCopyToSession });
    if (promotable && input.visualCopy?.onShare) actions.push({ id: 'shareVisual', title: t('widgetDefinition.visualShareMenu'),
        icon: 'link', group: contentGroup, onPress: input.visualCopy.onShare });

    if (input.density !== 'full' || !input.canEdit) {
        // A compact placement or a transcript reply edits and deletes the same shared item as the
        // Board (content and deletion only; placement geometry belongs to the Board). Deletion is
        // deliberately distinct from the viewer-local Companion removal above, capability-gated and destructive.
        // While the Board facts load, the rows the item itself predicts hold their place, disabled.
        const edit = input.canEdit ? input.onEdit : undefined;
        const network = input.canEdit ? input.onEditNetwork : undefined;
        const remove = input.canEdit ? input.onRemove : undefined;
        const held = (handler: (() => void) | undefined) => handler ? { onPress: handler } : { disabled: true };
        if (isSessionBoardItemEditableInPlace(item) && (edit || pending)) {
            actions.push({ id: 'edit', title: t('common.edit'), icon: 'pencil', group: contentGroup, ...held(edit) });
        }
        if (network || (pending && readSessionVisualNetworkChoice(item) !== null)) {
            actions.push({ id: 'network', title: t('sessionBoard.item.actions.network'), icon: 'globe', group: contentGroup, ...held(network) });
        }
        if (remove || pending) {
            actions.push({
                id: 'remove',
                title: t('sessionBoard.item.actions.remove'),
                icon: 'trash',
                group: destructiveGroup,
                destructive: true,
                ...held(remove),
            });
        }
        return actions;
    }

    if (input.editInputs) {
        actions.push({
            id: 'edit-inputs',
            title: t('widgetAdd.editInputs'),
            ...(input.editInputs.binding ? { subtitle: input.editInputs.binding } : {}),
            icon: 'sliders-horizontal',
            group: contentGroup,
            onPress: input.editInputs.onPress,
        });
    }
    if (input.onEdit && isSessionBoardItemEditableInPlace(item)) {
        actions.push({ id: 'edit', title: t('common.edit'), icon: 'pencil', group: contentGroup, onPress: input.onEdit });
    }
    if (input.onEditNetwork) {
        actions.push({ id: 'network', title: t('sessionBoard.item.actions.network'), icon: 'globe', group: contentGroup, onPress: input.onEditNetwork });
    }
    if (input.onRename) {
        // Pressing the title starts the same editor for a pointer. This entry is
        // how a keyboard and a screen reader reach it at all.
        actions.push({
            id: 'rename',
            title: t('sessionBoard.item.actions.rename'),
            icon: 'text-aa',
            group: contentGroup,
            onPress: input.onRename,
        });
    }
    if (input.onMove && input.canMoveBefore !== false) {
        actions.push({
            id: 'move-before',
            title: t('common.moveUp'),
            icon: 'arrow-up',
            group: movementGroup,
            onPress: () => input.onMove?.('before'),
        });
    }
    if (input.onMove && input.canMoveAfter !== false) {
        actions.push({
            id: 'move-after',
            title: t('common.moveDown'),
            icon: 'arrow-down',
            group: movementGroup,
            onPress: () => input.onMove?.('after'),
        });
    }
    if (input.onMoveToView) {
        for (const destination of input.moveDestinations ?? []) {
            actions.push({
                id: `move-view-${destination.id}`,
                // One authored phrase per locale. Joining an unrelated strip label
                // and a colon in code produced a menu entry with no verb that no
                // translator ever saw.
                title: t('sessionBoard.item.actions.moveToView', { title: destination.title }),
                icon: 'arrow-right',
                group: movementGroup,
                onPress: () => input.onMoveToView?.(destination.id),
            });
        }
    }
    actions.push(...buildWidgetSizeActions(input.sizeControl));
    if (!input.sizeControl && input.onResize && item.source.kind !== 'widget') {
        for (const width of SessionBoardItemWidthSchema.options) {
            actions.push({
                id: `resize-${width}`,
                title: t(`sessionBoard.width.${width}`),
                icon: width === 'full' ? 'arrows-out' : 'arrows-left-right',
                group: geometryGroup,
                // The current width is CHECKED, never disabled: disabling would
                // announce a perfectly valid value as unavailable.
                selected: input.width === width,
                onPress: () => input.onResize?.(width),
            });
        }
    }
    if (input.onSetHeight) {
        const height = item.height;
        // Auto remains the native measurement mode. Widgets choose fixed variants
        // through the shared size picker; other Board sources retain their height choices.
        actions.push({
            id: 'height-auto',
            title: t('sessionBoard.height.auto'),
            icon: 'arrows-out-cardinal',
            group: geometryGroup,
            selected: height.mode === 'auto',
            onPress: () => input.onSetHeight?.(resolveFitContentHeight(input.reportedHeight)),
        });
        if (item.source.kind !== 'widget') {
            for (const size of ['compact', 'regular', 'tall'] as const) {
                actions.push({
                    id: `height-${size}`,
                    title: t(`sessionBoard.height.${size}`),
                    icon: 'arrows-down-up',
                    group: geometryGroup,
                    selected: height.mode === 'fixed' && height.size === size,
                    onPress: () => input.onSetHeight?.({ mode: 'fixed', size }),
                });
            }
        }
    }
    if (input.frame) {
        actions.push(...buildWidgetFrameStyleActions({ placement: 'board', ...input.frame, group: geometryGroup }));
    }
    if (input.onUnpin) {
        actions.push({
            id: 'unpin',
            title: t('sessionBoard.item.actions.unpin'),
            icon: 'eye-slash',
            group: destructiveGroup,
            onPress: input.onUnpin,
        });
    }
    if (input.onRemove) {
        actions.push({
            id: 'remove',
            title: t('sessionBoard.item.actions.remove'),
            icon: 'trash',
            group: destructiveGroup,
            destructive: true,
            onPress: input.onRemove,
        });
    }
    return actions;
}
