import { randomUUID } from 'node:crypto';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { resolveManagedProviderBrokerPurpose, resolveTeamCredentialPurposeProvider } from './applicationProjection';
import type { ProviderConnectionRegistryReader } from './providerConnectionSource';
import {
  type TeamCredentialResourceSummaryV1,
  type TeamCredentialSourceBindingV1,
  type TeamCredentialSourceMemberV1,
} from '@happier-dev/protocol/teams';

import { resolveManagedProviderPurposeBindingSnapshot } from '@/providers/managed/resolvePurposeBindingSnapshot';
import { readConnectedAccountCatalogSources } from '@/providers/modelManagement/connectedAccountCatalog';
import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { ConnectedAccountRequestAuthService } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import { preserveBrokerSourceHealthFailure } from './sourceFailure';
import type { ManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import type { TeamCredentialBrokerSourceOpenInput, TeamCredentialBrokerOpenedSource, TeamCredentialBrokerSourceOpenFailureReason } from './teamCredentialBrokerSourceOwner';
import { acquireBrokerSourceOperation } from './brokerSourceOperationAcquisition';
import { readConnectedAccountBrokerModelCatalog, type ReadConnectedAccountBrokerModelProjection } from './connectedAccountModelCatalog';
import { observeCurrentConnectedServiceMaterializationPhase as observeMaterializationPhase } from '@/daemon/connectedServices/materialize/materializationPhase';
import { openConnectedAccountProviderTransport } from './connectedAccountTransport';
import {
  isCpxBrokerApplication,
  sameTeamCredentialBrokerSource,
  teamCredentialBrokerResourceAcceptsMachine,
} from './teamCredentialBrokerSourceOwner';

type ConnectedSource = Extract<
  TeamCredentialSourceBindingV1,
  { kind: 'connected_account' | 'connected_pool' }
>;

type ConnectedOpenInput = TeamCredentialBrokerSourceOpenInput & Readonly<{
  source: ConnectedSource;
}>;

type ConnectedSelectionInput = Pick<ConnectedOpenInput, 'source' | 'application' | 'signal' | 'admittedSourceMember'>;

/**
 * The one current Connected Account/Pool choice for a broker source: the
 * Provider purpose the signed source admits, and the member the
 * canonical purpose-binding owner selects for it. A pure read — it neither
 * starts nor joins managed custody — so the Home can attribute and admit a
 * request before anything is materialized; acquisition then resolves exactly
 * the admitted member.
 */
async function resolveConnectedServicesBrokerSelection(
  withRegistry: ProviderConnectionRegistryReader,
  resolveBindingIntentSelection: ConnectedAccountPurposeBindingOwner['resolveBindingIntentSelection'],
  request: ConnectedSelectionInput,
) {
  // An admitted request materializes exactly its admitted member; only a
  // fresh selection reads the Pool's current choice.
  const admitted = request.admittedSourceMember?.kind === 'connected_account'
    ? request.admittedSourceMember : null;
  const target = admitted
    ? { kind: 'account' as const, account: { service: admitted.service, accountId: admitted.connectedAccountId } }
    : request.source.target;
  const chosen = await withRegistry(async (registry) => {
    if (request.source.kind === 'connected_account' && request.source.providerPurpose) {
      const savedPurpose = request.source.providerPurpose;
      if (target.kind !== 'account' || !sameQualifiedConnectedAccountRef(target.account, request.source.target.account)) return null;
      const provider = resolveTeamCredentialPurposeProvider({ registry, purpose: savedPurpose, application: request.application });
      if (!provider) return null;
      const [source] = await readConnectedAccountCatalogSources({ registry, provider, purpose: savedPurpose.purpose,
        target, protocols: [request.application.protocol], endpointTemplateId: request.application.endpointTemplateId,
        signal: request.signal, resolveSelection: resolveBindingIntentSelection });
      if (!source) return null;
      if (provider.definition.managedRuntime) {
        return isCpxBrokerApplication(registry, request.application) ? { ...source, purpose: savedPurpose, direct: null } : null;
      }
      const direct = source.requestAuthUses.find(use => use.purpose === savedPurpose.purpose);
      return direct ? { ...source, purpose: savedPurpose, direct } : null;
    }
    const service = request.source.target.kind === 'account' ? request.source.target.account.service : request.source.target.service;
    if (!isCpxBrokerApplication(registry, request.application)) return null;
    const family = resolveManagedProviderBrokerPurpose({ registry, application: request.application, service });
    if (!family) return null;
    const purpose = { consumer: request.application.implementationIdentity, purpose: family.purpose };
    const selection = await resolveBindingIntentSelection({ purpose, target, serviceRefs: [family.service], signal: request.signal });
    return selection ? { family, purpose, selection, endpoint: null, direct: null } : null;
  }).catch(preserveBrokerSourceHealthFailure);
  if (!chosen) return null;
  const { selection } = chosen;
  const sourceMember: TeamCredentialSourceMemberV1 = Object.freeze({
    kind: 'connected_account' as const,
    service: Object.freeze({ ...selection.resolved.account.service }),
    connectedAccountId: selection.resolved.account.accountId,
  });
  return { ...chosen, sourceMember };
}

/** Selects the current source member without acquiring anything. */
export function createConnectedServicesBrokerSourceMemberSelect(input: Readonly<{
  withRegistry: ProviderConnectionRegistryReader;
  resolveBindingIntentSelection: ConnectedAccountPurposeBindingOwner['resolveBindingIntentSelection'];
}>): (request: ConnectedSelectionInput) => Promise<TeamCredentialSourceMemberV1 | null> {
  return async (request) => {
    if (request.source.kind === 'connected_account') {
      if (request.source.target.kind !== 'account') return null;
      return Object.freeze({
        kind: 'connected_account' as const,
        service: Object.freeze({ ...request.source.target.account.service }),
        connectedAccountId: request.source.target.account.accountId,
      });
    }
    return (await resolveConnectedServicesBrokerSelection(
      input.withRegistry, input.resolveBindingIntentSelection, request,
    ))?.sourceMember ?? null;
  };
}

/**
 * Captures one admitted Connected Account/Pool source for its declared carrier.
 * Rejoining uses that capture; the purpose-binding owner
 * still acquires credentials at each natural materialization boundary.
 */
export function createConnectedServicesBrokerSourceOpen(input: Readonly<{
  withRegistry: ProviderConnectionRegistryReader;
  readResource(
    resourceId: string,
    signal: AbortSignal,
  ): Promise<TeamCredentialResourceSummaryV1 | null>;
  resolveBindingIntentSelection: ConnectedAccountPurposeBindingOwner['resolveBindingIntentSelection'];
  custody: ManagedProviderExplicitStartCustody;
  readModelProjection?: ReadConnectedAccountBrokerModelProjection;
  purposeBindings?: Pick<ConnectedAccountPurposeBindingOwner, 'activatePurposeBindings'>;
  requestAuth?: Pick<ConnectedAccountRequestAuthService, 'lookupRequestAuth' | 'refreshAfterAuthFailure'>;
  resolveAddresses?: Parameters<typeof openConnectedAccountProviderTransport>[0]['resolveAddresses'];
  transport?: Parameters<typeof openConnectedAccountProviderTransport>[0]['transport'];
}>): (request: ConnectedOpenInput) => Promise<TeamCredentialBrokerOpenedSource
  | Readonly<{ unavailable: TeamCredentialBrokerSourceOpenFailureReason }>> {
  return async (request) => {
    const readsResourceCurrent = async (
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (signal.aborted) return false;
      const resource = await observeMaterializationPhase('binding_read', () => input.readResource(request.resourceId, signal));
      // Source currentness is enabled, placement and source identity. The
      // Home checks the admitted job's revision with its active-job lookup;
      // a policy edit is not a source replacement.
      return teamCredentialBrokerResourceAcceptsMachine(resource, request.brokerMachineId)
        && sameTeamCredentialBrokerSource(resource.source, request.source);
    };
    const chosen = await observeMaterializationPhase('group_selection', () => resolveConnectedServicesBrokerSelection(
      input.withRegistry,
      input.resolveBindingIntentSelection,
      request,
    ));
    if (!chosen) return { unavailable: 'source_selection_unavailable' };
    const { family, purpose, selection, sourceMember } = chosen;
    const exactTarget = Object.freeze({
      kind: 'account' as const,
      account: Object.freeze({
        service: Object.freeze({ ...selection.resolved.account.service }),
        accountId: selection.resolved.account.accountId,
      }),
    });
    if (chosen.direct && chosen.endpoint) {
      const { requestAuth, purposeBindings } = input;
      if (!requestAuth || !purposeBindings) return { unavailable: 'purpose_binding_unavailable' };
      const { endpoint, direct: { materialization } } = chosen;
      const reopen = async (signal: AbortSignal): Promise<TeamCredentialBrokerOpenedSource
        | Readonly<{ unavailable: TeamCredentialBrokerSourceOpenFailureReason }>> => {
        if (signal.aborted) return { unavailable: 'projection_not_current' };
        // Each carrier stream owns its own exact binding lease. Server-side job
        // admission has already selected this source and authorizes every request.
        const bindingLease = purposeBindings.activatePurposeBindings({
          subject: { kind: 'operation', operationId: randomUUID(), consumer: purpose.consumer, isCurrent: () => !signal.aborted },
          purposes: [purpose], bindings: [{ purpose, target: exactTarget }],
        });
        try {
          const projection = await openConnectedAccountProviderTransport({ endpoint, purpose, materialization,
            bindingLease, requestAuth, signal, isCurrent: async currentSignal => !signal.aborted && !currentSignal?.aborted,
            resolveAddresses: input.resolveAddresses, transport: input.transport });
          if (!projection) {
            bindingLease.dispose();
            return { unavailable: 'projection_not_current' };
          }
          const cleanup = async () => {
            bindingLease.dispose();
            await projection.cleanup();
          };
          return { projection: { ...projection, cleanup }, sourceMember, reopen, retire: cleanup };
        } catch (error) {
          bindingLease.dispose();
          throw error;
        }
      };
      return await reopen(request.signal);
    }
    if (!await readsResourceCurrent(request.signal)) return { unavailable: 'resource_not_current' };
    const purposeBindings = await resolveManagedProviderPurposeBindingSnapshot({
      implementationIdentity: request.application.implementationIdentity,
      connectedAccounts: [{
        purpose: family.purpose,
        title: family.title,
        service: family.service,
        required: family.required,
        materializationKinds: family.materializationKinds,
      }],
      purposeBindingIntents: {
        v: 1,
        bindings: [{
          purpose,
          target: exactTarget,
        }],
      },
      resolveBindingIntent: async ({ purpose: exactPurpose }) => ({
        purpose: exactPurpose,
        target: exactTarget,
      }),
      signal: request.signal,
    }).catch(() => null);
    if (!purposeBindings) return { unavailable: 'purpose_binding_unavailable' };

    const readCatalog = input.readModelProjection;
    const catalog = readCatalog ? await observeMaterializationPhase('binding_read', () => readConnectedAccountBrokerModelCatalog({ request, purpose,
      projectModels: readCatalog, signal: request.signal })) : undefined;
    if (catalog === null) return { unavailable: 'projection_not_current' };

    let sourceAdmitted = false;
    const reopen = async (signal: AbortSignal): Promise<TeamCredentialBrokerOpenedSource
      | Readonly<{ unavailable: TeamCredentialBrokerSourceOpenFailureReason }>> => {
      const acquired = await observeMaterializationPhase('materialization_invoke', () => acquireBrokerSourceOperation({
        custody: input.custody,
        ...(request.retirementGroup ? { retirementGroup: request.retirementGroup } : {}),
        identity: request.application.implementationIdentity,
        contributionKey: `${request.application.implementationIdentity.pluginId}/${request.application.implementationIdentity.localId}`,
        endpointTemplateId: request.application.endpointTemplateId,
        operationClaim: { kind: 'providerBroker', operation: request.operation },
        purposeBindings,
        // Selection already admitted the declared CPX application above.
        sourceEnvelopeTransport: 'cpx-v1',
        ...(catalog?.modelCatalogs ? { modelCatalogs: catalog.modelCatalogs } : {}),
        isSourceCurrent: async (signal) => (
          sourceAdmitted || await readsResourceCurrent(signal) && await selection.isCurrent(signal)
          && (!readCatalog || (await readConnectedAccountBrokerModelCatalog({ request, purpose,
            projectModels: readCatalog, signal }))?.sourceRevision === catalog?.sourceRevision)
        ),
        callerSignal: signal,
      }));
      if (!acquired) return { unavailable: 'managed_custody_unavailable' };
      if ('unavailable' in acquired) return acquired;
      sourceAdmitted = true;
      const { projection, retire } = acquired;
      return Object.freeze({
        projection,
        retire,
        sourceMember,
        reopen,
      });
    };
    return await reopen(request.signal);
  };
}
