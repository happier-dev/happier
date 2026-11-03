import { OrganizationPolicyDiagnostic, OrganizationPolicyFieldNotice } from '@/components/organizationPolicy/OrganizationPolicyFieldNotice';
import * as React from 'react';
import { accountDirectoryAuthClient, createVerifiedAccountServiceAuthority, type AccountDirectoryAuthMethodDiscovery, type AccountDirectoryAuthTransport } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import { AccountServiceAuthenticationFlow } from '@/components/account/auth/AccountServiceAuthenticationFlow';
import type { AccountDirectoryKeyLoginOutcome } from '@/components/account/auth/AccountDirectoryKeyLoginForm';
import { AccountServiceContinuation } from '@/components/account/auth/AccountServiceContinuation';
import { useAccountServiceDisplayName } from '@/components/account/auth/accountServiceDisplayName';
import { AccountServiceHomeAuthenticationAdapter } from '@/components/account/auth/AccountServiceHomeAuthenticationAdapter';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { consumeAccountServiceOAuthReturn } from '@/sync/ops/accountDirectory/consumeAccountServiceOAuthReturn';
import { isCompletedAccountPostAuthResult, shouldDismissAccountPostAuthContinuation, type AccountPostAuthInput, type AccountPostAuthResult, type CompletedAccountPostAuthResult } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';

import { AUTHENTICATED_ACCOUNT_ENTRY_ROUTE, type AuthenticatedAccountEntryRequest } from './authenticatedAccountEntryRoute';

type State =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'unavailable' }>
    | Readonly<{ kind: 'organization_policy_locked' }>
    | Readonly<{ kind: 'organization_policy_invalid' }>
    | Readonly<{ kind: 'methods'; discovery: AccountDirectoryAuthMethodDiscovery; intent: AccountPostAuthInput['intent'] }>
    | Readonly<{ kind: 'continuation'; input: AccountPostAuthInput; result: AccountPostAuthResult }>
    | Readonly<{ kind: 'home_auth'; input: AccountPostAuthInput; previous: AccountPostAuthResult; homeServerIdentityId: string }>;

export type AccountEntryFlowStage = State['kind'];

export type AccountEntryFlow = Readonly<{
    stage: AccountEntryFlowStage;
    /** The service's name from its one name owner (or "your sign-in service"). */
    serviceName: string;
    content: React.ReactNode;
    /** Leaves the flow (aborting any in-flight step) for the request's `returnTo`. */
    exit: () => void;
}>;

type RouteParams = Readonly<Record<string, string | string[] | undefined>>;

const NO_ROUTE_PARAMS: RouteParams = Object.freeze({});

// The key-login form reports its own non-authenticated outcomes alongside the
// post-auth results; only the shared dismissal rule exits immediately.
function isTerminalResult(result: AccountDirectoryKeyLoginOutcome): result is CompletedAccountPostAuthResult {
    return isCompletedAccountPostAuthResult(result) && shouldDismissAccountPostAuthContinuation(result);
}

/**
 * Signing in to an account service while already in a Home: its advertised methods, the
 * post-auth continuation (`completeAccountServicePostAuth`) and a Home's own sign-in when the
 * continuation asks for it. The one owner of that sequence; the `/homes/sign-in`
 * route frames it in the wizard shell, and "Already use Happier?" hosts it in place on Home.
 *
 * `routeParams` are the route's own params, where an OAuth return lands (OAuth always returns to
 * the account-entry route). An in-place host passes none: it only ever starts a sign-in.
 */
