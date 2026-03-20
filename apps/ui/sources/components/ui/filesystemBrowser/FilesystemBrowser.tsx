import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { FilesystemBrowserList } from './FilesystemBrowserList';
import type { FilesystemBrowserListProps } from './filesystemBrowserTypes';

export type FilesystemBrowserProps = FilesystemBrowserListProps & Readonly<{
    loadingTestID?: string;
    errorTestID?: string;
    emptyTestID?: string;
    emptyLabel: string;
    emptyIconName?: React.ComponentProps<typeof Ionicons>['name'];
    loadingLabelCentered?: string;
    retryLabel?: string;
}>;

export function FilesystemBrowser(props: FilesystemBrowserProps): React.ReactElement {
    const { theme } = useUnistyles();
    const retryLabel = props.retryLabel ?? props.inlineRetryLabel;
    const centeredLoadingLabel = props.loadingLabelCentered ?? props.loadingLabel;

    if (props.rootLoading && props.nodes.length === 0) {
        return (
            <View
                testID={props.loadingTestID}
                style={{
                    flex: 1,
                    justifyContent: 'center',
                    alignItems: 'center',
                    paddingTop: 40,
                }}
            >
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                <Text
                    style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
                        textAlign: 'center',
                        marginTop: 16,
                        ...Typography.default(),
                    }}
                >
                    {centeredLoadingLabel}
                </Text>
            </View>
        );
    }

    if (props.rootError && props.nodes.length === 0) {
        return (
            <View
                testID={props.errorTestID}
                style={{
                    flex: 1,
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 12,
                    paddingHorizontal: 20,
                }}
            >
                <Ionicons name="alert-circle-outline" size={28} color={theme.colors.textSecondary} />
                <Text style={{ fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() }}>
                    {props.rootError}
                </Text>
                <RoundButton title={retryLabel} display="inverted" onPress={() => { void props.retryRoot(); }} />
            </View>
        );
    }

    if (props.nodes.length === 0) {
        return (
            <View
                testID={props.emptyTestID}
                style={{
                    flex: 1,
                    justifyContent: 'center',
                    alignItems: 'center',
                    paddingTop: 40,
                    paddingHorizontal: 20,
                }}
            >
                <Ionicons name={props.emptyIconName ?? 'folder-outline'} size={48} color={theme.colors.textSecondary} />
                <Text
                    style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
                        textAlign: 'center',
                        marginTop: 16,
                        ...Typography.default(),
                    }}
                >
                    {props.emptyLabel}
                </Text>
            </View>
        );
    }

    return <FilesystemBrowserList {...props} />;
}
