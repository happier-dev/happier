import React, { memo, useEffect, useState } from 'react';
import { View, Switch, Platform, Linking, ScrollView } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';

import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PublicSessionShare } from '@/sync/domains/social/sharingTypes';
import { HappyError } from '@/utils/errors/errors';
import { QRCode } from '@/components/qr';
import { Text } from '@/components/ui/text/Text';
import { useScrollViewWheelScrollTo } from '@/components/ui/scroll/useScrollViewWheelScrollTo';


export interface PublicLinkDialogProps {
    publicShare: PublicSessionShare | null;
    onCreate: (options: {
        expiresInDays?: number;
        maxUses?: number;
        isConsentRequired: boolean;
    }) => Promise<PublicSessionShare | void> | PublicSessionShare | void;
    onDelete: () => Promise<void> | void;
}

export const PublicLinkDialog = memo(function PublicLinkDialog({
    publicShare,
    onCreate,
    onDelete,
    onClose: _onClose,
}: PublicLinkDialogProps & CustomModalInjectedProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const [shareUrl, setShareUrl] = useState<string | null>(null);
    const [isConfiguring, setIsConfiguring] = useState(false);
    const [expiresInDays, setExpiresInDays] = useState<number | undefined>(7);
    const [maxUses, setMaxUses] = useState<number | undefined>(undefined);
    const [isConsentRequired, setIsConsentRequired] = useState(true);

    const scrollRef = React.useRef<ScrollView>(null);
    const wheelScrollHandlers = useScrollViewWheelScrollTo(scrollRef);

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
        const webAppUrl = configuredWebAppUrl || 'https://app.happier.dev';
        return `${webAppUrl}${path}`;
    }, []);

    useEffect(() => {
        if (!publicShare?.token) {
            setShareUrl(null);
            return;
        }

        const url = buildPublicShareUrl(publicShare.token);
        setShareUrl(url);
    }, [buildPublicShareUrl, publicShare?.token]);

    useEffect(() => {
        if (!shareUrl) return;
        // Ensure the generated QR code is visible even if the user was scrolled
        // to the bottom of the configuration screen when creating the link.
        requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: 0, animated: false }));
    }, [shareUrl]);

    const handleCreate = async () => {
        try {
            await Promise.resolve(onCreate({
                expiresInDays,
                maxUses,
                isConsentRequired,
            }));
            setIsConfiguring(false);
            // When generating/regenerating a link, users often press the button at the bottom
            // of the config screen. Scroll back to top so the resulting QR code is visible.
            requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: 0, animated: false }));
        } catch (e) {
            const message =
                e instanceof HappyError ? e.message :
                e instanceof Error ? e.message :
                t('errors.unknownError');
            Modal.alert(t('common.error'), message);
        }
    };

    const handleDelete = async () => {
        try {
            await Promise.resolve(onDelete());
            _onClose();
        } catch (e) {
            const message =
                e instanceof HappyError ? e.message :
                e instanceof Error ? e.message :
                t('errors.unknownError');
            Modal.alert(t('common.error'), message);
        }
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
        <View
            style={styles.body}
            {...(Platform.OS === 'web' ? ({ onWheel: wheelScrollHandlers.onWheel } as any) : {})}
        >
            <ScrollView
                ref={scrollRef}
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
                onScroll={wheelScrollHandlers.onScroll}
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
                                    icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.accent.blue} />}
                                />
                            </ItemGroup>

                            {shareUrl ? (
                                <View style={styles.qrSection}>
                                    <QRCode data={shareUrl} size={250} />
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
                                        icon={<Ionicons name="copy-outline" size={29} color={theme.colors.accent.blue} />}
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
                                    onPress={handleDelete}
                                    destructive
                                    showDivider={false}
                                />
                            </ItemGroup>
                        </>
                    )}
            </ScrollView>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        flex: 1,
        minHeight: 0,
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
        color: theme.colors.text.secondary,
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
