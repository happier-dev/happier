import * as React from 'react';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { View } from 'react-native';

import { PageHeader, renderPageHeaderText, type PageHeaderProps } from '@/components/ui/layout/PageHeader';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { HomeCredentialUnreadableCard } from '@/components/sessions/access/UnboundSessionHomeScopeCard';
import { useHomeAdministration } from '@/hooks/home/useHomeAdministration';
import { refreshHomeGovernanceSnapshot } from '@/sync/engine/home/governance/homeGovernanceEngine';
import { serverAccountScopeKeySuffix, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

import type { HomeAdministrationContext } from './homeAdministrationContext';
import { HomeClaimSetup } from './HomeClaimSetup';
import { HomeConsoleMenu, useHomeConsoleNavigation } from './HomeConsoleNavigation';
import { isApprovalRequestV2InFlightStatus } from '@happier-dev/protocol/approvals/approvalRequestV1';

/**
 * A condition that occupies the page because there is genuinely nothing else
 * truthful to show. Every state that *does* have retained content renders that
 * content instead, with an explanation attached. The page header stays above it.
 */
const HomeAdministrationStateCard = React.memo(function HomeAdministrationStateCard(props: Readonly<{
    kind: 'loading' | 'unavailable' | 'error';
    title: string;
    body?: string;
    action?: Readonly<{ label: string; onPress: () => void }>;
    testID: string;
}>) {
    return (
        <SurfaceStateCard
            testID={props.testID}
            kind={props.kind}
            title={props.title}
            reason={props.body}
            action={props.action}
            accessibilitySemantics={props.kind === 'loading' ? 'status' : 'alert'}
        />
    );
});

/**
 * The one place Home Administration decides how a Home's condition is shown.
 *
 * Overview, People and Policies all render through this, so the freshness
 * notice, the offline explanation, the retry and the owner-setup state cannot
 * drift between them. Sections receive the projection only once it exists, so
 * no section has to defend itself against a Home that has not answered — and
 * none of them re-derives when Home/Account-qualified section state must be
 * discarded.
 *
 * Every destination is a configuration page: its header comes first in every state, then any
 * condition banner (approval, stale, setup), then the destination's sections.
 */
export const HomeAdministrationSection = React.memo(function HomeAdministrationSection(props: Readonly<{
    serverId: string;
    title: string;
    /** The destination's purpose line. */
    description?: string;
    /** Destination-specific explanation of a settled Home refusal. */
    forbiddenBody?: string;
    /** An entity header rendered from the Home once it has answered (the Home overview). */
    renderHeader?: (context: HomeAdministrationContext) => React.ReactNode;
    /**
     * The page is about something the child loads itself (a person): once the Home has answered the
     * child renders its own `PageHeader` first and then the condition banners it receives as the
     * second argument of `children`.
     */
    childRendersHeader?: boolean;
    /** `virtualized-list`: the child draws the page with a `VirtualizedItemList` and places the header in its list header. */
    presentation?: 'item-list' | 'virtualized-list';
    /** The page's own actions in its header once the Home has answered (Invite people on People and Teams). */
    pageActions?: (context: HomeAdministrationContext) => Pick<PageHeaderProps, 'actions' | 'primaryAction'>;
    children: (context: HomeAdministrationContext, header?: React.ReactNode) => React.ReactNode;
}>) {
    const navigation = useNavigation();
    const router = useRouter();
    const binding = useHomeAdministration(props.serverId);
    // The console sidebar beside the page already names the Home; elsewhere the header does.
    const namesHome = useHomeConsoleNavigation() !== 'sidebar';
    const scope = binding.kind === 'bound' ? binding.scope : null;
    const scopeServerId = scope?.serverId ?? '';
    const scopeAccountId = scope?.accountId ?? '';
    const scopeKey = scope ? serverAccountScopeKeySuffix(scope) : `unbound:${props.serverId}`;
    // Read at capture time, not at render: a confirmation opened now must bind to the credential
    // current now, and must see a later credential change as a different lifetime.
    const lifetimeRef = React.useRef<ServerAccountScopeLifetime | null>(null);
    lifetimeRef.current = binding.kind === 'bound' ? binding.lifetime : null;
    const captureDestructiveTarget = React.useCallback(() => lifetimeRef.current, []);
    const approvalRefresh = React.useCallback(() => {
        if (scopeServerId && scopeAccountId) {
            void refreshHomeGovernanceSnapshot({ serverId: scopeServerId, accountId: scopeAccountId });
        }
    }, [scopeAccountId, scopeServerId]);
    const {
        approvalId,
        approvalStatus,
        approvalPending,
        isLoading: approvalLoading,
        error: approvalError,
        requestApproval,
    } = useActionApprovalContinuation({
        scopeKey,
        serverId: props.serverId,
        onExecuted: approvalRefresh,
    });

    React.useEffect(() => {
        navigation.setOptions({ title: props.title });
    }, [navigation, props.title]);

    const retry = React.useCallback(() => {
        if (!scopeServerId || !scopeAccountId) return;
        void refreshHomeGovernanceSnapshot({ serverId: scopeServerId, accountId: scopeAccountId });
    }, [scopeServerId, scopeAccountId]);

    // Catching up after a good answer is routine: a quiet note, never a warning. It joins the meta
    // line where the header names the Home, and otherwise sits after the title, so the header never
    // grows a line for it (nor keeps an empty one waiting for it).
    const updating = 'state' in binding && binding.state.kind === 'ready' && binding.state.updating;
    const renderPlainHeader = (actions?: Pick<PageHeaderProps, 'actions' | 'primaryAction'>) => (
        <PageHeader
            testID="home-admin-page-header"
            title={props.title}
            description={props.description}
            actions={actions?.actions}
            primaryAction={actions?.primaryAction}
            titleAccessory={updating && !namesHome ? (
                <View testID="home-admin-updating">
                    {renderPageHeaderText({ role: 'meta', text: t('homeGovernance.updating'), header: false })}
                </View>
            ) : undefined}
            meta={namesHome ? [
                // An empty line keeps its place until the Home's name is known.
                ...('homeName' in binding ? [{ key: 'home', icon: 'house' as const, text: binding.homeName }] : []),
                ...(updating ? [{ key: 'updating', text: t('homeGovernance.updating'), testID: 'home-admin-updating' }] : []),
            ] : undefined}
        />
    );
    const plainHeader = renderPlainHeader();
    // Where the console rail is not beside the page, its pages are a menu above the header.
    const consoleMenu = <HomeConsoleMenu serverId={props.serverId} />;
    const conditionPage = (condition: React.ReactNode) => (
        <ItemList>
            {consoleMenu}
            {plainHeader}
            {condition}
        </ItemList>
    );

    if (binding.kind === 'resolving') {
        return conditionPage(
            <HomeAdministrationStateCard kind="loading" title={t('homeGovernance.loading')} testID="home-admin-resolving" />,
        );
    }

    if (binding.kind === 'unknown_home') {
        return conditionPage(
            <HomeAdministrationStateCard
                kind="unavailable"
                title={t('homeGovernance.unavailableTitle')}
                body={t('homeGovernance.notObservedBody')}
                testID="home-admin-unknown-home"
            />,
        );
    }

    if (binding.kind === 'signed_out') {
        // Being signed out is a fact about this device, not a refusal by the
        // Home. Saying "you may not administer this Home" here would be wrong
        // and would send someone looking for authority they may already have.
        return conditionPage(
            <HomeAdministrationStateCard
                kind="unavailable"
                title={t('homeGovernance.signedOutTitle')}
                body={t('homeGovernance.signedOutBody')}
                testID="home-admin-signed-out"
            />,
        );
    }

    if (binding.kind === 'credential_unreadable') {
        return conditionPage(
            <HomeCredentialUnreadableCard serverId={binding.serverId} testID="home-admin-credential-unreadable" />,
        );
    }

    const { state, homeName } = binding;

    if (state.kind === 'unobserved' || state.kind === 'loading') {
        return conditionPage(
            <HomeAdministrationStateCard kind="loading" title={t('homeGovernance.loading')} testID="home-admin-loading" />,
        );
    }

    if (state.kind === 'setup_required') {
        // An ownerless Home has one thing to do (lab `hcClaim-N`): the page is that Home, and claiming it.
        return (
            <ItemList>
                {consoleMenu}
                <PageHeader
                    testID="home-admin-page-header"
                    // Named on phones too, as the owned Overview is: the phone header is only the way back.
                    alwaysShowTitle
                    title={homeName}
                    description={t('homeGovernance.claim.pageDescription')}
                />
                <HomeClaimSetup scope={binding.scope} homeName={homeName} requestApproval={requestApproval} />
            </ItemList>
        );
    }

    if (state.kind === 'unavailable') {
        // `forbidden` and `unauthorized` are the Home's settled answers about
        // this Account, and `unsupported` is its settled answer about itself.
        // None of them is offered a retry that would ask the same question again.
        const denied = state.error.kind === 'forbidden' || state.error.kind === 'unauthorized';
        const unsupported = state.error.kind === 'unsupported';
        return conditionPage(
            <HomeAdministrationStateCard
                kind={denied || unsupported ? 'unavailable' : 'error'}
                title={denied ? t('homeGovernance.forbiddenTitle') : t('homeGovernance.unavailableTitle')}
                body={denied
                    ? props.forbiddenBody ?? t('homeGovernance.forbiddenBody')
                    : unsupported
                        ? t('homeGovernance.unsupportedBody')
                        : t('homeGovernance.unavailableBody')}
                action={state.retryable ? { label: t('homeGovernance.retry'), onPress: retry } : undefined}
                testID="home-admin-unavailable"
            />,
        );
    }

    const context: HomeAdministrationContext = {
        scope: state.scope,
        credentialLifetime: binding.lifetime,
        homeName,
        projection: state.projection,
        mutationsAvailable: state.mutationsAvailable && !approvalPending,
        approvalPending,
        requestApproval,
        refresh: retry,
        captureDestructiveTarget,
    };

    const header = (
        <>
            {props.childRendersHeader
                ? null
                : props.renderHeader
                    ? props.renderHeader(context)
                    : props.pageActions ? renderPlainHeader(props.pageActions(context)) : plainHeader}
            {approvalId ? (
                <AttentionBanner
                    testID="home-admin-approval"
                    tone="neutral"
                    title={t('approvals.title')}
                    description={approvalError
                        ? t('approvals.loadError')
                        : approvalLoading || isApprovalRequestV2InFlightStatus(approvalStatus)
                            ? t('approvals.status.open')
                            : undefined}
                    accessibilityLiveRegion={approvalError ? 'assertive' : 'polite'}
                    action={{
                        label: t('approvals.details'),
                        onPress: () => router.push(`/inbox/approvals/${encodeURIComponent(approvalId)}?serverId=${encodeURIComponent(props.serverId)}`),
                    }}
                />
            ) : null}
            {/* Retained content stays on screen; the reason it may be behind is
                stated once, at the top, rather than disabling the whole view. */}
            {state.readFailed ? (
                <AttentionBanner
                    testID="home-admin-stale"
                    title={state.error ? t('homeGovernance.offlineNotice') : t('homeGovernance.refreshing')}
                    // How old the retained state is, not only that it is
                    // old. A projection observed before this device could
                    // record when is shown without a manufactured time.
                    description={[
                        state.error ? null : t('homeGovernance.staleNotice'),
                        state.lastObservedAt === null
                            ? null
                            : t('homeGovernance.lastUpdated', {
                                time: formatAsOfTime(state.lastObservedAt),
                            }),
                    ].filter((part): part is string => part !== null).join(' ') || undefined}
                    accessibilityLiveRegion="polite"
                    action={{ label: t('homeGovernance.retry'), onPress: retry }}
                />
            ) : null}

            {state.projection.setupState === 'setup_required' ? (
                <HomeClaimSetup scope={state.scope} homeName={homeName} requestApproval={requestApproval} />
            ) : null}
        </>
    );

    // Section-local drafts, in-flight markers and errors belong to the exact
    // Home and Account they were entered for. Discarding them here is what keeps
    // each section from re-deriving that rule and eventually disagreeing about
    // it, and what stops a draft from being applied as a different Account.
    if (props.presentation === 'virtualized-list') {
        return (
            <React.Fragment key={scopeKey}>
                {props.children(context, <>{consoleMenu}{header}</>)}
            </React.Fragment>
        );
    }

    return (
        <ItemList>
            {consoleMenu}
            {props.childRendersHeader ? null : header}

            <React.Fragment key={scopeKey}>
                {props.childRendersHeader ? props.children(context, header) : props.children(context)}
            </React.Fragment>
        </ItemList>
    );
});
