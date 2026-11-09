import * as React from 'react';
import type { AccountContinuationIntent } from '@happier-dev/cli-common/accountService';

import type { AccountDirectoryAuthenticationAction, AccountDirectoryAuthTransport, VerifiedAccountServiceAuthority } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import { WelcomeActionCard } from '@/components/onboarding/preAuth/WelcomeActionCard';
import { WelcomeActionList } from '@/components/onboarding/preAuth/WelcomeActionList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { AccountDirectoryKeyLoginForm, type AccountDirectoryKeyLoginOutcome } from './AccountDirectoryKeyLoginForm';
import { t } from '@/text';
import { describeAccountServiceAuthenticationAction, launchAccountServiceOAuthAuthentication } from './accountServiceAuthenticationActions';
import type { AccountPostAuthInput, AccountPostAuthResult } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';

export type AccountServiceAuthenticationFlowProps = Readonly<{
    service: Readonly<{
        authority: VerifiedAccountServiceAuthority;
        displayName: string;
        authenticationActions: readonly AccountDirectoryAuthenticationAction[];
        transport?: AccountDirectoryAuthTransport;
    }>;
    intent: AccountContinuationIntent;
    returnTo: string;
    accountEntryReturnTo?: string;
    onResult: (result: AccountDirectoryKeyLoginOutcome) => Promise<void> | void;
    /**
     * The host adopts a key sign-in's post-auth card as its own continuation
     * step, so the card's Done/Back and the step indicator belong to the host.
     */
    onPostAuthContinuation: (input: AccountPostAuthInput, result: AccountPostAuthResult) => void;
    onExternalAuthStarted: () => Promise<void> | void;
    onBack: () => void;
    onReauthenticate?: (input: AccountPostAuthInput) => void | Promise<void>;
    onOpenHomeAuthentication?: (
        input: AccountPostAuthInput,
        homeServerIdentityId: string,
        previous: AccountPostAuthResult,
    ) => void | Promise<void>;
    isCurrent?: () => boolean;
    signal?: AbortSignal;
}>;

export function AccountServiceAuthenticationFlow(props: AccountServiceAuthenticationFlowProps): React.ReactElement {
    const inFlightRef = React.useRef(false);
    const [pendingActionId, setPendingActionId] = React.useState<string | null>(null);
    const [keySelection, setKeySelection] = React.useState<'login' | 'provision' | null>(null);
    const [passwordSelection, setPasswordSelection] = React.useState<'sign_in' | 'create' | null>(null);
    const [launchFailed, setLaunchFailed] = React.useState(false);
    const actions = props.service.authenticationActions;
    const admission = React.useMemo(() => ({
        pendingActionId,
        run: async (actionId: string, action: () => Promise<void> | void) => {
            if (inFlightRef.current || props.signal?.aborted || props.isCurrent?.() === false) return;
            inFlightRef.current = true;
            setPendingActionId(actionId);
            try {
                await action();
            } finally {
                inFlightRef.current = false;
                setPendingActionId(null);
            }
        },
    }), [pendingActionId, props]);
    if (passwordSelection) {
        const login = actions.find(({ execution }) => execution.kind === 'email_password' && execution.action === 'login')?.execution;
        return <AccountDirectoryKeyLoginForm
            service={props.service.authority}
            serviceName={props.service.displayName}
            intent={props.intent}
            returnTo={props.accountEntryReturnTo ?? props.returnTo}
            mode="password"
            password={{ login: login?.kind === 'email_password' ? login : null, view: passwordSelection }}
            transport={props.service.transport}
            onResult={props.onResult}
            onPostAuthContinuation={props.onPostAuthContinuation}
            onBack={() => setPasswordSelection(null)}
            onReauthenticate={props.onReauthenticate}
            onOpenHomeAuthentication={props.onOpenHomeAuthentication}
            isCurrent={props.isCurrent}
            signal={props.signal}
        />;
    }
    if (keySelection) {
        return <AccountDirectoryKeyLoginForm
            service={props.service.authority}
            serviceName={props.service.displayName}
            intent={props.intent}
            returnTo={props.accountEntryReturnTo ?? props.returnTo}
            mode={keySelection}
            transport={props.service.transport}
            onResult={props.onResult}
            onPostAuthContinuation={props.onPostAuthContinuation}
            onBack={() => setKeySelection(null)}
            onReauthenticate={props.onReauthenticate}
            onOpenHomeAuthentication={props.onOpenHomeAuthentication}
            isCurrent={props.isCurrent}
            signal={props.signal}
        />;
    }
    if (launchFailed) {
        return <SurfaceStateCard testID="account-service-auth-launch-failed" kind="error"
            title={t('welcome.signInServiceUnavailableTitle')} reason={t('errors.operationFailed')}
            accessibilitySemantics="alert"
            action={{ label: t('common.retry'), onPress: () => setLaunchFailed(false) }} />;
    }
    return <WelcomeActionList admission={admission}>
        {actions.map((entry) => {
            const { execution } = entry;
            const presentation = describeAccountServiceAuthenticationAction(entry, props.service.displayName);
            const testID = `account-service-auth-${presentation.slug}`;
            return <WelcomeActionCard key={testID} testID={testID} title={presentation.title}
                subtitle={presentation.subtitle} iconName={presentation.iconName}
                accentColor={presentation.accentColor} onPress={async () => {
                    if (execution.kind === 'email_password') {
                        setPasswordSelection(execution.action === 'provision' ? 'create' : 'sign_in');
                        return;
                    }
                    if (execution.kind === 'key_entry' || execution.kind === 'generated_key') {
                        setKeySelection(execution.kind === 'generated_key' ? 'provision' : 'login');
                        return;
                    }
                    const outcome = await launchAccountServiceOAuthAuthentication({
                        authority: props.service.authority,
                        execution,
                        intent: props.intent,
                        returnTo: props.returnTo,
                        accountEntryReturnTo: props.accountEntryReturnTo,
                        transport: props.service.transport,
                        signal: props.signal,
                        isCurrent: props.isCurrent,
                    });
                    if (outcome === 'opened') await props.onExternalAuthStarted();
                    else if (outcome === 'failed') setLaunchFailed(true);
                }} />;
        })}
        <WelcomeActionCard testID="account-service-auth-back" title={t('common.back')} iconName="arrow-left" escape onPress={props.onBack} />
    </WelcomeActionList>;
}
