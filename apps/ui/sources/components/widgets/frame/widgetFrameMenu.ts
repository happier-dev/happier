import type { ItemAction } from '@/components/ui/lists/itemActions';
import { t } from '@/text';

import type { WidgetFramePlacement, WidgetFrameStyle } from './WidgetFrame';
import { resolveWidgetFrameStyleToggle } from './widgetFrameStyle';

function styleLabel(style: WidgetFrameStyle): string {
    return style === 'card' ? t('widgetFrame.styleCard') : t('widgetFrame.stylePlain');
}

export function widgetFrameSurfaceLabel(placement: WidgetFramePlacement): string {
    switch (placement) {
        case 'home': return t('widgetFrame.surfaceHome');
        case 'board': return t('widgetFrame.surfaceBoard');
        case 'companion': return t('widgetFrame.surfaceCompanion');
    }
}

/**
 * The widget ⋯ menu's frame entries (lab WK/WKm), the same on Home, the Board and the Companion:
 * "Show frame" / "Hide frame" for this widget only, saying what the surface uses, and — once the
 * widget has an override — "Use the {surface} default". `onSet(null)` removes the override.
 */
export function buildWidgetFrameStyleActions(input: Readonly<{
    placement: WidgetFramePlacement;
    surfaceDefault: WidgetFrameStyle;
    override: WidgetFrameStyle | null | undefined;
    onSet: (style: WidgetFrameStyle | null) => void;
    group?: ItemAction['group'];
    /** The surface's own name when it is not one of the placements' ("this page", "this project"). */
    surfaceLabel?: string;
}>): ItemAction[] {
    const toggle = resolveWidgetFrameStyleToggle({
        placement: input.placement,
        surfaceDefault: input.surfaceDefault,
        override: input.override ?? null,
    });
    const surface = input.surfaceLabel ?? widgetFrameSurfaceLabel(input.placement);
    const group = input.group ? { group: input.group } : {};
    const actions: ItemAction[] = [{
        id: 'frameStyle',
        title: toggle.toggleTo === 'card' ? t('widgetFrame.showFrame') : t('widgetFrame.hideFrame'),
        subtitle: toggle.canReset
            ? t('widgetFrame.thisWidgetOnly')
            : `${t('widgetFrame.thisWidgetOnly')} · ${t('widgetFrame.surfaceUses', { surface, style: styleLabel(input.surfaceDefault) })}`,
        icon: toggle.toggleTo === 'card' ? 'square' : 'file-dashed',
        onPress: () => input.onSet(toggle.toggleTo),
        ...group,
    }];
    if (toggle.canReset) {
        actions.push({
            id: 'frameStyleReset',
            title: t('widgetFrame.useSurfaceDefault', { surface }),
            subtitle: t('widgetFrame.likeTheOthers', { style: styleLabel(input.surfaceDefault) }),
            icon: 'arrow-arc-left',
            onPress: () => input.onSet(null),
            ...group,
        });
    }
    return actions;
}

/**
 * A widget's ⋯ in the lab's order (`dashboards` dbind E), the same on every surface: Edit inputs…
 * and Rename (this copy), then how it sits (width, frame, movement), then About, then the surface's
 * own entries, and Remove last. Each group exists only when its surface supplied it, so a control
 * never appears without a producer behind it.
 */
export function orderWidgetMenu(groups: Readonly<{
    instance?: readonly ItemAction[];
    width?: readonly ItemAction[];
    frame?: readonly ItemAction[];
    move?: readonly ItemAction[];
    /** About this widget (and, on a Session Board card, Save as your widget and Post a snapshot). */
    definition?: readonly ItemAction[];
    /** The surface's own entries (Open, Customize Home). */
    surface?: readonly ItemAction[];
    remove?: readonly ItemAction[];
}>): ItemAction[] {
    return [
        ...(groups.instance ?? []),
        ...(groups.width ?? []),
        ...(groups.frame ?? []),
        ...(groups.move ?? []),
        ...(groups.definition ?? []),
        ...(groups.surface ?? []),
        ...(groups.remove ?? []),
    ];
}

/**
 * Moving a widget from its ⋯: one Move… where the surface has the Organize chooser (every place it
 * can go, here or on another surface), else one step earlier or later — and only the steps that do
 * something: nothing for a single widget, no "up" for the first.
 */
