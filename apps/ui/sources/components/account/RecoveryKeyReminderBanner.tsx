import React from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { useRecoveryKeyReminder } from '@/components/account/useRecoveryKeyReminder';
import { Icon } from '@/components/ui/icons/Icon';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';

/**
 * "Save your recovery key": one message on My work in the standard Item/ItemGroup chrome:
 * the key, the title, the reason beneath and its dismiss. Account setup carries the same reminder in its hub tile.
 */
export const RecoveryKeyReminderBanner = React.memo((props: Readonly<{
    /** A list that leads with it already spaces it from what is above; a page keeps the section gap. */
    header?: 'none';
    /** The leading list's spacing around the card (its rhythm is the list's, not the card's). */
    style?: StyleProp<ViewStyle>;
}>) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const reminder = useRecoveryKeyReminder({ surface: 'banner' });

    if (!reminder.needed) return null;

    const open = () => router.push(SETTINGS_ROUTES.accountSecurity);
    // Amber: the key is the one thing on the list that needs the person.
    const icon = <Icon name="key" color={theme.colors.state.warning.foreground} />;
    const dismiss = (
        <HappierPressable
            testID="recovery-key-reminder-dismiss"
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
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

    return (
        <ItemGroup {...(props.header ? { header: props.header } : {})} style={props.style}>
            <Item
                testID="recovery-key-reminder"
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
