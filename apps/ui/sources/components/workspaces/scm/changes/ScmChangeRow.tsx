import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { InlineRepoPathLabel } from '@/components/ui/path/InlineRepoPathLabel';
const PATH_SEPARATOR = '/';
const CHANGE_STATS_MIN_COLUMN_WIDTH = 38;
const CHANGE_STATS_CHARACTER_WIDTH = 7;
const CHANGE_STATS_COLUMN_EXTRA_WIDTH = 4;

type Theme = Readonly<{
    colors: Readonly<{
        surface?: string;
        surfaceHigh?: string;
        divider?: string;
        text?: string;
        textSecondary: string;
        textLink?: string;
        success?: string;
        warning?: string;
        textDestructive?: string;
    }>;
}>;

const ViewWithClick = View as unknown as React.ComponentType<
    React.ComponentPropsWithRef<typeof View> & {
        onClick?: any;
        onDoubleClick?: any;
        tabIndex?: number;
        onKeyDown?: any;
    }
>;

type ChangeDescriptor = Readonly<{
    code: string;
    color: string;
    label: string;
}>;

type ScmChangeStatsLike = Readonly<{
    linesAdded?: number | null;
    linesRemoved?: number | null;
}>;

function normalizeLineCount(value: unknown): string {
    return typeof value === 'number' && Number.isFinite(value)
        ? String(Math.max(0, Math.trunc(value)))
        : '0';
}

export function resolveScmChangeStatsColumnWidth(files: readonly ScmChangeStatsLike[]): number {
    let maxLabelLength = 0;
    for (const file of files) {
        const added = normalizeLineCount(file.linesAdded);
        const removed = normalizeLineCount(file.linesRemoved);
        maxLabelLength = Math.max(maxLabelLength, `+${added}${PATH_SEPARATOR}-${removed}`.length);
    }
    return Math.max(
        CHANGE_STATS_MIN_COLUMN_WIDTH,
        maxLabelLength * CHANGE_STATS_CHARACTER_WIDTH + CHANGE_STATS_COLUMN_EXTRA_WIDTH,
    );
}

function describeChange(file: ScmFileStatus, theme: Theme): ChangeDescriptor {
    const info = theme.colors.textLink ?? theme.colors.textSecondary;
    const success = theme.colors.success ?? theme.colors.textSecondary;
    const warning = theme.colors.warning ?? theme.colors.textSecondary;
    const danger = theme.colors.textDestructive ?? theme.colors.textSecondary;

    switch (file.status) {
        case 'untracked':
            // Treat untracked files as "added" in the UI for consistency with file tree badges.
            return { code: 'A', color: success, label: t('files.changeRow.status.untracked') };
        case 'added':
            return { code: 'A', color: success, label: t('files.changeRow.status.added') };
        case 'deleted':
            return { code: 'D', color: danger, label: t('files.changeRow.status.deleted') };
        case 'renamed':
            return { code: 'R', color: info, label: t('files.changeRow.status.renamed') };
        case 'copied':
            return { code: 'C', color: info, label: t('files.changeRow.status.copied') };
        case 'conflicted':
            return { code: '!', color: danger, label: t('files.changeRow.status.conflicted') };
        case 'modified':
        default:
            return { code: 'M', color: warning, label: t('files.changeRow.status.modified') };
    }
}

export type ScmChangeRowProps = Readonly<{
    theme: Theme;
    file: ScmFileStatus;
    onPress: () => void;
    onPressPinned?: () => void;
    onToggleSelection?: () => void;
    leadingElement?: React.ReactNode;
    trailingElement?: React.ReactNode;
    density?: 'comfortable' | 'compact';
    showDivider?: boolean;
    highlighted?: boolean;
    statsColumnWidth?: number;
}>;

