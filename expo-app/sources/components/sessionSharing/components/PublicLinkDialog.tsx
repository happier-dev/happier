import React, { memo, useEffect, useState } from 'react';
import { View, Text, Switch, Platform, Linking, useWindowDimensions, ScrollView, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'qrcode';
import { Image } from 'expo-image';
import * as Clipboard from 'expo-clipboard';

import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal } from '@/modal';
import { BaseModal } from '@/modal/components/BaseModal';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { RoundButton } from '@/components/RoundButton';
import { PublicSessionShare } from '@/sync/sharingTypes';

export interface PublicLinkDialogProps {
    publicShare: PublicSessionShare | null;
    onCreate: (options: {
        expiresInDays?: number;
        maxUses?: number;
        isConsentRequired: boolean;
    }) => void;
    onDelete: () => void;
    onCancel: () => void;
}

export const PublicLinkDialog = memo(function PublicLinkDialog({
    publicShare,
    onCreate,
    onDelete,
    onCancel
}: PublicLinkDialogProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { height: windowHeight } = useWindowDimensions();

    const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
    const [shareUrl, setShareUrl] = useState<string | null>(null);
    const [isConfiguring, setIsConfiguring] = useState(false);
    const [expiresInDays, setExpiresInDays] = useState<number | undefined>(7);
    const [maxUses, setMaxUses] = useState<number | undefined>(undefined);
    const [isConsentRequired, setIsConsentRequired] = useState(true);

    const scrollRef = React.useRef<ScrollView>(null);
    const scrollYRef = React.useRef(0);

    const maxHeight = React.useMemo(() => {
        return Math.min(720, Math.max(360, Math.floor(windowHeight * 0.85)));
    }, [windowHeight]);

    const buildPublicShareUrl = React.useCallback((token: string): string => {
        const path = `/share/${token}`;

        if (Platform.OS === 'web') {
            const origin =
                typeof window !== 'undefined' && window.location?.origin
                    ? window.location.origin
                    : '';
            return `${origin}${path}`;
        }

        const configuredWebAppUrl = (process.env.EXPO_PUBLIC_HAPPY_WEBAPP_URL || '').trim();
        const webAppUrl = configuredWebAppUrl || 'https://app.happy.engineering';
        return `${webAppUrl}${path}`;
    }, []);

    const handleScroll = React.useCallback((e: any) => {
        scrollYRef.current = e?.nativeEvent?.contentOffset?.y ?? 0;
    }, []);

    // On web, RN ScrollView inside a modal doesn't reliably respond to mouse wheel / trackpad scroll.
    // Manually translate wheel deltas into scrollTo.
    const handleWheel = React.useCallback((e: any) => {
        if (Platform.OS !== 'web') return;
        const deltaY = e?.deltaY;
        if (typeof deltaY !== 'number' || Number.isNaN(deltaY)) return;

        if (e?.cancelable) {
            e?.preventDefault?.();
        }
        e?.stopPropagation?.();
        scrollRef.current?.scrollTo({ y: Math.max(0, scrollYRef.current + deltaY), animated: false });
    }, []);

    useEffect(() => {
        if (!publicShare?.token) {
            setQrDataUrl(null);
            setShareUrl(null);
            return;
        }

        const url = buildPublicShareUrl(publicShare.token);
        setShareUrl(url);

        QRCode.toDataURL(url, {
            width: 250,
            margin: 2,
            color: {
                dark: '#000000',
                light: '#FFFFFF',
            },
        })
            .then(setQrDataUrl)
            .catch(() => setQrDataUrl(null));
    }, [buildPublicShareUrl, publicShare?.token]);

    const handleCreate = () => {
        setIsConfiguring(false);
        // When generating/regenerating a link, users often press the button at the bottom
        // of the config screen. Scroll back to top so the resulting QR code is visible.
        requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: 0, animated: false }));
        onCreate({
            expiresInDays,
            maxUses,
            isConsentRequired,
        });
    };

    const handleOpenLink = async () => {
        if (!shareUrl) return;
        try {
            if (Platform.OS === 'web') {
                window.open(shareUrl, '_blank', 'noopener,noreferrer');
                return;
            }
            await Linking.openURL(shareUrl);
        } catch {
            // ignore
        }
    };

    const handleCopyLink = async () => {
        if (!shareUrl) return;
        try {
            await Clipboard.setStringAsync(shareUrl);
            Modal.alert(t('common.copied'), t('items.copiedToClipboard', { label: t('session.sharing.publicLink') }));
        } catch {
            Modal.alert(t('common.error'), t('textSelection.failedToCopy'));
        }
    };

    const formatDate = (timestamp: number) => new Date(timestamp).toLocaleDateString();

    const Radio = ({ selected }: { selected: boolean }) => (
        <View style={[styles.radioOuter, selected ? styles.radioActive : styles.radioInactive]}>
            {selected ? <View style={styles.radioDot} /> : null}
        </View>
    );

    return (
        <BaseModal visible={true} onClose={onCancel}>
            <View
                style={[styles.container, { height: maxHeight, maxHeight }]}
                {...(Platform.OS === 'web' ? ({ onWheel: handleWheel } as any) : {})}
            >
                <View style={styles.header}>
                    <Text style={styles.headerTitle}>{t('session.sharing.publicLink')}</Text>
                    <Pressable
                        onPress={onCancel}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                    >
                        <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>

                <ScrollView
                    ref={scrollRef}
                    style={styles.scroll}
                    contentContainerStyle={styles.scrollContent}
                    showsVerticalScrollIndicator
                    nestedScrollEnabled
                    keyboardShouldPersistTaps="handled"
                    onScroll={handleScroll}
                    scrollEventThrottle={16}
                >
                    {!publicShare || isConfiguring ? (
                        <>
                            <View style={styles.section}>
                                <Text style={styles.descriptionText}>
                                    {t('session.sharing.publicLinkDescription')}
                                </Text>
                            </View>

                            <ItemGroup title={t('session.sharing.expiresIn')}>
                                <Item
                                    title={t('session.sharing.days7')}
                                    leftElement={<Radio selected={expiresInDays === 7} />}
                                    selected={expiresInDays === 7}
                                    onPress={() => setExpiresInDays(7)}
                                    showChevron={false}
                                />
                                <Item
                                    title={t('session.sharing.days30')}
                                    leftElement={<Radio selected={expiresInDays === 30} />}
                                    selected={expiresInDays === 30}
                                    onPress={() => setExpiresInDays(30)}
                                    showChevron={false}
                                />
                                <Item
                                    title={t('session.sharing.never')}
                                    leftElement={<Radio selected={expiresInDays === undefined} />}
                                    selected={expiresInDays === undefined}
                                    onPress={() => setExpiresInDays(undefined)}
                                    showChevron={false}
                                    showDivider={false}
                                />
                            </ItemGroup>

                            <ItemGroup title={t('session.sharing.maxUsesLabel')}>
                                <Item
                                    title={t('session.sharing.unlimited')}
                                    leftElement={<Radio selected={maxUses === undefined} />}
                                    selected={maxUses === undefined}
                                    onPress={() => setMaxUses(undefined)}
                                    showChevron={false}
                                />
                                <Item
                                    title={t('session.sharing.uses10')}
                                    leftElement={<Radio selected={maxUses === 10} />}
                                    selected={maxUses === 10}
                                    onPress={() => setMaxUses(10)}
                                    showChevron={false}
                                />
                                <Item
                                    title={t('session.sharing.uses50')}
                                    leftElement={<Radio selected={maxUses === 50} />}
                                    selected={maxUses === 50}
                                    onPress={() => setMaxUses(50)}
                                    showChevron={false}
                                    showDivider={false}
                                />
                            </ItemGroup>

                            <ItemGroup>
                                <Item
                                    title={t('session.sharing.requireConsent')}
                                    subtitle={t('session.sharing.requireConsentDescription')}
                                    rightElement={
                                        <Switch value={isConsentRequired} onValueChange={setIsConsentRequired} />
                                    }
                                    showChevron={false}
                                />
                            </ItemGroup>

                            <View style={styles.section}>
                                <RoundButton
                                    title={publicShare ? t('session.sharing.regeneratePublicLink') : t('session.sharing.createPublicLink')}
                                    onPress={handleCreate}
                                    size="large"
                                    style={{ width: '100%', maxWidth: 420, alignSelf: 'center' }}
                                />
                            </View>
                        </>
                    ) : (
                        <>
                            <ItemGroup>
                                <Item
                                    title={t('session.sharing.regeneratePublicLink')}
                                    onPress={() => {
                                        setIsConfiguring(true);
                                        requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: 0, animated: false }));
                                    }}
                                    icon={<Ionicons name="refresh-outline" size={29} color="#007AFF" />}
                                />
                            </ItemGroup>

                            {qrDataUrl ? (
                                <View style={styles.qrSection}>
                                    <Image
                                        source={{ uri: qrDataUrl }}
                                        style={styles.qrImage}
                                        contentFit="contain"
                                    />
                                </View>
                            ) : null}

                            {shareUrl ? (
                                <ItemGroup>
                                    <Item
                                        title={t('session.sharing.publicLink')}
                                        subtitle={<Text selectable>{shareUrl}</Text>}
                                        subtitleLines={0}
                                        onPress={handleOpenLink}
                                    />
                                    <Item
                                        title={t('common.copy')}
                                        icon={<Ionicons name="copy-outline" size={29} color="#007AFF" />}
                                        onPress={handleCopyLink}
                                        showChevron={false}
                                        showDivider={false}
                                    />
                                </ItemGroup>
                            ) : null}

                            <ItemGroup>
                                {publicShare.token ? (
                                    <Item
                                        title={t('session.sharing.linkToken')}
                                        subtitle={publicShare.token}
                                        subtitleLines={1}
                                        showChevron={false}
                                    />
                                ) : (
                                    <Item
                                        title={t('session.sharing.tokenNotRecoverable')}
                                        subtitle={t('session.sharing.tokenNotRecoverableDescription')}
                                        showChevron={false}
                                    />
                                )}

                                {publicShare.expiresAt ? (
                                    <Item
                                        title={t('session.sharing.expiresOn')}
                                        subtitle={formatDate(publicShare.expiresAt)}
                                        showChevron={false}
                                    />
                                ) : null}

                                <Item
                                    title={t('session.sharing.usageCount')}
                                    subtitle={
                                        publicShare.maxUses
                                            ? t('session.sharing.usageCountWithMax', {
                                                used: publicShare.useCount,
                                                max: publicShare.maxUses,
                                            })
                                            : t('session.sharing.usageCountUnlimited', {
                                                used: publicShare.useCount,
                                            })
                                    }
                                    showChevron={false}
                                />
                                <Item
                                    title={t('session.sharing.requireConsent')}
                                    subtitle={publicShare.isConsentRequired ? t('common.yes') : t('common.no')}
                                    showChevron={false}
                                    showDivider={false}
                                />
                            </ItemGroup>

                            <ItemGroup>
                                <Item
                                    title={t('session.sharing.deletePublicLink')}
                                    onPress={onDelete}
                                    destructive
                                    showDivider={false}
                                />
                            </ItemGroup>
                        </>
                    )}
                </ScrollView>
            </View>
        </BaseModal>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
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
        paddingHorizontal: 16,
        paddingTop: 12,
    },
    descriptionText: {
        color: theme.colors.textSecondary,
        fontSize: Platform.select({ ios: 15, default: 14 }),
        lineHeight: 20,
        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
        ...Typography.default(),
    },
    qrSection: {
        paddingHorizontal: 16,
        paddingTop: 12,
        alignItems: 'center',
    },
    qrImage: {
        width: 250,
        height: 250,
    },
    radioOuter: {
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    radioActive: {
        borderColor: theme.colors.radio.active,
    },
    radioInactive: {
        borderColor: theme.colors.radio.inactive,
    },
    radioDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: theme.colors.radio.dot,
    },
}));
