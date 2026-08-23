import * as React from 'react';
import { Platform, RefreshControl, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { useAuth } from '@/auth/context/AuthContext';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ShimmerView } from '@/components/ui/feedback/ShimmerView';
import { Icon } from '@/components/ui/icons/Icon';
import { CenteredInfoTile } from '@/components/ui/lists/CenteredInfoTile';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { SoftSlideTransitionFrame } from '@/components/ui/motion';
import { RelativeTimeText } from '@/components/ui/selectionList/accessories/RelativeTimeText';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { Modal } from '@/modal';
import { t } from '@/text';

import {
    createApiTokenSettingsController,
    type ApiTokenSettingsController,
} from './apiTokenSettingsController';
import {
    buildApiTokenRowPresentation,
    resolveApiTokenListPresentation,
    resolveApiTokenOperationErrorMessageKey,
} from './apiTokenSettingsPresentation';
import { showApiTokenCreateModal } from './showApiTokenCreateModal';
import { useApiTokenSettingsControllerState } from './useApiTokenSettingsControllerState';
import { completeApiTokenSettingsSignOutEverywhere } from './apiTokenSettingsSignOutLifecycle';

function resolveOperationNotice(notice: 'revoked' | 'revokedAll' | 'signedOutEverywhere'): string {
    if (notice === 'revoked') return t('settingsApiTokens.notices.revoked');
    if (notice === 'revokedAll') return t('settingsApiTokens.notices.revokedAll');
    return t('settingsApiTokens.notices.signedOutEverywhere');
}

const stylesheet = StyleSheet.create((theme) => ({
    intro: {
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        paddingTop: 24,
        paddingBottom: 4,
        gap: 6,
        alignItems: 'flex-start',
        alignSelf: 'center',
        width: '100%',
        maxWidth: 760,
    },
    heading: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 24,
        lineHeight: 30,
    },
    introBody: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        lineHeight: 20,
    },
    headerActions: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        marginTop: 10,
    },
    rowMetadata: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 7,
        minWidth: 0,
    },
    prefix: {
        ...Typography.mono(),
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
    metadataLabel: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
    separator: {
        color: theme.colors.text.secondary,
        opacity: 0.55,
    },
    skeletonRow: {
        height: Platform.select({ ios: 68, default: 76 }),
        paddingHorizontal: 16,
        justifyContent: 'center',
        gap: 8,
    },
    skeletonTitle: {
        width: '42%',
        height: 14,
        borderRadius: 6,
        backgroundColor: theme.colors.surface.inset,
    },
    skeletonSubtitle: {
        width: '68%',
        height: 11,
        borderRadius: 5,
        backgroundColor: theme.colors.surface.inset,
    },
    feedback: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
    },
    error: {
        color: theme.colors.state.danger.foreground,
    },
    notice: {
        color: theme.colors.state.success.foreground,
    },
    listErrorContainer: {
        paddingVertical: 20,
    },
    retryAction: {
        alignItems: 'center',
        marginTop: 12,
    },
    tokenListTransition: {
        overflow: 'visible',
    },
}));

