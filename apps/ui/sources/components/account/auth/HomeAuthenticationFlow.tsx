import * as React from 'react';
import { AccountCredentialJourney } from './AccountCredentialJourney';
import { useRouter } from 'expo-router';
import type { HomeTargetInput } from '@happier-dev/cli-common/homeTarget';
import type { NativeAccountAdmissionV1 } from '@happier-dev/protocol';

import type { AccountDirectoryAuthTransport } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import type { HomeAuthenticationAction } from '@/auth/capabilities/authMethodCapabilities';
import { useAuth } from '@/auth/context/AuthContext';
import { executeHomeAuthentication, type ExecuteHomeAuthenticationOptions } from '@/auth/flows/executeHomeAuthentication';
import { resolveHomeAuthenticationTarget } from '@/auth/flows/resolveHomeAuthenticationTarget';
import { getAuthProvider } from '@/auth/providers/registry';
import { describeHomeAuthenticationAction } from '@/components/account/auth/homeAuthenticationActionPresentation';
import type { AccountHomeAuthenticationContinuation, AuthCredentials } from '@/auth/storage/tokenStorage';
import { SecretKeyLoginForm } from '@/components/account/restore/SecretKeyLoginForm';
import { EmailPasswordAuthPanel } from '@/components/account/auth/emailPassword/EmailPasswordAuthPanel';
import { completeEmailPasswordAuthentication } from '@/components/account/auth/emailPassword/completeEmailPasswordAuthentication';
import type { WelcomeAuthenticationMethod } from '@/components/onboarding/preAuth/composeWelcomeEntryModel';
import { WelcomeActionCard } from '@/components/onboarding/preAuth/WelcomeActionCard';
import { WelcomeActionList } from '@/components/onboarding/preAuth/WelcomeActionList';
import { ExactHomeDestinationNotice } from '@/components/account/auth/ExactHomeDestinationNotice';
import { useExactHomeArrival } from '@/components/account/auth/useExactHomeDestination';
import { t } from '@/text';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import {
    ACCOUNT_SECURITY_EMAIL_PASSWORD_CONNECT_INTENT,
    openAccountSecurityForHome,
} from '@/components/settings/account/openAccountSecurityForHome';

const homeActionTestId = ({ method, action }: HomeAuthenticationAction): string => `home-auth-${method.id}-${action.id}-${action.mode}`;

type HomeAuthenticationFlowProps = Readonly<{
    target: HomeTargetInput;
    actions: readonly HomeAuthenticationAction[];
    transport?: AccountDirectoryAuthTransport;
    keyChallengeV2Available?: boolean;
    returnTo: string;
    /** Optional Team entry context carried into the existing Home OAuth owner. */
    teamAdmission?: ExecuteHomeAuthenticationOptions['teamAdmission'];
    accountContinuation?: AccountHomeAuthenticationContinuation;
    /** Human label for the selected Home, used in native auth failure copy. */
    homeLabel?: string;
    /** Server-validated bounded admission bearer for native Account creation. */
    nativeAdmission?: NativeAccountAdmissionV1;
    /** Server-previewed transferable invitation; native creation must prove its submitted mailbox separately. */
    invitationEmailVerificationRequired?: boolean;
    /** Mailbox this journey already proved, so the panel never asks for it a second time. */
    initialEmail?: string;
    signal?: AbortSignal;
    /**
     * The caller's own page already chose this single action. A method with a
     * form opens it directly and a one-tap method runs on arrival, so the
     * person is never asked to pick the same method twice. Leaving the form
     * leaves the flow. The step that chose it owns the way back, so the flow
     * draws no Back control of its own.
     */
    openChosenAction?: boolean;
    onAuthenticated: (authenticatedHome: Readonly<{
        homeServerIdentityId: string;
        credentials: AuthCredentials;
        /** Present when native provisioning atomically completed Team admission. */
        teamId?: string | null;
    }>) => void | Promise<void>;
    onExternalAuthStarted?: () => void | Promise<void>;
    onBack: () => void;
}>;

export function HomeAuthenticationFlow(props: HomeAuthenticationFlowProps): React.ReactElement {
    const target = resolveHomeAuthenticationTarget(props.target);
    return <AccountCredentialJourney request={target && !props.accountContinuation && !props.nativeAdmission ? {
        kind: 'home', profileRef: target.serverId, returnTo: props.returnTo,
    } : null}><HomeAuthenticationFlowBody {...props} /></AccountCredentialJourney>;
}

