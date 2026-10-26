import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { t } from '@/text';
import { trackFriendsSearch } from '@/track';

export function FriendsAddButton({ variant = 'icon' }: Readonly<{ variant?: 'icon' | 'text' }>) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { isReady } = useFriendsIdentityReadiness();

    return (
        <Pressable
            testID="friends-add-friend"
            accessibilityRole="button"
            accessibilityLabel={t('friends.addFriend')}
            accessibilityState={{ disabled: !isReady }}
            disabled={!isReady}
            hitSlop={15}
            style={[variant === 'text' ? styles.textButton : styles.iconButton, { opacity: isReady ? 1 : 0.5 }]}
            onPress={() => {
                if (!isReady) return;
                trackFriendsSearch();
                router.push('/friends/search');
            }}
        >
            {variant === 'text'
                ? <Text style={styles.label}>{t('friends.addFriend')}</Text>
                : <Icon name="user-plus" size={24} color={theme.colors.chrome.header.foreground} />}
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    iconButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    textButton: { paddingHorizontal: 16 },
    label: { color: theme.colors.button.primary.tint, fontSize: 16 },
}));
