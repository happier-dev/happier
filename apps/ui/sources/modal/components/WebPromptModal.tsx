import React, { useState, useRef, useEffect } from 'react';
import { View, Pressable, KeyboardTypeOptions, Platform } from 'react-native';
import { BaseModal } from './BaseModal';
import { PromptModalConfig } from '../types';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';
import { ModalCardFrame } from './card/ModalCardFrame';


interface WebPromptModalProps {
    config: PromptModalConfig;
    onClose: () => void;
    onConfirm: (value: string | null) => void;
    showBackdrop?: boolean;
    zIndexBase?: number;
}

const stylesheet = StyleSheet.create((theme) => ({
    content: {
        paddingHorizontal: 16,
        paddingTop: 20,
        paddingBottom: 16,
        alignItems: 'center'
    },
    title: {
        fontSize: 17,
        textAlign: 'center',
        color: theme.colors.text.primary,
        marginBottom: 4
    },
    message: {
        fontSize: 13,
        textAlign: 'center',
        color: theme.colors.text.primary,
        marginTop: 4,
        lineHeight: 18
    },
    input: {
        width: '100%',
        height: 36,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 8,
        paddingHorizontal: 10,
        marginTop: 16,
        fontSize: 14,
        color: theme.colors.text.primary,
        backgroundColor: theme.colors.input.background
    },
    buttonContainer: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        flexDirection: 'row'
    },
    button: {
        flex: 1,
        paddingVertical: 11,
        alignItems: 'center',
        justifyContent: 'center'
    },
    buttonPressed: {
        backgroundColor: theme.colors.border.default
    },
    buttonSeparator: {
        width: 1,
        backgroundColor: theme.colors.border.default
    },
    buttonText: {
        fontSize: 17,
        color: theme.colors.text.link
    },
    cancelText: {
        fontWeight: '400'
    }
}));

export function WebPromptModal({ config, onClose, onConfirm, showBackdrop = true, zIndexBase }: WebPromptModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [inputValue, setInputValue] = useState(config.defaultValue || '');
    const inputRef = useRef<React.ElementRef<typeof TextInput> | null>(null);
    const didResolveRef = useRef(false);

    const resolveAndClose = React.useCallback((value: string | null) => {
        if (didResolveRef.current) {
            return;
        }

        didResolveRef.current = true;
        onConfirm(value);
        onClose();
    }, [onClose, onConfirm]);

    useEffect(() => {
        // Auto-focus the input when modal opens
        const timer = setTimeout(() => {
            inputRef.current?.focus();
        }, 100);
        return () => clearTimeout(timer);
    }, []);

    const handleCancel = () => {
        resolveAndClose(null);
    };

    const handleConfirm = () => {
        resolveAndClose(inputValue);
    };

    const getKeyboardType = (): KeyboardTypeOptions => {
        switch (config.inputType) {
            case 'email-address':
                return 'email-address';
            case 'numeric':
                return 'numeric';
            default:
                return 'default';
        }
    };

    return (
        <BaseModal
            visible={true}
            onClose={handleCancel}
            closeOnBackdrop={false}
            showBackdrop={showBackdrop}
            zIndexBase={zIndexBase}
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
                    <TextInput
                        ref={inputRef}
                        testID="web-prompt-input"
                        style={[styles.input, Typography.default()]}
                        value={inputValue}
                        onChangeText={setInputValue}
                        placeholder={config.placeholder}
                        placeholderTextColor={theme.colors.input.placeholder}
                        keyboardType={getKeyboardType()}
                        secureTextEntry={config.inputType === 'secure-text'}
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoFocus={Platform.OS === 'web'}
                        onSubmitEditing={handleConfirm}
                        returnKeyType="done"
                    />
                </View>
                
                <View style={styles.buttonContainer}>
                    <Pressable
                        style={({ pressed }) => [
                            styles.button,
                            pressed && styles.buttonPressed
                        ]}
                        testID="web-prompt-cancel"
                        accessibilityRole="button"
                        accessibilityLabel={config.cancelText || t('common.cancel')}
                        onPress={handleCancel}
                    >
                        <Text style={[
                            styles.buttonText,
                            styles.cancelText,
                            Typography.default()
                        ]}>
                            {config.cancelText || t('common.cancel')}
                        </Text>
                    </Pressable>
                    <View style={styles.buttonSeparator} />
                    <Pressable
                        style={({ pressed }) => [
                            styles.button,
                            pressed && styles.buttonPressed
                        ]}
                        testID="web-prompt-confirm"
                        accessibilityRole="button"
                        accessibilityLabel={config.confirmText || t('common.ok')}
                        onPressIn={handleConfirm}
                        onPress={handleConfirm}
                    >
                        <Text style={[
                            styles.buttonText,
                            Typography.default('semiBold')
                        ]}>
                            {config.confirmText || t('common.ok')}
                        </Text>
                    </Pressable>
                </View>
            </ModalCardFrame>
        </BaseModal>
    );
}
