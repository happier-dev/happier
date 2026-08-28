import * as React from 'react';
import { Platform, RefreshControl, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { useAuth } from '@/auth/context/AuthContext';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
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
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

import {
    createApiTokenSettingsController,
    type ApiTokenSettingsController,
    type ApiTokenSettingsErrorCode,
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

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const API_TOKEN_EXPIRING_WINDOW_MS = 7 * DAY_MS;
const SKELETON_TITLE = '██████████';
const SKELETON_PREFIX = '████████';
const SKELETON_METADATA = '████████';

function resolveNextRelativeTimeChangeAt(atMs: number, nowMs: number): number | null {
    if (!Number.isFinite(atMs)) return null;
    const elapsedMs = nowMs - atMs;
    if (elapsedMs < MINUTE_MS) return atMs + MINUTE_MS;

    const minutes = Math.floor(elapsedMs / MINUTE_MS);
    if (minutes < 60) return atMs + (minutes + 1) * MINUTE_MS;

    const hours = Math.floor(elapsedMs / HOUR_MS);
    if (hours < 24) return atMs + (hours + 1) * HOUR_MS;

    const days = Math.floor(elapsedMs / DAY_MS);
    return atMs + (days + 1) * DAY_MS;
}

function resolveNextApiTokenPresentationChangeAt(
    tokens: readonly Readonly<{ createdAt: string; lastUsedAt: string | null; expiresAt: string | null }>[],
    nowMs: number,
): number | null {
    let nextAt: number | null = null;
    const consider = (candidate: number | null): void => {
        if (candidate === null || !Number.isFinite(candidate) || candidate <= nowMs) return;
        nextAt = nextAt === null ? candidate : Math.min(nextAt, candidate);
    };

    for (const token of tokens) {
        consider(resolveNextRelativeTimeChangeAt(Date.parse(token.createdAt), nowMs));
        if (token.lastUsedAt) consider(resolveNextRelativeTimeChangeAt(Date.parse(token.lastUsedAt), nowMs));

        const expiresAtMs = token.expiresAt ? Date.parse(token.expiresAt) : Number.NaN;
        if (!Number.isFinite(expiresAtMs)) continue;
        const expiringAtMs = expiresAtMs - API_TOKEN_EXPIRING_WINDOW_MS;
        if (nowMs < expiringAtMs) consider(expiringAtMs);
        else if (nowMs < expiresAtMs) consider(expiresAtMs);
    }

    return nextAt;
}

function useApiTokenSettingsClock(
    tokens: readonly Readonly<{ createdAt: string; lastUsedAt: string | null; expiresAt: string | null }>[],
    active: boolean,
): number {
    const [nowMs, setNowMs] = React.useState(() => Date.now());
    const tokensRef = React.useRef(tokens);
    tokensRef.current = tokens;
    const timingKey = tokens.map((token) => [
        token.createdAt,
        token.lastUsedAt ?? '',
        token.expiresAt ?? '',
    ].join('\u001f')).join('\u001e');

    React.useEffect(() => {
        if (!active || tokensRef.current.length === 0) return undefined;

        let timeout: ReturnType<typeof setTimeout> | undefined;
        let disposed = false;
        const scheduleNextChange = () => {
            const currentNowMs = Date.now();
            setNowMs((previousNowMs) => previousNowMs === currentNowMs ? previousNowMs : currentNowMs);

            const nextAtMs = resolveNextApiTokenPresentationChangeAt(tokensRef.current, currentNowMs);
            if (nextAtMs === null || disposed) return;
            timeout = setTimeout(scheduleNextChange, Math.max(1, nextAtMs - currentNowMs + 1));
        };

        scheduleNextChange();
        return () => {
            disposed = true;
            if (timeout) clearTimeout(timeout);
        };
    }, [active, timingKey]);

    return nowMs;
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
    emptyState: {
        alignItems: 'center',
        gap: 14,
        paddingVertical: 22,
    },
    tokenListTransition: {
        overflow: 'visible',
    },
}));

function TokenRow(props: Readonly<{
    controller: ApiTokenSettingsController;
    token: ReturnType<typeof buildApiTokenRowPresentation>['token'];
    nowMs: number;
    operation: 'revoke' | 'revokeAll' | 'signOutEverywhere' | null;
    operationTokenId: string | null;
    actionsPending: boolean;
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
    const revokingThisToken = props.operation === 'revoke' && props.operationTokenId === props.token.tokenId;

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
        disabled: props.actionsPending,
        onPress: revoke,
    }], [props.actionsPending, props.token.tokenId, revoke]);

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
                    overflowTriggerAccessibilityLabel={t('settingsApiTokens.moreActionsAccessibilityLabel', {
                        label: props.token.label,
                    })}
                />
            )}
            rightElementOutsidePressable
            disabled={props.actionsPending}
            loading={revokingThisToken}
            showChevron={false}
        />
    );
}

function SkeletonRows() {
    const styles = stylesheet;
    return (
        <ItemGroup title={t('settingsApiTokens.tokens')}>
            {[0, 1, 2].map((index) => (
                <View
                    key={index}
                    testID={`settings-api-tokens-skeleton:${index}`}
                    aria-hidden={true}
                    accessibilityElementsHidden={true}
                    importantForAccessibility="no-hide-descendants"
                >
                    <ShimmerView animationEnabled={false}>
                        <Item
                            testID={`settings-api-tokens-skeleton-row:${index}`}
                            mode="info"
                            title={SKELETON_TITLE}
                            subtitle={(
                                <View style={styles.rowMetadata}>
                                    <Text style={styles.prefix}>{SKELETON_PREFIX}</Text>
                                    <Text style={styles.separator}>·</Text>
                                    <Text style={styles.metadataLabel}>{SKELETON_METADATA}</Text>
                                    <Text style={styles.separator}>·</Text>
                                    <Text style={styles.metadataLabel}>{SKELETON_METADATA}</Text>
                                </View>
                            )}
                            icon={<Icon name="key" size={24} />}
                            showChevron={false}
                            showDivider={false}
                        />
                    </ShimmerView>
                </View>
            ))}
        </ItemGroup>
    );
}

