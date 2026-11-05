import React from 'react';
import { Pressable, type GestureResponderEvent } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { SecretKeyBackupModal } from '@/components/account/SecretKeyBackupModal';
import { useRecoveryKeyReminder } from '@/components/account/useRecoveryKeyReminder';
import { Icon } from '@/components/ui/icons/Icon';

export const RecoveryKeyReminderBanner = React.memo(() => {
    const { theme } = useUnistyles();
    const triggerRef = React.useRef<React.ComponentRef<typeof Pressable> | null>(null);
    const reminder = useRecoveryKeyReminder({ surface: 'banner' });

    if (!reminder.needed || !reminder.secret) return null;

    const secret = reminder.secret;

    return (
        <ItemGroup surface="none">
            <Item
                testID="recovery-key-reminder"
                pressableRef={triggerRef}
                // One line: it leads a list of work, and the backup it opens does the explaining.
                title={t('settingsOverview.saveRecoveryKeyTitle')}
                density="tight"
                icon={<Icon name="key" color={theme.colors.text.secondary} />}
                onPress={() => {
                    Modal.show({
                        component: SecretKeyBackupModal,
                        props: {
                            secret,
                            onSaved: reminder.markSaved,
                        },
                        focusReturnRef: triggerRef,
                    });
                }}
                showChevron={false}
                rightElement={
                    <Pressable
                        testID="recovery-key-reminder-dismiss"
                        onPress={async (event: GestureResponderEvent) => {
                            event.stopPropagation();
                            try {
                                await reminder.dismiss();
                            } catch {
                                Modal.alert(t('common.error'), t('errors.unknownError'), [{ text: t('common.ok') }]);
                            }
                        }}
                        hitSlop={12}
                    >
                        <Icon name="x" size={20} color={theme.colors.text.secondary} />
                    </Pressable>
                }
                rightElementOutsidePressable={true}
            />
        </ItemGroup>
    );
});
