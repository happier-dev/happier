import * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item, type ItemProps } from '@/components/ui/lists/Item';
import { t } from '@/text';
import type { FilesystemBrowserNode, FilesystemBrowserWrapContentInput } from './filesystemBrowserTypes';

export type FilesystemBrowserRowProps = Readonly<{
    node: FilesystemBrowserNode;
    index: number;
    totalCount: number;
    title: string;
    subtitle?: React.ReactNode;
    icon: React.ReactNode;
    rightElement?: React.ReactNode;
    onPress?: () => void;
    onDoublePress?: () => void;
    onLongPress?: () => void;
    onContextMenu?: (event: unknown) => void;
    selected?: boolean;
    testID?: string;
    density?: ItemProps['density'];
    basePaddingLeft?: number;
    depthIndent?: number;
    paddingRight?: number;
    style?: StyleProp<ViewStyle>;
    errorTitle?: string;
    errorSubtitle?: React.ReactNode;
    onRetryError?: (node: FilesystemBrowserNode) => void | Promise<void>;
    wrapContent?: ((input: FilesystemBrowserWrapContentInput) => React.ReactElement) | null;
}>;

export function FilesystemBrowserRow(props: FilesystemBrowserRowProps): React.ReactElement {
    const { theme } = useUnistyles();
    const paddingLeft = (props.basePaddingLeft ?? 12) + Math.min(6, Math.max(0, props.node.depth)) * (props.depthIndent ?? 12);
    const showDivider = props.index < props.totalCount - 1;

    const content = props.node.type === 'error'
        ? (
            <Item
                title={props.errorTitle ?? t('common.error')}
                subtitle={props.errorSubtitle}
                icon={<Ionicons name="alert-circle-outline" size={18} color={theme.colors.textSecondary} />}
                density={props.density}
                showChevron={false}
                onPress={() => {
                    if (props.onRetryError) {
                        void props.onRetryError(props.node);
                    }
                }}
                showDivider={showDivider}
                style={{
                    paddingLeft,
                    paddingRight: props.paddingRight ?? 12,
                }}
            />
        )
        : props.node.type === 'info'
            ? (
                <Item
                    testID={props.testID}
                    title={props.title}
                    subtitle={props.subtitle}
                    icon={<Ionicons name="information-circle-outline" size={18} color={theme.colors.textSecondary} />}
                    density={props.density}
                    showChevron={false}
                    showDivider={showDivider}
                    style={[
                        {
                            paddingLeft,
                            paddingRight: props.paddingRight ?? 12,
                        },
                        props.style,
                    ]}
                />
            )
        : (
            <Item
                testID={props.testID}
                title={props.title}
                subtitle={props.subtitle}
                icon={props.icon}
                density={props.density}
                rightElement={props.rightElement}
                showChevron={false}
                selected={props.selected}
                onPress={props.onPress}
                onDoublePress={props.onDoublePress}
                onLongPress={props.onLongPress}
                onContextMenu={props.onContextMenu}
                showDivider={showDivider}
                style={[
                    {
                        paddingLeft,
                        paddingRight: props.paddingRight ?? 12,
                    },
                    props.style,
                ]}
            />
        );

    if (!props.wrapContent) {
        return content;
    }

    return props.wrapContent({
        node: props.node,
        content,
    });
}
