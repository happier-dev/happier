import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { HomeAdministrationSection } from '../governance/HomeAdministrationSection';
import { homeAdministrationIdentityConnectionPath } from '../governance/homeAdministrationRoutes';
import { IdentityConnectionDetailContent } from '@/components/settings/teams/identity/IdentityConnectionDetailScreen';
import { IdentityWorkosSetupContent } from '@/components/settings/teams/identity/IdentityWorkosSetupContent';
import { t } from '@/text';

export function HomeIdentityConnectionDetailScreen(props: Readonly<{
    serverId: string;
    connectionId: string;
    workosPortalReturn?: boolean;
    testReturn?: Readonly<{ purpose: string | null; resultHandle: string | null; error: string | null }>;
}>) {
    return <HomeAdministrationSection serverId={props.serverId} title={t('teams.authentication.detail.connection')} childRendersHeader>
        {(context, conditionBanners) => <IdentityConnectionDetailContent
            key={`${context.scope.serverId}:${context.scope.accountId}:${props.connectionId}`}
            scope={context.scope} teamId={null} connectionId={props.connectionId}
            mutationsAvailable={context.mutationsAvailable && context.projection.capabilities.manageAuthentication}
            requestApproval={context.requestApproval} conditionBanners={conditionBanners}
            testReturn={props.testReturn} workosPortalReturn={props.workosPortalReturn}
        />}
    </HomeAdministrationSection>;
}

export function HomeWorkosSetupScreen(props: Readonly<{ serverId: string }>) {
    const router = useRouter();
    return <HomeAdministrationSection serverId={props.serverId} title={t('identityAdministration.homeWorkosAdd')} childRendersHeader>
        {(context, conditionBanners) => <IdentityWorkosSetupContent
            key={`${context.scope.serverId}:${context.scope.accountId}`}
            scope={context.scope} teamId={null} homeName={context.homeName}
            conditionBanners={conditionBanners}
            mutationsAvailable={context.mutationsAvailable && context.projection.capabilities.manageAuthentication}
            requestApproval={context.requestApproval}
            onCreated={(connectionId) => router.replace(homeAdministrationIdentityConnectionPath(context.scope.serverId, connectionId))}
        />}
    </HomeAdministrationSection>;
}
