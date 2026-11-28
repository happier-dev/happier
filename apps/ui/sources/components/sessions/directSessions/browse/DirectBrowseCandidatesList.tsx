import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text, TextInput } from '@/components/ui/text/Text';
import { useResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import type { Theme } from '@/theme';
import { t } from '@/text';

import {
    buildDirectBrowseCandidateDisplayTitle,
    buildDirectBrowseCandidateRightElement,
    buildDirectBrowseCandidateSubtitle,
} from './buildDirectBrowseCandidatePresentation';
import type { DirectBrowseCandidate } from './useDirectBrowseCandidates';
import { DirectBrowseCandidateActions } from './DirectBrowseCandidateActions';

type AppTheme = Theme;

const stylesheet = StyleSheet.create((theme: AppTheme) => ({
    helperText: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        color: theme.colors.text.secondary,
        fontSize: 13,
    },
    searchContainer: {
        position: 'relative',
        paddingHorizontal: 12,
        paddingTop: 12,
        paddingBottom: 6,
    },
    searchInput: {
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.inset,
        color: theme.colors.text.primary,
        fontSize: 13,
    },
    searchInputWithAugmentingIndicator: {
        paddingRight: 40,
    },
    searchAugmentingIndicator: {
        position: 'absolute',
        right: 22,
        top: 22,
    },
    loadingRow: {
        paddingVertical: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    candidateAccessory: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
}));

export const DirectBrowseCandidatesList = React.memo(function DirectBrowseCandidatesList(props: Readonly<{
    candidates: readonly DirectBrowseCandidate[];
    loading: boolean;
    error: string | null;
    nextCursor: string | null;
    loadingMore: boolean;
    searchAugmenting: boolean;
    linkingSessionId: string | null;
    deletingSessionId: string | null;
    canDeleteCandidates: boolean;
    providerLabel: string;
    searchQuery: string;
    onSearchQueryChange: (value: string) => void;
    onSelectCandidate: (candidate: DirectBrowseCandidate) => void;
    onDeleteCandidate: (candidate: DirectBrowseCandidate) => void;
    onKeepCandidate?: (candidate: DirectBrowseCandidate) => void;
    onLoadMore: () => void;
}>) {
    const { theme } = useUnistyles() as { theme: AppTheme };
    const styles = stylesheet;
    const itemDensity = useResolvedItemDensity(undefined);
    const hasSearchQuery = props.searchQuery.trim().length > 0;

    return (
        <ItemGroup title={t('directSessions.browseCandidates')}>
            <View style={styles.searchContainer}>
                <TextInput
                    testID="direct-session-candidates-search-input"
                    value={props.searchQuery}
                    onChangeText={props.onSearchQueryChange}
                    placeholder={t('directSessions.browseSearchPlaceholder')}
                    placeholderTextColor={theme.colors.input.placeholder}
                    style={[styles.searchInput, props.searchAugmenting ? styles.searchInputWithAugmentingIndicator : null]}
                />
                {props.searchAugmenting ? (
                    <View testID="direct-session-candidates-search-augmenting" style={styles.searchAugmentingIndicator}>
                        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    </View>
                ) : null}
            </View>

            {props.loading ? (
                <View style={styles.loadingRow}>
                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                </View>
            ) : props.error ? (
                <View>
                    <Text style={styles.helperText}>{props.error}</Text>
                </View>
            ) : props.candidates.length === 0 && hasSearchQuery ? (
                <View>
                    <Text style={styles.helperText}>{t('directSessions.browseNoSearchResults')}</Text>
                </View>
            ) : props.candidates.length === 0 ? (
                <View>
                    <Text style={styles.helperText}>{t('directSessions.browseNoCandidates')}</Text>
                </View>
            ) : (
                <>
                    {props.candidates.map((candidate) => (
                        <Item
                            key={candidate.remoteSessionId}
                            testID={`direct-session-candidate:${candidate.remoteSessionId}`}
                            title={buildDirectBrowseCandidateDisplayTitle(candidate)}
                            subtitle={buildDirectBrowseCandidateSubtitle(candidate, theme, itemDensity)}
                            rightElement={props.canDeleteCandidates || props.onKeepCandidate ? (
                                <View style={styles.candidateAccessory}>
                                    {buildDirectBrowseCandidateRightElement(candidate, theme, itemDensity)}
                                    <DirectBrowseCandidateActions
                                        candidateTitle={buildDirectBrowseCandidateDisplayTitle(candidate)}
                                        candidateId={candidate.remoteSessionId}
                                        providerLabel={props.providerLabel}
                                        deleting={props.deletingSessionId !== null}
                                        canDelete={props.canDeleteCandidates}
                                        onDelete={() => props.onDeleteCandidate(candidate)}
                                        onKeep={props.onKeepCandidate ? () => props.onKeepCandidate?.(candidate) : undefined}
                                    />
                                </View>
                            ) : buildDirectBrowseCandidateRightElement(candidate, theme, itemDensity)}
                            rightElementOutsidePressable={props.canDeleteCandidates || Boolean(props.onKeepCandidate)}
                            onPress={() => props.onSelectCandidate(candidate)}
                            loading={props.linkingSessionId === candidate.remoteSessionId || props.deletingSessionId === candidate.remoteSessionId}
                            disabled={props.deletingSessionId === candidate.remoteSessionId}
                        />
                    ))}
                    {props.nextCursor ? (
                        <Item
                            testID="direct-session-candidates-load-more"
                            title={t('directSessions.browseLoadMore')}
                            onPress={props.onLoadMore}
                            loading={props.loadingMore}
                        />
                    ) : null}
                </>
            )}
        </ItemGroup>
    );
});
