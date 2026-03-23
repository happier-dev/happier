import * as React from 'react';
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import type { FilesystemBrowserListProps } from './filesystemBrowserTypes';

export function FilesystemBrowserList(props: FilesystemBrowserListProps): React.ReactElement {
    const { theme } = useUnistyles();

    return (
        <FlatList
            ref={props.listRef}
            data={props.nodes}
            keyExtractor={(node) => `${node.type}:${node.path}`}
            style={props.style}
            contentContainerStyle={props.contentContainerStyle}
            ListHeaderComponent={
                props.rootLoading ? (
                    <View
                        style={{
                            paddingHorizontal: 12,
                            paddingVertical: 10,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 10,
                        }}
                    >
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                            {props.loadingLabel}
                        </Text>
                    </View>
                ) : props.rootError ? (
                    <View
                        testID={props.listHeaderTestID}
                        style={{
                            paddingHorizontal: 12,
                            paddingVertical: 10,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 10,
                        }}
                    >
                        <Ionicons name="alert-circle-outline" size={16} color={theme.colors.textSecondary} />
                        <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                            {props.inlineRetryLabel}
                        </Text>
                        <View style={{ flex: 1 }} />
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={props.inlineRetryLabel}
                            onPress={() => {
                                void props.retryRoot();
                            }}
                            style={{ paddingHorizontal: 10, paddingVertical: 6 }}
                        >
                            <Text style={{ fontSize: 12, color: theme.colors.textLink, ...Typography.default('semiBold') }}>
                                {props.inlineRetryLabel}
                            </Text>
                        </Pressable>
                    </View>
                ) : null
            }
            renderItem={({ item: node, index }) => props.renderRow({ node, index, totalCount: props.nodes.length })}
            initialNumToRender={props.initialNumToRender}
            maxToRenderPerBatch={props.maxToRenderPerBatch}
            windowSize={props.windowSize}
            removeClippedSubviews={props.removeClippedSubviews}
            onLayout={props.onLayout}
            onContentSizeChange={props.onContentSizeChange}
            onScroll={props.onScroll}
            onScrollToIndexFailed={props.onScrollToIndexFailed}
            scrollEventThrottle={props.scrollEventThrottle}
            getItemLayout={props.getItemLayout}
        />
    );
}
