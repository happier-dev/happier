import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { InboxModelBoundary, useInboxModel } from '@/hooks/inbox/useInboxModel';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { InboxContent } from './InboxContent';
import { countInbox } from './inboxCounts';
import { motionTokens } from '@/components/ui/motion/motionTokens';

/**
 * The Inbox as the rail's popover (lab `inbox-I2`): it names itself and its count, "Open Inbox" is its
 * header's one quiet action, and below are the grouped needs-you rows with inline answers. The rail's
 * popover owner (`SidebarFooterPopoverButton`) draws the floating surface and mounts this only while
 * open, so a closed rail icon holds no Inbox model.
 */
export const InboxPopoverContent = React.memo(function InboxPopoverContent(props: Readonly<{
    close: () => void;
    onOpenInbox: () => void;
}>) {
    return (
        <InboxModelBoundary>
            <OpenInboxPopoverContent {...props} />
        </InboxModelBoundary>
    );
});

const OpenInboxPopoverContent = React.memo(function OpenInboxPopoverContent(props: Readonly<{
    close: () => void;
    onOpenInbox: () => void;
}>) {
    const { theme } = useUnistyles();
    const model = useInboxModel();
    const { close, onOpenInbox } = props;
    const openInbox = React.useCallback(() => { close(); onOpenInbox(); }, [close, onOpenInbox]);
    // The number the rail badge that opened this shows: everything in the Inbox.
    const inboxCount = countInbox(model);
    return (
        <>
            <View style={styles.header}>
                <Text accessibilityRole="header" style={styles.title}>{t('tabs.inbox')}</Text>
                {inboxCount > 0 ? <Text testID="inbox.popover.count" style={styles.count}>{String(inboxCount)}</Text> : null}
                <View style={styles.grow} />
                <Pressable testID="inbox.popover.open" accessibilityRole="button" accessibilityLabel={t('inbox.openInbox')} onPress={openInbox} hitSlop={8} style={({ pressed }) => [styles.openAction, pressed ? styles.openActionPressed : null]}>
                    <Text style={styles.openLabel}>{t('inbox.openInbox')}</Text>
                    <Icon name="caret-right" size={14} color={theme.colors.text.tertiary} />
                </Pressable>
            </View>
            <InboxContent model={model} onBeforeNavigate={close} onOpenInbox={openInbox} presentation="popover" />
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    header: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        paddingLeft: 16,
        paddingRight: 12,
        paddingTop: 6,
    },
    title: { fontSize: 14, lineHeight: 18, ...Typography.default('semiBold'), color: theme.colors.text.primary },
    count: { fontSize: 13, lineHeight: 18, ...Typography.default('regular'), color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'] },
    grow: { flex: 1 },
    openAction: {
        minHeight: 32,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    openActionPressed: { opacity: motionTokens.press.opacity },
    openLabel: { fontSize: 13, lineHeight: 18, ...Typography.default('regular'), color: theme.colors.text.secondary },
}));
