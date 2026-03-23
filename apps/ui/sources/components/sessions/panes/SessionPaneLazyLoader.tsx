import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export type SessionPaneLazyLoaderProps<TProps extends object> = Readonly<{
    testID: string;
    load: () => Promise<React.ComponentType<TProps>>;
    props: TProps;
}>;

export function SessionPaneLazyLoader<TProps extends object>(input: SessionPaneLazyLoaderProps<TProps>) {
    const [Impl, setImpl] = React.useState<React.ComponentType<TProps> | null>(null);
    const [retryNonce, setRetryNonce] = React.useState(0);
    const [error, setError] = React.useState<unknown>(null);
    const { theme } = useUnistyles();

    React.useEffect(() => {
        let cancelled = false;
        setError(null);
        void input.load()
            .then((mod) => {
                if (cancelled) return;
                setImpl(() => mod);
            })
            .catch((loadError) => {
                if (cancelled) return;
                setError(loadError);
            });
        return () => {
            cancelled = true;
        };
    }, [input.load, retryNonce]);

    const onRetry = React.useCallback(() => {
        setImpl(null);
        setError(null);
        setRetryNonce((value) => value + 1);
    }, []);

    if (error) {
        return (
            <View
                testID={`${input.testID}-error`}
                style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 16, gap: 10 }}
            >
                <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                    {t('common.error')}
                </Text>
                <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                    {t('errors.tryAgain')}
                </Text>
                <Pressable
                    onPress={onRetry}
                    accessibilityRole="button"
                    style={{
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderRadius: 10,
                        backgroundColor: theme.colors.surface,
                    }}
                >
                    <Text style={{ fontSize: 12, color: theme.colors.text, ...Typography.default('semiBold') }}>
                        {t('common.retry')}
                    </Text>
                </Pressable>
            </View>
        );
    }

    if (!Impl) {
        return (
            <View
                testID={input.testID}
                style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 16, gap: 10 }}
            >
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    return React.createElement(Impl, input.props);
}
