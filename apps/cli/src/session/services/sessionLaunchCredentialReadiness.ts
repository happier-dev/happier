import { resolveConnectedServiceSessionSelection } from '@happier-dev/agents';
import type { AccountProfileResponse, ActionExecutorDeps, ConnectedServiceBindingsV2 } from '@happier-dev/protocol';
import type { ScmDiffSummaryCatalogUnavailableTargetV1 } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { isQualifiedConnectedAccountProfileUsableV4 } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { TeamCredentialProviderModelCatalogEntryV1 } from '@happier-dev/protocol/teams';

import { fetchAccountProfile } from '@/api/accountProfile';
import { probeAgentSignInStatus } from '@/capabilities/cliAuth/agentSignIn';
import { readLeasedConnectedAccountService } from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { resolveLaunchPurposeDeclarations } from '@/daemon/connectedServices/requestAuth/agentPurposeDeclarations';
import { connectedAccountProjectionFamily } from '@/plugins/projection/registry/connectedAccounts';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { selectSessionTeamCredentialProviderModel } from '@/providers/broker/sessionTeamCredentialProviderBinding';
import { readAgentConnectedDefaultRoutes } from './agentConnectedDefaultRoutes';
import { readSessionMemberTeamIds } from './sessionTeamCredentialCatalog';
import { readQualifiedSessionTeamCredentialResources, readSessionTeamCredentialApplications } from './sessionTeamCredentialProviderCatalog';

type AgentLaunchCredentialRoute =
    | Readonly<{ kind: 'inherited' }>
    | Readonly<{ kind: 'personal'; connectedServices: ConnectedServiceBindingsV2 }>
    | Readonly<{ kind: 'team'; models: readonly TeamCredentialProviderModelCatalogEntryV1[] }>
    | Readonly<{ kind: 'unavailable'; reason: ScmDiffSummaryCatalogUnavailableTargetV1['reason'] }>;

/** Value-free launch eligibility. Effect-time credential acquisition stays with Session and Run admission. */
export async function withSessionLaunchCredentialReadiness<T>(input: Parameters<typeof readAgentConnectedDefaultRoutes>[0]
    & Readonly<{ executionMachineId?: string; homeDomainAction?: ActionExecutorDeps['homeDomainAction'] }>,
    consume: (readiness: Readonly<{
        purposeCatalog: Awaited<ReturnType<typeof readAgentConnectedDefaultRoutes>>['purposeCatalog'];
        readAgent(agentId: string, agentTargetKey: string): Promise<AgentLaunchCredentialRoute>;
    }>) => Promise<T>,
): Promise<T> {
    const { purposeCatalog, dispositions } = await readAgentConnectedDefaultRoutes(input);
    const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
    const { credentials, executionMachineId, homeDomainAction, signal } = input;
    let accountProfile: Promise<AccountProfileResponse> | undefined;
    let serviceEntries: ReturnType<typeof connectedAccountProjectionFamily.project>['entriesById'] | undefined;
    let memberTeams: ReturnType<typeof readSessionMemberTeamIds> | undefined;
    const readPersonal = async (agentId: string): Promise<ConnectedServiceBindingsV2 | null> => {
        if (!credentials || !lease) return null;
        const contributions = lease.registry.contributes;
        const scopes = resolveLaunchPurposeDeclarations({ agentId, contributions, purposeDemand: 'agent' })
            .flatMap(declaration => declaration.snapshot.authorizedPurposes);
        for (const scope of scopes) {
            for (const serviceRef of scope.serviceRefs) {
                serviceEntries ??= connectedAccountProjectionFamily.project({ generation: 0, registry: contributions }).entriesById;
                const service = readLeasedConnectedAccountService(lease, serviceRef, serviceEntries);
                if (service?.availability !== 'available') continue;
                accountProfile ??= fetchAccountProfile({ token: credentials.token, authorizeRequest: input.authorizeRequest, signal });
                const accounts = (await accountProfile).connectedAccountsV4 ?? [];
                const serviceId = buildQualifiedPluginContributionKey(serviceRef);
                const now = Date.now();
                const profileOptions = accounts.filter(profile => buildQualifiedPluginContributionKey(profile.ref.service) === serviceId
                    && (!scope.credentialKinds || scope.credentialKinds.includes(profile.kind))
                    && isQualifiedConnectedAccountProfileUsableV4({ profile, authentication: service.authentication, now }))
                    .map(profile => ({ profileId: profile.ref.accountId, status: profile.status }));
                const selection = resolveConnectedServiceSessionSelection({ serviceId, binding: { source: 'connected' },
                    availability: { kind: 'known', profileOptions, groupOptions: [], accountGroupsEnabled: false } });
                if (selection.status === 'valid_selection') {
                    return { v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', ...selection.selection } } };
                }
            }
        }
        return null;
    };
    const readTeam = async (agentId: string, agentTargetKey: string) => {
        if (!lease || !homeDomainAction || !executionMachineId) return [];
        const applications = readSessionTeamCredentialApplications({ lease, agentId, agentTargetKey });
        if (!applications.length) return [];
        memberTeams ??= readSessionMemberTeamIds({ homeDomainAction, signal });
        const resources = await readQualifiedSessionTeamCredentialResources({ lease, agentId, homeDomainAction, applications,
            teamIds: await memberTeams, executionMachineId, signal });
        return resources.flatMap(resource => [...new Set(resource.providerModels.map(row => row.selection.modelId))]
            .flatMap(modelId => {
                const model = selectSessionTeamCredentialProviderModel({ resource, agentTargetKey, modelId, applications });
                return model?.selection.deliveryMode === 'brokered' ? [model] : [];
            }));
    };
    try {
        return await consume({ purposeCatalog, async readAgent(agentId, agentTargetKey) {
            const defaults = dispositions.get(agentId);
            if (defaults?.kind === 'connected') return { kind: 'inherited' };
            if (defaults?.kind === 'unavailable' && defaults.reason === 'connected_account_purpose_catalog_unavailable') {
                return { kind: 'unavailable', reason: 'account_metadata_unavailable' };
            }
            const signIn = defaults?.kind === 'unavailable' ? null : await probeAgentSignInStatus(agentId);
            signal?.throwIfAborted();
            if (signIn?.status === 'signedIn') return { kind: 'inherited' };
            let metadataUnavailable = false;
            try {
                const connectedServices = await readPersonal(agentId);
                if (connectedServices) return { kind: 'personal', connectedServices };
            } catch {
                signal?.throwIfAborted();
                metadataUnavailable = true;
            }
            try {
                const models = await readTeam(agentId, agentTargetKey);
                if (models.length) return { kind: 'team', models };
            } catch {
                signal?.throwIfAborted();
                metadataUnavailable = true;
            }
            return { kind: 'unavailable', reason: metadataUnavailable ? 'account_metadata_unavailable'
                : defaults?.kind === 'unavailable' ? 'connected_default_unavailable'
                    : signIn?.status === 'signedOut' ? 'native_sign_in_required' : 'native_auth_unavailable' };
        } });
    } finally {
        await lease?.release();
    }
}
