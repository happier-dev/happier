import * as React from 'react';
import { isHappierCloudServerUrl } from '@happier-dev/cli-common/happierCloud';
import { usePendingTerminalConnect } from '@/hooks/session/usePendingTerminalConnect';

import type { AccountServiceEntryOptions } from '@/components/account/auth/useAccountServiceEntryOptions';
import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import { readAccountServiceDisplayName } from '@/components/account/auth/accountServiceDisplayName';
import { createVerifiedAccountServiceAuthority } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import { onboardingAuthHistoryState, useLastSignInMethod } from '@/sync/domains/state/onboardingUiState';
import { formatAccountServiceHost } from '@/sync/domains/accountDirectory/accountDirectoryEndpoint';
import { canonicalizeServerUrl, createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { t } from '@/text';
import { presentUseServiceAsHomeSheet } from '@/components/homes/journeys/serviceHome/UseServiceAsHomeSheet';
import { resolveReverseQrTargetProfileId } from '@/components/onboarding/restore/loginWays';
import { usePublishFirstOpenWelcomeModel } from '@/components/onboarding/firstOpen/FirstOpenWelcomeModelContext';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { readOrganizationPolicyFieldState } from '@/components/organizationPolicy/OrganizationPolicyFieldNotice';
import { getOrganizationPolicyFieldLock, readOrganizationPolicy } from '@/sync/domains/organizationPolicy/organizationPolicy';
import { useReturningGreeting } from './useReturningGreeting';
import type { WelcomeActionAdmission } from './WelcomeActionList';
import { WelcomeEntryView } from './WelcomeEntryView';
import { CHOOSE_ANOTHER_SERVICE_TEST_ID, projectWelcomeEntryViewModel, type WelcomeEntryViewModel } from './welcomeEntryViewModel';
import {
    composeWelcomeEntryModel,
    type WelcomeAuthenticationMethod,
} from './composeWelcomeEntryModel';

export type WelcomeDecisionPanelProps = Readonly<{
    authEntryOptions: AuthEntryOptions;
    /** A setup/authentication parent can supply the task's heading. */
    showGreeting?: boolean;
    /** The Approve step uses the same admitted catalog for its alternative ways in. */
    restoreWays?: boolean;
    /** Keep the last waiting presentation inert while the requester adopts credentials. */
    restoreApprovalVisible?: boolean;
    onLeaveRestore?: () => void;
    onOpenTerminalLink?: () => void;
    /** Marks Approve puts first on the ways row (Back on a computer, the recovery key). */
    waysLeading?: React.ReactNode;
    /**
     * Advertised methods of the exact effective sign-in service. These remain additive to any
     * usable Home methods and never retarget the Home authority.
     */
    accountServiceEntry?: AccountServiceEntryOptions;
    onContinueWithAccountServiceProvider?: (request: WelcomeAuthenticationMethod) => Promise<void> | void;
    /** Key sign-in on the selected sign-in service. Never touches the focused Home. */
    onContinueWithAccountServiceKey?: (request: WelcomeAuthenticationMethod) => Promise<void> | void;
    onChooseAccountService?: () => Promise<void> | void;
    onContinueWithHomeAuthentication?: (request: WelcomeAuthenticationMethod, emailProvision?: WelcomeAuthenticationMethod) => Promise<void> | void;
    onOpenRestore: () => void;
    onOpenSecretKeyLogin?: () => void;
    onChangeRelay: () => void;
    canChangeHome?: boolean;
    canScanQr?: boolean;
    canCreatePersonalHome?: boolean;
    onCreatePersonalHome?: () => void;
    /**
     * "Connect to a Home directly" (phone doorway and every width): the wizard's own step for it. Absent
     * when setup policy does not allow adding a Home by its address, and the way in is left out.
     */
    onConnectHomeDirectly?: () => void;
}>;

export const WelcomeDecisionPanel = React.memo(function WelcomeDecisionPanel(props: WelcomeDecisionPanelProps) {
    const homePolicy = readOrganizationPolicyFieldState('home');
    const servicePolicy = readOrganizationPolicyFieldState('accountService');
    const options = props.authEntryOptions;
    // welcome-1115 r2: the wide panel reads its intro at the reading size with a s24 step to the doors; a phone
    // column is tighter (40 px headline, body-size intro, s10 and s16 steps).
    const compactViewport = useViewportClass() === 'compact';
    // The success of this visit belongs to the next Welcome. Keep this greeting through the Home hand-off.
    const [hasCompletedAuth] = React.useState(() => onboardingAuthHistoryState.read('completed') === true);
    const lastSignInMethodId = useLastSignInMethod();
    // A terminal link hands off to sign-in here: the heading says what signing in is for, for as
    // long as that link can still be approved. The pairing's own expiry decides, not a second clock.
    const pendingTerminal = usePendingTerminalConnect(props.showGreeting !== false);
    const terminalWaiting = pendingTerminal !== null;
    const activeActionIdRef = React.useRef<string | null>(null);
    const [pendingActionId, setPendingActionId] = React.useState<string | null>(null);
    const runAction = React.useCallback(async (actionId: string, action: () => Promise<void> | void) => {
        if (activeActionIdRef.current !== null) return;
        activeActionIdRef.current = actionId;
        setPendingActionId(actionId);
        try {
            await action();
        } finally {
            if (activeActionIdRef.current === actionId) {
                activeActionIdRef.current = null;
                setPendingActionId(null);
            }
        }
    }, []);
    const actionAdmission = React.useMemo<WelcomeActionAdmission>(() => ({
        pendingActionId,
        run: runAction,
    }), [pendingActionId, runAction]);
    const accountServiceEntry = props.accountServiceEntry;
    const requestedHomeTarget = options.requestedHomeTarget;
    const homeTarget = options.homeTarget;
    const customHomeUrl = requestedHomeTarget && !isHappierCloudServerUrl(options.serverUrlForCopy)
        ? canonicalizeServerUrl(options.serverUrlForCopy) : null;
    // A build without a default Home has nothing to report on: status lines about "this Home" would
    // describe a Home nobody chose.
    const hasHome = homeTarget != null && options.serverUrlForCopy.trim().length > 0;
    const homeMethods: WelcomeAuthenticationMethod[] = homeTarget
        && options.showAuthActions
        && props.onContinueWithHomeAuthentication
        && (options.serverAvailability === 'ready' || options.serverAvailability === 'legacy')
        ? (options.authenticationActions ?? []).map(({ method, action, execution }) => ({
            method, action, execution,
            authority: { purpose: 'home' as const, target: homeTarget },
            intendedHome: homeTarget,
        })) : [];
    const discovery = accountServiceEntry?.status === 'ready' ? accountServiceEntry.discovery : null;
    const serviceAuthority = discovery ? createVerifiedAccountServiceAuthority(discovery) : null;
    const serviceMethods: WelcomeAuthenticationMethod[] = discovery && serviceAuthority
        ? discovery.authenticationActions.filter(({ execution }) => (
            execution.kind === 'oauth'
                ? props.onContinueWithAccountServiceProvider != null
                : props.onContinueWithAccountServiceKey != null
        )).map(({ method, action, execution }) => ({ method, action, execution, authority: { purpose: 'account_service' as const, service: serviceAuthority }, intendedHome: requestedHomeTarget ?? null }))
        : [];
    const serviceName = accountServiceEntry?.endpoint ? readAccountServiceDisplayName({
        url: discovery?.endpointUrl ?? accountServiceEntry.endpoint.url,
        serverIdentityId: discovery?.serverIdentityId ?? accountServiceEntry.endpoint.serverIdentityId,
        savedName: accountServiceEntry.endpoint.displayName,
        advertisedName: discovery?.accountServiceDisplayName,
    }) ?? formatAccountServiceHost(discovery?.endpointUrl ?? accountServiceEntry.endpoint.url) : null;
    const serviceCatalogState = accountServiceEntry?.status === 'ready'
        ? serviceMethods.length > 0 && serviceAuthority
            ? { kind: 'ready' as const, authority: serviceAuthority, name: serviceName ?? t('welcome.yourSignInService'), methods: serviceMethods }
            : { kind: 'methodless' as const, hintName: serviceName ?? undefined }
        : accountServiceEntry?.status === 'loading'
            ? { kind: 'loading' as const, hintName: serviceName ?? undefined }
            : accountServiceEntry?.status === 'unavailable'
                ? { kind: 'unavailable' as const, hintName: serviceName ?? undefined }
                : accountServiceEntry?.status === 'unsupported'
                    ? { kind: 'unsupported' as const, hintName: serviceName ?? undefined }
                    : { kind: 'not_offered' as const };
    // Only the first load holds the primary door's place; a retry keeps the form it last settled into.
    const catalogSettled = React.useRef(false);
    const catalogLoading = (homeTarget != null && options.serverAvailability === 'loading')
        || accountServiceEntry?.status === 'loading';
    if (!catalogLoading) catalogSettled.current = true;
    const catalogFirstLoad = catalogLoading && !catalogSettled.current;
    const heldRestoreView = React.useRef<WelcomeEntryViewModel | null>(null);
    const approving = props.restoreWays === true && props.restoreApprovalVisible === true;
    const frozenView = approving ? heldRestoreView.current : null;
    const model = frozenView ? null : composeWelcomeEntryModel({
        target: accountServiceEntry?.selectedInWelcome
            ? { kind: 'selected_service', label: serviceName ?? t('welcome.yourSignInService') }
            : requestedHomeTarget
                ? { kind: 'selected_home', home: requestedHomeTarget, label: options.homeLabel ?? t('settingsAccount.thisHomeTitle') }
                : accountServiceEntry?.endpoint.source === 'user'
                    ? { kind: 'selected_service', label: serviceName ?? formatAccountServiceHost(accountServiceEntry.endpoint.url) }
                    : { kind: 'none' },
        homeMethods,
        catalogFirstLoad,
        homePairingAvailable: options.homePairingAvailable,
        selectedHomeAddress: customHomeUrl ? new URL(customHomeUrl).host : undefined,
        ...(homeTarget && homeMethods.length > 0 && accountServiceEntry
            && createServerUrlComparableKey(accountServiceEntry.endpoint.url) === createServerUrlComparableKey(options.serverUrlForCopy)
            && (!accountServiceEntry.endpoint.serverIdentityId || accountServiceEntry.endpoint.serverIdentityId === options.observedHomeServerIdentityId)
            ? { observedHomeAtServiceEndpoint: { home: homeTarget, label: options.homeLabel ?? t('settingsAccount.thisHomeTitle') } } : {}),
        ...(options.observedHomeServerIdentityId ? { observedHomeServerIdentityId: options.observedHomeServerIdentityId } : {}),
        context: { kind: props.restoreWays ? 'restore' : 'home' },
        terminalWaiting,
        allowedNavigation: {
            // A Home or sign-in service fixed by the organization policy is shown as the managed
            // value; the ways to pick another are left out rather than offered dead.
            changeHome: props.canChangeHome !== false && !homePolicy.disabled,
            selectService: props.onChooseAccountService != null && (props.restoreWays === true || !servicePolicy.disabled),
            // Camera support controls how the restore surface starts, not
            // whether it exists: every client can paste a Home link.
            scanOrPasteHome: !homePolicy.disabled,
            openTerminalLink: props.onOpenTerminalLink != null,
            createPersonalHome: props.canCreatePersonalHome === true && props.onCreatePersonalHome != null,
        },
        serviceCatalogState,
        userHistory: hasCompletedAuth ? 'returning' : 'first_time',
        placement: {
            hasHome,
            canConnectDirectly: props.onConnectHomeDirectly != null,
            platform: compactViewport ? 'phone' : 'computer',
            canScanQr: props.canScanQr === true,
            canShowQr: compactViewport && resolveReverseQrTargetProfileId() !== null,
            ...(discovery && serviceName ? { serviceHome: { name: serviceName, url: discovery.endpointUrl } } : {}),
        },
        lastSignInMethodId,
    });
    const returningGreeting = useReturningGreeting({ besideLogin: model?.hasLoginDoor ?? false });
    const policyField = homePolicy.lock ? 'home' : servicePolicy.lock ? 'accountService' : 'personalHome';
    const policyLock = homePolicy.lock ?? servicePolicy.lock ?? getOrganizationPolicyFieldLock('personalHome');
    const viewModel = model ? projectWelcomeEntryViewModel(model, {
        options,
        showGreeting: !props.restoreWays && props.showGreeting !== false,
        terminalWaiting,
        returningGreeting,
        hasHome,
        serviceName,
        canRetryService: accountServiceEntry != null,
        policy: props.restoreWays ? undefined : policyLock ? {
            kind: 'managed',
            field: policyField,
            display: { organization: policyLock.organization, hasSupport: Boolean(policyLock.supportUrl) },
        } : readOrganizationPolicy().status === 'invalid' ? { kind: 'invalid' } : undefined,
        canChooseService: props.onChooseAccountService != null,
    }) : frozenView;
    React.useLayoutEffect(() => {
        if (props.restoreWays && !approving) heldRestoreView.current = viewModel;
    }, [approving, props.restoreWays, viewModel]);
    usePublishFirstOpenWelcomeModel(props.restoreWays ? null : viewModel);

    if (!viewModel) return null;
    if (approving || !model) {
        return <WelcomeEntryView model={viewModel} compact={compactViewport} waysLeading={props.waysLeading} />;
    }

    const onAction = (index: number) => {
        const action = model.actions[index]?.action;
        if (action) props.onLeaveRestore?.();
        switch (action?.kind) {
            case 'scan_or_paste_home': return props.onOpenRestore();
            case 'choose_home': return model.chooseHomeDestination === 'picker'
                ? props.onChangeRelay() : props.onConnectHomeDirectly?.();
            case 'choose_sign_in_service': return props.onChooseAccountService?.();
            case 'open_terminal_link': return props.onOpenTerminalLink?.();
            case 'create_personal_home': return props.onCreatePersonalHome?.();
            case 'use_service_as_home':
                presentUseServiceAsHomeSheet({ serviceName: action.name, serviceUrl: action.url });
                return;
            case 'authenticate': {
                const request = action.request;
                if (request.authority.purpose === 'home') return 'emailProvision' in action && action.emailProvision
                    ? props.onContinueWithHomeAuthentication?.(request, action.emailProvision)
                    : props.onContinueWithHomeAuthentication?.(request);
                return request.execution.kind === 'oauth'
                    ? props.onContinueWithAccountServiceProvider?.(request)
                    : props.onContinueWithAccountServiceKey?.(request);
            }
        }
    };
    const onNoticeAction = (testID: string) => {
        if (testID === CHOOSE_ANOTHER_SERVICE_TEST_ID) void props.onChooseAccountService?.();
        else if (testID === 'welcome-account-service-retry') accountServiceEntry?.retry();
        else options.retryServerCheck();
    };
    return <WelcomeEntryView model={viewModel} compact={compactViewport} waysLeading={props.waysLeading} interaction={{
        admission: actionAdmission,
        getActionId: (index) => model.actions[index]?.id,
        onAction,
        onNoticeAction,
        onSelfHosting: props.onChangeRelay,
        onRetryRetention: options.retentionDisclosure?.kind === 'unreadable' ? options.retentionDisclosure.retry : undefined,
        policySupportUrl: policyLock?.supportUrl,
    }} />;
});
