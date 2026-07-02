import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { Typography } from '@/constants/Typography';
import { addTodo } from '@/sync/domains/todos/todoOps';
import { useAuth } from '@/auth/context/AuthContext';
import { t } from '@/text';
import { TextInput } from '@/components/ui/text/Text';
import { KeyboardAwareScreen } from '@/components/ui/keyboardAvoidance';


export const ZenAdd = React.memo(() => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const insets = useChromeSafeAreaInsets();
    const [text, setText] = React.useState('');
    const auth = useAuth();

    const handleSubmit = async () => {
        if (text.trim() && auth?.credentials) {
            await addTodo(auth.credentials, text.trim());
            router.back();
        }
    };

    return (
        <KeyboardAwareScreen
            style={styles.container}
        >
            <View style={[
                styles.content,
                { paddingBottom: insets.bottom + 20 }
            ]}>
                <TextInput
                    style={[
                        styles.input,
                        {
                            color: theme.colors.text.primary,
                            borderBottomColor: theme.colors.border.default,
                        }
                    ]}
                    placeholder={t('zen.add.placeholder')}
                    placeholderTextColor={theme.colors.text.secondary}
                    value={text}
                    onChangeText={setText}
                    onSubmitEditing={handleSubmit}
                    autoFocus
                    returnKeyType="done"
                    multiline
                    blurOnSubmit={true}
                />
            </View>
        </KeyboardAwareScreen>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
    },
    content: {
        flex: 1,
        paddingHorizontal: 20,
        paddingTop: 20,
    },
    input: {
        fontSize: 18,
        lineHeight: 24,
        borderBottomWidth: 1,
        paddingVertical: 12,
        paddingHorizontal: 4,
        ...Typography.default(),
    },
}));
