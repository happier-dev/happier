import * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item, type ItemProps } from '@/components/ui/lists/Item';
import { t } from '@/text';
import type { FilesystemBrowserNode, FilesystemBrowserWrapContentInput } from './filesystemBrowserTypes';
import { Icon } from '@/components/ui/icons/Icon';

export type FilesystemBrowserRowProps = Readonly<{
    node: FilesystemBrowserNode;
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
    showDivider?: boolean;
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
    const showDivider = props.showDivider === true;

    const content = props.node.type === 'error'
        ? (
            <Item
                title={props.errorTitle ?? t('common.error')}
                subtitle={props.errorSubtitle}
                icon={<Icon name="warning-circle" size={16} color={theme.colors.text.secondary} />}
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
                    icon={<Icon name="info" size={16} color={theme.colors.text.secondary} />}
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
