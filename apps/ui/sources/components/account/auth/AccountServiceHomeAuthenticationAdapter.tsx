import * as React from 'react';

import type { AccountHomeAuthenticationContinuation } from '@/auth/storage/tokenStorage';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveServerProfileForPortableIdentity } from '@/sync/domains/server/serverProfiles';
import { resumeAccountServicePostAuth, type AccountPostAuthInput, type AccountPostAuthResult } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';
import { t } from '@/text';

import { HomeAuthenticationFlow } from './HomeAuthenticationFlow';
import { useExactSavedHomeAuthenticationCatalog } from './useExactSavedHomeAuthenticationCatalog';

export function AccountServiceHomeAuthenticationAdapter(props: Readonly<{
    input: AccountPostAuthInput;
    previous: AccountPostAuthResult;
    homeServerIdentityId: string;
    returnTo: string;
    accountEntryReturnTo?: string;
    onResult: (result: AccountPostAuthResult) => void | Promise<void>;
    onBack: () => void;
}>): React.ReactElement {
    const resolved = resolveServerProfileForPortableIdentity(props.homeServerIdentityId);
    const catalog = useExactSavedHomeAuthenticationCatalog(resolved.kind === 'resolved' ? resolved.profile : null);

    if (resolved.kind !== 'resolved' || catalog.state === 'unavailable') {
        return <SurfaceStateCard testID="account-service-home-auth-unavailable" kind="error"
            title={t('common.error')} reason={t('errors.operationFailed')}
            accessibilitySemantics="alert" action={{ label: t('common.back'), onPress: props.onBack }} />;
    }
    if (catalog.state === 'loading') {
        return <ActivitySpinner />;
    }

    const continuation: AccountHomeAuthenticationContinuation = {
        endpoint: props.input.service.endpointUrl,
        serverIdentityId: props.input.service.serverIdentityId,
        canonicalServerUrl: props.input.service.canonicalServerUrl,
        entryIntent: props.input.intent,
        credentialTokenDigest: props.input.credentialTokenDigest,
        returnTo: props.returnTo,
        ...(props.accountEntryReturnTo ? { accountEntryReturnTo: props.accountEntryReturnTo } : {}),
        homeServerIdentityId: props.homeServerIdentityId,
    };
    return <HomeAuthenticationFlow
        target={{ kind: 'saved_profile', profileRef: resolved.profile.id }}
        actions={catalog.actions}
        transport={catalog.transport ?? undefined}
        keyChallengeV2Available={catalog.keyChallengeV2Available}
        returnTo={props.returnTo}
        accountContinuation={continuation}
        signal={props.input.signal}
        onAuthenticated={async (authenticatedHome) => {
            await props.onResult(await resumeAccountServicePostAuth(props.input, props.previous, authenticatedHome));
        }}
        onBack={props.onBack}
    />;
}
