import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { HappierSurface } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet } from 'react-native-unistyles';

import { shadowLevelStyle } from '@/shadowElevation';
import { resolveThemeSurfaceChromeStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { resolveThemeRaisedEdge } from '@/components/ui/surfaces/themeRaisedEdge';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useListPresentation } from '@/components/ui/lists/listPresentation';
import { GROUPED_SURFACE_RADIUS_PX, PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';

/**
 * `flat` draws no chrome at all: the content is one section of a column that already
 * separates its sections (the Companion). It keeps the card's one element topology,
 * so a host that switches tone never remounts its content.
 */
type SurfaceCardTone = 'surface' | 'muted' | 'flat';
export type SurfaceCardPadding = 'none' | 'sm' | 'md' | 'lg';

/**
 * The card's corner and inset, published rather than copied.
 *
 * A consumer that has to reach the card's true edge — full-bleed media, an
 * embedded surface, a renderer that owns its own frame — needs the exact numbers
 * this card draws with. Publishing them keeps that consumer correct at every
 * padding step; hardcoding "18" beside it silently overhangs the card at `sm`
 * and clips outside its rounded corner.
 */
export const SURFACE_CARD_RADIUS_PX: number = GROUPED_SURFACE_RADIUS_PX;

export const SURFACE_CARD_PADDING_PX: Readonly<Record<
    SurfaceCardPadding,
    Readonly<{ horizontal: number; vertical: number }>
>> = Object.freeze({
    none: Object.freeze({ horizontal: 0, vertical: 0 }),
    sm: Object.freeze({ horizontal: 14, vertical: 12 }),
    md: Object.freeze({ horizontal: 18, vertical: 16 }),
    lg: Object.freeze({ horizontal: 22, vertical: 20 }),
});

type SurfaceCardProps = Readonly<{
    children: React.ReactNode;
    testID?: string;
    onPress?: () => void;
    tone?: SurfaceCardTone;
    padding?: SurfaceCardPadding;
    style?: StyleProp<ViewStyle>;
    /** Fill the parent's height (a card in a grid row that shares its height with its neighbours). */
    fill?: boolean;
}>;

const FILL_STYLE = { flexGrow: 1 } as const;

const styles = StyleSheet.create((theme) => {
    return {
        cardBase: {
            width: '100%',
            minWidth: 0,
            borderRadius: SURFACE_CARD_RADIUS_PX,
            backgroundColor: theme.colors.edge.cardFill,
            ...resolveThemeSurfaceChromeStyle({
                borderColor: theme.colors.border.surface,
                edge: resolveThemeRaisedEdge(theme, 'surface'),
                shadowStyle: shadowLevelStyle(theme.colors.shadowLevels[1]),
            }),
        },
        toneMuted: {
            backgroundColor: theme.colors.surface.inset,
        },
        toneFlat: {
            backgroundColor: 'transparent',
            borderRadius: 0,
            borderWidth: 0,
            borderTopWidth: 0,
            boxShadow: 'none',
            shadowOpacity: 0,
            elevation: 0,
        },
        // On a configuration page a card is a small sheet: the same section tint and hairline as the
        // page's sections, never a shadowed card floating on paper.
        cardPage: {
            backgroundColor: theme.colors.surface.sectionTint,
            borderRadius: PAGE_LIST_METRICS.sheetRadiusPx,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.border.default,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.colors.border.default,
            boxShadow: 'none',
            shadowOpacity: 0,
            elevation: 0,
        },
        paddingSm: {
            paddingHorizontal: SURFACE_CARD_PADDING_PX.sm.horizontal,
            paddingVertical: SURFACE_CARD_PADDING_PX.sm.vertical,
        },
        paddingMd: {
            paddingHorizontal: SURFACE_CARD_PADDING_PX.md.horizontal,
            paddingVertical: SURFACE_CARD_PADDING_PX.md.vertical,
        },
        paddingLg: {
            paddingHorizontal: SURFACE_CARD_PADDING_PX.lg.horizontal,
            paddingVertical: SURFACE_CARD_PADDING_PX.lg.vertical,
        },
        pressable: {
            width: '100%',
            borderRadius: SURFACE_CARD_RADIUS_PX,
        },
        pressablePage: {
            borderRadius: PAGE_LIST_METRICS.sheetRadiusPx,
        },
        pressablePressed: {
            opacity: motionTokens.press.opacitySurface,
        },
    };
});

function resolvePaddingStyle(padding: SurfaceCardPadding): StyleProp<ViewStyle> {
    if (padding === 'none') {
        return undefined;
    }
    if (padding === 'sm') {
        return styles.paddingSm;
    }
    if (padding === 'lg') {
        return styles.paddingLg;
    }
    return styles.paddingMd;
}

export const SurfaceCard = React.memo(function SurfaceCard(props: SurfaceCardProps) {
    const {
        children,
        testID,
        onPress,
        tone = 'surface',
        padding = 'md',
        style,
    } = props;
    const page = useListPresentation() === 'page';

    const content = (
        <View
            style={[
                styles.cardBase,
                page ? styles.cardPage : null,
                tone === 'muted' ? styles.toneMuted : null,
                tone === 'flat' ? styles.toneFlat : null,
                resolvePaddingStyle(padding),
                style,
            ]}
        >
            {children}
        </View>
    );

    return (
        <HappierSurface
            testID={testID}
            onPress={onPress}
            frameStyle={props.fill ? FILL_STYLE : undefined}
            style={props.fill ? FILL_STYLE : undefined}
            pressableStyle={[styles.pressable, page ? styles.pressablePage : null]}
            pressedStyle={styles.pressablePressed}
        >
            {content}
        </HappierSurface>
    );
});
