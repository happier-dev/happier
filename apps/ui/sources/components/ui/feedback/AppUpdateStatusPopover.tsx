import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';

import type { VisibleAppUpdateStatusModel } from '@/updates/updateStatusTypes';

export type AppUpdateStatusPopoverProps = Readonly<{
    anchorRef: React.RefObject<unknown>;
    model: VisibleAppUpdateStatusModel;
    onPrimaryAction: () => void | Promise<void>;
    onDismiss?: () => void;
    onRequestClose: () => void;
    open: boolean;
    testID?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    content: {
        gap: 14,
        paddingHorizontal: 16,
        paddingVertical: 16,
        backgroundColor: theme.colors.surface,
    },
    title: {
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.text,
    },
    message: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
    },
    actionButton: {
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: theme.colors.surface,
    },
    primaryButton: {
        backgroundColor: theme.colors.button.primary.background,
        borderColor: theme.colors.button.primary.background,
    },
    actionText: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text,
    },
    primaryActionText: {
        color: theme.colors.button.primary.tint,
    },
    disabledButton: {
        opacity: 0.6,
    },
}));

export function AppUpdateStatusPopover(props: AppUpdateStatusPopoverProps) {
    const styles = stylesheet;
    useUnistyles();

    return (
        <Popover
            open={props.open}
            anchorRef={props.anchorRef}
            placement="bottom"
            edgePadding={{ horizontal: 12, vertical: 12 }}
            portal={{
                web: true,
                native: true,
                matchAnchorWidth: false,
                anchorAlign: 'end',
            }}
            maxWidthCap={320}
            onRequestClose={props.onRequestClose}
        >
            {({ maxHeight }) => (
                <FloatingOverlay
                    maxHeight={Math.max(160, Math.min(maxHeight, 320))}
                    keyboardShouldPersistTaps="always"
                    edgeFades={{ top: false, bottom: false, size: 0 }}
                    edgeIndicators={false}
                >
                    <View testID={props.testID} style={styles.content}>
                        <Text style={styles.title}>{props.model.label}</Text>
                        <Text style={styles.message}>{props.model.message}</Text>
                        <View style={styles.actions}>
                            {props.model.dismissLabel && props.onDismiss ? (
                                <Pressable
                                    style={styles.actionButton}
                                    onPress={props.onDismiss}
                                    accessibilityRole="button"
                                >
                                    <Text style={styles.actionText}>{props.model.dismissLabel}</Text>
                                </Pressable>
                            ) : null}
                            <Pressable
                                style={[
                                    styles.actionButton,
                                    styles.primaryButton,
                                    props.model.actionDisabled ? styles.disabledButton : null,
                                ]}
                                disabled={props.model.actionDisabled}
                                onPress={() => {
                                    void props.onPrimaryAction();
                                }}
                                accessibilityRole="button"
                            >
                                <Text style={[styles.actionText, styles.primaryActionText]}>{props.model.actionLabel}</Text>
                            </Pressable>
                        </View>
                    </View>
                </FloatingOverlay>
            )}
        </Popover>
    );
}