function TokenRow(props: Readonly<{
    controller: ApiTokenSettingsController;
    token: ReturnType<typeof buildApiTokenRowPresentation>['token'];
    nowMs: number;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const presentation = buildApiTokenRowPresentation({ token: props.token, nowMs: props.nowMs });
    const createdAt = Date.parse(props.token.createdAt);
    const lastUsedAt = props.token.lastUsedAt ? Date.parse(props.token.lastUsedAt) : null;
    const statusLabel = presentation.status === 'expired'
        ? t('settingsApiTokens.status.expired')
        : presentation.status === 'expiring'
            ? t('settingsApiTokens.status.expiring')
            : null;

    const revoke = React.useCallback(async () => {
        const confirmed = await Modal.confirm(
            t('settingsApiTokens.revoke.title', { label: props.token.label }),
            t('settingsApiTokens.revoke.body'),
            {
                cancelText: t('common.cancel'),
                confirmText: t('settingsApiTokens.revoke.confirm'),
                destructive: true,
            },
        );
        if (confirmed) await props.controller.revokeToken(props.token.tokenId);
    }, [props.controller, props.token.label, props.token.tokenId]);

    const rowActions = React.useMemo(() => [{
        id: `settings-api-tokens-revoke:${props.token.tokenId}`,
        title: t('settingsApiTokens.revoke.confirm'),
        icon: 'trash' as const,
        destructive: true,
        onPress: revoke,
    }], [props.token.tokenId, revoke]);

    return (
        <Item
            key={props.token.tokenId}
            testID={`settings-api-tokens-row:${props.token.tokenId}`}
            mode="info"
            title={props.token.label}
            titleStyle={{ flexShrink: 1, color: presentation.status === 'expired' ? theme.colors.text.secondary : theme.colors.text.primary }}
            accessibilityLabel={t('settingsApiTokens.rowAccessibilityLabel', {
                label: props.token.label,
                state: statusLabel ?? t('settingsApiTokens.status.active'),
            })}
            subtitle={(
                <View style={styles.rowMetadata}>
                    <Text style={styles.prefix}>{presentation.displayPrefix}</Text>
                    <Text style={styles.separator}>·</Text>
                    <Text style={styles.metadataLabel}>{t('settingsApiTokens.created')}</Text>
                    <RelativeTimeText atMs={createdAt} nowMs={props.nowMs} />
                    <Text style={styles.separator}>·</Text>
                    {lastUsedAt === null ? (
                        <Text style={styles.metadataLabel}>{t('settingsApiTokens.neverUsed')}</Text>
                    ) : (
                        <>
                            <Text style={styles.metadataLabel}>{t('settingsApiTokens.lastUsed')}</Text>
                            <RelativeTimeText atMs={lastUsedAt} nowMs={props.nowMs} />
                        </>
                    )}
                    {statusLabel ? (
                        <StatusPill
                            testID={`settings-api-tokens-status:${props.token.tokenId}`}
                            variant={presentation.statusVariant}
                            label={statusLabel}
                            accessibilityLabel={statusLabel}
                        />
                    ) : null}
                </View>
            )}
            subtitleLines={0}
            icon={<Icon name="key" size={24} color={theme.colors.text.secondary} />}
            rightElement={(
                <ItemRowActions
                    title={props.token.label}
                    actions={rowActions}
                    layoutWidthPx={320}
                    compactActionIds={[]}
                    overflowTriggerTestID={`settings-api-tokens-overflow:${props.token.tokenId}`}
                />
            )}
            rightElementOutsidePressable
            showChevron={false}
        />
    );
}

function SkeletonRows() {
    const styles = stylesheet;
    return (
        <ItemGroup title={t('settingsApiTokens.tokens')}>
            {[0, 1, 2].map((index) => (
                <ShimmerView key={index} animationEnabled style={styles.skeletonRow}>
                    <View testID={`settings-api-tokens-skeleton:${index}`} style={styles.skeletonRow}>
                        <View style={styles.skeletonTitle} />
                        <View style={styles.skeletonSubtitle} />
                    </View>
                </ShimmerView>
            ))}
        </ItemGroup>
    );
}

function ApiTokenListRetry(props: Readonly<{
    controller: ApiTokenSettingsController;
    error: string | null;
    testID: string;
    retryTestID: string;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    return (
        <ItemGroup>
            <View testID={props.testID} style={styles.listErrorContainer}>
                <CenteredInfoTile
                    icon={<Icon name="warning" size={30} color={theme.colors.state.danger.foreground} />}
                    title={t('settingsApiTokens.errors.listTitle')}
                    description={t(resolveApiTokenOperationErrorMessageKey(props.error))}
                />
                <View style={styles.retryAction}>
                    <RoundButton
                        size="normal"
                        title={t('common.retry')}
                        testID={props.retryTestID}
                        action={props.controller.refresh}
                    />
                </View>
            </View>
        </ItemGroup>
    );
}

export const ApiTokensSettingsScreen = React.memo(function ApiTokensSettingsScreen(props: Readonly<{
    controller?: ApiTokenSettingsController;
}> = {}) {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const router = useRouter();
    const styles = stylesheet;
    const ownedControllerRef = React.useRef<ApiTokenSettingsController | null>(null);
    if (!props.controller && !ownedControllerRef.current) {
        ownedControllerRef.current = createApiTokenSettingsController();
    }
    const controller = props.controller ?? ownedControllerRef.current!;
    const state = useApiTokenSettingsControllerState(controller);
    const presentation = resolveApiTokenListPresentation(state);
    const reducedMotion = useReducedMotionPreference();
    const nowMs = Date.now();
    const tokenListTransitionKey = state.tokens.map((token) => token.tokenId).join(',') || 'empty';
    const showsTokenList = presentation === 'list' || presentation === 'listWithRetry';
    const showsEmptyState = presentation === 'empty' || presentation === 'emptyWithRetry';
    const showsRefreshRetry = presentation === 'listWithRetry' || presentation === 'emptyWithRetry';

    React.useEffect(() => {
        void controller.refresh();
        return () => {
            if (!props.controller) controller.retire();
        };
    }, [controller, props.controller]);

    const revokeAll = React.useCallback(async () => {
        const confirmed = await Modal.confirm(
            t('settingsApiTokens.revokeAll.title'),
            t('settingsApiTokens.revokeAll.body'),
            { cancelText: t('common.cancel'), confirmText: t('settingsApiTokens.revokeAll.confirm'), destructive: true },
        );
        if (confirmed) await controller.revokeAllTokens();
    }, [controller]);

    const signOutEverywhere = React.useCallback(async () => {
        const confirmed = await Modal.confirm(
            t('settingsApiTokens.signOutEverywhere.title'),
            t('settingsApiTokens.signOutEverywhere.body'),
            { cancelText: t('common.cancel'), confirmText: t('settingsApiTokens.signOutEverywhere.confirm'), destructive: true },
        );
        if (!confirmed) return;
        await completeApiTokenSettingsSignOutEverywhere({
            signOutEverywhere: controller.signOutEverywhere,
            logout: auth.logout,
            replace: (path) => router.replace(path),
        });
    }, [auth.logout, controller, router]);

    return (
        <ItemList
            style={{ paddingTop: 0 }}
            refreshControl={(
                <RefreshControl
                    refreshing={state.isRefreshing}
                    onRefresh={() => void controller.refresh()}
                    tintColor={theme.colors.text.secondary}
                />
            )}
        >
            <View style={styles.intro}>
                <Text style={styles.heading}>{t('settingsApiTokens.title')}</Text>
                <Text style={styles.introBody}>{t('settingsApiTokens.description')}</Text>
                <View style={styles.headerActions}>
                    <RoundButton
                        size="normal"
                        title={t('settingsApiTokens.create.button')}
                        testID="settings-api-tokens-create"
                        onPress={() => showApiTokenCreateModal(controller)}
                    />
                    {state.isRefreshing && state.tokens.length > 0 ? (
                        <Text accessibilityLiveRegion="polite" style={styles.introBody} testID="settings-api-tokens-refreshing">
                            {t('settingsApiTokens.refreshing')}
                        </Text>
                    ) : null}
                </View>
            </View>

            {presentation === 'skeleton' ? <SkeletonRows /> : null}
            {presentation === 'error' ? (
                <ApiTokenListRetry
                    controller={controller}
                    error={state.listError}
                    testID="settings-api-tokens-list-error"
                    retryTestID="settings-api-tokens-list-retry"
                />
            ) : null}
            {showsTokenList || showsEmptyState ? (
                <SoftSlideTransitionFrame
                    direction="forward"
                    reducedMotion={reducedMotion}
                    style={styles.tokenListTransition}
                    testID="settings-api-tokens-list-transition"
                    transitionKey={tokenListTransitionKey}
                >
                    {showsEmptyState ? (
                        <ItemGroup>
                            <View testID="settings-api-tokens-empty" style={{ paddingVertical: 22 }}>
                                <CenteredInfoTile
                                    icon={<Icon name="key" size={32} color={theme.colors.text.secondary} />}
                                    title={t('settingsApiTokens.emptyTitle')}
                                    description={t('settingsApiTokens.emptyBody')}
                                />
                            </View>
                        </ItemGroup>
                    ) : (
                        <ItemGroup title={t('settingsApiTokens.tokens')}>
                            {state.tokens.map((token) => (
                                <TokenRow key={token.tokenId} controller={controller} token={token} nowMs={nowMs} />
                            ))}
                        </ItemGroup>
                    )}
                </SoftSlideTransitionFrame>
            ) : null}
            {showsRefreshRetry ? (
                <ApiTokenListRetry
                    controller={controller}
                    error={state.listError}
                    testID="settings-api-tokens-refresh-error"
                    retryTestID="settings-api-tokens-refresh-retry"
                />
            ) : null}

            {state.operationError || state.operationNotice ? (
                <ItemGroup>
                    <Item
                        mode="info"
                        title={state.operationError
                            ? t(resolveApiTokenOperationErrorMessageKey(state.operationError))
                            : resolveOperationNotice(state.operationNotice!)}
                        titleStyle={[styles.feedback, state.operationError ? styles.error : styles.notice]}
                        icon={<Icon
                            name={state.operationError ? 'warning' : 'check-circle'}
                            size={22}
                            color={state.operationError ? theme.colors.state.danger.foreground : theme.colors.state.success.foreground}
                        />}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            <ItemGroup title={t('settingsApiTokens.securityTitle')} footer={t('settingsApiTokens.securityFooter')}>
                <Item
                    testID="settings-api-tokens-revoke-all"
                    title={t('settingsApiTokens.revokeAll.title')}
                    subtitle={t('settingsApiTokens.revokeAll.subtitle')}
                    icon={<Icon name="trash" size={24} color={theme.colors.state.danger.foreground} />}
                    destructive
                    disabled={state.tokens.length === 0 || state.operation !== null}
                    loading={state.operation === 'revokeAll'}
                    onPress={revokeAll}
                />
                <Item
                    testID="settings-api-tokens-sign-out-everywhere"
                    title={t('settingsApiTokens.signOutEverywhere.title')}
                    subtitle={t('settingsApiTokens.signOutEverywhere.subtitle')}
                    icon={<Icon name="sign-out" size={24} color={theme.colors.state.danger.foreground} />}
                    destructive
                    disabled={state.operation !== null}
                    loading={state.operation === 'signOutEverywhere'}
                    onPress={signOutEverywhere}
                />
            </ItemGroup>
        </ItemList>
    );
});
