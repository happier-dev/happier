import React, { memo, useCallback, useState } from 'react';
import { View, Text, ScrollView, Pressable, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import { t } from '@/text';
import { SessionShare, ShareAccessLevel } from '@/sync/sharingTypes';
import { Avatar } from '@/components/Avatar';
import { BaseModal } from '@/modal/components/BaseModal';
import { Typography } from '@/constants/Typography';

/**
 * Props for the SessionShareDialog component
 */
interface SessionShareDialogProps {
    /** ID of the session being shared */
    sessionId: string;
    /** Current shares for this session */
    shares: SessionShare[];
    /** Whether the current user can manage shares (owner/admin) */
    canManage: boolean;
    /** Callback when user wants to add a new share */
    onAddShare: () => void;
    /** Callback when user updates share access level */
    onUpdateShare: (shareId: string, accessLevel: ShareAccessLevel) => void;
    /** Callback when user removes a share */
    onRemoveShare: (shareId: string) => void;
    /** Callback when user wants to create/manage public link */
    onManagePublicLink: () => void;
    /** Callback to close the dialog */
    onClose: () => void;
}

/**
 * Dialog for managing session sharing
 *
 * @remarks
 * Displays current shares and allows managing them. Shows:
 * - List of users the session is shared with
 * - Their access levels (view/edit/admin)
 * - Options to add/remove shares (if canManage)
 * - Link to public share management
 */
export const SessionShareDialog = memo(function SessionShareDialog({
    sessionId,
    shares,
    canManage,
    onAddShare,
    onUpdateShare,
    onRemoveShare,
    onManagePublicLink,
    onClose
}: SessionShareDialogProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { height: windowHeight } = useWindowDimensions();
    const [selectedShareId, setSelectedShareId] = useState<string | null>(null);

    const maxHeight = React.useMemo(() => {
        return Math.min(760, Math.max(420, Math.floor(windowHeight * 0.85)));
    }, [windowHeight]);

    const handleSharePress = useCallback((shareId: string) => {
        if (canManage) {
            setSelectedShareId(selectedShareId === shareId ? null : shareId);
        }
    }, [canManage, selectedShareId]);

    const handleAccessLevelChange = useCallback((shareId: string, accessLevel: ShareAccessLevel) => {
        onUpdateShare(shareId, accessLevel);
        setSelectedShareId(null);
    }, [onUpdateShare]);

    const handleRemoveShare = useCallback((shareId: string) => {
        onRemoveShare(shareId);
        setSelectedShareId(null);
    }, [onRemoveShare]);

    return (
        <BaseModal visible={true} onClose={onClose}>
            <View style={[styles.modal, { height: maxHeight, maxHeight }]}>
                <View style={styles.header}>
                    <Text style={styles.headerTitle}>{t('session.sharing.title')}</Text>
                    <Pressable
                        onPress={onClose}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                    >
                        <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>

                <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
                    <ItemList>
                        {canManage && (
                            <Item
                                title={t('session.sharing.shareWith')}
                                icon={<Ionicons name="person-add-outline" size={29} color="#007AFF" />}
                                onPress={onAddShare}
                            />
                        )}

                        {canManage && (
                            <Item
                                title={t('session.sharing.publicLink')}
                                icon={<Ionicons name="link-outline" size={29} color="#007AFF" />}
                                onPress={onManagePublicLink}
                            />
                        )}

                        {shares.length > 0 ? (
                            <View style={styles.section}>
                                <Text style={styles.sectionTitle}>{t('session.sharing.sharedWith')}</Text>
                                {shares.map((share) => (
                                    <ShareItem
                                        key={share.id}
                                        share={share}
                                        canManage={canManage}
                                        isSelected={selectedShareId === share.id}
                                        onPress={() => handleSharePress(share.id)}
                                        onAccessLevelChange={handleAccessLevelChange}
                                        onRemove={handleRemoveShare}
                                    />
                                ))}
                            </View>
                        ) : null}

                        {shares.length === 0 && !canManage ? (
                            <View style={styles.emptyState}>
                                <Text style={styles.emptyText}>{t('session.sharing.noShares')}</Text>
                            </View>
                        ) : null}
                    </ItemList>
                </ScrollView>
            </View>
        </BaseModal>
    );
});

/**
 * Individual share item component
 */
interface ShareItemProps {
    share: SessionShare;
    canManage: boolean;
    isSelected: boolean;
    onPress: () => void;
    onAccessLevelChange: (shareId: string, accessLevel: ShareAccessLevel) => void;
    onRemove: (shareId: string) => void;
}

const ShareItem = memo(function ShareItem({
    share,
    canManage,
    isSelected,
    onPress,
    onAccessLevelChange,
    onRemove
}: ShareItemProps) {
    const styles = stylesheet;
    const accessLevelLabel = getAccessLevelLabel(share.accessLevel);
    const userName = share.sharedWithUser.username || [share.sharedWithUser.firstName, share.sharedWithUser.lastName]
        .filter(Boolean)
        .join(' ');

    return (
        <View>
            <Item
                title={userName}
                subtitle={accessLevelLabel}
                icon={
                    <Avatar
                        id={share.sharedWithUser.id}
                        imageUrl={share.sharedWithUser.avatar}
                        size={32}
                    />
                }
                onPress={canManage ? onPress : undefined}
                showChevron={canManage}
            />

            {/* Access level options (shown when selected) */}
            {isSelected && canManage && (
                <View style={styles.options}>
                    <Item
                        title={t('session.sharing.viewOnly')}
                        subtitle={t('session.sharing.viewOnlyDescription')}
                        onPress={() => onAccessLevelChange(share.id, 'view')}
                        selected={share.accessLevel === 'view'}
                    />
                    <Item
                        title={t('session.sharing.canEdit')}
                        subtitle={t('session.sharing.canEditDescription')}
                        onPress={() => onAccessLevelChange(share.id, 'edit')}
                        selected={share.accessLevel === 'edit'}
                    />
                    <Item
                        title={t('session.sharing.canManage')}
                        subtitle={t('session.sharing.canManageDescription')}
                        onPress={() => onAccessLevelChange(share.id, 'admin')}
                        selected={share.accessLevel === 'admin'}
                    />
                    <Item
                        title={t('session.sharing.stopSharing')}
                        onPress={() => onRemove(share.id)}
                        destructive
                    />
                </View>
            )}
        </View>
    );
});

/**
 * Get localized label for access level
 */
function getAccessLevelLabel(level: ShareAccessLevel): string {
    switch (level) {
        case 'view':
            return t('session.sharing.viewOnly');
        case 'edit':
            return t('session.sharing.canEdit');
        case 'admin':
            return t('session.sharing.canManage');
    }
}

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
        paddingBottom: 16,
        flexGrow: 1,
    },
    section: {
        marginTop: 16,
    },
    sectionTitle: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingVertical: 8,
        textTransform: 'uppercase',
        ...Typography.default('semiBold'),
    },
    options: {
        paddingLeft: 24,
        backgroundColor: theme.colors.surfaceHigh,
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
}));