function HomeAuthenticationFlowBody(props: HomeAuthenticationFlowProps): React.ReactElement {
    const auth = useAuth();
    const router = useRouter();
    const toRequest = ({ method, action, execution }: HomeAuthenticationAction): WelcomeAuthenticationMethod => ({
        method,
        action,
        execution,
        authority: { purpose: 'home', target: props.target },
        intendedHome: props.target,
    });
    const chosenAction = props.openChosenAction && props.actions.length === 1 ? props.actions[0]! : null;
    const [keyRequest, setKeyRequest] = React.useState<WelcomeAuthenticationMethod | null>(() => (
        chosenAction?.execution.kind === 'key_entry' ? toRequest(chosenAction) : null
    ));
    const [passwordRequest, setPasswordRequest] = React.useState<WelcomeAuthenticationMethod | null>(() => (
        chosenAction?.execution.kind === 'email_password' ? toRequest(chosenAction) : null
    ));
    const [pendingActionId, setPendingActionId] = React.useState<string | null>(null);
    const inFlightRef = React.useRef(false);
    const abortRef = React.useRef(new AbortController());
    React.useEffect(() => () => abortRef.current.abort(), []);
    const cancellation = React.useMemo(() => mergeAbortSignals([abortRef.current.signal, props.signal]), [props.signal]);
    React.useEffect(() => () => cancellation.dispose(), [cancellation]);
    const resolvedTarget = resolveHomeAuthenticationTarget(props.target);
    // Connect mounts Account Security on the exact Home it just authenticated
    // against, and that opener can genuinely fail to get there. Discarding its
    // answer would leave the sign-in form mounted over a Home this device is not
    // on, where the only thing left to press re-submits a credential that already
    // committed. The shared arrival owner holds that state and its retry instead.
    const arrival = useExactHomeArrival();
    const admission = React.useMemo(() => ({
        pendingActionId,
        run: async (actionId: string, action: () => Promise<void> | void) => {
            if (inFlightRef.current || cancellation.signal.aborted) return;
            inFlightRef.current = true;
            setPendingActionId(actionId);
            try { await action(); }
            finally {
                inFlightRef.current = false;
                if (!cancellation.signal.aborted) setPendingActionId(null);
            }
        },
    }), [cancellation.signal, pendingActionId]);

    // The one method-card -> action decision: a method with a form opens it, anything else runs now.
    const runHomeAction = async (homeAction: HomeAuthenticationAction): Promise<void> => {
        const { execution } = homeAction;
        const request = toRequest(homeAction);
        if (execution.kind === 'key_entry') {
            setKeyRequest(request);
            return;
        }
        if (execution.kind === 'email_password') {
            setPasswordRequest(request);
            return;
        }
        await executeHomeAuthentication({
            request,
            loginWithCredentials: auth.loginWithCredentials,
            returnTo: props.returnTo,
            transport: props.transport,
            keyChallengeV2Available: props.keyChallengeV2Available,
            accountContinuation: props.accountContinuation,
            teamAdmission: props.teamAdmission,
            signal: cancellation.signal,
            onAuthenticated: props.onAuthenticated,
            onExternalAuthStarted: props.onExternalAuthStarted,
        });
    };
    // A chosen one-tap action is already the person's decision, so it runs on arrival through
    // the same admission as its card. The card stays as the retry if the run does not finish.
    const arrivalRunRef = React.useRef(false);
    React.useEffect(() => {
        if (!chosenAction || keyRequest || passwordRequest || arrivalRunRef.current) return;
        arrivalRunRef.current = true;
        void admission.run(homeActionTestId(chosenAction), () => runHomeAction(chosenAction));
        // eslint-disable-next-line react-hooks/exhaustive-deps -- arrival runs once for the chosen action
    }, []);

    const leave = () => { abortRef.current.abort(); props.onBack(); };

    if (arrival.state.kind !== 'idle') {
        const arrivalState = arrival.state;
        return <WelcomeActionList admission={admission}>
            <ExactHomeDestinationNotice testID="home-auth-destination-home" state={arrivalState} />
            <WelcomeActionCard testID="home-auth-destination-back" title={t('common.back')} iconName="arrow-left" escape
                onPress={() => { abortRef.current.abort(); props.onBack(); }} />
        </WelcomeActionList>;
    }

    if (keyRequest && resolvedTarget) {
        return <WelcomeActionList admission={admission}>
            <SecretKeyLoginForm embedded returnTo={props.returnTo} target={{
                ...resolvedTarget,
                ...(props.transport?.runtimeOrigin ? { runtimeOrigin: props.transport.runtimeOrigin } : {}),
                ...(props.transport?.homeCarrier ? { homeCarrier: props.transport.homeCarrier } : {}),
                signal: cancellation.signal,
                requireKeyChallengeV2: props.keyChallengeV2Available === true,
                ...(props.teamAdmission?.invitationToken
                    ? { admission: { kind: 'team_invitation' as const, token: props.teamAdmission.invitationToken } }
                    : {}),
            }} onAuthenticated={async (credentials) => {
                if (cancellation.signal.aborted) return;
                await props.onAuthenticated({ homeServerIdentityId: resolvedTarget.serverIdentityId, credentials });
            }} onSuccess={() => {}} />
            {chosenAction ? null : (
                <WelcomeActionCard testID="home-auth-key-back" title={t('common.back')} iconName="arrow-left" escape
                    onPress={() => setKeyRequest(null)} />
            )}
        </WelcomeActionList>;
    }

    if (passwordRequest && resolvedTarget && passwordRequest.execution.kind === 'email_password') {
        const execution = passwordRequest.execution;
        return <WelcomeActionList admission={admission}>
            <EmailPasswordAuthPanel
                returnTo={props.returnTo}
                target={{
                    ...resolvedTarget,
                    ...(props.transport?.runtimeOrigin ? { runtimeOrigin: props.transport.runtimeOrigin } : {}),
                    ...(props.transport?.homeCarrier ? { homeCarrier: props.transport.homeCarrier } : {}),
                }}
                recoveryTarget={resolvedTarget.serverIdentityId}
                action={execution.action}
                mode={execution.mode}
                {...(execution.recommendedProvisionMode ? { recommendedProvisionMode: execution.recommendedProvisionMode } : {})}
                {...(execution.passwordReset ? { passwordReset: execution.passwordReset } : {})}
                {...(props.homeLabel ? { homeLabel: props.homeLabel } : {})}
                {...(props.nativeAdmission ? { admission: props.nativeAdmission } : {})}
                {...(props.initialEmail ? { initialEmail: props.initialEmail } : {})}
                invitationEmailVerificationRequired={props.invitationEmailVerificationRequired === true}
                signal={cancellation.signal}
                onAuthenticated={async (outcome) => {
                    await completeEmailPasswordAuthentication({
                        outcome,
                        target: {
                            serverUrl: resolvedTarget.canonicalServerUrl,
                            serverId: resolvedTarget.serverId ?? resolvedTarget.serverIdentityId,
                        },
                        signal: cancellation.signal,
                        loginWithCredentials: auth.loginWithCredentials,
                        onCompleted: async () => {
                            if (execution.action === 'connect') {
                                const serverId = resolvedTarget.serverId ?? resolvedTarget.serverIdentityId;
                                await arrival.continueThrough(async () => await openAccountSecurityForHome({
                                    serverId,
                                    router,
                                    refreshAuth: auth.refreshFromActiveServer,
                                    intent: ACCOUNT_SECURITY_EMAIL_PASSWORD_CONNECT_INTENT,
                                }));
                                return;
                            }
                            await props.onAuthenticated({
                                homeServerIdentityId: resolvedTarget.serverIdentityId,
                                credentials: outcome.credentials,
                                ...(outcome.teamId !== undefined ? { teamId: outcome.teamId } : {}),
                            });
                        },
                    });
                }}
                onBack={() => chosenAction ? leave() : setPasswordRequest(null)}
                // The caller's step already carries the way back, so the form adds none of its own.
                showBackAction={chosenAction === null}
            />
        </WelcomeActionList>;
    }

    return <WelcomeActionList admission={admission}>
        {props.actions.map((homeAction) => {
            const { method, execution } = homeAction;
            const providerName = method.presentation?.displayName ?? getAuthProvider(method.id)?.displayName ?? method.id;
            const testID = homeActionTestId(homeAction);
            const presentation = describeHomeAuthenticationAction({ execution, providerName });
            // A chosen action is the one thing this step is for.
            return <WelcomeActionCard key={testID} testID={testID} title={presentation.title} primary={chosenAction !== null}
                subtitle={presentation.description} iconName={presentation.iconName} accentColor={method.presentation?.connectButtonColor}
                onPress={() => runHomeAction(homeAction)} />;
        })}
        {chosenAction ? null : (
            <WelcomeActionCard testID="home-auth-back" title={t('common.back')} iconName="arrow-left" escape
                onPress={() => { abortRef.current.abort(); props.onBack(); }} />
        )}
    </WelcomeActionList>;
}
