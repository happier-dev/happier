import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';

export function StandaloneSessionPromptEditorModal(props: Readonly<{
    initialText: string;
    onResolve: (value: string | null) => void;
}> & CustomModalInjectedProps) {
    const { theme } = useUnistyles();
    const [text, setText] = React.useState(props.initialText);
    const resolveAndClose = React.useCallback((value: string | null) => {
        props.onResolve(value);
        props.onClose();
    }, [props]);
    const footer = React.useMemo(() => (
        <View style={{ paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', justifyContent: 'flex-end', gap: 10 }}>
            <RoundButton
                size="normal"
                display="inverted"
                title={t('common.cancel')}
                onPress={() => resolveAndClose(null)}
            />
            <RoundButton
                size="normal"
                title={t('common.save')}
                onPress={() => resolveAndClose(text)}
            />
        </View>
    ), [resolveAndClose, text]);
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: t('settingsSession.promptPersonalization.standalonePromptTitle'),
        testID: 'standalone-session-prompt-editor-modal',
        layout: 'fill' as const,
        dimensions: { width: 640, maxHeightRatio: 0.92, size: 'lg' as const },
        footer,
    }), [footer]);
    useModalCardChrome(props.setChrome, chrome);

    return (
        <ScrollView
            style={{ flex: 1 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            {...(Platform.OS === 'ios' ? { automaticallyAdjustKeyboardInsets: true } : {})}
            contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 14, paddingBottom: 18, gap: 8 }}
        >
            <Text style={{ fontSize: 13, color: theme.colors.text.secondary }}>
                {t('settingsSession.promptPersonalization.standalonePromptEditorHint')}
            </Text>
            <TextInput
                testID="standalone-session-prompt-input"
                accessibilityLabel={t('settingsSession.promptPersonalization.standalonePromptTitle')}
                style={[{
                    borderWidth: 1,
                    borderColor: theme.colors.border.default,
                    borderRadius: 10,
                    paddingHorizontal: 12,
                    paddingVertical: Platform.select({ web: 10, ios: 8, default: 10 }),
                    color: theme.colors.text.primary,
                    backgroundColor: theme.colors.input.background,
                    minHeight: 220,
                    textAlignVertical: 'top',
                }, Typography.default()]}
                placeholder={t('settingsSession.promptPersonalization.standalonePromptPlaceholder')}
                placeholderTextColor={theme.colors.input.placeholder}
                value={text}
                onChangeText={setText}
                multiline
                autoFocus
            />
        </ScrollView>
    );
}
