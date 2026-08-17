import React from 'react';
import { View } from 'react-native';
import { Typography } from '@/constants/Typography';
import { Session } from '@/sync/domains/state/storageTypes';
import { useSessionStatus, formatPathRelativeToHome } from '@/utils/sessions/sessionUtils';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { Icon, type IconName } from '@/components/ui/icons/Icon';


const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 48,
    },
    iconContainer: {
        marginBottom: 12,
    },
    hostText: {
        fontSize: 18,
        color: theme.colors.text.primary,
        textAlign: 'center',
        marginBottom: 4,
        ...Typography.default('semiBold'),
    },
    pathText: {
        fontSize: 14,
        color: theme.colors.text.secondary,
        textAlign: 'center',
        marginBottom: 40,
        ...Typography.default('regular'),
    },
    noMessagesText: {
        fontSize: 20,
        color: theme.colors.text.secondary,
        textAlign: 'center',
        marginBottom: 8,
        ...Typography.default('regular'),
    },
    createdText: {
        fontSize: 16,
        color: theme.colors.text.secondary,
        textAlign: 'center',
        lineHeight: 24,
        ...Typography.default(),
    },
}));

interface EmptyMessagesProps {
    session: Session;
}

function getOSIcon(os?: string): IconName {
    if (!os) return 'cpu';
    
    const osLower = os.toLowerCase();
    if (osLower.includes('darwin') || osLower.includes('mac')) {
        return 'laptop';
    } else if (osLower.includes('win')) {
        return 'desktop';
    } else if (osLower.includes('linux')) {
        return 'terminal';
    }
    return 'cpu';
}

function formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffMinutes < 1) {
        return t('time.justNow');
    } else if (diffMinutes < 60) {
        return t('time.minutesAgo', { count: diffMinutes });
    } else if (diffHours < 24) {
        return t('time.hoursAgo', { count: diffHours });
    } else {
        return t('sessionHistory.daysAgo', { count: diffDays });
    }
}

export function EmptyMessages({ session }: EmptyMessagesProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const metadata = readSessionOwnerMetadataView(session);
    const osIcon = getOSIcon(metadata?.os);
    const sessionStatus = useSessionStatus(session);
    const startedTime = formatRelativeTime(session.createdAt);
    
    return (
        <View testID="session-empty-messages" style={styles.container}>
            <Icon
                name={osIcon}
                size={72} 
                color={theme.colors.text.secondary}
                style={styles.iconContainer}
            />
            
            {metadata?.host ? (
                <Text style={styles.hostText}>
                    {metadata.host}
                </Text>
            ) : null}
            
            {metadata?.path ? (
                <Text style={styles.pathText}>
                    {formatPathRelativeToHome(metadata.path, metadata.homeDir)}
                </Text>
            ) : null}
            
            <Text style={styles.noMessagesText}>
                {t('components.emptyMessages.noMessagesYet')}
            </Text>
            
            <Text style={styles.createdText}>
                {t('components.emptyMessages.created', { time: startedTime })}
            </Text>
        </View>
    );
}
