import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';


export type ElevenLabsAgentReuseDecision = 'create_new' | 'update_existing' | 'cancel';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        minHeight: 0,
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    message: {
        fontSize: 13,
        textAlign: 'center',
        color: theme.colors.text,
        lineHeight: 18,
    },
    footer: {
        paddingVertical: 2,
    },
    footerButton: {
        paddingVertical: 12,
        paddingHorizontal: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    footerButtonPressed: {
        backgroundColor: theme.colors.divider,
    },
    footerSeparator: {
        height: 1,
        backgroundColor: theme.colors.divider,
    },
    footerButtonText: {
        fontSize: 15,
        color: theme.colors.textLink,
    },
    footerButtonTextPrimary: {
        color: theme.colors.text,
    },
}));

type DialogProps = CustomModalInjectedProps & Readonly<{
    message: string;
    onResolve: (decision: ElevenLabsAgentReuseDecision) => void;
    onRequestClose?: () => void;
}>;

const ElevenLabsAgentReuseDialog: React.FC<DialogProps> = (props) => {
    useUnistyles();
    const styles = stylesheet;
    const { onClose, onResolve } = props;
    const resolve = React.useCallback((decision: ElevenLabsAgentReuseDecision) => {
        onResolve(decision);
        onClose();
    }, [onClose, onResolve]);

    const footer = React.useMemo(() => {
        const FooterButton = (p: Readonly<{
            label: string;
            primary?: boolean;
            testID: string;
            onPress: () => void;
        }>) => (
            <Pressable
                testID={p.testID}
                accessibilityRole="button"
                accessibilityLabel={p.label}
                onPress={p.onPress}
                style={({ pressed }) => [
                    styles.footerButton,
                    pressed ? styles.footerButtonPressed : null,
                ]}
            >
                <Text
                    style={[
                        styles.footerButtonText,
                        Typography.default('semiBold'),
                        p.primary ? styles.footerButtonTextPrimary : null,
                    ]}
                >
                    {p.label}
                </Text>
            </Pressable>
        );

        return (
            <View style={styles.footer}>
                <FooterButton
                    testID="elevenlabs-agent-reuse-create"
                    label={t('common.create')}
                    onPress={() => resolve('create_new')}
                />
                <View style={styles.footerSeparator} />
                <FooterButton
                    testID="elevenlabs-agent-reuse-update"
                    label={t('common.update')}
                    primary={true}
                    onPress={() => resolve('update_existing')}
                />
                <View style={styles.footerSeparator} />
                <FooterButton
                    testID="elevenlabs-agent-reuse-cancel"
                    label={t('common.cancel')}
                    onPress={() => resolve('cancel')}
                />
            </View>
        );
    }, [resolve, styles.footer, styles.footerButton, styles.footerButtonPressed, styles.footerButtonText, styles.footerButtonTextPrimary, styles.footerSeparator]);

    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        footer,
    }), [footer]);

    useModalCardChrome(props.setChrome, chrome);

    return (
        <View style={styles.container}>
            <Text style={[styles.message, Typography.default()]}>{props.message}</Text>
        </View>
    );
};

export async function showElevenLabsAgentReuseDialog(params: Readonly<{
  existingAgentId: string;
  existingAgentName: string;
}>): Promise<ElevenLabsAgentReuseDecision> {
  const existingAgentId = String(params.existingAgentId ?? '').trim();
  const existingAgentName = String(params.existingAgentName ?? '').trim();

    return await new Promise<ElevenLabsAgentReuseDecision>((resolve) => {
        let resolved = false;
        const resolveOnce = (decision: ElevenLabsAgentReuseDecision) => {
            if (resolved) return;
      resolved = true;
            resolve(decision);
        };

        Modal.show({
            component: ElevenLabsAgentReuseDialog,
            props: {
                message: existingAgentId
                    ? t('settingsVoice.byo.agentReuseDialog.messageWithId', { name: existingAgentName, id: existingAgentId })
                    : t('settingsVoice.byo.agentReuseDialog.messageNoId', { name: existingAgentName }),
                onResolve: resolveOnce,
            },
            onRequestClose: () => resolveOnce('cancel'),
            chrome: {
                kind: 'card',
                title: t('settingsVoice.byo.agentReuseDialog.title'),
                testID: 'elevenlabs-agent-reuse-dialog',
                layout: 'fit',
                dimensions: { width: 320, maxHeightRatio: 0.6, size: 'dialog' },
            },
            closeOnBackdrop: true,
        });
    });
}
