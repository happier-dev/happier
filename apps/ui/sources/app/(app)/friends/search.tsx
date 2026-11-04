import React, { useState, useCallback } from 'react';
import type { ScrollView, ScrollViewProps } from 'react-native';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { UserSearchResult } from '@/components/friends/UserSearchResult';
import { searchUsersByUsername } from '@/sync/api/social/apiFriends';
import { readFriendMutationProfile } from '@/sync/ops/friends';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useAuth } from '@/auth/context/AuthContext';
import { UserProfile } from '@/sync/domains/social/friendTypes';
import { Modal } from '@/modal';
import { t } from '@/text';
import { trackFriendsConnect } from '@/track';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { KeyboardAwareScrollView } from '@/components/ui/keyboardAvoidance';
import { useSearch } from '@/hooks/search/useSearch';
import { useRequireFriendsEnabled } from '@/hooks/friends/useRequireFriendsEnabled';
import { HappyError } from '@/utils/errors/errors';
import { RequireFriendsIdentityForFriends } from '@/components/friends/RequireFriendsIdentityForFriends';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useDestinationPageTitle } from '@/components/appShell/workspace/DestinationInstanceHost';

type KeyboardAwareItemListProps = ScrollViewProps & Readonly<{
    children?: React.ReactNode;
}>;

const FriendsSearchKeyboardAwareItemList = React.forwardRef<ScrollView, KeyboardAwareItemListProps>(
    function FriendsSearchKeyboardAwareItemList({ children, ...props }, ref) {
        return (
            <ItemList ref={ref} {...props}>
                {children}
            </ItemList>
        );
    },
);

export function SearchFriendsScreen() {
    useDestinationPageTitle(t('friends.addFriend'));
    const enabled = useRequireFriendsEnabled();
    const { credentials } = useAuth();
    const { serverId } = useActiveServerSnapshot();
    const { execute } = useMountedActionExecution(serverId);
    const [searchQuery, setSearchQuery] = useState('');
    const [processingUserId, setProcessingUserId] = useState<string | null>(null);
    const [profileOverrides, setProfileOverrides] = useState<Record<string, UserProfile>>({});
    
    if (!enabled) return null;

    // Use the new search hook
    const { results: searchResults, isSearching, error: searchError } = useSearch(
        searchQuery,
        useCallback((query: string) => {
            if (!credentials) {
                return Promise.resolve([]);
            }
            return searchUsersByUsername(credentials, query.trim());
        }, [credentials])
    );
    
    const handleAddFriend = useCallback(async (user: UserProfile) => {
        if (!credentials) return;

        setProcessingUserId(user.id);
        try {
            const updatedProfile = readFriendMutationProfile(
                await execute('friends.add', { uid: user.id }),
            );

            if (updatedProfile) {
                setProfileOverrides((prev) => ({ ...prev, [updatedProfile.id]: updatedProfile }));
                trackFriendsConnect();
                await Modal.alert(t('common.success'), t('friends.requestSent'));
            } else {
                await Modal.alert(t('friends.userNotFound'));
            }
        } catch (error: unknown) {
            if (error instanceof HappyError && error.message === 'provider-required') {
                await Modal.alert(t('friends.bothMustHaveGithub'));
                return;
            }
            if (error instanceof HappyError && error.message === 'username-required') {
                await Modal.alert(t('friends.username.required'));
                return;
            }
            if (error instanceof HappyError && error.message === 'friends-disabled') {
                await Modal.alert(t('friends.disabled'));
                return;
            }
            if (error instanceof Error && error.message.includes('yourself')) {
                await Modal.alert(t('friends.cannotAddYourself'));
            } else {
                await Modal.alert(t('errors.failedToSendRequest'));
            }
        } finally {
            setProcessingUserId(null);
        }
    }, [credentials, execute]);

    const renderUserItem = ({ item }: { item: UserProfile }) => (
        <UserSearchResult
            user={profileOverrides[item.id] ?? item}
            onAddFriend={() => handleAddFriend(item)}
            isProcessing={processingUserId === item.id}
        />
    );

    const renderSeparator = () => (
        <View style={styles.separator} />
    );
    
    const hasSearched = searchQuery.trim().length > 0;
    const searchErrorText =
        searchError === 'searchFailed' ? t('errors.searchFailed') : null;

    return (
        <RequireFriendsIdentityForFriends>
            <KeyboardAwareScrollView
                style={styles.container}
                ScrollViewComponent={FriendsSearchKeyboardAwareItemList}
                keyboardShouldPersistTaps="handled"
            >
                <PageHeader title={t('friends.addFriend')} alwaysShowTitle description={t('friends.findInstructions')} />
                <CompactSearchField
                    placement="page"
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    placeholder={t('friends.searchPlaceholder')}
                    editable={!processingUserId}
                />
                {searchErrorText ? (
                    <SurfaceStateCard size="line" kind="error" title={searchErrorText} />
                ) : searchResults.length > 0 ? (
                    <ItemGroup>
                        {searchResults.map((item, index) => (
                            <React.Fragment key={item.id}>
                                {index > 0 ? renderSeparator() : null}
                                {renderUserItem({ item })}
                            </React.Fragment>
                        ))}
                    </ItemGroup>
                ) : isSearching ? (
                    <ItemGroup>
                        <ItemLoadStateRows state={{ kind: 'loading' }} rows={2} lines={2} accessibilityLabel={t('friends.searching')} />
                    </ItemGroup>
                ) : hasSearched ? (
                    <ItemGroup surface="none">
                        <EmptyState layout="line" title={t('friends.noUserFound')} subtitle={t('friends.checkUsername')} />
                    </ItemGroup>
                ) : null}
            </KeyboardAwareScrollView>
        </RequireFriendsIdentityForFriends>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    separator: {
        height: 1,
        backgroundColor: theme.colors.border.default,
        marginHorizontal: theme.space.s16,
    },
}));
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { SearchFriendsScreen as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={SearchFriendsScreen} />; }
