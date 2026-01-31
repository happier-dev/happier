import React, { memo, useCallback, useState } from 'react';
import { View, Text, Pressable, useWindowDimensions, Switch } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
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
    /** Whether the current user can grant/revoke permission approvals for recipients */
    canManagePermissionDelegation: boolean;
    /** Callback when user wants to add a new share */
    onAddShare: () => void;
    /** Callback when user updates share access level */
    onUpdateShare: (shareId: string, patch: { accessLevel?: ShareAccessLevel; canApprovePermissions?: boolean }) => void;
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
    canManagePermissionDelegation,
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
        onUpdateShare(shareId, {
            accessLevel,
            ...(accessLevel === 'view' ? { canApprovePermissions: false } : {}),
        });
        setSelectedShareId(null);
    }, [onUpdateShare]);

    const handlePermissionApprovalChange = useCallback((shareId: string, value: boolean) => {
        onUpdateShare(shareId, { canApprovePermissions: value });
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

                <ItemList>
                    {canManage ? (
                        <ItemGroup>
                            <Item
                                title={t('session.sharing.shareWith')}
                                icon={<Ionicons name="person-add-outline" size={29} color="#007AFF" />}
                                onPress={onAddShare}
                            />
                            <Item
                                title={t('session.sharing.publicLink')}
                                icon={<Ionicons name="link-outline" size={29} color="#007AFF" />}
                                onPress={onManagePublicLink}
                                showDivider={false}
                            />
                        </ItemGroup>
                    ) : null}

                    <ItemGroup title={t('session.sharing.sharedWith')}>
                        {shares.length > 0 ? (
                            shares.map((share) => {
                                const accessLevelLabel = getAccessLevelLabel(share.accessLevel);
                                const userName = share.sharedWithUser.username || [share.sharedWithUser.firstName, share.sharedWithUser.lastName]
                                    .filter(Boolean)
                                    .join(' ');
                                const subtitle = share.canApprovePermissions && share.accessLevel !== 'view'
                                    ? `${accessLevelLabel} • ${t('session.sharing.permissionApprovals')}`
                                    : accessLevelLabel;

                                return (
                                    <React.Fragment key={share.id}>
                                        <Item
                                            title={userName}
                                            subtitle={subtitle}
                                            icon={
                                                <Avatar
                                                    id={share.sharedWithUser.id}
                                                    imageUrl={share.sharedWithUser.avatar}
                                                    size={32}
                                                />
                                            }
                                            onPress={canManage ? () => handleSharePress(share.id) : undefined}
                                            showChevron={canManage}
                                        />

                                        {selectedShareId === share.id && canManage ? (
                                            <View style={styles.options}>
                                                <Item
                                                    title={t('session.sharing.viewOnly')}
                                                    subtitle={t('session.sharing.viewOnlyDescription')}
                                                    onPress={() => handleAccessLevelChange(share.id, 'view')}
                                                    selected={share.accessLevel === 'view'}
                                                />
                                                <Item
                                                    title={t('session.sharing.canEdit')}
                                                    subtitle={t('session.sharing.canEditDescription')}
                                                    onPress={() => handleAccessLevelChange(share.id, 'edit')}
                                                    selected={share.accessLevel === 'edit'}
                                                />
                                                <Item
                                                    title={t('session.sharing.canManage')}
                                                    subtitle={t('session.sharing.canManageDescription')}
                                                    onPress={() => handleAccessLevelChange(share.id, 'admin')}
                                                    selected={share.accessLevel === 'admin'}
                                                />

                                                {canManagePermissionDelegation && share.accessLevel !== 'view' ? (
                                                    <Item
                                                        title={t('session.sharing.allowPermissionApprovals')}
                                                        subtitle={t('session.sharing.allowPermissionApprovalsDescription')}
                                                        rightElement={
                                                            <Switch
                                                                value={share.canApprovePermissions}
                                                                onValueChange={(value) => handlePermissionApprovalChange(share.id, value)}
                                                            />
                                                        }
                                                        showChevron={false}
                                                    />
                                                ) : null}
                                                <Item
                                                    title={t('session.sharing.stopSharing')}
                                                    onPress={() => handleRemoveShare(share.id)}
                                                    destructive
                                                    showDivider={false}
                                                />
                                            </View>
                                        ) : null}
                                    </React.Fragment>
                                );
                            })
                        ) : (
                            <Item
                                title={t('session.sharing.noShares')}
                                icon={<Ionicons name="people-outline" size={29} color="#8E8E93" />}
                                showChevron={false}
                                showDivider={false}
                            />
                        )}
                    </ItemGroup>
                </ItemList>
            </View>
        </BaseModal>
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
    options: {
        paddingLeft: 24,
        backgroundColor: theme.colors.surfaceHigh,
    },
}));
