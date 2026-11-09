import type { ManagedGitHubAppOwnerV1 } from '@happier-dev/protocol/identity/githubApps';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type {
    homeAdministrationGitHubAppCreatePath,
    homeAdministrationGitHubAppEditPath,
    homeAdministrationGitHubAppPath,
    homeAdministrationPoliciesPath,
    homeAdministrationSignInProvidersPath,
} from '../governance/homeAdministrationRoutes';
import type { teamAuthenticationPath, teamDirectoryPath, teamGitHubAppEditPath, teamGitHubAppPath, teamIdentityProviderSetupPath } from '../../teams/teamsRoutes';

export type ManagedGitHubAppCreatePath = ReturnType<typeof homeAdministrationGitHubAppCreatePath | typeof teamIdentityProviderSetupPath>;

/**
 * Everything the shared GitHub App list, detail and editor need in order to
 * serve one owner.
 *
 * A Team-owned App is the same registration record as a Home-owned one, read
 * and written through the same Actions; only the owner and the destinations
 * differ. Passing them in keeps one composition rather than letting each
 * administration tree grow its own idea of what a verified installation is.
 */
export type ManagedGitHubAppSurface = Readonly<{
    scope: ServerAccountScope;
    owner: ManagedGitHubAppOwnerV1;
    mutationsAvailable: boolean;
    onApprovalPending?: (registration: ActionApprovalRegistration) => void;
    routes: Readonly<{
        detail: (registrationId: string) => ReturnType<typeof homeAdministrationGitHubAppPath | typeof teamGitHubAppPath>;
        edit: (registrationId: string) => ReturnType<typeof homeAdministrationGitHubAppEditPath | typeof teamGitHubAppEditPath>;
        /** Canonical identity administration owner for this App's scope. */
        signIn: ReturnType<typeof homeAdministrationPoliciesPath | typeof teamAuthenticationPath>;
        /** Present only when one exact Team owns the directory destination. */
        directory?: ReturnType<typeof teamDirectoryPath>;
    }>;
    /**
     * Present only when this surface owns the Home policy that can approve a
     * GitHub Enterprise origin. Team-owned Apps deliberately omit it: their
     * administration tree must not manufacture Home authority or navigation.
     */
    githubEnterpriseOriginPolicyPath?: ReturnType<typeof homeAdministrationSignInProvidersPath>;
}>;
