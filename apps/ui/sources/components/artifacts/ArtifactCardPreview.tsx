import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatByteSize } from '@/utils/files/formatByteSize';

import { ARTIFACT_KIND_ICONS } from './artifactKindPresentation';
import type { ArtifactBrowserKind, ArtifactPreview } from './artifactBrowserModel';

/** A Markdown preview's lines: headings, bullets and checklist items, the rest as plain text. */
type PreviewLine = Readonly<{ kind: 'heading' | 'text' | 'bullet' | 'check'; text: string; done?: boolean }>;

const PREVIEW_LINES = 7;

function stripInline(text: string): string {
    return text.replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]*)\*\*/g, '$1').replace(/[*_]([^*_]+)[*_]/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

export function readMarkdownPreviewLines(markdown: string): readonly PreviewLine[] {
    const lines: PreviewLine[] = [];
    for (const raw of markdown.split('\n')) {
        const line = raw.trim();
        if (line.length === 0 || line.startsWith('```')) continue;
        const check = /^[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
        if (check) lines.push({ kind: 'check', text: stripInline(check[2]!), done: check[1] !== ' ' });
        else if (/^#{1,6}\s/.test(line)) lines.push({ kind: 'heading', text: stripInline(line.replace(/^#{1,6}\s+/, '')) });
        else if (/^([-*]|\d+\.)\s/.test(line)) lines.push({ kind: 'bullet', text: stripInline(line.replace(/^([-*]|\d+\.)\s+/, '')) });
        else lines.push({ kind: 'text', text: stripInline(line) });
        if (lines.length >= PREVIEW_LINES) break;
    }
    return lines;
}

/**
 * The card's preview band: Markdown, code, or a typed file's name,
 * read from what the store already holds. No request, no
 * subscription; nothing loaded yet shows the kind's mark.
 */
export const ArtifactCardPreview = React.memo(function ArtifactCardPreview(props: Readonly<{
    preview: ArtifactPreview;
    kind: ArtifactBrowserKind;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { preview } = props;
    if (preview.kind === 'markdown') {
        const lines = readMarkdownPreviewLines(preview.text);
        return (
            <View style={styles.band} testID={props.testID} accessible={false} importantForAccessibility="no-hide-descendants">
                {lines.map((line, index) => line.kind === 'heading' ? (
                    <Text key={index} numberOfLines={1} style={styles.heading}>{line.text}</Text>
                ) : (
                    <View key={index} style={styles.line}>
                        {line.kind === 'bullet' ? <Text style={styles.bullet}>•</Text> : null}
                        {line.kind === 'check' ? (
                            <Icon name={line.done ? 'check-square' : 'square'} size={11} color={theme.colors.text.tertiary} />
                        ) : null}
                        <Text numberOfLines={2} style={[styles.text, line.done ? styles.done : null]}>{line.text}</Text>
                    </View>
                ))}
            </View>
        );
    }
    if (preview.kind === 'code') {
        const lines = preview.text.split('\n').slice(0, PREVIEW_LINES + 1);
        return (
            <View style={styles.band} testID={props.testID} accessible={false} importantForAccessibility="no-hide-descendants">
                {lines.map((line, index) => (
                    <Text key={index} numberOfLines={1} useDefaultTypography={false} style={styles.code}>{line.length > 0 ? line : ' '}</Text>
                ))}
            </View>
        );
    }
    return (
        <View style={[styles.band, styles.centered]} testID={props.testID} accessible={false} importantForAccessibility="no-hide-descendants">
            <Icon name={preview.kind === 'image' ? 'image' : preview.kind === 'html' ? 'code' : preview.kind === 'file' ? 'file' : ARTIFACT_KIND_ICONS[props.kind]} size={26} color={theme.colors.text.tertiary} />
            {(preview.kind === 'image' || preview.kind === 'file' || preview.kind === 'html') && preview.name ? <Text numberOfLines={1} style={styles.caption}>{preview.name}</Text> : null}
            {preview.kind === 'html' ? <Text numberOfLines={1} style={styles.caption}>{t('artifacts.browser.kindOne.document')}</Text> : null}
            {preview.kind === 'file' ? <Text numberOfLines={1} style={styles.caption}>{`${preview.mime} · ${formatByteSize(preview.sizeBytes)}`}</Text> : null}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    band: {
        flex: 1,
        paddingHorizontal: 16,
        paddingTop: 14,
        gap: 3,
        overflow: 'hidden',
    },
    centered: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 0,
        gap: 8,
    },
    heading: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.primary,
        marginBottom: 2,
    },
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    bullet: {
        fontSize: 11,
        lineHeight: 15,
        color: theme.colors.text.tertiary,
    },
    text: {
        flexShrink: 1,
        fontSize: 11,
        lineHeight: 15,
        color: theme.colors.text.secondary,
    },
    done: {
        color: theme.colors.text.tertiary,
        textDecorationLine: 'line-through',
    },
    code: {
        ...Typography.mono(),
        fontSize: 10.5,
        lineHeight: 16,
        color: theme.colors.text.primary,
    },
    caption: {
        fontSize: 11,
        color: theme.colors.text.tertiary,
    },
}));
