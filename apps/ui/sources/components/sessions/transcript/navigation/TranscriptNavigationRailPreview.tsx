import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import {
    resolveTranscriptNavigationEntryPrimaryText,
    resolveTranscriptNavigationEntrySecondaryText,
} from './transcriptNavigationAccessibility';
import { resolveTranscriptNavigationRailSoftFadeStyle } from './useTranscriptNavigationRailSoftPresence';
import type { TranscriptNavigationRailEntry } from './TranscriptNavigationRail';

type WebPreviewViewProps = React.ComponentPropsWithRef<typeof View> & {
    onPointerEnter?: (event: unknown) => void;
    onPointerLeave?: (event: unknown) => void;
};

const WebPreviewView = View as unknown as React.ComponentType<WebPreviewViewProps>;

export type TranscriptNavigationRailPreviewProps = Readonly<{
    entry: TranscriptNavigationRailEntry;
    /** Horizontal offset beside the rail, derived from rail layout facts. */
    leftPx?: number;
    maxWidthPx?: number;
    onLayout?: (event: unknown) => void;
    onPointerEnter?: (event: unknown) => void;
    onPointerLeave?: (event: unknown) => void;
    reducedMotion?: boolean;
    /** Soft-presence visibility: drives the opacity fade in/out. */
    shown: boolean;
    topPx: number;
}>;

/**
 * Glass hover preview beside the rail: a short bold title line (the turn's
 * prompt / pin label via the canonical entry-text resolvers shared with the
 * navigation panel) over the actual message text in regular weight, clamped
 * to a few lines.
 *
 * The opacity fade lives on the glass element itself (GlassPanel surface
 * style): animating opacity — like transform — on an ancestor of a
 * backdrop-filter surface silently defeats the blur on web, so the positioned
 * wrapper stays static (top/left only, opacity 1).
 */
export function TranscriptNavigationRailPreview(props: TranscriptNavigationRailPreviewProps) {
    const styles = stylesheet;
    const title = resolveTranscriptNavigationEntryPrimaryText(props.entry);
    const body = resolveTranscriptNavigationEntrySecondaryText(props.entry);
    return (
        <WebPreviewView
            accessibilityLabel={props.entry.label}
            onLayout={props.onLayout}
            onPointerEnter={props.onPointerEnter}
            onPointerLeave={props.onPointerLeave}
            testID="transcript-navigation-rail.preview"
            style={[
                styles.preview,
                {
                    left: props.leftPx ?? 32,
                    maxWidth: props.maxWidthPx ?? 320,
                    top: props.topPx,
                },
                props.shown ? null : styles.previewHidden,
            ]}
        >
            <GlassPanel
                innerShadow={false}
                radius={14}
                shadowLevel={1}
                softShadow
                testID="transcript-navigation-rail.preview.glass"
                style={[
                    styles.glass,
                    resolveTranscriptNavigationRailSoftFadeStyle(props.shown, props.reducedMotion === true),
                ]}
            >
                <Text
                    numberOfLines={1}
                    style={styles.previewTitle}
                    testID="transcript-navigation-rail.preview.title"
                >
                    {title}
                </Text>
                {body ? (
                    <Text
                        numberOfLines={3}
                        style={styles.previewBody}
                        testID="transcript-navigation-rail.preview.body"
                    >
                        {body}
                    </Text>
                ) : null}
            </GlassPanel>
        </WebPreviewView>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    preview: {
        position: 'absolute',
        minWidth: 180,
    },
    previewHidden: {
        // A fading-out preview must not trap hover (WCAG 1.4.13 dismissal).
        pointerEvents: 'none',
    },
    glass: {
        justifyContent: 'center',
        paddingHorizontal: 12,
        paddingVertical: 9,
    },
    previewTitle: {
        color: theme.colors.text.primary,
        ...Typography.rowTitle(),
    },
    previewBody: {
        marginTop: 3,
        color: theme.colors.text.secondary,
        ...Typography.rowMeta(),
    },
}));
