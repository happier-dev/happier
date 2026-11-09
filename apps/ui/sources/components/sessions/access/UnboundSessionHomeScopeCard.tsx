import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { SurfaceStateCard, type SurfaceStateAction } from '@/components/ui/surfaces/SurfaceStateCard';
import { retryServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import type { ServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';
import { openAddHome } from '@/components/homes/add/openAddHome';

export type UnboundServerCredentialAccountScopeResolution =
    Exclude<ServerCredentialAccountScopeResolution, Readonly<{ kind: 'bound' }>>;

/**
 * The ONE presentation of an `unavailable` exact-Home resolution: this device
 * could not read its own saved credential. The Home is not down and nothing was
 * signed out, so the remedy is to read again, never to sign in or add a Home.
 * Every surface that meets this state renders this card; a surface with a way
 * out (Back) passes it as the secondary action.
 */
export function HomeCredentialUnreadableCard(props: Readonly<{
    serverId: string;
    testID: string;
    /** Surface-specific reassurance, e.g. that an invitation link still works. */
    reason?: string;
    secondaryAction?: SurfaceStateAction;
}>): React.ReactElement {
    const { serverId } = props;
    const retry = React.useCallback(() => retryServerCredentialAccountScope(serverId), [serverId]);
    return (
        <SurfaceStateCard
            testID={props.testID}
            kind="error"
            title={t('homeGovernance.credentialUnreadableTitle')}
            reason={props.reason ?? t('homeGovernance.credentialUnreadableBody')}
            action={{ label: t('homeGovernance.retry'), onPress: retry }}
            secondaryAction={props.secondaryAction}
            accessibilitySemantics="status"
        />
    );
}

/**
 * The ONE presentation of a Session host's non-bound exact-Home resolution.
 *
 * `useServerCredentialAccountScopeResolution` answers four settled non-bound
 * states, and each is a different fact with a different next step. A host that
 * folds them together either strands a settled failure on a spinner forever or
 * tells a device whose secure storage failed that it signed out — so the
 * compact and full collaboration hosts share this reducer instead of each
 * writing their own.
 *
 * `unavailable` is a device secure-storage read failure, not a refusal by the
 * Home and not an absent credential; it offers a re-read, never sign-in.
 */
export function UnboundSessionHomeScopeCard(props: Readonly<{
    resolution: UnboundServerCredentialAccountScopeResolution;
    serverId: string;
    /** Host-local testID prefix, e.g. `session-collaboration`. */
    testIDPrefix: string;
}>): React.ReactElement {
    const router = useRouter();
    const openHomes = React.useCallback(() => openAddHome(router), [router]);

    if (props.resolution.kind === 'resolving') {
        return (
            <SurfaceStateCard
                testID={`${props.testIDPrefix}-home-loading`}
                kind="loading"
                title={t('common.loading')}
                accessibilitySemantics="status"
            />
        );
    }
    if (props.resolution.kind === 'unknown_home') {
        return (
            <SurfaceStateCard
                testID={`${props.testIDPrefix}-unknown-home`}
                kind="unavailable"
                title={t('teams.join.unknownHomeTitle')}
                reason={t('server.notificationAddServerHint')}
                action={{ label: t('server.addServerTitle'), onPress: openHomes }}
                accessibilitySemantics="status"
            />
        );
    }
    if (props.resolution.kind === 'unavailable') {
        return (
            <HomeCredentialUnreadableCard
                serverId={props.serverId}
                testID={`${props.testIDPrefix}-home-unavailable`}
            />
        );
    }
    return (
        <SurfaceStateCard
            testID={`${props.testIDPrefix}-signed-out`}
            kind="unavailable"
            title={t('homeGovernance.signedOutTitle')}
            reason={t('homeGovernance.signedOutBody')}
            action={{ label: t('server.addServerTitle'), onPress: openHomes }}
            accessibilitySemantics="status"
        />
    );
}
