import React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { ContextGauge, InstrumentCard } from '@/components/instrument';
import { t } from '@/text';
import { EntranceView } from './EntranceView';
import { Icon } from '@/components/ui/icons/Icon';

const styles = StyleSheet.create((theme) => ({
    errorCard: {
        marginHorizontal: 16,
        marginBottom: 12,
        padding: 16,
        gap: 12,
    },
    errorRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    errorText: {
        flex: 1,
        fontSize: 14,
        color: theme.colors.text.primary,
    },
    retryButton: {
        alignSelf: 'flex-start',
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 999,
        backgroundColor: theme.colors.status.error,
    },
    retryText: {
        color: theme.colors.surface.base,
        fontSize: 13,
        fontWeight: '700',
    },
    errorCardShell: {
        marginHorizontal: 16,
        marginBottom: 12,
    },
    emptyShell: {
        marginHorizontal: 16,
    },
    emptyBody: {
        paddingHorizontal: 24,
        paddingVertical: 32,
        alignItems: 'center',
        gap: 12,
    },
    emptyGauge: {
        marginBottom: 4,
        opacity: 0.85,
    },
    emptyTitle: {
        ...Typography.default('semiBold'),
        fontSize: 17,
        lineHeight: 22,
        letterSpacing: -0.2,
        color: theme.colors.text.primary,
        textAlign: 'center',
    },
    emptySubtitle: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
        textAlign: 'center',
        maxWidth: 320,
    },
    emptyCta: {
        marginTop: 8,
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderRadius: 999,
        backgroundColor: theme.colors.text.primary,
        minHeight: 40,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyCtaText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.surface.base,
    },
}));

export const UsageErrorCard: React.FC<{ message: string; onRetry?: () => void }> = ({ message, onRetry }) => {
    const { theme } = useUnistyles();
    return (
        <View style={styles.errorCardShell}>
            <InstrumentCard>
                <View style={styles.errorCard}>
                    <View style={styles.errorRow}>
                        <Icon name="warning-circle" size={20} color={theme.colors.status.error} />
                        <Text style={styles.errorText}>{message}</Text>
                    </View>
                    {typeof onRetry === 'function' ? (
                        <Pressable
                            style={styles.retryButton}
                            onPress={onRetry}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.retry')}
                        >
                            <Text style={styles.retryText}>{t('common.retry')}</Text>
                        </Pressable>
                    ) : null}
                </View>
            </InstrumentCard>
        </View>
    );
};

/**
 * Designed empty-state invitation (F-UI-4): a becalmed gauge at rest, the
 * distinct title/subtitle pair, and a "start a session" CTA into `/new`.
 */
export const UsageEmptyState: React.FC = () => {
    const router = useRouter();

    return (
        <EntranceView entranceId="usage-empty" style={styles.emptyShell}>
            <InstrumentCard testID="usage-empty-state">
                <View style={styles.emptyBody}>
                    <View style={styles.emptyGauge} pointerEvents="none">
                        <ContextGauge usedPct={0} size={28} />
                    </View>
                    <Text style={styles.emptyTitle}>{t('usage.noData.title')}</Text>
                    <Text style={styles.emptySubtitle}>
                        {t('usage.noData.subtitle')}
                    </Text>
                    <Pressable
                        testID="usage-empty-start-session"
                        style={styles.emptyCta}
                        onPress={() => router.push('/new')}
                        accessibilityRole="button"
                        accessibilityLabel={t('newSession.title')}
                    >
                        <Text style={styles.emptyCtaText}>{t('newSession.title')}</Text>
                    </Pressable>
                </View>
            </InstrumentCard>
        </EntranceView>
    );
};
