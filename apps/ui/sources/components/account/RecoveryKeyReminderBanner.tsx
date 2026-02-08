import React from 'react';
import { Pressable, type GestureResponderEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useAuth } from '@/auth/AuthContext';
import { TokenStorage } from '@/auth/tokenStorage';
import { getServerFeatures } from '@/sync/apiFeatures';
import { Modal } from '@/modal';
import { t } from '@/text';
import { SecretKeyBackupModal } from '@/components/account/SecretKeyBackupModal';

export const RecoveryKeyReminderBanner = React.memo(() => {
    const auth = useAuth();

    const [dismissed, setDismissed] = React.useState<boolean | null>(null);
    const [enabled, setEnabled] = React.useState<boolean | null>(null);

    React.useEffect(() => {
        let mounted = true;
        void (async () => {
            const [isDismissed, features] = await Promise.all([
                TokenStorage.getRecoveryKeyReminderDismissed().catch(() => true),
                getServerFeatures({ timeoutMs: 800 }).catch(() => null),
            ]);

            const featureEnabled = features?.features?.auth?.ui?.recoveryKeyReminder?.enabled === true;
            if (!mounted) return;
            setDismissed(isDismissed);
            setEnabled(featureEnabled);
        })();
        return () => {
            mounted = false;
        };
    }, []);

    if (!auth.isAuthenticated) return null;
    if (!auth.credentials?.secret) return null;
    if (dismissed !== false) return null;
    if (enabled !== true) return null;

    return (
        <ItemGroup>
            <Item
                title={t('settingsAccount.secretKey')}
                subtitle={t('settingsAccount.backupDescription')}
                icon={<Ionicons name="key-outline" size={28} />}
                onPress={() => {
                    Modal.show({
                        component: SecretKeyBackupModal,
                        props: { secret: auth.credentials!.secret },
                    });
                }}
                showChevron={false}
                rightElement={
                    <Pressable
                        onPress={async (event: GestureResponderEvent) => {
                            event.stopPropagation();
                            try {
                                await TokenStorage.setRecoveryKeyReminderDismissed(true);
                                setDismissed(true);
                            } catch {
                                Modal.alert(t('common.error'), t('errors.unknownError'), [{ text: t('common.ok') }]);
                            }
                        }}
                        hitSlop={12}
                    >
                        <Ionicons name="close" size={20} />
                    </Pressable>
                }
            />
        </ItemGroup>
    );
});
