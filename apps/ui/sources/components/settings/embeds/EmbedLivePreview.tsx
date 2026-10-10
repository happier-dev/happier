import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { EmbedStyleV1, EmbedUiOverridesV1 } from '@happier-dev/protocol/embed';

import { Switch } from '@/components/ui/forms/Switch';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';

import type { EmbedPreviewConfiguration } from '@/embed/preview/embedPreviewConfiguration';
import { EMBED_PREVIEW_PATH, buildEmbedPreviewSearch } from '@/embed/preview/embedPreviewRoute';

import { EmbedPreviewFrame } from './EmbedPreviewFrame';

type PreviewWidth = 'phone' | 'desktop';
/** The frame widths the toolbar switches between: a phone, and a desktop host column. */
const PREVIEW_FRAME_WIDTH: Record<PreviewWidth, number> = { phone: 390, desktop: 760 };
const PREVIEW_HEIGHT_PX = 560;
// The empty-state illustration's measure in settings lab L2; its contents are the real preview route.
const ILLUSTRATION_WIDTH_PX = 294;
const ILLUSTRATION_HEIGHT_PX = 168;

const stylesheet = StyleSheet.create((theme) => ({
    column: {
        gap: theme.margins.sm,
    },
    toolbar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.sm,
    },
    caption: {
        ...Typography.rowMeta(),
        flex: 1,
        color: theme.colors.text.secondary,
    },
    page: {
        flex: 1,
        minHeight: 0,
    },
    pageFrame: {
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
        backgroundColor: theme.colors.background.canvas,
    },
    frame: {
        height: PREVIEW_HEIGHT_PX,
        borderRadius: theme.borderRadius.xl,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.background.canvas,
    },
    unavailable: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    unavailableText: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.sm,
    },
    note: {
        ...Typography.rowMeta(),
        color: theme.colors.text.tertiary,
    },
}));

/**
 * The live preview (plan 04 §4.10): the real embed route (`/embed/preview`) in the platform's frame
 * — a same-origin iframe on web, the app's WebView engine on iOS and Android — driven by the bridge's
 * `configure` messages exactly as a host page drives an embed, so an edit repaints the real session
 * components without reloading them. It holds no credential and the route makes no requests.
 */
export function EmbedLivePreview(props: Readonly<{
    style: EmbedStyleV1 | null;
    ui: EmbedUiOverridesV1;
    newChat: boolean;
    /**
     * `interactive` (default): the framed widget with its Phone/Desktop toolbar beside the settings.
     * `page`: the pushed phone preview (lab P3), the chat filling the page at its own width.
     * `illustration`: the empty state's passive compact art.
     */
    presentation?: 'interactive' | 'page' | 'illustration';
    /** An unsaved access edit: show what open chats show while they reconnect (lab D2). */
    reconnecting?: boolean;
}>): React.ReactElement {
    const styles = stylesheet;
    const page = props.presentation === 'page';
    const interactive = props.presentation !== 'illustration';
    // The framed widget carries the width toolbar and preview controls; a full page is only the chat.
    const widget = interactive && !page;
    const [pageHeight, setPageHeight] = React.useState(PREVIEW_HEIGHT_PX);
    const height = page ? pageHeight : interactive ? PREVIEW_HEIGHT_PX : ILLUSTRATION_HEIGHT_PX;
    const [columnWidth, setColumnWidth] = React.useState(interactive ? 344 : ILLUSTRATION_WIDTH_PX);
    const [width, setWidth] = React.useState<PreviewWidth>('phone');
    const [reduceMotion, setReduceMotion] = React.useState(false);
    const identity = React.useMemo(() => ({ instanceId: randomUUID(), mountNonce: randomUUID() }), []);
    const configuration = React.useMemo<EmbedPreviewConfiguration>(() => ({ style: props.style, ui: props.ui }), [props.style, props.ui]);

    const frameWidth = page ? columnWidth : PREVIEW_FRAME_WIDTH[width];
    const scale = page ? 1 : Math.min(1, columnWidth / frameWidth);
    const path = `${EMBED_PREVIEW_PATH}?${buildEmbedPreviewSearch({ identity, reduceMotion: !interactive || reduceMotion, newChat: props.newChat, reconnecting: props.reconnecting === true })}`;
    // A failure belongs to the route it happened on; the next route gets its own attempt. It never
    // blocks saving: the preview only says it cannot show (plan 04 §6.2).
    const [unavailablePath, setUnavailablePath] = React.useState<string | null>(null);
    const markUnavailable = React.useCallback(() => setUnavailablePath(path), [path]);

    return (
        <View
            style={page ? styles.page : [styles.column, !interactive ? { width: ILLUSTRATION_WIDTH_PX } : null]}
            onLayout={(event) => {
                setColumnWidth(event.nativeEvent.layout.width);
                if (page) setPageHeight(event.nativeEvent.layout.height);
            }}
            testID="settings-embed-preview"
        >
            {widget ? <View style={styles.toolbar}>
                <Text style={styles.caption}>{t('settingsEmbeds.preview.title')}</Text>
                <SegmentedTabBar<PreviewWidth>
                    testIDPrefix="settings-embed-preview-width"
                    role="radiogroup"
                    compact
                    segmentSizing="content"
                    tabs={[
                        { id: 'phone', label: t('settingsEmbeds.preview.phone') },
                        { id: 'desktop', label: t('settingsEmbeds.preview.desktop') },
                    ]}
                    activeTabId={width}
                    onSelectTab={setWidth}
                />
            </View> : null}
            <View style={page ? styles.pageFrame : [styles.frame, { height }]} pointerEvents={interactive ? 'auto' : 'none'} importantForAccessibility={interactive ? 'auto' : 'no-hide-descendants'} accessibilityElementsHidden={!interactive}>
                {unavailablePath === path ? (
                    <View style={styles.unavailable} testID="settings-embed-preview-unavailable">
                        <Text style={styles.unavailableText}>{t('settingsEmbeds.preview.unavailable')}</Text>
                    </View>
                ) : (
                    <EmbedPreviewFrame
                        key={path}
                        title={t('settingsEmbeds.preview.title')}
                        path={path}
                        identity={identity}
                        configuration={configuration}
                        frameWidth={frameWidth}
                        height={height}
                        scale={scale}
                        passive={!interactive}
                        onUnavailable={markUnavailable}
                    />
                )}
            </View>
            {widget ? <View style={styles.footer}>
                <Text style={styles.note}>{t('settingsEmbeds.preview.reduceMotion')}</Text>
                <Switch
                    testID="settings-embed-preview-reduce-motion"
                    accessibilityLabel={t('settingsEmbeds.preview.reduceMotion')}
                    value={reduceMotion}
                    onValueChange={setReduceMotion}
                />
            </View> : null}
            {widget ? <Text style={styles.note}>{t('settingsEmbeds.preview.note')}</Text> : null}
        </View>
    );
}
