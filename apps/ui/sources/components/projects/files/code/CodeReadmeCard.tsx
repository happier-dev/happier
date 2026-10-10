import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';

import { MarkdownView } from '@/components/markdown/MarkdownView';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { GROUPED_SURFACE_RADIUS_PX } from '@/components/ui/lists/pageListMetrics';
import { resolveThemeHairlineBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';

import { useCodeTextFile } from './useCodeTextFile';

/** A folder's README, the one GitHub and every forge render below the listing. */
export function findCodeReadmePath(entries: ReadonlyArray<Readonly<{ name: string; path: string; type: string }>>): string | null {
    const readme = entries.find((entry) => entry.type === 'file' && /^readme(\.(md|markdown|mdx|txt))?$/i.test(entry.name));
    return readme?.path ?? null;
}

/**
 * The README under a Code folder's table (lab p-code BROWSE): its name, a way to edit it, and the
 * rendered text. A folder without one shows nothing — the page ends after the files.
 */
export const CodeReadmeCard = React.memo(function CodeReadmeCard(props: Readonly<{
    testID?: string;
    scope: WorkspaceScopeBase;
    path: string;
    onEdit?: ((path: string) => void) | null;
    reloadToken?: number;
}>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const testID = props.testID ?? 'code-readme';
    const file = useCodeTextFile(props.scope, props.path, props.reloadToken);
    const name = props.path.split('/').pop() ?? props.path;
    return (
        <GlassSurface surfaceGroup="content" nested finishRole="card" testID={testID} style={[styles.card, resolveThemeHairlineBorderStyle(theme.colors.border.surface)]}>
            <View style={styles.header}>
                <Icon name="book-open" size={16} color={theme.colors.text.secondary} />
                <Text numberOfLines={1} style={styles.name}>{name}</Text>
                <View style={styles.grow} />
                {props.onEdit ? (
                    <IconButton
                        testID={`${testID}-edit`}
                        variant="plain"
                        size={26}
                        iconName="pencil-simple"
                        accessibilityLabel={t('common.edit')}
                        tooltip={t('common.edit')}
                        onPress={() => props.onEdit?.(props.path)}
                    />
                ) : null}
            </View>
            <View style={styles.body}>
                {file.kind === 'ready' ? (
                    <MarkdownView testID={`${testID}-markdown`} markdown={file.text} renderCacheKey={props.path} />
                ) : file.kind === 'error' ? (
                    <Text style={styles.quiet}>{t('projects.code.readUnavailable')}</Text>
                ) : (
                    <View aria-busy style={styles.skeleton}>
                        <HappierSkeletonBlock width="40%" height={18} radius={6} color={theme.colors.surface.pressedOverlay} reducedMotion={reducedMotion} />
                        <HappierSkeletonBlock width="86%" height={10} radius={5} color={theme.colors.surface.pressedOverlay} reducedMotion={reducedMotion} />
                        <HappierSkeletonBlock width="72%" height={10} radius={5} color={theme.colors.surface.pressedOverlay} reducedMotion={reducedMotion} />
                    </View>
                )}
            </View>
        </GlassSurface>
    );
});

const styles = StyleSheet.create((theme) => ({
    card: {
        marginTop: 28,
        borderRadius: GROUPED_SURFACE_RADIUS_PX,
        backgroundColor: theme.colors.edge.cardFill,
        overflow: 'hidden',
    },
    header: {
        minHeight: 44,
        paddingLeft: 14,
        paddingRight: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderBottomWidth: StyleSheet.hairlineWidth || 1,
        borderBottomColor: theme.colors.border.subtle,
    },
    name: {
        ...Typography.rowTitle(),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    grow: {
        flex: 1,
    },
    body: {
        paddingHorizontal: 24,
        paddingVertical: 20,
    },
    quiet: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    skeleton: {
        gap: 12,
    },
}));
