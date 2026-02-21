import * as React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { RoundButton } from './RoundButton';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';
import { trackConnectAttempt } from '@/track';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text, TextInput } from '@/components/ui/text/Text';


export const ConnectButton = React.memo(() => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();
    const [manualUrl, setManualUrl] = React.useState('');
    const [showManualEntry, setShowManualEntry] = React.useState(false);

    const handleConnect = async () => {
        trackConnectAttempt();
        connectTerminal();
    };

    const handleManualConnect = async () => {
        if (manualUrl.trim()) {
            trackConnectAttempt();
            connectWithUrl(manualUrl.trim());
            setManualUrl('');
        }
    };

    return (
        <View style={styles.container}>
            <RoundButton
                title={t('connectButton.authenticate')}
                size="large"
                onPress={handleConnect}
                loading={isLoading}
            />
            
            <TouchableOpacity
                onPress={() => setShowManualEntry(!showManualEntry)}
                style={styles.manualToggle}
            >
                <Ionicons 
                    name="link-outline" 
                    size={16} 
                    color={theme.colors.textSecondary}
                    style={styles.manualToggleIcon}
                />
                <Text style={styles.manualToggleText}>
                    {t('connectButton.authenticateWithUrlPaste')}
                </Text>
            </TouchableOpacity>

            {showManualEntry && (
                <View style={styles.manualEntryContainer}>
                    <Text style={styles.manualEntryLabel}>
                        {t('connectButton.pasteAuthUrl')}
                    </Text>
                    <View style={styles.manualEntryRow}>
                        <TextInput
                            style={styles.manualUrlInput}
                            value={manualUrl}
                            onChangeText={setManualUrl}
                            placeholder={t('connect.terminalUrlPlaceholder')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            autoCapitalize="none"
                            autoCorrect={false}
                            onSubmitEditing={handleManualConnect}
                        />
                        <TouchableOpacity
                            onPress={handleManualConnect}
                            disabled={!manualUrl.trim()}
                            style={[
                                styles.manualSubmitButton,
                                manualUrl.trim() ? null : styles.manualSubmitButtonDisabled,
                            ]}
                        >
                            <Ionicons 
                                name="checkmark-circle" 
                                size={24} 
                                color={theme.colors.accent.blue}
                            />
                        </TouchableOpacity>
                    </View>
                </View>
            )}
        </View>
    )
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: 210,
    },
    manualToggle: {
        marginTop: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
    },
    manualToggleIcon: {
        marginRight: 6,
    },
    manualToggleText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textDecorationLine: 'underline',
    },
    manualEntryContainer: {
        marginTop: 12,
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHigh,
        width: 210,
    },
    manualEntryLabel: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginBottom: 8,
    },
    manualEntryRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    manualUrlInput: {
        flex: 1,
        backgroundColor: theme.colors.input.background,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 6,
        padding: 8,
        fontSize: 12,
        color: theme.colors.input.text,
    },
    manualSubmitButton: {
        marginLeft: 8,
        padding: 8,
    },
    manualSubmitButtonDisabled: {
        opacity: 0.5,
    },
}));
