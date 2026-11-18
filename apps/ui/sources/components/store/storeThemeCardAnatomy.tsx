import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { CollectionAnatomy } from '@happier-dev/plugin-ui';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { useOptionalPluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';
import { useMeasuredNearViewport } from '@/components/widgets/nearViewport';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { getThemeRegistryLifecycle } from '@/theme/profiles/themeTryOnRuntime';
import type { AcquiredRegistryThemePreview } from '@/registries/themeRegistryInstall';

import { THEME_MINIATURE_CARD_MIN_WIDTH, ThemeMiniaturePreview } from '@/components/settings/appearance/ThemeModePreview';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import { describeStoreThemeModes } from './catalog/storeThemes';

import type { StoreThemeCardView } from './storeThemeViewTypes';

/**
 * The narrowest Store theme card on a wide page (lab C1/C2): three across the wide column, two beside the open
 * listing. A card carries its name and source under the miniature, so it stands half again as wide as the library's
 * bare miniature tile; a phone keeps that tile's width (two across).
 */
export const STORE_THEME_CARD_MIN_WIDTH = THEME_MINIATURE_CARD_MIN_WIDTH * 1.5;

/**
 * Store → Themes cards (lab C1): the shared Collection grid's preview card. The preview band is the theme
 * itself, both faces side by side when it has two. Missing colours are acquired near the viewport;
 * the registry mark keeps the same space while pending or unavailable. Under it: the name, then publisher ·
 * source, then modes · reshape. No ratings, counts or badges.
 */
export function useStoreThemeCardAnatomy(): CollectionAnatomy<StoreThemeCardView> {
    const phone = useDeviceType() === 'phone';
    return React.useMemo((): CollectionAnatomy<StoreThemeCardView> => ({
        glyph: () => null,
        title: (card) => card.name,
        where: (card) => card.byline,
        reason: (card) => <StoreThemeCardFoot summary={card.summary} listing={card.listing} />,
        preview: (card) => <StoreThemeCardPreview faces={card.faces} mark={card.mark}
            sourceId={card.listing?.sourceId} itemId={card.listing?.itemId} version={card.listing?.version} />,
        // The preview is a window: it keeps its proportions at every card width (lab C1 1.6:1, phones 1.1:1).
        previewAspectRatio: phone ? STORE_THEME_PREVIEW_ASPECT_PHONE : STORE_THEME_PREVIEW_ASPECT,
        accessibilityLabel: (card) => [card.name, card.byline, card.summary].filter(Boolean).join(', '),
        testID: (card) => `store.theme.card:${card.key}`,
        columnTitles: { title: t('themeStore.columnName'), where: t('themeStore.columnSource'), reason: t('themeStore.columnModes') },
    }), [phone]);
}

/** The listing's face tiles use the same proportions (StoreThemeListing), so a card and its listing read alike. */
const STORE_THEME_PREVIEW_ASPECT = 1.6;
const STORE_THEME_PREVIEW_ASPECT_PHONE = 1.1;

/**
 * The card's foot (lab C1): which modes, then what it changes. A listing without catalog metadata says it once the
 * card's own near-viewport acquisition has settled; the foot only reads that settled result, it never starts a read.
 */
const StoreThemeCardFoot = React.memo(function StoreThemeCardFoot(props: Readonly<{
    summary: string; listing?: StoreThemeCardView['listing'];
}>) {
    const scope = useAccountSettingsScope();
    const presented = useLayoutPresentationActive();
    const lifecycle = getThemeRegistryLifecycle();
    const { sourceId, itemId, version } = props.listing ?? {};
    const subscribe = React.useCallback((notify: () => void) => presented && sourceId && itemId && version
        ? lifecycle.subscribePreview({ sourceId, itemId, version }, scope, notify) : () => {},
    [lifecycle, presented, sourceId, itemId, version, scope]);
    const read = React.useCallback(() => sourceId && itemId && version
        ? lifecycle.readPreview({ sourceId, itemId, version }, scope) : null, [lifecycle, sourceId, itemId, version, scope]);
    const acquired = React.useSyncExternalStore(subscribe, read, read);
    const themes = acquired?.item.payload.themes ?? [];
    const modes = props.summary || describeStoreThemeModes(themes.map(face => face.mode));
    const changes = themes.length === 0 ? null
        : themes.some(face => Boolean(face.document.profile.css?.trim())) ? t('themeStore.reshapesLayout') : t('themeStore.colorsOnly');
    // The foot line the grid draws for a text reason: one quiet meta line, the muted tone of a preview card's foot.
    return <Text variant="meta" numberOfLines={1} style={styles.foot}>{[modes, changes].filter(Boolean).join(' · ')}</Text>;
});

const StoreThemeCardPreview = React.memo(function StoreThemeCardPreview(props: Readonly<{
    faces: StoreThemeCardView['faces']; mark: StoreThemeCardView['mark'];
    sourceId?: string; itemId?: string; version?: string;
}>) {
    const node = React.useRef<View>(null);
    const tracker = useOptionalPluginUiScrollActivityTracker();
    const presented = useLayoutPresentationActive();
    const scope = useAccountSettingsScope();
    const { sourceId, itemId, version } = props;
    const identity = JSON.stringify([sourceId, itemId, version]);
    const { near, measure } = useMeasuredNearViewport(tracker, node, presented, identity);
    const [resolved, setResolved] = React.useState<Readonly<{ scope: typeof scope; identity: string; value: AcquiredRegistryThemePreview }> | null>(null);
    const acquired = resolved?.scope === scope && resolved?.identity === identity ? resolved.value : null;
    React.useEffect(() => {
        if (!presented || !near || props.faces.length > 0 || !sourceId || !itemId || !version) return;
        let active = true;
        void getThemeRegistryLifecycle().acquirePreview({ sourceId, itemId, version }, { expectedScope: scope }).then(value => {
            if (active) setResolved(previous => previous?.value === value && previous.scope === scope && previous.identity === identity
                ? previous : { scope, identity, value });
        }).catch(() => { /* The registry mark remains visible when this optional preview is unavailable. */ });
        return () => { active = false; };
    }, [presented, near, props.faces, sourceId, itemId, version, scope, identity]);
    const faces = props.faces.length > 0 ? props.faces : acquired?.miniatures ?? props.faces;
    return (
        <View ref={node} collapsable={false} onLayout={measure} style={styles.inset}
            accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {/* The theme stands inset on the card as one framed window (lab C1), both faces sharing its frame. */}
            <View style={styles.faces}>
                {faces.length === 0 ? <View style={styles.markWell}>
                    {props.mark ? <HappierBrandMark brand={props.mark} pixelSize={40} externallyLabelled /> : null}
                </View> : faces.slice(0, 2).map((face, index) => (
                    <View key={index} style={styles.face}><ThemeMiniaturePreview miniature={face} /></View>
                ))}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    foot: {
        flexShrink: 1,
        color: theme.colors.text.tertiary,
    },
    // Concentric with the card: the window's corner is the card's less the inset it stands at.
    inset: {
        flex: 1,
        padding: theme.space.s8,
    },
    faces: {
        flex: 1,
        flexDirection: 'row',
        overflow: 'hidden',
        borderRadius: HAPPIER_PAGE_METRICS.cardRadiusPx - theme.space.s8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.subtle,
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
