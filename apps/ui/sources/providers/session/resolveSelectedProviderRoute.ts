import type { TeamCredentialProviderModelSelectionV1, TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';
import type { MachineAgentCredentialSelection } from '@/agents/machineAgents/machineAgentModel';
import type { ProviderDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import { readAccountAgentProviderRequirements, readAccountAgentQualifiedConnectedAccounts } from '@/providers/catalog/accountProviderDeclarations';
import { resolveProjectedConnectedAccountServiceKeys } from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';
import { presentProviderModelRow } from '@/providers/models/presentProviderModelRow';
import { resourceHasAvailableTeamCredentialProviderModel } from '@/components/sessions/teamCredentials/teamCredentialProviderModelCurrentness';
import type { TeamCredentialResourceStatusByKey } from '@/sync/domains/teams/teamCredentialResourceStatus';
import { readProviderRouteConnectionId, type ProviderRouteSource, type RouteSelection } from './resolveSessionRoutePresentation';

/** Selected model authentication uses the same admitted route for Home and Voice. */
export function resolveSelectedProviderRoute(input: Readonly<{
    selection: RouteSelection | TeamCredentialProviderModelSelectionV1;
    agentTargetKey?: string | null;
    declarationContext: ProviderDeclarationContext;
    providerSources?: readonly ProviderRouteSource[];
    teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
    teamCredentialResourceStatusByKey?: TeamCredentialResourceStatusByKey;
    acceptedConnectedServiceIds?: readonly string[];
}>): MachineAgentCredentialSelection['providerRoute'] {
    const selection = input.selection;
    const acceptedConnectedServiceIds = input.acceptedConnectedServiceIds ?? resolveProjectedConnectedAccountServiceKeys(
        input.agentTargetKey ? readAccountAgentQualifiedConnectedAccounts(input.agentTargetKey, input.declarationContext) ?? [] : []);
    if (selection && (('source' in selection && selection.source === 'team_resource')
        || ('kind' in selection && selection.kind === 'team_credential_provider_model'))) {
        const requirements = readAccountAgentProviderRequirements(selection.agentTargetKey, input.declarationContext);
        return {
            ready: Boolean(requirements && selection.agentTargetKey === input.agentTargetKey
                && input.teamCredentialResourceStatusByKey?.get(`${selection.teamId}:${selection.resourceId}`)?.kind === 'current'
                && input.teamCredentialResources?.some(resource => resourceHasAvailableTeamCredentialProviderModel(resource,
                    { ...selection, kind: 'team_credential_provider_model' }))),
            suppressedConnectedServiceIds: requirements?.authIsolation.suppressConnectedServiceIds ?? [],
            acceptedConnectedServiceIds,
        };
    }
    const connectionId = readProviderRouteConnectionId(selection && 'kind' in selection ? null : selection);
    if (!connectionId) return null;
    const source = input.providerSources?.find(source => source.connectionId === connectionId);
    const row = source?.rows?.find(row => row.ref.modelId === selection?.modelId);
    return {
        ready: source?.authorization?.authorized === true && Boolean(row && !presentProviderModelRow({
            modelId: row.ref.modelId, authorization: source.authorization, compatibility: row.compatibility,
            visibility: row.visibility,
        }).selectionDisabled),
        suppressedConnectedServiceIds: source?.suppressedConnectedServiceIds ?? [],
        acceptedConnectedServiceIds,
    };
}
