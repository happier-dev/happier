import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, Popover } from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { LinkBubbleProps } from './linkBubbleTypes';
import { LinkBubbleEditInput } from './LinkBubbleEditInput';

const MAX_URL_DISPLAY_LENGTH = 50;

/**
 * Link bubble primitive (Lane H, D4).
 *
 * Renders a floating bubble anchored to a rect (the caret position inside a
 * link in the markdown editor). Two internal states:
 * - "display": shows the URL (truncated) + Open / Edit / Unlink buttons.
 * - "edit": shows a TextInput pre-filled with the href + Cancel / Save.
 *
 * The bubble uses `Popover` in rect-anchor mode (Lane B) + `FloatingOverlay`
 * for surface chrome, matching the `CommandMenu` composition pattern.
 *
 * All labels use `t(...)` for i18n. Theme tokens for all colors.
 */
export const LinkBubble = React.memo(function LinkBubble(props: LinkBubbleProps) {
    const {
        open,
        anchor,
        href,
        onOpenLink,
        onUnlink,
        onSetLink,
        onRequestClose,
        testID,
    } = props;

    const { theme } = useUnistyles();
    const [isEditing, setIsEditing] = React.useState(false);

    // Reset to display mode when the href changes (e.g. cursor moved to a
    // different link) or the bubble closes.
    const prevHrefRef = React.useRef(href);
    React.useEffect(() => {
        if (prevHrefRef.current !== href) {
            prevHrefRef.current = href;
            setIsEditing(false);
        }
    }, [href]);

    React.useEffect(() => {
        if (!open) {
            setIsEditing(false);
        }
    }, [open]);

    const handleEditStart = React.useCallback(() => {
        setIsEditing(true);
    }, []);

    const handleEditCancel = React.useCallback(() => {
        setIsEditing(false);
    }, []);

    const handleSave = React.useCallback((nextHref: string) => {
        onSetLink(nextHref);
        setIsEditing(false);
    }, [onSetLink]);

    const displayHref = href.length > MAX_URL_DISPLAY_LENGTH
        ? `${href.slice(0, MAX_URL_DISPLAY_LENGTH)}…`
        : href;

    return (
        <Popover
            open={open}
            anchor={anchor}
            placement="bottom"
            gap={4}
            maxHeightCap={200}
            maxWidthCap={360}
            onRequestClose={onRequestClose}
            backdrop={{ enabled: false }}
            portal={MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
        >
            {() => (
                <View testID={testID ? `${testID}:surface` : undefined} collapsable={false}>
                    <FloatingOverlay
                        maxHeight={200}
                        scrollEnabled={false}
                        surfaceChrome="theme"
                    >
                        {isEditing ? (
                            <LinkBubbleEditInput
                                initialHref={href}
                                onSave={handleSave}
                                onCancel={handleEditCancel}
                                testID={testID ? `${testID}:edit-input` : undefined}
                            />
                        ) : (
                            <View style={styles.displayRow}>
                                <Text
                                    testID={testID ? `${testID}:url` : undefined}
                                    style={[styles.urlText, { color: theme.colors.text.link }]}
                                    numberOfLines={1}
                                >
                                    {displayHref}
                                </Text>
                                <View style={styles.buttonGroup}>
                                    <Pressable
                                        testID={testID ? `${testID}:open` : undefined}
                                        onPress={onOpenLink}
                                        style={styles.iconButton}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('markdown.linkBubble.open')}
                                    >
                                        <Text style={[styles.iconButtonText, { color: theme.colors.text.secondary }]}>
                                            {t('markdown.linkBubble.open')}
                                        </Text>
                                    </Pressable>
                                    <Pressable
                                        testID={testID ? `${testID}:edit` : undefined}
                                        onPress={handleEditStart}
                                        style={styles.iconButton}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('markdown.linkBubble.edit')}
                                    >
                                        <Text style={[styles.iconButtonText, { color: theme.colors.text.secondary }]}>
                                            {t('markdown.linkBubble.edit')}
                                        </Text>
                                    </Pressable>
                                    <Pressable
                                        testID={testID ? `${testID}:unlink` : undefined}
                                        onPress={onUnlink}
                                        style={styles.iconButton}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('markdown.linkBubble.unlink')}
                                    >
                                        <Text style={[styles.iconButtonText, { color: theme.colors.text.secondary }]}>
                                            {t('markdown.linkBubble.unlink')}
                                        </Text>
                                    </Pressable>
                                </View>
                            </View>
                        )}
                    </FloatingOverlay>
                </View>
            )}
        </Popover>
    );
});

const styles = StyleSheet.create({
    displayRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        paddingVertical: 6,
        gap: 8,
    },
    urlText: {
        flex: 1,
        fontSize: 12,
    },
    buttonGroup: {
        flexDirection: 'row',
        gap: 2,
    },
    iconButton: {
        paddingHorizontal: 6,
        paddingVertical: 3,
        borderRadius: 4,
    },
    iconButtonText: {
        fontSize: 11,
    },
});
