import * as React from 'react';
import { View } from 'react-native';

import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { RowActionRevealSlot } from '@/components/ui/lists/RowActionRevealSlot';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { t } from '@/text';

import { useWidgetFrameSurfaceDefault } from '@/components/widgets/frame/useWidgetFrameStyle';
import {
    buildWidgetDefinitionActions,
    buildWidgetFrameStyleActions,
    buildWidgetInstanceActions,
    buildWidgetMoveActions,
    buildWidgetSizeActions,
    orderWidgetMenu,
    useWidgetMenuAlwaysShown,
    WIDGET_MENU_MAX_HEIGHT_PX,
} from '@/components/widgets/frame/widgetFrameMenu';

import { homeHubSectionTitle, isHomeHubCardSection } from '../homeHubSections';
import type { HomeHubSection } from './homeHubLayout';
import type { HomeHubLayout } from './useHomeHubLayout';
import { normalizeWidgetSizeForSurfaceV1, resolveWidgetSizeChoicesV1 } from '@happier-dev/protocol/widgets';
import { renderWidgetSizeMenuSection, stepWidgetSizeControl, type WidgetSizeControl } from '@/components/widgets/frame/WidgetSizeControl';

/** Every action sits in the overflow menu: the header shows one quiet "⋯". */
const ALWAYS_OVERFLOW = Number.POSITIVE_INFINITY;

/**
 * A home section's "⋯": open a widget's page, hide or remove the section, move it, or customize
 * the whole home. In a widget frame the frame shows it (a card always; a plain section on hover or focus);
 * a frameless built-in shows it while hovered or focused with a fine pointer, and always on touch.
 */
export function HubSectionMenu(props: Readonly<{
    section: HomeHubSection<WidgetCandidate>;
    index: number;
    layout: HomeHubLayout;
    /** A frameless built-in's row is hovered (its only reveal); a framed section's frame decides. */
    hovered?: boolean;
    onCustomize: () => void;
    /** A widget whose plugin has one page opens it from here. */
    onOpen?: () => void;
    /** A configurable widget's Edit inputs… (lab dbind E): this copy only; the line repeats its binding. */
    editInputs?: Readonly<{ onPress: () => void; binding: string | null }>;
    /** Where Edit inputs anchors (the ⋯ itself). */
    anchorRef?: React.RefObject<View | null>;
    /** Renames this copy in place (lab dbind E): optional, its binding already names it. */
    onRename?: () => void;
    /** An HTML copy's Network access… (the Board's panel). */
    onNetwork?: () => void;
    /** About this widget, for a copy of one of the Account's own widgets (lab dagent G2). */
    onAbout?: () => void;
    onAddTo?: () => void;
    /**
     * Inside a group (lab widget-groups C): no frame entry, movement steps within the group, and
     * Remove takes the widget off Home rather than hiding a section.
     */
    inGroup?: Readonly<{ index: number; count: number; onMove: (delta: -1 | 1) => void }>;
    /** Move to group / Remove from group / Ungroup, or Group with… (`buildWidgetGroupMembershipActions`). */
    groupActions?: readonly ItemAction[];
    /** Inside a half group: the sizes it cannot take there, and why. */
    sizeLimit?: WidgetSizeControl['unavailable'];
}>) {
    const { section, layout } = props;
    // A section drawn in the widget frame leaves its ⋯ to the frame (card: shown; plain: rests unseen on a hover
    // pointer). Only a frameless built-in (Attention, Setup) reveals it here: with the hovered row, on touch, or on focus.
    const framed = isHomeHubCardSection(section);
    const revealed = useWidgetMenuAlwaysShown() || props.hovered === true;
    const title = homeHubSectionTitle(section);
    const surfaceDefault = useWidgetFrameSurfaceDefault('home');
    // Menu events consume rejection; the layout queue retains the failed intent for Customize's Retry.
    // Only sections drawn in the widget frame have a frame to show or hide.
    const frameActions = framed && !props.inGroup
        ? buildWidgetFrameStyleActions({
            placement: 'home',
            surfaceDefault,
            override: section.frameStyle,
            onSet: (style) => layout.setFrameStyle(section.id, style).catch(() => {}),
        })
        : [];

    // The candidate's useful variants intersected with Home's one presentation policy.
    const sizes = section.kind === 'widget' ? resolveWidgetSizeChoicesV1('home', section.widget?.sizeDeclaration) : null;
    const sizeControl: WidgetSizeControl | undefined = section.kind === 'widget' && section.widget && sizes?.defaultSize ? {
        surface: 'home', sizes: sizes.sizes,
        size: normalizeWidgetSizeForSurfaceV1('home', section.size, section.widget?.sizeDeclaration)!,
        onSet: size => { void layout.setSize(section.instance.id, size).catch(() => {}); },
        ...(props.sizeLimit ? { unavailable: props.sizeLimit } : {}),
    } : undefined;

    const actions = (
            <ItemRowActions
                title={title}
                compactThreshold={ALWAYS_OVERFLOW}
                compactActionIds={[]}
                // Every entry of a grouped widget's menu shows at once; nothing is cut at the menu's foot.
                overflowMaxHeightCap={WIDGET_MENU_MAX_HEIGHT_PX}
                overflowTriggerTestID={`home-hub.${section.id}.menuTrigger`}
                overflowTriggerAccessibilityLabel={`${section.kind === 'widget' ? t('widgetAdd.widgetOptions') : t('settingsOverview.homeSectionOptions')}: ${title}`}
                onOverflowTriggerKeyDown={key => stepWidgetSizeControl(sizeControl, key)}
                renderOverflowSection={({ id }) => renderWidgetSizeMenuSection(sizeControl, id, `home-hub.${section.id}.size`)}
                actions={orderWidgetMenu({
                    instance: buildWidgetInstanceActions({ editInputs: props.editInputs, onRename: props.onRename, onNetwork: props.onNetwork }),
                    size: buildWidgetSizeActions(sizeControl),
                    frame: frameActions,
                    move: [
                        ...(props.inGroup ? buildWidgetMoveActions(props.inGroup) : buildWidgetMoveActions({
                            index: props.index,
                            count: layout.sections.length,
                            onMove: (delta) => { void layout.move(section.id, delta).catch(() => {}); },
                        })),
                        ...(props.groupActions ?? []),
                    ],
                    definition: buildWidgetDefinitionActions({ onAbout: props.onAbout, onAddTo: props.onAddTo }),
                    surface: [
                        ...(props.onOpen ? [{ id: 'open', title: t('common.open'), icon: 'arrow-square-out' as const, onPress: props.onOpen }] : []),
                        { id: 'customize', title: t('settingsOverview.homeCustomize'), icon: 'sliders-horizontal' as const, onPress: props.onCustomize },
                    ],
                    remove: section.hideable ? [{
                        id: 'hide',
                        title: section.kind === 'widget'
                            ? t('settingsOverview.homeRemoveWidget')
                            : t('settingsOverview.homeHideSection'),
                        icon: 'eye-slash' as const,
                        onPress: () => { void (section.kind === 'widget' ? layout.remove(section.id) : layout.setHidden(section.id, true)).catch(() => {}); },
                    }] : [],
                })}
            />
    );
    return (
        <View
            ref={props.anchorRef}
            collapsable={false}
            testID={`home-hub.${section.id}.menu`}
        >
            {framed ? actions : <RowActionRevealSlot revealed={revealed}>{actions}</RowActionRevealSlot>}
        </View>
    );
}