export const ScmChangeRow = React.memo((props: ScmChangeRowProps) => {
    const { theme, file, density = 'comfortable' } = props;
    const descriptor = describeChange(file, theme);
    const testIdSafePath = React.useMemo(() => toTestIdSafeValue(file.fullPath), [file.fullPath]);
    const isWeb = Platform.OS === 'web';

    const paddingVertical = density === 'compact' ? 4 : 10;
    const statsColumnWidth = props.statsColumnWidth ?? resolveScmChangeStatsColumnWidth([file]);

    const containerStyle = React.useMemo(() => {
        const bg = props.highlighted
            ? (theme.colors.surfaceHigh ?? theme.colors.surface ?? theme.colors.textSecondary)
            : (theme.colors.surface ?? theme.colors.textSecondary);
        return {
            paddingHorizontal: 12,
            paddingVertical,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            backgroundColor: bg,
            borderBottomWidth: props.showDivider ? Platform.select({ ios: 0.33, default: 1 }) : 0,
            borderBottomColor: theme.colors.divider ?? theme.colors.textSecondary,
        } as const;
    }, [paddingVertical, props.highlighted, props.showDivider, theme.colors.divider, theme.colors.surface, theme.colors.surfaceHigh, theme.colors.textSecondary]);

    const onKeyDown = React.useCallback((event: any) => {
        if (!isWeb) return;
        const key = String(event?.key ?? '');
        if (key === 'Enter') {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            if (event?.shiftKey && props.onPressPinned) {
                props.onPressPinned();
            } else {
                props.onPress();
            }
            return;
        }
        if (key === ' ' || key === 'Spacebar') {
            if (!props.onToggleSelection) return;
            event?.preventDefault?.();
            event?.stopPropagation?.();
            props.onToggleSelection();
        }
    }, [isWeb, props.onPress, props.onPressPinned, props.onToggleSelection]);

    const onClick = React.useCallback((event: any) => {
        if (!isWeb) return;
        event?.preventDefault?.();
        event?.stopPropagation?.();
        if (event?.shiftKey && props.onPressPinned) {
            props.onPressPinned();
            return;
        }
        props.onPress();
    }, [isWeb, props.onPress, props.onPressPinned]);

    const rowContent = (
        <>
            <View style={{ width: 18, alignItems: 'center', justifyContent: 'center' }}>
                <Text
                    style={{
                        fontSize: 12,
                        color: descriptor.color,
                        ...Typography.default('semiBold'),
                    }}
                    accessibilityLabel={descriptor.label}
                >
                    {descriptor.code}
                </Text>
            </View>

            <InlineRepoPathLabel
                fileName={file.fileName}
                filePath={file.filePath}
                fullPath={file.fullPath}
                nameMaxWidth="70%"
                pathTextStyle={{
                    fontSize: 13,
                    color: theme.colors.textSecondary,
                    ...Typography.default(),
                }}
                nameTextStyle={{
                    fontSize: 13,
                    color: theme.colors.text ?? theme.colors.textSecondary,
                    ...Typography.default('semiBold'),
                }}
            />

            <View
                testID="scm-change-row-stats-column"
                style={{
                    width: statsColumnWidth,
                    flexShrink: 0,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: 2,
                }}
            >
                <Text style={{ fontSize: 11, fontVariant: ['tabular-nums'], color: theme.colors.success ?? theme.colors.textSecondary, ...Typography.default('semiBold') }}>
                    {`+${file.linesAdded}`}
                </Text>
                <Text style={{ fontSize: 11, fontVariant: ['tabular-nums'], color: theme.colors.textSecondary, ...Typography.default() }}>
                    {PATH_SEPARATOR}
                </Text>
                <Text style={{ fontSize: 11, fontVariant: ['tabular-nums'], color: theme.colors.textDestructive ?? theme.colors.textSecondary, ...Typography.default('semiBold') }}>
                    {`-${file.linesRemoved}`}
                </Text>
            </View>
        </>
    );

    return (
        <View style={containerStyle}>
            {props.leadingElement ? (
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    {props.leadingElement}
                </View>
            ) : null}

            {isWeb ? (
                <ViewWithClick
                    testID={`scm-change-row-${testIdSafePath}`}
                    accessibilityRole="button"
                    accessibilityLabel={t('files.changeRow.viewDiffA11y', { file: file.fullPath })}
                    onClick={onClick as any}
                    onDoubleClick={
                        props.onPressPinned
                            ? (event: any) => {
                                event?.preventDefault?.();
                                event?.stopPropagation?.();
                                props.onPressPinned?.();
                            }
                            : undefined
                    }
                    tabIndex={0}
                    onKeyDown={onKeyDown as any}
                    style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 }}
                >
                    {rowContent}
                </ViewWithClick>
            ) : (
                <Pressable
                    testID={`scm-change-row-${testIdSafePath}`}
                    accessibilityRole="button"
                    accessibilityLabel={t('files.changeRow.viewDiffA11y', { file: file.fullPath })}
                    onPress={props.onPress}
                    style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 }}
                >
                    {rowContent}
                </Pressable>
            )}

            {props.trailingElement ? (
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    {props.trailingElement}
                </View>
            ) : null}
        </View>
    );
});
