import * as React from 'react';
import { Platform, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import {
    WEB_START_ELLIPSIS_CONTAINER_TEXT_STYLE,
    WEB_START_ELLIPSIS_CONTENT_TEXT_STYLE,
} from '@/components/ui/text/webStartEllipsisTextStyles';
import { normalizeRepoPathParts } from '@/utils/path/normalizeRepoPathParts';

const PATH_SEPARATOR = '/';
const ROOT_FILE_ALIGNMENT_SPACER_STYLE = { flex: 1, minWidth: 0 } satisfies ViewStyle;

export type InlineRepoPathLabelProps = Readonly<{
    fileName?: string | null;
    filePath?: string | null;
    fullPath?: string | null;
    nameSuffix?: string;
    alignForRootFiles?: boolean;
    style?: StyleProp<ViewStyle>;
    pathTextStyle?: StyleProp<TextStyle>;
    nameTextStyle?: StyleProp<TextStyle>;
    nameMaxWidth?: number | `${number}%`;
}>;

export const InlineRepoPathLabel = React.memo(function InlineRepoPathLabel(props: InlineRepoPathLabelProps) {
    const { dir, name } = React.useMemo(() => {
        return normalizeRepoPathParts({
            fileName: props.fileName,
            filePath: props.filePath,
            fullPath: props.fullPath,
        });
    }, [props.fileName, props.filePath, props.fullPath]);

    const isWeb = Platform.OS === 'web';
    const dirLabel = dir ? `${dir}${PATH_SEPARATOR}` : null;
    const containerStyle = React.useMemo<StyleProp<ViewStyle>>(() => {
        return [
            {
                flex: 1,
                minWidth: 0,
                flexDirection: 'row',
                alignItems: 'baseline',
            } satisfies ViewStyle,
            props.style,
        ];
    }, [props.style]);
    const pathStyle = React.useMemo<StyleProp<TextStyle>>(() => {
        return [
            {
                flex: 1,
                minWidth: 0,
            } satisfies TextStyle,
            isWeb
                ? WEB_START_ELLIPSIS_CONTAINER_TEXT_STYLE
                : { textAlign: 'right' } satisfies TextStyle,
            props.pathTextStyle,
        ];
    }, [isWeb, props.pathTextStyle]);
    const nameStyle = React.useMemo<StyleProp<TextStyle>>(() => {
        return [
            {
                flexShrink: 0,
            } satisfies TextStyle,
            props.nameMaxWidth != null ? { maxWidth: props.nameMaxWidth } satisfies TextStyle : null,
            props.nameTextStyle,
        ];
    }, [props.nameMaxWidth, props.nameTextStyle]);

    return (
        <View style={containerStyle}>
            {dirLabel ? (
                <Text numberOfLines={1} ellipsizeMode={isWeb ? undefined : 'head'} style={pathStyle}>
                    {isWeb ? (
                        <Text style={WEB_START_ELLIPSIS_CONTENT_TEXT_STYLE}>
                            {dirLabel}
                        </Text>
                    ) : dirLabel}
                </Text>
            ) : props.alignForRootFiles === false ? null : (
                <View style={ROOT_FILE_ALIGNMENT_SPACER_STYLE} />
            )}
            <Text numberOfLines={1} ellipsizeMode="middle" style={nameStyle}>
                {`${name}${props.nameSuffix ?? ''}`}
            </Text>
        </View>
    );
});
