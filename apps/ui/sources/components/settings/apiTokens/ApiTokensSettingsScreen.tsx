import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RefreshControl, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { Icon } from '@/components/ui/icons/Icon';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { CenteredInfoTile } from '@/components/ui/lists/CenteredInfoTile';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { StepTransitionFrame } from '@/components/ui/motion';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { ApiTokenSettingsController, ApiTokenSettingsErrorCode, ApiTokenSettingsToken } from './apiTokenSettingsController';
import {
    resolveApiTokenListPresentation,
    resolveApiTokenOperationErrorMessageKey,
} from './apiTokenSettingsPresentation';
import { ApiTokenRow } from './ApiTokenRow';
import { apiTokenRowHref } from './collection/apiTokensCollection';
import { ApiTokenSettingsScope, useOptionalApiTokenSettingsScopeController } from './collection/ApiTokenSettingsScope';
import { useApiTokenGrantNames } from './grant/useApiTokenGrantCatalogs';
import { useApiTokenOperations } from './useApiTokenOperations';
import { useApiTokenSettingsClock } from './useApiTokenSettingsClock';
import { useApiTokenSettingsControllerState } from './useApiTokenSettingsControllerState';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { API_TOKEN_SETTINGS } from './apiTokensSettings';

function resolveOperationNotice(notice: 'revoked' | 'revokedAll' | 'signedOutEverywhere'): string {
    if (notice === 'revoked') return t('settingsApiTokens.notices.revoked');
    if (notice === 'revokedAll') return t('settingsApiTokens.notices.revokedAll');
    return t('settingsApiTokens.notices.signedOutEverywhere');
}

const stylesheet = StyleSheet.create((theme) => ({
    refreshing: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
    },
    feedback: {
        ...Typography.variant('body'),
    },
    error: {
        color: theme.colors.state.danger.textForeground,
    },
    notice: {
        color: theme.colors.state.success.textForeground,
    },
    listErrorContainer: {
        paddingVertical: theme.space.s20,
    },
    retryAction: {
        alignItems: 'center',
        marginTop: theme.space.s12,
    },
    tokenListTransition: {
        overflow: 'visible',
    },
}));

