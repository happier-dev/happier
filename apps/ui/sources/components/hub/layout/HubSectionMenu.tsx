import * as React from 'react';
import { Platform, View } from 'react-native';

import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { readCoarsePrimaryPointer } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { t } from '@/text';

import { useWidgetFrameSurfaceDefault } from '@/components/widgets/frame/useWidgetFrameStyle';
import {
    buildWidgetDefinitionActions,
    buildWidgetFrameStyleActions,
    buildWidgetInstanceActions,
    buildWidgetMoveActions,
    buildWidgetWidthActions,
    orderWidgetMenu,
} from '@/components/widgets/frame/widgetFrameMenu';

import { homeHubSectionTitle, isHomeHubCardSection } from '../homeHubSections';
import type { HomeHubSection } from './homeHubLayout';
import type { HomeHubLayout } from './useHomeHubLayout';

/** Every action sits in the overflow menu: the header shows one quiet "⋯". */
const ALWAYS_OVERFLOW = Number.POSITIVE_INFINITY;

/**
 * A home section's "⋯": open a widget's page, hide or remove the section, move it, or customize
 * the whole home. With a fine pointer it appears while the section is hovered or the menu has
 * keyboard focus; touch always shows it.
 */
export function HubSectionMenu(props: Readonly<{
    section: HomeHubSection<WidgetCandidate>;
    index: number;
    layout: HomeHubLayout;
    hovered: boolean;
    onCustomize: () => void;
    /** A widget whose plugin has one page opens it from here. */
    onOpen?: () => void;
    /** A configurable widget's Edit inputs… (lab dbind E): this copy only; the line repeats its binding. */
    editInputs?: Readonly<{ onPress: () => void; binding: string | null }>;
    /** Where Edit inputs anchors (the ⋯ itself). */
    anchorRef?: React.RefObject<View | null>;
    /** Renames this copy in place (lab dbind E): optional, its binding already names it. */
    onRename?: () => void;
    /** About this widget, for a copy of one of the Account's own widgets (lab dagent G2). */
    onAbout?: () => void;
}>) {
    const [focused, setFocused] = React.useState(false);
    const alwaysVisible = Platform.OS !== 'web' || readCoarsePrimaryPointer();
    const visible = alwaysVisible || props.hovered || focused;
    const { section, layout } = props;
    const title = homeHubSectionTitle(section);
    const surfaceDefault = useWidgetFrameSurfaceDefault('home');
    // Menu events consume rejection; the layout queue retains the failed intent for Customize's Retry.
    // Only sections drawn in the widget frame have a frame to show or hide.
    const frameActions = isHomeHubCardSection(section)
        ? buildWidgetFrameStyleActions({
            placement: 'home',
            surfaceDefault,
            override: section.frameStyle,
            onSet: (style) => layout.setFrameStyle(section.id, style).catch(() => {}),
        })
        : [];

    // A widget's width on Home: half (two to a row) or the whole row (lab dlayout H2).
    const widthActions = section.kind === 'widget'
        ? buildWidgetWidthActions({ width: section.width, onSet: (width) => { void layout.setWidth(section.instance.id, width).catch(() => {}); } })
        : [];

    return (
        <View
            ref={props.anchorRef}
            collapsable={false}
            testID={`home-hub.${section.id}.menu`}
            style={{ opacity: visible ? 1 : 0 }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
        >
            <ItemRowActions
                title={title}
                compactThreshold={ALWAYS_OVERFLOW}
                compactActionIds={[]}
                overflowTriggerTestID={`home-hub.${section.id}.menuTrigger`}
                overflowTriggerAccessibilityLabel={`${section.kind === 'widget' ? t('widgetAdd.widgetOptions') : t('settingsOverview.homeSectionOptions')}: ${title}`}
                actions={orderWidgetMenu({
                    instance: buildWidgetInstanceActions({ editInputs: props.editInputs, onRename: props.onRename }),
                    width: widthActions,
                    frame: frameActions,
                    move: buildWidgetMoveActions({
                        index: props.index,
                        count: layout.sections.length,
                        onMove: (delta) => { void layout.move(section.id, delta).catch(() => {}); },
                    }),
                    definition: buildWidgetDefinitionActions({ onAbout: props.onAbout }),
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
                        onPress: () => { void layout.setHidden(section.id, true).catch(() => {}); },
                    }] : [],
                })}
            />
        </View>
    );
}
