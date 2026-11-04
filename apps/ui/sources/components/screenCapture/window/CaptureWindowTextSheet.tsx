import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { CaptureWindowTextPreview } from './captureWindowTextView';

const ACTION_HEIGHT = 32;

/** What goes with the picture, readable before it goes (lab `wt` V). It scrolls inside; the window keeps its size. */
export function CaptureWindowTextSheet(props: Readonly<{
    preview: CaptureWindowTextPreview;
    maxHeight: number;
    onDone: () => void;
    onExclude: () => void;
}>) {
    const { preview } = props;
    const facts = [preview.appName, preview.windowTitle, t('screenCapture.windowText.words', { count: preview.wordCount })]
        .filter((fact): fact is string => Boolean(fact));
    return (
        <View style={[styles.root, { maxHeight: props.maxHeight }]} testID="capture-window-text-sheet">
            <View style={styles.header}>
                <View style={styles.headerText}>
                    <Text variant="heading" emphasis="semiBold" style={styles.title}>{t('screenCapture.window.wholeWindowText')}</Text>
                    <Text variant="body" style={styles.description}>{t('screenCapture.windowText.sheetDescription', { app: preview.appName })}</Text>
                </View>
                <IconButton variant="plain" iconName="x" accessibilityLabel={t('common.close')} onPress={props.onDone} testID="capture-window-text-sheet-close" />
            </View>
            <ScrollView style={styles.scroller} contentContainerStyle={styles.scrollContent} testID="capture-window-text-sheet-body">
                <Text variant="body" selectable style={styles.text}>{preview.text}</Text>
            </ScrollView>
            <View style={styles.footer}>
                <Text variant="meta" numberOfLines={1} style={styles.facts}>{facts.join(' · ')}</Text>
                <RoundButton size="small" capsuleHeight={ACTION_HEIGHT} display="secondary" title={t('screenCapture.windowText.dontInclude')} onPress={props.onExclude} testID="capture-window-text-exclude" />
                <RoundButton size="small" capsuleHeight={ACTION_HEIGHT} title={t('common.done')} onPress={props.onDone} testID="capture-window-text-done" />
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    root: {
        minHeight: 0,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s12,
    },
    headerText: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        color: theme.colors.text.primary,
    },
    description: {
        color: theme.colors.text.secondary,
    },
    scroller: {
        flexShrink: 1,
        minHeight: 0,
        marginHorizontal: theme.space.s12,
        borderRadius: theme.borderRadius.md,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    scrollContent: {
        padding: theme.space.s12,
    },
    text: {
        ...Typography.variant('body'),
        color: theme.colors.text.primary,
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        padding: theme.space.s12,
        paddingLeft: theme.space.s16,
    },
    facts: {
        ...Typography.tabular(),
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.tertiary,
    },
}));