export function buildWidgetMoveActions(input: Readonly<{
    index: number;
    count: number;
    /** The Organize chooser (the shared drag handle's keyboard/touch path). */
    chooser?: (() => void) | undefined;
    onMove?: ((delta: -1 | 1) => void) | undefined;
    labels?: Readonly<{ earlier: string; later: string }>;
}>): ItemAction[] {
    // The chooser also lists other places it can go, so it stays for a single widget.
    if (input.chooser) return [{ id: 'moveTo', title: t('widgetAdd.moveTo'), icon: 'arrows-down-up' as const, onPress: input.chooser }];
    const onMove = input.onMove;
    if (!onMove || input.count < 2) return [];
    return [
        ...(input.index > 0 ? [{ id: 'moveUp', title: input.labels?.earlier ?? t('common.moveUp'), icon: 'caret-up' as const, onPress: () => onMove(-1) }] : []),
        ...(input.index < input.count - 1 ? [{ id: 'moveDown', title: input.labels?.later ?? t('common.moveDown'), icon: 'caret-down' as const, onPress: () => onMove(1) }] : []),
    ];
}

/**
 * A configured copy's own entries in its ⋯ (lab `dashboards` dbind E), the same on every personal
 * surface: Edit inputs… repeating the current binding, then Rename.
 */
export function buildWidgetInstanceActions(input: Readonly<{
    editInputs?: Readonly<{ onPress: () => void; binding: string | null }> | undefined;
    onRename?: (() => void) | undefined;
}>): ItemAction[] {
    return [
        ...(input.editInputs ? [{
            id: 'editInputs',
            title: t('widgetAdd.editInputs'),
            ...(input.editInputs.binding ? { subtitle: input.editInputs.binding } : {}),
            icon: 'sliders-horizontal' as const,
            onPress: input.editInputs.onPress,
        }] : []),
        ...(input.onRename ? [{ id: 'rename', title: t('common.rename'), icon: 'text-aa' as const, onPress: input.onRename }] : []),
    ];
}

/**
 * A widget's width where its surface has the one width step (lab `dashboards` dlayout Q8: Home and
 * plugin areas, half | full): half sits two to a row, full takes the row. The current width is checked.
 */
export function buildWidgetWidthActions(input: Readonly<{
    width: 'half' | 'full';
    onSet: (width: 'half' | 'full') => void;
}>): ItemAction[] {
    return (['half', 'full'] as const).map((width) => ({
        id: `width-${width}`,
        title: width === 'half' ? t('widgetAdd.widthHalf') : t('widgetAdd.widthFull'),
        icon: width === 'half' ? 'square-split-horizontal' as const : 'square' as const,
        selected: input.width === width,
        group: { id: 'width', title: t('widgetAdd.width') },
        onPress: () => { if (input.width !== width) input.onSet(width); },
    }));
}

/**
 * A widget definition's own entries (lab `dashboards` dagent G2/G3, dscope VS), the same in every
 * ⋯: About this widget; on a Session Board card, Save as your widget and Post a snapshot. Each exists
 * only when its flow can succeed here.
 */
export function buildWidgetDefinitionActions(input: Readonly<{
    onAbout?: (() => void) | undefined;
    onSaveAsYours?: (() => void) | undefined;
    onPostSnapshot?: (() => void) | undefined;
    group?: ItemAction['group'];
}>): ItemAction[] {
    const group = input.group ? { group: input.group } : {};
    return [
        ...(input.onAbout ? [{ id: 'about', title: t('widgetDefinition.aboutMenu'), icon: 'info' as const, onPress: input.onAbout, ...group }] : []),
        ...(input.onSaveAsYours ? [{ id: 'saveAsYours', title: t('widgetDefinition.saveMenu'), subtitle: t('widgetDefinition.saveMenuSubtitle'),
            icon: 'floppy-disk' as const, onPress: input.onSaveAsYours, ...group }] : []),
        ...(input.onPostSnapshot ? [{ id: 'postSnapshot', title: t('widgetDefinition.snapshotMenu'), subtitle: t('widgetDefinition.snapshotMenuSubtitle'),
            icon: 'cloud' as const, onPress: input.onPostSnapshot, ...group }] : []),
    ];
}
