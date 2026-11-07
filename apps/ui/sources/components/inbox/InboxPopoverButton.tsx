import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { PressableSurface } from '@/components/ui/interaction/PressableSurface';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { InboxSummary } from '@/hooks/inbox/useInboxSummary';

import { InboxContent } from './InboxContent';
import { useInboxContentModel } from './useInboxContentModel';

const InboxPopoverContent = React.memo(function InboxPopoverContent(props: Readonly<{
    close: () => void;
}>) {
    const { theme } = useUnistyles();
    const model = useInboxContentModel();
    const openFullInbox = React.useCallback(() => {
        props.close();
        model.openInbox();
    }, [model, props.close]);

    return (
        <>
            <InboxContent model={model} onBeforeNavigate={props.close} presentation="popover" />
            <Pressable
                testID="inbox.open_full"
                accessibilityRole="button"
                accessibilityLabel={t('inbox.openInbox')}
                onPress={openFullInbox}
                style={({ pressed }) => [styles.openInboxButton, pressed ? styles.openInboxButtonPressed : null]}
            >
                <Text style={styles.openInboxText}>{t('inbox.openInbox')}</Text>
                <Icon name="arrow-square-out" size={16} color={theme.colors.text.primary} />
            </Pressable>
        </>
    );
});

export const InboxPopoverButton = React.memo(function InboxPopoverButton(props: Readonly<{
    summary: InboxSummary;
    buttonSize: number;
    iconSize: number;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const [webAnchorRect, setWebAnchorRect] = React.useState<Readonly<{
        left: number;
        top: number;
        width: number;
        height: number;
    }> | null>(null);
    const close = React.useCallback(() => setOpen(false), []);
    const accessibilityLabel = t('tabs.inbox');

    return (
        <View ref={anchorRef} collapsable={false} style={styles.anchor}>
            <PressableSurface
                testID={props.testID ?? 'sidebar-inbox-button'}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                webTooltip={accessibilityLabel}
                focusRingRadius={props.buttonSize / 2}
                accessibilityState={{ expanded: open }}
                hitSlop={8}
                onPress={(event) => {
                    if (!open && Platform.OS === 'web') {
                        const target = event?.currentTarget as unknown as {
                            getBoundingClientRect?: () => Readonly<{ left: number; top: number; width: number; height: number }>;
                        };
                        const rect = target?.getBoundingClientRect?.();
                        if (rect) setWebAnchorRect(rect);
                    }
                    setOpen((current) => !current);
                }}
                style={[
                    styles.button,
                    {
                        width: props.buttonSize,
                        height: props.buttonSize,
                        borderRadius: props.buttonSize / 2,
                    },
                ]}
            >
                <View style={styles.glyph}>
                    <Icon
                        name="mailbox"
                        size={props.iconSize}
                        color={theme.colors.chrome.header.foreground}
                    />
                    {props.summary.hasContent ? <View testID="sidebar-inbox-attention-dot" style={styles.attentionDot} /> : null}
                </View>
            </PressableSurface>

            {open ? (
                <Popover
                    open
                    anchorRef={anchorRef}
                    anchor={webAnchorRect ? {
                        kind: 'rect',
                        rect: webAnchorRect,
                        coordinateSpace: 'window',
                    } : undefined}
                    boundaryRef={null}
                    placement="bottom"
                    edgePadding={{ horizontal: 12, vertical: 12 }}
                    portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false, anchorAlign: 'end' }}
                    maxWidthCap={420}
                    maxHeightCap={560}
                    onRequestClose={close}
                >
                    {({ maxHeight, maxWidth }) => (
                        <FloatingOverlay
                            maxHeight={Math.min(maxHeight, 560)}
                            edgeFades={{ top: true, bottom: true, size: 18 }}
                            edgeIndicators
                            surfaceChrome="theme"
                            containerStyle={{ width: Math.min(maxWidth, 400) }}
                        >
                            <InboxPopoverContent close={close} />
                        </FloatingOverlay>
                    )}
                </Popover>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    anchor: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    button: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    glyph: {
        position: 'relative',
        alignItems: 'center',
        justifyContent: 'center',
    },
    attentionDot: {
        position: 'absolute',
        right: -3,
        top: -2,
        width: 7,
        height: 7,
        borderRadius: 4,
        backgroundColor: theme.colors.chrome.header.foreground,
        borderWidth: 1.5,
        borderColor: theme.colors.background.canvas,
    },
    openInboxButton: {
        minHeight: 48,
        paddingHorizontal: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    openInboxButtonPressed: {
        opacity: 0.72,
        transform: [{ scale: 0.99 }],
    },
    openInboxText: {
        fontSize: 14,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
}));