function SkeletonRows() {
    // The shared quiet placeholder rows: the token rows' final box in the sheet's hairline tone.
    return (
        <ItemGroup title={t('settingsApiTokens.tokens')}>
            <ItemLoadStateRows
                testID="settings-api-tokens-skeleton"
                state={{ kind: 'loading' }}
                rows={3}
                lines={2}
                accessibilityLabel={t('settingsApiTokens.tokens')}
            />
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

/**
 * `/settings/account/api-tokens` as a page: the token list where no rail shows (phones, narrow
 * windows, or no tokens yet). Inside the collection it reads the collection's controller; mounted on
 * its own it scopes one itself.
 */
export const ApiTokensSettingsScreen = React.memo(function ApiTokensSettingsScreen(props: Readonly<{
    controller?: ApiTokenSettingsController;
}> = {}) {
    const scoped = useOptionalApiTokenSettingsScopeController();
    if (scoped && !props.controller) return <ApiTokensListPage controller={scoped} />;
    return (
        <ApiTokenSettingsScope controller={props.controller}>
            <ScopedApiTokensListPage />
        </ApiTokenSettingsScope>
    );
});

function ScopedApiTokensListPage() {
    const controller = useOptionalApiTokenSettingsScopeController();
    return controller ? <ApiTokensListPage controller={controller} /> : null;
}

const ApiTokensListPage = React.memo(function ApiTokensListPage(props: Readonly<{
    controller: ApiTokenSettingsController;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const styles = stylesheet;
    const controller = props.controller;
    const state = useApiTokenSettingsControllerState(controller);
    const presentation = resolveApiTokenListPresentation(state);
    const hostActivelyViewed = useHostActivelyViewed();
    const names = useApiTokenGrantNames();
    const operations = useApiTokenOperations(controller);
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
        const previousNotice = announcedOperationNoticeRef.current;
        announcedOperationNoticeRef.current = state.operationNotice;
        if (!state.operationNotice || state.operationNotice === previousNotice) return;
        announceAccessibilityMessage(resolveOperationNotice(state.operationNotice));
    }, [state.operationNotice]);

    React.useEffect(() => {
        if (!state.operationError && !state.operationNotice) return undefined;
        const timeout = setTimeout(() => controller.clearOperationFeedback(), 5_000);
        return () => clearTimeout(timeout);
    }, [controller, state.operationError, state.operationNotice]);

    const revokeAll = operations.revokeAll;
    const openCreate = operations.create;
    const openToken = React.useCallback((token: ApiTokenSettingsToken) => {
        const result = runGuardedNavigation(() => router.push(apiTokenRowHref(token)));
        if (result !== true) fireAndForget(result, { tag: 'ApiTokensSettingsScreen.openToken' });
    }, [router]);

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
            <SettingsPageHeader
                description={t('settingsApiTokens.entrySubtitle')}
                details={state.isRefreshing ? (
                    <Text accessibilityLiveRegion="polite" style={styles.refreshing} testID="settings-api-tokens-refreshing">
                        {t('settingsApiTokens.refreshing')}
                    </Text>
                ) : undefined}
                primaryAction={!showsEmptyState ? {
                    title: t('settingsApiTokens.create.button'),
                    icon: 'plus',
                    testID: 'settings-api-tokens-create',
                    disabled: actionsPending,
                    onPress: openCreate,
                } : undefined}
            />

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
                <StepTransitionFrame
                    direction="forward"
                    style={styles.tokenListTransition}
                    testID="settings-api-tokens-list-transition"
                    transitionKey={tokenListTransitionKey}
                >
                    {showsEmptyState ? (
                        <ItemGroup surface="none">
                            <EmptyState
                                testID="settings-api-tokens-empty"
                                layout="page"
                                variant="add"
                                iconName="key"
                                title={t('settingsApiTokens.emptyTitle')}
                                subtitle={t('settingsApiTokens.emptyBody')}
                                primaryAction={{
                                    label: t('settingsApiTokens.create.button'),
                                    testID: 'settings-api-tokens-empty-create',
                                    disabled: actionsPending,
                                    onPress: openCreate,
                                }}
                            />
                        </ItemGroup>
                    ) : (
                        <ItemGroup title={t('settingsApiTokens.tokens')}>
                            {state.tokens.map((token) => (
                                <ApiTokenRow
                                    key={token.tokenId}
                                    token={token}
                                    names={names}
                                    nowMs={nowMs}
                                    variant="page"
                                    disabled={state.operation !== null && state.operationTokenId === token.tokenId}
                                    onPress={openToken}
                                />
                            ))}
                        </ItemGroup>
                    )}
                </StepTransitionFrame>
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

            {/* Leaving and destroying close the page as a quiet button row, and only when there is
                something to revoke (a control over an empty set is not offered). */}
            {state.tokens.length > 0 ? (
                <ItemGroup surface="none" accessibilityLabel={t('settingsApiTokens.securityTitle')}>
                    <SettingAnchor setting={API_TOKEN_SETTINGS.settings.revokeAll}>
                        <SectionButtonRow
                            testID="settings-api-tokens-closing"
                            footnote={t('settingsApiTokens.revokeAll.subtitle')}
                        >
                            <RoundButton
                                testID="settings-api-tokens-revoke-all"
                                size="small"
                                display="destructive"
                                title={t('settingsApiTokens.revokeAll.title')}
                                accessibilityHint={t('settingsApiTokens.securityFooter')}
                                disabled={actionsPending}
                                loading={state.operation === 'revokeAll'}
                                onPress={revokeAll}
                            />
                        </SectionButtonRow>
                    </SettingAnchor>
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});
