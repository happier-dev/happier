import { Header } from '@/components/navigation/Header';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useIsTablet } from '@/utils/platform/responsive';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { View, Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Text } from '@/components/ui/text/Text';
import { useConnectionHealth } from '@/components/navigation/connectionStatus/useConnectionHealth';


export const ZenHeader = React.memo(() => {
    const isTablet = useIsTablet();
    return (
        <Header
            title={isTablet ? <HeaderTitleTablet /> : <HeaderTitle />}
            headerRight={() => <HeaderRight />}
            headerLeft={isTablet ? () => null : () => <HeaderLeft />}
            headerShadowVisible={false}
            headerTransparent={true}
        />
    )
});

function HeaderTitleTablet() {
    const { theme } = useUnistyles();
    return (
        <Text style={{
            fontSize: 17,
            color: theme.colors.chrome.header.foreground,
            fontWeight: '600',
            ...Typography.default('semiBold'),
        }}>
            {t('zen.title')}
        </Text>
    );
}

function HeaderTitle() {
    const { theme } = useUnistyles();
    const connectionHealth = useConnectionHealth();

    return (
        <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{
                fontSize: 17,
                color: theme.colors.chrome.header.foreground,
                fontWeight: '600',
                ...Typography.default('semiBold'),
            }}>
                {t('zen.title')}
            </Text>
            {connectionHealth.statusLabelKey ? (
                <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginTop: -2,
                }}>
                    <StatusDot
                        color={connectionHealth.color}
                        isPulsing={connectionHealth.isPulsing}
                        size={6}
                        style={{ marginRight: 4 }}
                    />
                    <Text style={{
                        fontSize: 12,
                        fontWeight: '500',
                        lineHeight: 16,
                        color: connectionHealth.color,
                        ...Typography.default(),
                    }}>
                        {t(connectionHealth.statusLabelKey)}
                    </Text>
                </View>
            ) : null}
        </View>
    );
}

function HeaderLeft() {
    const { theme } = useUnistyles();
    return (
        <View style={{
            width: 32,
            height: 32,
            alignItems: 'center',
            justifyContent: 'center',
        }}>
            <Image
                source={require('@/assets/images/logo-black.png')}
                contentFit="contain"
                style={[{ width: 24, height: 24 }]}
                tintColor={theme.colors.chrome.header.foreground}
            />
        </View>
    );
}

function HeaderRight() {
    const router = useRouter();
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={() => router.push('/zen/new')}
            hitSlop={15}
            style={{
                width: 32,
                height: 32,
                alignItems: 'center',
                justifyContent: 'center',
            }}
        >
            <Ionicons name="add-outline" size={28} color={theme.colors.chrome.header.foreground} />
        </Pressable>
    );
}   
