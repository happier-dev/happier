import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { CollectionAnatomy } from '@happier-dev/plugin-ui';
import { useOptionalPluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';
import { useMeasuredNearViewport } from '@/components/widgets/nearViewport';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { getThemeRegistryLifecycle } from '@/theme/profiles/themeTryOnRuntime';
import { projectThemeLibraryEntry } from '@/theme/profiles/themeProfilePresentation';
import type { AcquiredRegistryTheme } from '@/registries/themeRegistryInstall';

import { ThemeMiniaturePreview } from '@/components/settings/appearance/ThemeModePreview';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { t } from '@/text';

import type { StoreThemeCardView } from './storeThemeViewTypes';

/**
 * Store → Themes cards (lab C1): the shared Collection grid's preview card. The preview band is the theme
 * itself, both faces side by side when it has two. Missing colours are acquired near the viewport;
 * the registry mark keeps the same space while pending or unavailable. Under it: the name, then publisher ·
 * source, then modes · reshape. No ratings, counts or badges.
 */
export function useStoreThemeCardAnatomy(): CollectionAnatomy<StoreThemeCardView> {
    return React.useMemo((): CollectionAnatomy<StoreThemeCardView> => ({
        glyph: () => null,
        title: (card) => card.name,
        where: (card) => card.byline,
        reason: (card) => card.summary,
        preview: (card) => <StoreThemeCardPreview faces={card.faces} mark={card.mark}
            sourceId={card.listing?.sourceId} itemId={card.listing?.itemId} version={card.listing?.version} />,
        accessibilityLabel: (card) => `${card.name}, ${card.byline}, ${card.summary}`,
        testID: (card) => `store.theme.card:${card.key}`,
        columnTitles: { title: t('themeStore.columnName'), where: t('themeStore.columnSource'), reason: t('themeStore.columnModes') },
    }), []);
}

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
    const [resolved, setResolved] = React.useState<Readonly<{ scope: typeof scope; identity: string; value: AcquiredRegistryTheme }> | null>(null);
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
    const faces = React.useMemo(() => props.faces.length > 0 ? props.faces
        : acquired?.item.payload.themes.map(face => projectThemeLibraryEntry(face.document).miniature) ?? props.faces,
    [props.faces, acquired]);
    return (
        <View ref={node} collapsable={false} onLayout={measure} style={styles.faces}
            accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {faces.length === 0 ? <View style={styles.markWell}>
                {props.mark ? <HappierBrandMark brand={props.mark} pixelSize={40} externallyLabelled /> : null}
            </View> : faces.slice(0, 2).map((face, index) => (
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
