import React, { memo, useMemo, useState } from 'react';
import { View, Text, TextInput, FlatList, ScrollView, Pressable, useWindowDimensions, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { UserProfile, getDisplayName } from '@/sync/friendTypes';
import { ShareAccessLevel } from '@/sync/sharingTypes';
import { UserCard } from '@/components/UserCard';
import { Item } from '@/components/Item';
import { t } from '@/text';
import { BaseModal } from '@/modal/components/BaseModal';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/RoundButton';
import { Modal } from '@/modal';
import { HappyError } from '@/utils/errors';

/**
 * Props for FriendSelector component
 */
export interface FriendSelectorProps {
    /** List of friends to choose from */
    friends: UserProfile[];
    /** IDs of users already having access */
    excludedUserIds: string[];
    /** Callback when a friend is selected */
    onSelect: (userId: string, accessLevel: ShareAccessLevel) => Promise<void> | void;
    /** Close without selecting */
    onCancel: () => void;
    /** Currently selected user ID (optional) */
    selectedUserId?: string | null;
    /** Currently selected access level (optional) */
    selectedAccessLevel?: ShareAccessLevel;
}

/**
 * Friend selector component for sharing
 *
 * @remarks
 * Displays a searchable list of friends and allows selecting
 * an access level. This is a controlled component - parent
 * manages the modal and button states.
 */
export const FriendSelector = memo(function FriendSelector({
    friends,
    excludedUserIds,
    onSelect,
    onCancel,
    selectedUserId: initialSelectedUserId = null,
    selectedAccessLevel: initialSelectedAccessLevel = 'view',
}: FriendSelectorProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { height: windowHeight } = useWindowDimensions();

    const [searchQuery, setSearchQuery] = useState('');
    const [selectedUserId, setSelectedUserId] = useState<string | null>(initialSelectedUserId);
    const [selectedAccessLevel, setSelectedAccessLevel] = useState<ShareAccessLevel>(initialSelectedAccessLevel);
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Filter friends based on search and exclusions
    const filteredFriends = useMemo(() => {
        const excluded = new Set(excludedUserIds);
        return friends.filter(friend => {
            if (excluded.has(friend.id)) return false;
            if (!searchQuery) return true;

            const displayName = getDisplayName(friend).toLowerCase();
            const username = friend.username.toLowerCase();
            const query = searchQuery.toLowerCase();

            return displayName.includes(query) || username.includes(query);
        });
    }, [friends, excludedUserIds, searchQuery]);

    const selectedFriend = useMemo(() => {
        return friends.find(f => f.id === selectedUserId);
    }, [friends, selectedUserId]);

    const maxHeight = React.useMemo(() => {
        return Math.min(760, Math.max(420, Math.floor(windowHeight * 0.85)));
    }, [windowHeight]);

    const handleConfirm = async () => {
        if (!selectedUserId) return;
        if (isSubmitting) return;
        setIsSubmitting(true);
        try {
            await Promise.resolve(onSelect(selectedUserId, selectedAccessLevel));
        } catch (e) {
            const message =
                e instanceof HappyError ? e.message :
                e instanceof Error ? e.message :
                t('errors.operationFailed');
            Modal.alert(t('common.error'), message);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <BaseModal visible={true} onClose={onCancel}>
            <View style={[styles.modal, { height: maxHeight, maxHeight }]}>
                <View style={styles.header}>
                    <Text style={styles.headerTitle}>{t('session.sharing.addShare')}</Text>
                    <Pressable
                        onPress={onCancel}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                    >
                        <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>

                <ScrollView
                    style={styles.scroll}
                    contentContainerStyle={styles.scrollContent}
                    keyboardShouldPersistTaps="handled"
                >
                    <TextInput
                        style={styles.searchInput}
                        placeholder={t('friends.searchPlaceholder')}
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        autoFocus
                    />

                    <View style={styles.friendList}>
                        <FlatList
                            data={filteredFriends}
                            keyExtractor={(item) => item.id}
                            renderItem={({ item }) => {
                                const canShare = Boolean(item.contentPublicKey && item.contentPublicKeySig);
                                const isSelected = selectedUserId === item.id;
                                return (
                                    <View style={styles.friendItem}>
                                        <UserCard
                                            user={item}
                                            onPress={canShare ? () => setSelectedUserId(item.id) : undefined}
                                            disabled={!canShare}
                                            subtitle={!canShare ? t('session.sharing.recipientMissingKeys') : undefined}
                                        />
                                        {isSelected ? <View style={styles.selectedIndicator} /> : null}
                                    </View>
                                );
                            }}
                            ListEmptyComponent={
                                <View style={styles.emptyState}>
                                    <Text style={styles.emptyText}>
                                        {searchQuery ? t('common.noMatches') : t('friends.noFriendsYet')}
                                    </Text>
                                </View>
                            }
                            scrollEnabled={false}
                        />
                    </View>

                    {selectedFriend ? (
                        <View style={styles.accessLevelSection}>
                            <Text style={styles.sectionTitle}>{t('session.sharing.accessLevel')}</Text>
                            <Item
                                title={t('session.sharing.viewOnly')}
                                subtitle={t('session.sharing.viewOnlyDescription')}
                                onPress={() => setSelectedAccessLevel('view')}
                                rightElement={
                                    selectedAccessLevel === 'view' ? (
                                        <View style={styles.radioSelected}>
                                            <View style={styles.radioDot} />
                                        </View>
                                    ) : (
                                        <View style={styles.radioUnselected} />
                                    )
                                }
                            />
                            <Item
                                title={t('session.sharing.canEdit')}
                                subtitle={t('session.sharing.canEditDescription')}
                                onPress={() => setSelectedAccessLevel('edit')}
                                rightElement={
                                    selectedAccessLevel === 'edit' ? (
                                        <View style={styles.radioSelected}>
                                            <View style={styles.radioDot} />
                                        </View>
                                    ) : (
                                        <View style={styles.radioUnselected} />
                                    )
                                }
                            />
                            <Item
                                title={t('session.sharing.canManage')}
                                subtitle={t('session.sharing.canManageDescription')}
                                onPress={() => setSelectedAccessLevel('admin')}
                                rightElement={
                                    selectedAccessLevel === 'admin' ? (
                                        <View style={styles.radioSelected}>
                                            <View style={styles.radioDot} />
                                        </View>
                                    ) : (
                                        <View style={styles.radioUnselected} />
                                    )
                                }
                            />
                        </View>
                    ) : null}

                    <View style={styles.footer}>
                        <RoundButton
                            title={t('session.sharing.addShare')}
                            onPress={handleConfirm}
                            disabled={!selectedUserId || isSubmitting}
                            size="large"
                            style={{ width: '100%', maxWidth: 420, alignSelf: 'center' }}
                        />
                    </View>
                </ScrollView>
            </View>
        </BaseModal>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    modal: {
        width: '92%',
        maxWidth: 560,
        backgroundColor: theme.colors.groupped.background,
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        flexShrink: 1,
    },
    header: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    headerTitle: {
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    scroll: {
        flex: 1,
    },
    scrollContent: {
        padding: 16,
        paddingBottom: 18,
        flexGrow: 1,
    },
    searchInput: {
        height: 40,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHigh,
        paddingHorizontal: 12,
        marginBottom: 16,
        fontSize: 16,
        color: theme.colors.text,
    },
    friendList: {
        marginBottom: 16,
    },
    friendItem: {
        position: 'relative',
    },
    selectedIndicator: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: 4,
        backgroundColor: theme.colors.textLink,
    },
    emptyState: {
        padding: 32,
        alignItems: 'center',
    },
    emptyText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    accessLevelSection: {
        marginTop: 4,
    },
    sectionTitle: {
        fontSize: 17,
        color: theme.colors.text,
        marginBottom: 12,
        paddingHorizontal: 4,
        ...Typography.default('semiBold'),
    },
    radioSelected: {
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: 'transparent',
        borderWidth: 2,
        borderColor: theme.colors.radio.active,
        alignItems: 'center',
        justifyContent: 'center',
    },
    radioDot: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: theme.colors.radio.dot,
    },
    radioUnselected: {
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: theme.colors.radio.inactive,
    },
    footer: {
        marginTop: 16,
    },
}));
