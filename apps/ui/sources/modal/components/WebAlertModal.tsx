import React from 'react';
import { View } from 'react-native';
import { HappierPressable, happierFocusRingStyle } from '@happier-dev/plugin-ui/presentation';
import { BaseModal } from './BaseModal';
import { AlertModalConfig, ConfirmModalConfig } from '../types';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { ModalCardFrame } from './card/ModalCardFrame';
import { ModalChoiceRow } from './card/ModalChoiceRow';
import { ModalCommands } from './ModalCommands';


interface WebAlertModalProps {
    config: AlertModalConfig | ConfirmModalConfig;
    onClose: () => void;
    onConfirm?: (confirmed: boolean, checked?: boolean) => void;
    showBackdrop?: boolean;
    /** False while the dialog leaves; the host unmounts it once the exit has played. */
    visible?: boolean;
    zIndexBase?: number;
    /** Hears the dialog leave the screen, so its host drops it then. */
    onExited?: () => void;
}

const stylesheet = StyleSheet.create((theme) => ({
    content: {
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s20,
        paddingBottom: theme.space.s16,
        // Stretch, not centre: a centred text item sizes to its longest word, so an unbroken token
        // (a path, an id) would overflow the card. The text itself stays centred.
        alignItems: 'stretch',
    },
    title: {
        textAlign: 'center',
        color: theme.colors.text.primary,
        marginBottom: theme.space.s4,
    },
    message: {
        textAlign: 'center',
        color: theme.colors.text.primary,
        marginTop: theme.space.s4,
    },
    link: {
        alignSelf: 'center',
        marginTop: theme.space.s4,
    },
    irreversibleText: {
        color: theme.colors.state.warning.textForeground,
    },
    toggle: {
        marginTop: theme.space.s12,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s8,
        borderRadius: theme.borderRadius.sm,
    },
    toggleCopy: {
        flex: 1,
        gap: theme.space.s4,
    },
    toggleDescription: {
        color: theme.colors.text.secondary,
    },
    facts: {
        marginTop: theme.space.s12,
        gap: theme.space.s4,
    },
    fact: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: theme.space.s12,
    },
    factLabel: {
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    factValue: {
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
        textAlign: 'right',
    },
}));

export function WebAlertModal({ config, onClose, onConfirm, showBackdrop = true, visible = true, zIndexBase, onExited }: WebAlertModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const isConfirm = config.type === 'confirm';
    const [checked, setChecked] = React.useState(false);
    
    const handleButtonPress = (buttonIndex: number) => {
        if (isConfirm && onConfirm) {
            if (config.toggle) onConfirm(buttonIndex === 1, checked);
            else onConfirm(buttonIndex === 1);
            return;
        }
        if (!isConfirm && config.buttons?.[buttonIndex]?.onPress) {
            config.buttons[buttonIndex].onPress!();
        }
        onClose();
    };

    // Escape and the hardware Back dismiss the card without a button press. An alert settles that through
    // its cancel choice, as the native alert does, so whoever awaits the decision (an unsaved-changes guard)
    // is released instead of waiting on a card that is gone. A confirm settles its dismissal in the provider.
    const handleDismiss = () => {
        if (!isConfirm) {
            config.buttons?.find((button) => button.style === 'cancel')?.onPress?.();
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

    const resolveButtonTestId = (index: number): string => {
        if (isConfirm) {
            if (index === 0) return 'web-modal-cancel';
            if (index === 1) return 'web-modal-confirm';
        }
        return `web-modal-button-${index}`;
    };

    return <ModalCommands bridge={config.commandBridge} commands={[
        ...buttons.map((button, index) => ({ key: `button:${index}`, title: button.text,
            invoke: () => handleButtonPress(index) })),
        { key: 'dismiss', title: t('common.close'), invoke: handleDismiss },
    ]}>{invoke => (
        <BaseModal
            visible={visible}
            onExited={onExited}
            onClose={() => { void invoke('dismiss'); }}
            accessibilityLabel={config.accessibilityLabel ?? config.title}
            closeOnBackdrop={false}
            showBackdrop={showBackdrop}
            zIndexBase={zIndexBase}
            focusReturnRef={config.focusReturnRef}
        >
            <ModalCardFrame dimensions={{ width: HAPPIER_PAGE_METRICS.dialogWidthPx.narrow, maxHeightRatio: 0.48 }}>
                <View style={styles.content}>
                    <Text variant="heading" style={styles.title}>
                        {config.title}
                    </Text>
                    {isConfirm && config.messageParagraphs ? config.messageParagraphs.map((paragraph, index) => (
                        <React.Fragment key={index}>
                            <Text variant="body" emphasis={paragraph.irreversible ? 'semiBold' : undefined} style={[
                                styles.message,
                                paragraph.irreversible ? styles.irreversibleText : null,
                            ]}>
                                {paragraph.text}
                            </Text>
                            {paragraph.link ? <View style={styles.link}>
                                <TextLinkButton label={paragraph.link.label} onPress={paragraph.link.onPress} />
                            </View> : null}
                        </React.Fragment>
                    )) : config.message ? (
                        <Text variant="body" style={styles.message}>
                            {config.message}
                        </Text>
                    ) : null}
                    {isConfirm && config.toggle ? (
                        <HappierPressable
                            testID="web-modal-confirm-toggle"
                            accessibilityRole="checkbox"
                            accessibilityLabel={config.toggle.label}
                            accessibilityHint={config.toggle.description}
                            checked={checked}
                            onPress={() => setChecked(value => !value)}
                            style={({ focused }) => [styles.toggle, happierFocusRingStyle({ visible: focused, color: theme.colors.border.focus })]}
                        >
                            <SelectionCheckGlyph state={checked ? 'checked' : 'unchecked'} />
                            <View style={styles.toggleCopy}>
                                <Text variant="label">{config.toggle.label}</Text>
                                {config.toggle.description ? (
                                    <Text variant="body" style={styles.toggleDescription}>{config.toggle.description}</Text>
                                ) : null}
                            </View>
                        </HappierPressable>
                    ) : null}
                    {/* What the choice changes, one fact per line: the label at the start, the value at the end in figures. */}
                    {isConfirm && config.facts && config.facts.length > 0 ? (
                        <View style={styles.facts}>
                            {config.facts.map((fact) => (
                                <View key={fact.label} style={styles.fact}>
                                    <Text variant="body" style={styles.factLabel}>{fact.label}</Text>
                                    <Text variant="body" emphasis="semiBold" style={styles.factValue}>{fact.value}</Text>
                                </View>
                            ))}
                        </View>
                    ) : null}
                </View>

                <ModalChoiceRow choices={buttons.map((button, index) => ({
                    text: button.text,
                    testID: resolveButtonTestId(index),
                    role: button.style === 'cancel' || button.style === 'destructive' ? button.style
                        : 'quiet' in button && button.quiet ? 'quiet' : 'default',
                    onPress: () => { void invoke(`button:${index}`); },
                }))} />
            </ModalCardFrame>
        </BaseModal>
    )}</ModalCommands>;
}

export { ModalCardFrame } from './card/ModalCardFrame';
