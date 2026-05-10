import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text, TextInput } from '@/components/ui/text/Text';
import { useResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import { lightTheme } from '@/theme';
import { t } from '@/text';

import {
    buildExternalSessionBrowseCandidateDisplayTitle,
    buildExternalSessionBrowseCandidateRightElement,
    buildExternalSessionBrowseCandidateSearchValue,
    buildExternalSessionBrowseCandidateSubtitle,
} from './buildExternalSessionBrowseCandidatePresentation';
import type { ExternalSessionBrowseCandidate } from './useExternalSessionBrowseCandidates';

type AppTheme = typeof lightTheme;

const stylesheet = StyleSheet.create((theme: AppTheme) => ({
    helperText: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        color: theme.colors.textSecondary,
        fontSize: 13,
    },
    searchContainer: {
        paddingHorizontal: 12,
        paddingTop: 12,
        paddingBottom: 6,
    },
    searchInput: {
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHigh,
        color: theme.colors.text,
        fontSize: 13,
    },
    loadingRow: {
        paddingVertical: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

export const ExternalSessionBrowseCandidatesList = React.memo(function ExternalSessionBrowseCandidatesList(props: Readonly<{
    candidates: readonly ExternalSessionBrowseCandidate[];
    loading: boolean;
    error: string | null;
    nextCursor: string | null;
    loadingMore: boolean;
    linkingSessionId: string | null;
    onSelectCandidate: (candidate: ExternalSessionBrowseCandidate) => void;
    onLoadMore: () => void;
}>) {
    const { theme } = useUnistyles() as { theme: AppTheme };
    const styles = stylesheet;
    const itemDensity = useResolvedItemDensity(undefined);

    const [searchQuery, setSearchQuery] = React.useState('');

    const filteredCandidates = React.useMemo(() => {
        const normalizedSearchQuery = searchQuery.trim().toLowerCase();
        if (!normalizedSearchQuery) return props.candidates;
        return props.candidates.filter((candidate) => buildExternalSessionBrowseCandidateSearchValue(candidate).includes(normalizedSearchQuery));
    }, [props.candidates, searchQuery]);

    return (
        <ItemGroup title={t('externalSessions.browseCandidates')}>
            <View style={styles.searchContainer}>
                <TextInput
                    testID="direct-session-candidates-search-input"
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    placeholder={t('externalSessions.browseSearchPlaceholder')}
                    placeholderTextColor={theme.colors.textSecondary}
                    style={styles.searchInput}
                />
            </View>

            {props.loading ? (
                <View style={styles.loadingRow}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            ) : props.error ? (
                <View>
                    <Text style={styles.helperText}>{props.error}</Text>
                </View>
            ) : props.candidates.length === 0 ? (
                <View>
                    <Text style={styles.helperText}>{t('externalSessions.browseNoCandidates')}</Text>
                </View>
            ) : filteredCandidates.length === 0 ? (
                <View>
                    <Text style={styles.helperText}>{t('externalSessions.browseNoSearchResults')}</Text>
                </View>
            ) : (
                <>
                    {filteredCandidates.map((candidate) => (
                        <Item
                            key={candidate.remoteSessionId}
                            testID={`direct-session-candidate:${candidate.remoteSessionId}`}
                            title={buildExternalSessionBrowseCandidateDisplayTitle(candidate)}
                            subtitle={buildExternalSessionBrowseCandidateSubtitle(candidate, theme, itemDensity)}
                            rightElement={buildExternalSessionBrowseCandidateRightElement(candidate, theme, itemDensity)}
                            onPress={() => props.onSelectCandidate(candidate)}
                            loading={props.linkingSessionId === candidate.remoteSessionId}
                        />
                    ))}
                    {props.nextCursor ? (
                        <Item
                            testID="direct-session-candidates-load-more"
                            title={t('externalSessions.browseLoadMore')}
                            onPress={props.onLoadMore}
                            loading={props.loadingMore}
                        />
                    ) : null}
                </>
            )}
        </ItemGroup>
    );
});

