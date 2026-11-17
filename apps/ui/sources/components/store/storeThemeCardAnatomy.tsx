import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { CollectionAnatomy } from '@happier-dev/plugin-ui';

import { ThemeMiniaturePreview } from '@/components/settings/appearance/ThemeModePreview';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { t } from '@/text';

import type { StoreThemeCardView } from './storeThemeViewTypes';

/**
 * Store → Themes cards (lab C1): the shared Collection grid's preview card. The preview band is the theme
 * itself, both faces side by side when it has two; a listing whose faces are only known once opened (Open
 * VSX) shows its registry mark there instead of an invented palette. Under it: the name, then publisher ·
 * source, then modes · reshape. No ratings, counts or badges.
 */
export function useStoreThemeCardAnatomy(): CollectionAnatomy<StoreThemeCardView> {
    return React.useMemo((): CollectionAnatomy<StoreThemeCardView> => ({
        glyph: () => null,
        title: (card) => card.name,
        where: (card) => card.byline,
        reason: (card) => card.summary,
        preview: (card) => <StoreThemeCardPreview card={card} />,
        accessibilityLabel: (card) => `${card.name}, ${card.byline}, ${card.summary}`,
        testID: (card) => `store.theme.card:${card.key}`,
        columnTitles: { title: t('themeStore.columnName'), where: t('themeStore.columnSource'), reason: t('themeStore.columnModes') },
    }), []);
}

const StoreThemeCardPreview = React.memo(function StoreThemeCardPreview(props: Readonly<{ card: StoreThemeCardView }>) {
    const { card } = props;
    if (card.faces.length === 0) {
        return (
            <View style={styles.markWell}>
                {card.mark ? <HappierBrandMark brand={card.mark} pixelSize={40} externallyLabelled /> : null}
            </View>
        );
    }
    return (
        <View style={styles.faces} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {card.faces.slice(0, 2).map((face, index) => (
                <View key={index} style={styles.face}><ThemeMiniaturePreview miniature={face} /></View>
            ))}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    faces: {
        flex: 1,
        flexDirection: 'row',
    },
    face: {
        flex: 1,
        overflow: 'hidden',
    },
    markWell: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.inset,
    },
}));