function ApiTokenListRetry(props: Readonly<{
    controller: ApiTokenSettingsController;
    error: ApiTokenSettingsErrorCode | null;
    testID: string;
    retryTestID: string;
    disabled: boolean;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    return (
        <ItemGroup>
            <View
                testID={props.testID}
                style={styles.listErrorContainer}
                accessibilityRole="alert"
                accessibilityLiveRegion="assertive"
                role="alert"
                aria-live="assertive"
            >
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
                        disabled={props.disabled}
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
    const activeServerAccountScope = useActiveServerAccountScope();
    const state = useApiTokenSettingsControllerState(controller);
    const presentation = resolveApiTokenListPresentation(state);
    const reducedMotion = useReducedMotionPreference();
    const hostActivelyViewed = useHostActivelyViewed();
    const tokenListTransitionKey = state.tokens.map((token) => token.tokenId).join(',') || 'empty';
    const showsTokenList = presentation === 'list' || presentation === 'listWithRetry';
    const showsEmptyState = presentation === 'empty' || presentation === 'emptyWithRetry';
    const showsRefreshRetry = presentation === 'listWithRetry' || presentation === 'emptyWithRetry';
    const nowMs = useApiTokenSettingsClock(state.tokens, hostActivelyViewed && showsTokenList);
    const actionsPending = state.phase === 'loading'
        || state.isRefreshing
        || state.createPending
        || state.operation !== null;
    const announcedOperationNoticeRef = React.useRef<typeof state.operationNotice | null>(null);

    React.useEffect(() => {
        void controller.refresh();
    }, [
        activeServerAccountScope?.accountId,
        activeServerAccountScope?.serverId,
        controller,
    ]);

    React.useInsertionEffect(() => {
        if (props.controller) return undefined;
        return () => {
            controller.retire();
        };
    }, [controller, props.controller]);

    React.useEffect(() => {
        const previousNotice = announcedOperationNoticeRef.current;
        announcedOperationNoticeRef.current = state.operationNotice;
        if (!state.operationNotice || state.operationNotice === previousNotice) return;
        announceAccessibilityMessage(resolveOperationNotice(state.operationNotice));
    }, [state.operationNotice]);

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
    const openCreate = React.useCallback(() => {
        showApiTokenCreateModal(controller);
    }, [controller]);

    return (
        <ItemList
            style={{ paddingTop: 0 }}
            refreshControl={(
                <RefreshControl
                    refreshing={state.isRefreshing}
                    enabled={!actionsPending}
                    onRefresh={() => void controller.refresh()}
                    tintColor={theme.colors.text.secondary}
                />
            )}
        >
            <View style={styles.intro}>
                <Text style={styles.heading}>{t('settingsApiTokens.title')}</Text>
                <Text style={styles.introBody}>{t('settingsApiTokens.description')}</Text>
                <View style={styles.headerActions}>
                    {!showsEmptyState ? (
                        <RoundButton
                            size="normal"
                            title={t('settingsApiTokens.create.button')}
                            testID="settings-api-tokens-create"
                            disabled={actionsPending}
                            onPress={openCreate}
                        />
                    ) : null}
                    {state.isRefreshing ? (
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
                    disabled={actionsPending}
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
                            <View testID="settings-api-tokens-empty" style={styles.emptyState}>
                                <CenteredInfoTile
                                    icon={<Icon name="key" size={32} color={theme.colors.text.secondary} />}
                                    title={t('settingsApiTokens.emptyTitle')}
                                    description={t('settingsApiTokens.emptyBody')}
                                />
                                <RoundButton
                                    size="normal"
                                    title={t('settingsApiTokens.create.button')}
                                    testID="settings-api-tokens-empty-create"
                                    disabled={actionsPending}
                                    onPress={openCreate}
                                />
                            </View>
                        </ItemGroup>
                    ) : (
                        <ItemGroup title={t('settingsApiTokens.tokens')}>
                            {state.tokens.map((token) => (
                                <TokenRow
                                    key={token.tokenId}
                                    controller={controller}
                                    token={token}
                                    nowMs={nowMs}
                                    operation={state.operation}
                                    operationTokenId={state.operationTokenId}
                                    actionsPending={actionsPending}
                                />
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
                    disabled={actionsPending}
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
                        accessibilityRole={state.operationError ? 'alert' : undefined}
                        accessibilityLiveRegion={state.operationError ? 'assertive' : 'none'}
                        webRole={state.operationError ? 'alert' : undefined}
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
                    disabled={state.tokens.length === 0 || actionsPending}
                    loading={state.operation === 'revokeAll'}
                    onPress={revokeAll}
                />
                <Item
                    testID="settings-api-tokens-sign-out-everywhere"
                    title={t('settingsApiTokens.signOutEverywhere.title')}
                    subtitle={t('settingsApiTokens.signOutEverywhere.subtitle')}
                    icon={<Icon name="sign-out" size={24} color={theme.colors.state.danger.foreground} />}
                    destructive
                    disabled={actionsPending}
                    loading={state.operation === 'signOutEverywhere'}
                    onPress={signOutEverywhere}
                />
            </ItemGroup>
        </ItemList>
    );
});
