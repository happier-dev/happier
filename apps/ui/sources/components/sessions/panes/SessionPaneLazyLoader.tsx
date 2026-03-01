import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
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
    const { theme } = useUnistyles();

    React.useEffect(() => {
        let cancelled = false;
        void input.load().then((mod) => {
            if (cancelled) return;
            setImpl(() => mod);
        });
        return () => {
            cancelled = true;
        };
    }, [input.load]);

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
