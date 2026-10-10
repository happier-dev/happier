import React from 'react';
import { View, Pressable } from 'react-native';
import { BaseModal } from './BaseModal';
import { AlertModalConfig, ConfirmModalConfig } from '../types';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { ModalCardFrame } from './card/ModalCardFrame';


interface WebAlertModalProps {
    config: AlertModalConfig | ConfirmModalConfig;
    onClose: () => void;
    onConfirm?: (value: boolean) => void;
    showBackdrop?: boolean;
    zIndexBase?: number;
}

const stylesheet = StyleSheet.create((theme) => ({
    content: {
        paddingHorizontal: 16,
        paddingTop: 20,
        paddingBottom: 16,
        alignItems: 'center',
    },
    title: {
        fontSize: 17,
        textAlign: 'center',
        color: theme.colors.text.primary,
        marginBottom: 4,
    },
    message: {
        fontSize: 13,
        textAlign: 'center',
        color: theme.colors.text.primary,
        marginTop: 4,
        lineHeight: 18,
    },
    buttonContainer: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    buttonRow: {
        flexDirection: 'row',
    },
    buttonColumn: {
        flexDirection: 'column',
    },
    button: {
        flex: 1,
        paddingVertical: 11,
        paddingHorizontal: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonPressed: {
        backgroundColor: theme.colors.border.default,
    },
    separatorVertical: {
        width: 1,
        backgroundColor: theme.colors.border.default,
    },
    separatorHorizontal: {
        height: 1,
        backgroundColor: theme.colors.border.default,
    },
    buttonText: {
        fontSize: 17,
        color: theme.colors.text.primary,
        textAlign: 'center',
        lineHeight: 20,
        flexShrink: 1,
        paddingHorizontal: 2,
    },
    primaryText: {
        color: theme.colors.text.primary,
    },
    cancelText: {
        fontWeight: '400',
    },
    destructiveText: {
        color: theme.colors.state.danger.foreground,
    },
}));

export function WebAlertModal({ config, onClose, onConfirm, showBackdrop = true, zIndexBase }: WebAlertModalProps) {
    useUnistyles();
    const styles = stylesheet;
    const isConfirm = config.type === 'confirm';
    
    const handleButtonPress = (buttonIndex: number) => {
        if (isConfirm && onConfirm) {
            onConfirm(buttonIndex === 1);
            return;
        }
        if (!isConfirm && config.buttons?.[buttonIndex]?.onPress) {
            config.buttons[buttonIndex].onPress!();
        }
        onClose();
    };

    const buttons = isConfirm
        ? [
            { text: config.cancelText || t('common.cancel'), style: 'cancel' as const },
            { text: config.confirmText || t('common.ok'), style: config.destructive ? 'destructive' as const : 'default' as const }
        ]
        : (config.buttons && config.buttons.length > 0)
            ? config.buttons
            : [{ text: t('common.ok'), style: 'default' as const }];

    // Two choices sit side by side; three or more stack, each a full-width row in the caller's order (DESIGN-9 N33).
    const buttonLayout = buttons.length > 2 ? 'column' : 'row';

    const resolveButtonTestId = (index: number): string => {
        if (isConfirm) {
            if (index === 0) return 'web-modal-cancel';
            if (index === 1) return 'web-modal-confirm';
        }
        return `web-modal-button-${index}`;
    };

    return (
        <BaseModal
            visible={true}
            onClose={onClose}
            accessibilityLabel={config.accessibilityLabel ?? config.title}
            closeOnBackdrop={false}
            showBackdrop={showBackdrop}
            zIndexBase={zIndexBase}
            focusReturnRef={config.focusReturnRef}
        >
            <ModalCardFrame dimensions={{ width: 270, maxHeightRatio: 0.48 }}>
                <View style={styles.content}>
                    <Text style={[styles.title, Typography.default('semiBold')]}>
                        {config.title}
                    </Text>
                    {config.message && (
                        <Text style={[styles.message, Typography.default()]}>
                            {config.message}
                        </Text>
                    )}
                </View>

                <View
                    style={[
                        styles.buttonContainer,
                        buttonLayout === 'row' ? styles.buttonRow : styles.buttonColumn,
                    ]}
                >
                    {buttons.map((button, index) => (
                        <React.Fragment key={index}>
                            {index > 0 && (
                                <View style={buttonLayout === 'row' ? styles.separatorVertical : styles.separatorHorizontal} />
                            )}
                            <Pressable
                                style={({ pressed }) => [
                                    styles.button,
                                    pressed && styles.buttonPressed
                                ]}
                                testID={resolveButtonTestId(index)}
                                accessibilityRole="button"
                                accessibilityLabel={button.text}
                                onPress={() => handleButtonPress(index)}
                            >
                                <Text style={[
                                    styles.buttonText,
                                    buttonLayout === 'column' && (button.style === 'default' || !button.style) && styles.primaryText,
                                    button.style === 'cancel' && styles.cancelText,
                                    button.style === 'destructive' && styles.destructiveText,
                                    Typography.default(button.style === 'cancel' ? undefined : 'semiBold')
                                ]}>
                                    {button.text}
                                </Text>
                            </Pressable>
                        </React.Fragment>
                    ))}
                </View>
            </ModalCardFrame>
        </BaseModal>
    );
}

export { ModalCardFrame } from './card/ModalCardFrame';
