import React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { SecretKeyBackupModal } from '@/components/account/SecretKeyBackupModal';
import { useRecoveryKeyReminder } from '@/components/account/useRecoveryKeyReminder';
import { Icon } from '@/components/ui/icons/Icon';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';

export const RecoveryKeyReminderBanner = React.memo((props: Readonly<{
    /** A list that leads with it already spaces it from what is above; a page keeps the section gap. */
    header?: 'none';
}>) => {
    const { theme } = useUnistyles();
    const triggerRef = React.useRef<React.ComponentRef<typeof Pressable> | null>(null);
    const reminder = useRecoveryKeyReminder({ surface: 'banner' });

    if (!reminder.needed || !reminder.secret) return null;

    const secret = reminder.secret;

    return (
        <ItemGroup surface="none" header={props.header}>
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
                    <HappierPressable
                        testID="recovery-key-reminder-dismiss"
                        // Beside the row's own target: it takes the 8 px accessory gap before it and the free edge after it.
                        hitTarget={HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE}
                        hitReach={{ left: 8 }}
                        onPress={async (event) => {
                            event?.stopPropagation?.();
                            try {
                                await reminder.dismiss();
                            } catch {
                                Modal.alert(t('common.error'), t('errors.unknownError'), [{ text: t('common.ok') }]);
                            }
                        }}
                    >
                        <Icon name="x" size={20} color={theme.colors.text.secondary} />
                    </HappierPressable>
                }
                rightElementOutsidePressable={true}
            />
        </ItemGroup>
    );
});
