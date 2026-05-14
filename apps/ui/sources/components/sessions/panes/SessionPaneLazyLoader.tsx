import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

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

    if (error) {
        return (
            <View
                testID={`${input.testID}-error`}
                style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 16, gap: 10 }}
            >
                <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                    {t('common.error')}
                </Text>
                <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                    {t('errors.tryAgain')}
                </Text>
                <Pressable
                    onPress={() => {
                        setImpl(null);
                        setError(null);
                        setRetryNonce((value) => value + 1);
                    }}
                    accessibilityRole="button"
                    style={{
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderRadius: 10,
                        backgroundColor: theme.colors.surface.base,
                    }}
                >
                    <Text style={{ fontSize: 12, color: theme.colors.text.primary, ...Typography.default('semiBold') }}>
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
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    return React.createElement(Impl, input.props);
}
