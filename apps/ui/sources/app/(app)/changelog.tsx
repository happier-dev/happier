import React, { useEffect } from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { getChangelogEntries, getLatestReleaseId, setLastViewedReleaseId } from '@/changelog';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/ui/layout/layout';
import { t } from '@/text';
import type { FeatureId } from '@happier-dev/protocol';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { AskHappierMark } from '@/components/sessions/bots/AskHappierOfferCard';
import { useAskHappierOpener } from '@/components/sessions/bots/useAskHappierOffer';


const CHANGELOG_FEATURE_ID = 'app.ui.changelog' as const satisfies FeatureId;

const styles = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
    },
    content: {
        paddingHorizontal: 16,
        paddingTop: 16,
    },
    entryContainer: {
        marginBottom: 32,
    },
    versionHeader: {
        ...Typography.default('semiBold'),
        fontSize: 20,
        lineHeight: 28,
        color: theme.colors.text.primary,
        marginBottom: 8,
    },
    dateText: {
        ...Typography.default('regular'),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
        marginBottom: 12,
    },
    askHappier: {
        alignSelf: 'flex-start',
        marginBottom: 12,
    },
    entryBodyContainer: {
        backgroundColor: theme.colors.surface.inset,
        borderRadius: 12,
        padding: 16,
    },
    markdownText: {
        ...Typography.default('regular'),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text.primary,
    },
    emptyState: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
    },
    emptyText: {
        ...Typography.default('regular'),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text.secondary,
        textAlign: 'center',
    }
}));

function ChangelogScreenEnabled() {
    const insets = useSafeAreaInsets();
    const entries = getChangelogEntries();
    const askHappier = useAskHappierOpener();
    
    useEffect(() => {
        // Mark as viewed when component mounts
        const latestReleaseId = getLatestReleaseId();
        if (latestReleaseId) {
            setLastViewedReleaseId(latestReleaseId);
        }
    }, []);

    if (entries.length === 0) {
        return (
            <View style={styles.container}>
                <View style={styles.emptyState}>
                    <Text style={styles.emptyText}>
                        {t('changelog.noEntriesAvailable')}
                    </Text>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <ScrollView 
                style={styles.container}
                contentContainerStyle={[
                    styles.content, 
                    { 
                        paddingBottom: insets.bottom + 40,
                        maxWidth: layout.maxWidth,
                        alignSelf: 'center',
                        width: '100%'
                    }
                ]}
                showsVerticalScrollIndicator={false}
            >
                {entries.map((entry) => (
                    <View key={entry.id} style={styles.entryContainer}>
                        <Text style={styles.versionHeader}>
                            {t('changelog.version', { version: entry.versionLabel })}
                        </Text>
                        <Text style={styles.dateText}>
                            {entry.date}
                        </Text>
                        {/* Asks about this exact release: its notes travel with the draft, nothing starts until Send. */}
                        <View style={styles.askHappier}>
                            <RoundButton
                                testID={`changelog-ask-happier-${entry.id}`}
                                size="small"
                                display="secondary"
                                leading={<AskHappierMark size={16} />}
                                title={t('bots.guide.aboutUpdate')}
                                onPress={() => askHappier({ kind: 'release', release: {
                                    id: entry.id, versionLabel: entry.versionLabel, date: entry.date, markdown: entry.markdown,
                                } })}
                            />
                        </View>
                        {entry.markdown ? (
                            <View style={styles.entryBodyContainer}>
                                <MarkdownView markdown={entry.markdown} textStyle={styles.markdownText} />
                            </View>
                        ) : null}
                    </View>
                ))}
            </ScrollView>
        </View>
    );
}

export default function ChangelogScreen() {
    if (getFeatureBuildPolicyDecision(CHANGELOG_FEATURE_ID) === 'deny') {
        return null;
    }
    return <ChangelogScreenEnabled />;
}
