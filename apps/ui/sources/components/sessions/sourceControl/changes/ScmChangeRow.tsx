import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { normalizeRepoPathParts } from '@/utils/path/normalizeRepoPathParts';

const PATH_SEPARATOR = '/';

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

function describeChange(file: ScmFileStatus, theme: any): ChangeDescriptor {
    const info = theme.colors.info ?? theme.colors.textSecondary;
    const success = theme.colors.success ?? theme.colors.textSecondary;
    const warning = theme.colors.warning ?? theme.colors.textSecondary;
    const danger = theme.colors.danger ?? theme.colors.textDestructive ?? theme.colors.textSecondary;

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
    theme: any;
    file: ScmFileStatus;
    onPress: () => void;
    onPressPinned?: () => void;
    onToggleSelection?: () => void;
    leadingElement?: React.ReactNode;
    trailingElement?: React.ReactNode;
    density?: 'comfortable' | 'compact';
    showDivider?: boolean;
    highlighted?: boolean;
}>;

export const ScmChangeRow = React.memo((props: ScmChangeRowProps) => {
    const { theme, file, density = 'comfortable' } = props;
    const descriptor = describeChange(file, theme);
    const testIdSafePath = React.useMemo(() => toTestIdSafeValue(file.fullPath), [file.fullPath]);
    const isWeb = Platform.OS === 'web';

    const paddingVertical = density === 'compact' ? 4 : 10;

    const containerStyle = React.useMemo(() => {
        const bg = props.highlighted
            ? (theme.colors.surfaceHigh ?? theme.colors.surface)
            : theme.colors.surface;
        return {
            paddingHorizontal: 12,
            paddingVertical,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            backgroundColor: bg,
            borderBottomWidth: props.showDivider ? Platform.select({ ios: 0.33, default: 1 }) : 0,
            borderBottomColor: theme.colors.divider,
        } as const;
    }, [paddingVertical, props.highlighted, props.showDivider, theme.colors.divider, theme.colors.surface, theme.colors.surfaceHigh]);

    const { dir, name } = React.useMemo(() => {
        return normalizeRepoPathParts({ fileName: file.fileName, filePath: file.filePath, fullPath: file.fullPath });
    }, [file.fileName, file.filePath, file.fullPath]);
    const hasDir = Boolean(dir);
    const dirLabel = hasDir ? `${dir}${PATH_SEPARATOR}` : null;

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

            <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline' }}>
                {dirLabel ? (
                    <Text
                        numberOfLines={1}
                        ellipsizeMode={isWeb ? 'clip' : 'tail'}
                        style={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: 13,
                            color: theme.colors.textSecondary,
                            ...Typography.default(),
                        }}
                    >
                        {dirLabel}
                    </Text>
                ) : (
                    // Keep the filename aligned to the right even for root-level files.
                    <View style={{ flex: 1, minWidth: 0 }} />
                )}
                <Text
                    numberOfLines={1}
                    ellipsizeMode="middle"
                    style={{
                        flexShrink: 0,
                        maxWidth: '70%' as any,
                        fontSize: 13,
                        color: theme.colors.text,
                        ...Typography.default('semiBold'),
                    }}
                >
                    {name}
                </Text>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                <Text style={{ fontSize: 11, color: theme.colors.success, ...Typography.default('semiBold') }}>
                    {`+${file.linesAdded}`}
                </Text>
                <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                    {PATH_SEPARATOR}
                </Text>
                <Text style={{ fontSize: 11, color: theme.colors.danger ?? theme.colors.textDestructive, ...Typography.default('semiBold') }}>
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
