import React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { CollectionNavigationRow } from '@/components/ui/lists/collection/CollectionList';
import { Modal } from '@/modal';
import { t } from '@/text';
import { SecretKeyBackupModal } from '@/components/account/SecretKeyBackupModal';
import { useRecoveryKeyReminder } from '@/components/account/useRecoveryKeyReminder';
import { Icon } from '@/components/ui/icons/Icon';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';

/**
 * "Save your recovery key": one message, drawn as a row of the surface it leads. In a list (`host="list"`, the
 * phone's My work) it is one of the list's rows, so its key, title and dismiss stand on the list's glyph, title
 * and trailing edges (phone-system lab D2); on a page it is a row of its own section.
 */
export const RecoveryKeyReminderBanner = React.memo((props: Readonly<{
    host?: 'list' | 'page';
}>) => {
    const { theme } = useUnistyles();
    const triggerRef = React.useRef<React.ComponentRef<typeof Pressable> | null>(null);
    const reminder = useRecoveryKeyReminder({ surface: 'banner' });

    if (!reminder.needed || !reminder.secret) return null;

    const secret = reminder.secret;
    const open = () => {
        Modal.show({
            component: SecretKeyBackupModal,
            props: {
                secret,
                onSaved: reminder.markSaved,
            },
            focusReturnRef: triggerRef,
        });
    };
    // Amber: the key is the one thing on the list that needs the person.
    const icon = <Icon name="key" color={theme.colors.state.warning.foreground} />;
    const dismiss = (
        <HappierPressable
            testID="recovery-key-reminder-dismiss"
            accessibilityRole="button"
            accessibilityLabel={t('common.dismiss')}
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
    );

    if (props.host === 'list') {
        return (
            <CollectionNavigationRow
                testID="recovery-key-reminder"
                title={t('settingsOverview.saveRecoveryKeyTitle')}
                subtitle={t('settingsOverview.saveRecoveryKeyReason')}
                icon={icon}
                selected={false}
                rightElement={dismiss}
                onPress={open}
            />
        );
    }

    return (
        <ItemGroup surface="none">
            <Item
                testID="recovery-key-reminder"
                pressableRef={triggerRef}
                title={t('settingsOverview.saveRecoveryKeyTitle')}
                subtitle={t('settingsOverview.saveRecoveryKeyReason')}
                icon={icon}
                onPress={open}
                showChevron={false}
                rightElement={dismiss}
                rightElementOutsidePressable={true}
            />
        </ItemGroup>
    );
});