export function useAccountEntryFlow(props: Readonly<{
    request: AuthenticatedAccountEntryRequest;
    routeParams?: RouteParams;
    transport?: AccountDirectoryAuthTransport;
    /** Completed post-auth result is present only after success; Back supplies no completion. */
    onExit: (returnTo: string, completion?: CompletedAccountPostAuthResult) => void;
}>): AccountEntryFlow {
    const routeParams = props.routeParams ?? NO_ROUTE_PARAMS;
    const [retryGeneration, setRetryGeneration] = React.useState(0);
    const [state, setState] = React.useState<State>({ kind: 'loading' });
    const operationSequenceRef = React.useRef(0);
    const activeOperationRef = React.useRef(0);
    const recoveryAbortRef = React.useRef<AbortController | null>(null);
    // Hosts pass an inline onExit; reading the latest one keeps the consume
    // effect (whose cleanup aborts a visible continuation) off its identity.
    const onExitRef = React.useRef(props.onExit);
    React.useLayoutEffect(() => {
        onExitRef.current = props.onExit;
    });
    const exit = React.useCallback(() => {
        recoveryAbortRef.current?.abort();
        onExitRef.current(props.request.returnTo);
    }, [props.request.returnTo]);
    const completeAndExit = React.useCallback((result: CompletedAccountPostAuthResult) => {
        recoveryAbortRef.current?.abort();
        onExitRef.current(props.request.returnTo, result);
    }, [props.request.returnTo]);
    // expo-router hands out a fresh params object on every render. The return is
    // keyed on its marker value; the latest object is read only when consuming.
    const routeParamsRef = React.useRef(routeParams);
    React.useLayoutEffect(() => {
        routeParamsRef.current = routeParams;
    });
    const accountServiceReturn = typeof routeParams.accountServiceReturn === 'string'
        ? routeParams.accountServiceReturn
        : undefined;

    React.useEffect(() => () => recoveryAbortRef.current?.abort(), []);

    React.useEffect(() => {
        const operation = ++operationSequenceRef.current;
        activeOperationRef.current = operation;
        const controller = new AbortController();
        recoveryAbortRef.current?.abort();
        recoveryAbortRef.current = controller;
        setState({ kind: 'loading' });
        void (async () => {
            const returned = await consumeAccountServiceOAuthReturn(routeParamsRef.current, {
                invokingSurface: AUTHENTICATED_ACCOUNT_ENTRY_ROUTE,
                signal: controller.signal,
                transport: props.transport,
            });
            if (controller.signal.aborted || operation !== activeOperationRef.current) return;
            if (returned.kind === 'retryable') {
                setState({ kind: 'unavailable' });
                return;
            }
            // `invalid` is a consumed or unrecognised one-shot return (a reload
            // after custody was claimed). Retrying the same params can never
            // succeed, so it falls through to read-only discovery exactly like
            // `absent`, inferring no link, enrollment or focus from them.
            if (returned.kind === 'consumed') {
                if (isTerminalResult(returned.result)) {
                    completeAndExit(returned.result);
                    return;
                }
                setState({ kind: 'continuation', input: returned.input, result: returned.result });
                return;
            }
            const discovery = await accountDirectoryAuthClient.discoverAuthenticationMethods({
                endpointUrl: props.request.service.endpointUrl,
                expectedServerIdentityId: props.request.service.serverIdentityId,
                ...props.transport,
                signal: controller.signal,
            });
            if (controller.signal.aborted || operation !== activeOperationRef.current) return;
            if (discovery.kind !== 'supported_account_service') {
                setState({ kind: discovery.kind === 'organization_policy_locked' || discovery.kind === 'organization_policy_invalid'
                    ? discovery.kind : 'unavailable' });
                return;
            }
            setState({ kind: 'methods', discovery, intent: props.request.intent });
        })().catch(() => {
            if (!controller.signal.aborted && operation === activeOperationRef.current) setState({ kind: 'unavailable' });
        });
        return () => {
            controller.abort();
            if (activeOperationRef.current === operation) activeOperationRef.current = 0;
        };
    }, [accountServiceReturn, completeAndExit, props.request, props.transport, retryGeneration]);

    const showExactServiceMethods = React.useCallback(async (input: AccountPostAuthInput) => {
        recoveryAbortRef.current?.abort();
        const controller = new AbortController();
        recoveryAbortRef.current = controller;
        const operation = ++operationSequenceRef.current;
        activeOperationRef.current = operation;
        setState({ kind: 'loading' });
        try {
            const discovery = await accountDirectoryAuthClient.discoverAuthenticationMethods({
                endpointUrl: input.service.endpointUrl,
                expectedServerIdentityId: input.service.serverIdentityId,
                ...props.transport,
                signal: controller.signal,
            });
            if (controller.signal.aborted || operation !== activeOperationRef.current) return;
            if (discovery.kind !== 'supported_account_service') {
                setState({ kind: discovery.kind === 'organization_policy_locked' || discovery.kind === 'organization_policy_invalid'
                    ? discovery.kind : 'unavailable' });
                return;
            }
            setState({ kind: 'methods', discovery, intent: input.intent });
        } catch {
            if (!controller.signal.aborted && operation === activeOperationRef.current) setState({ kind: 'unavailable' });
        }
    }, [props.transport]);

    const discovery = state.kind === 'methods' ? state.discovery : null;
    const serviceName = useAccountServiceDisplayName({
        url: discovery?.endpointUrl ?? props.request.service.endpointUrl,
        serverIdentityId: discovery?.serverIdentityId ?? props.request.service.serverIdentityId,
        advertisedName: discovery?.accountServiceDisplayName,
    }) ?? t('welcome.yourSignInService');

    let content: React.ReactNode;
    if (state.kind === 'loading') {
        // Directory discovery, adoption, assertion mint and approval polling all
        // sit behind this one wait. The contract names it, so it is announced
        // rather than left as an unlabeled spinner.
        content = <SurfaceStateCard testID="authenticated-account-entry-loading" kind="loading"
            title={t('settingsAccount.accountServiceOAuth.stages.findingHomes')} accessibilitySemantics="status" />;
    } else if (state.kind === 'organization_policy_locked' || state.kind === 'organization_policy_invalid') {
        content = state.kind === 'organization_policy_locked'
            ? <OrganizationPolicyFieldNotice field="accountService" />
            : <OrganizationPolicyDiagnostic />;
    } else if (state.kind === 'unavailable') {
        content = <SurfaceStateCard testID="authenticated-account-entry-unavailable" kind="error" title={t('welcome.signInServiceUnavailableTitle')}
            reason={t('settingsAccount.accountServiceDiscoveryUnavailableDescription')} accessibilitySemantics="alert"
            action={{ label: t('common.retry'), onPress: () => setRetryGeneration((value) => value + 1) }} />;
    } else if (state.kind === 'home_auth') {
        content = <AccountServiceHomeAuthenticationAdapter
            input={state.input}
            previous={state.previous}
            homeServerIdentityId={state.homeServerIdentityId}
            returnTo={AUTHENTICATED_ACCOUNT_ENTRY_ROUTE}
            accountEntryReturnTo={props.request.returnTo}
            onResult={async (result) => {
                if (isTerminalResult(result)) {
                    completeAndExit(result);
                    return;
                }
                setState({ kind: 'continuation', input: state.input, result });
            }}
            onBack={() => setState({ kind: 'continuation', input: state.input, result: state.previous })}
        />;
    } else if (state.kind === 'continuation') {
        const currentResult = state.result;
        content = <AccountServiceContinuation input={state.input} result={state.result}
            onResult={async (result, input) => {
                if (isTerminalResult(result)) {
                    completeAndExit(result);
                    return;
                }
                setState({ kind: 'continuation', input: input ?? state.input, result });
            }} onReauthenticate={showExactServiceMethods}
            onOpenHomeAuthentication={(input, homeServerIdentityId, previous) => {
                setState({ kind: 'home_auth', input, previous, homeServerIdentityId });
            }}
            onBack={isCompletedAccountPostAuthResult(currentResult) ? () => completeAndExit(currentResult) : exit} />;
    } else {
        content = <AccountServiceAuthenticationFlow service={{
            authority: createVerifiedAccountServiceAuthority(state.discovery),
            displayName: serviceName,
            authenticationActions: state.discovery.authenticationActions,
            transport: props.transport,
        }} intent={state.intent} returnTo={AUTHENTICATED_ACCOUNT_ENTRY_ROUTE}
            accountEntryReturnTo={props.request.returnTo}
            onResult={(result) => {
                if (isTerminalResult(result)) completeAndExit(result);
            }}
            onPostAuthContinuation={(input, result) => setState({ kind: 'continuation', input, result })}
            onReauthenticate={showExactServiceMethods}
            onOpenHomeAuthentication={(input, homeServerIdentityId, previous) => {
                setState({ kind: 'home_auth', input, previous, homeServerIdentityId });
            }}
            signal={recoveryAbortRef.current?.signal}
            onExternalAuthStarted={() => undefined} onBack={exit} isCurrent={() => activeOperationRef.current > 0} />;
    }

    return { stage: state.kind, serviceName, content, exit };
}
