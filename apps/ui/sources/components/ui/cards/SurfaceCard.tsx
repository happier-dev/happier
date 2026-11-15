import * as React from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import { HappierSurface, type HappierMaterialSurfaceRender, type HappierSurfaceProps } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { resolveThemeCardChromeStyle, resolveThemeSurfaceFinish } from '@/components/ui/surfaces/themeRaisedEdge';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useListPresentation } from '@/components/ui/lists/listPresentation';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { SURFACE_CARD_PADDING_PX, SURFACE_CARD_RADIUS_PX, type SurfaceCardPadding } from './surfaceCardMetrics';

/**
 * `flat` draws no chrome at all: the content is one section of a column that already
 * separates its sections (the Companion). It keeps the card's one element topology,
 * so a host that switches tone never remounts its content.
 */
type SurfaceCardTone = 'surface' | 'muted' | 'flat';
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
            ...resolveThemeCardChromeStyle(theme),
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
        // On a configuration page a card is a small sheet: the same W3 card as the page's sections, on
        // the sheet radius.
        cardPage: {
            borderRadius: PAGE_LIST_METRICS.sheetRadiusPx,
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
    const { theme } = useUnistyles();
    const renderMaterialSurface = React.useCallback<HappierMaterialSurfaceRender>((input) =>
        <GlassSurface surfaceGroup={input.role} noCoat={input.noCoat} nested enabled={tone !== 'flat'} finishRole={tone === 'flat' ? null : 'card'} gradient={input.gradient} style={input.style as StyleProp<ViewStyle>}>
            {input.children}
        </GlassSurface>, [tone]);
    const cardStyle: StyleProp<ViewStyle> = [
                styles.cardBase,
                page ? styles.cardPage : null,
                tone === 'muted' ? styles.toneMuted : null,
                tone === 'flat' ? styles.toneFlat : null,
                resolvePaddingStyle(padding),
                style,
            ];

    return (
        <HappierSurface
            testID={testID}
            onPress={onPress}
            materialRole="card"
            gradient={tone === 'flat' ? null : resolveThemeSurfaceFinish(theme, 'card')}
            renderMaterialSurface={renderMaterialSurface}
            frameStyle={props.fill ? FILL_STYLE : undefined}
            style={[props.fill ? FILL_STYLE : undefined, cardStyle] as HappierSurfaceProps['style']}
            pressableStyle={[styles.pressable, page ? styles.pressablePage : null]}
            pressedStyle={styles.pressablePressed}
        >
            {children}
        </HappierSurface>
    );
});
