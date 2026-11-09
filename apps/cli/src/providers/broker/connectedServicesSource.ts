import { resolveManagedProviderBrokerPurpose } from './applicationProjection';
import type { ProviderConnectionRegistryReader } from './providerConnectionSource';
import {
  type TeamCredentialResourceSummaryV1,
  type TeamCredentialSourceBindingV1,
  type TeamCredentialSourceMemberV1,
} from '@happier-dev/protocol/teams';

import { resolveManagedProviderPurposeBindingSnapshot } from '@/providers/managed/resolvePurposeBindingSnapshot';
import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { preserveConnectedAccountSourceHealthFailure } from '@/daemon/connectedServices/purposeBindings/sourceHealth';
import type { ManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import type { TeamCredentialBrokerSourceOpenInput, TeamCredentialBrokerSourceOpenFailureReason } from './teamCredentialBrokerSourceOwner';
import { acquireBrokerSourceOperation } from './brokerSourceOperationAcquisition';
import { readConnectedAccountBrokerModelCatalog, type ReadConnectedAccountBrokerModelProjection } from './connectedAccountModelCatalog';
import { observeCurrentConnectedServiceMaterializationPhase as observeMaterializationPhase } from '@/daemon/connectedServices/materialize/materializationPhase';
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
 * CLIProxyAPI upstream purpose the signed source and application admit, and the member the
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
  const service = request.source.target.kind === 'account'
    ? request.source.target.account.service
    : request.source.target.service;
  const family = await withRegistry((registry) => (
    isCpxBrokerApplication(registry, request.application)
      ? resolveManagedProviderBrokerPurpose({ registry, application: request.application, service })
      : null
  ));
  if (!family) return null;
  const purpose = {
    consumer: request.application.implementationIdentity,
    purpose: family.purpose,
  };
  // An admitted request materializes exactly its admitted member; only a
  // fresh selection reads the Pool's current choice.
  const admitted = request.admittedSourceMember?.kind === 'connected_account'
    ? request.admittedSourceMember : null;
  const target = admitted
    ? { kind: 'account' as const, account: { service: admitted.service, accountId: admitted.connectedAccountId } }
    : request.source.target;
  const selection = await resolveBindingIntentSelection({
    purpose,
    target,
    serviceRefs: [family.service],
    signal: request.signal,
  }).catch(preserveConnectedAccountSourceHealthFailure);
  if (!selection) return null;
  const sourceMember: TeamCredentialSourceMemberV1 = Object.freeze({
    kind: 'connected_account' as const,
    service: Object.freeze({ ...selection.resolved.account.service }),
    connectedAccountId: selection.resolved.account.accountId,
  });
  return { family, purpose, selection, sourceMember };
}

/** Selects the current source member without acquiring anything. */
export function createConnectedServicesBrokerSourceMemberSelect(input: Readonly<{
  withRegistry: ProviderConnectionRegistryReader;
  resolveBindingIntentSelection: ConnectedAccountPurposeBindingOwner['resolveBindingIntentSelection'];
}>): (request: ConnectedSelectionInput) => Promise<TeamCredentialSourceMemberV1 | null> {
  return async (request) => (
    await resolveConnectedServicesBrokerSelection(input.withRegistry, input.resolveBindingIntentSelection, request)
  )?.sourceMember ?? null;
}

/**
 * Opens one operation-scoped CLIProxyAPI projection over the exact current
 * Connected Account/Pool selected by the Team resource. The Connected Account
 * purpose-binding owner resolves credentials and Pool membership; this adapter
 * only connects that current authority to existing managed Provider custody.
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
}>): (request: ConnectedOpenInput) => Promise<Readonly<{
  projection: NonNullable<Awaited<ReturnType<ManagedProviderExplicitStartCustody['acquire']>>>;
  sourceCurrentness: Readonly<{
    sourceMember: TeamCredentialSourceMemberV1;
    isCurrent(): Promise<boolean | null>;
  }>;
  retire(): Promise<void>;
}> | Readonly<{ unavailable: TeamCredentialBrokerSourceOpenFailureReason }>> {
  return async (request) => {
    const readsResourceCurrent = async (
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (signal.aborted) return false;
      const resource = await observeMaterializationPhase('binding_read', () => input.readResource(request.resourceId, signal));
      // Source currentness is enabled, placement and source identity. The
      // revision is a policy fact the Home rechecks per request, so a policy
      // edit is not a source replacement (`04-private-iroh-broker-transport.md:272`).
      return teamCredentialBrokerResourceAcceptsMachine(resource, request.brokerMachineId)
        && sameTeamCredentialBrokerSource(resource.source, request.source);
    };
    const chosen = await observeMaterializationPhase('group_selection', () => resolveConnectedServicesBrokerSelection(
      input.withRegistry,
      input.resolveBindingIntentSelection,
      request,
    ));
    if (!chosen) return { unavailable: 'source_selection_unavailable' };
    if (!await readsResourceCurrent(request.signal)) return { unavailable: 'resource_not_current' };
    const { family, purpose, selection, sourceMember } = chosen;
    const exactTarget = Object.freeze({
      kind: 'account' as const,
      account: Object.freeze({
        service: Object.freeze({ ...selection.resolved.account.service }),
        accountId: selection.resolved.account.accountId,
      }),
    });
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
    if (!await readsResourceCurrent(request.signal)) return { unavailable: 'resource_not_current' };

    const readCatalog = input.readModelProjection;
    const catalog = readCatalog ? await observeMaterializationPhase('binding_read', () => readConnectedAccountBrokerModelCatalog({ request, purpose,
      projectModels: readCatalog, signal: request.signal })) : undefined;
    if (catalog === null) return { unavailable: 'projection_not_current' };

    const acquired = await observeMaterializationPhase('materialization_invoke', () => acquireBrokerSourceOperation({
      custody: input.custody,
      ...(request.retirementGroup ? { retirementGroup: request.retirementGroup } : {}),
      identity: request.application.implementationIdentity,
      contributionKey: `${request.application.implementationIdentity.pluginId}/${request.application.implementationIdentity.localId}`,
      endpointTemplateId: request.application.endpointTemplateId,
      operationClaim: { kind: 'providerBroker', operation: request.operation },
      purposeBindings,
      ...(catalog?.modelCatalogs ? { modelCatalogs: catalog.modelCatalogs } : {}),
      retainedCurrentnessScope: {
        facts: ['teams', 'team-credential-material', 'connected-services', 'connected-catalog'],
        connectedServiceRefs: [sourceMember.service],
      },
      isSourceCurrent: async (signal) => (
        await readsResourceCurrent(signal) && await selection.isCurrent(signal)
        && (!readCatalog || (await readConnectedAccountBrokerModelCatalog({ request, purpose,
          projectModels: readCatalog, signal }))?.sourceRevision === catalog?.sourceRevision)
      ),
      ...(request.revalidateOperationAuthorization
        ? { revalidateOperationAuthorization: request.revalidateOperationAuthorization }
        : {}),
      callerSignal: request.signal,
    }));
    if (!acquired) return { unavailable: 'managed_custody_unavailable' };
    if ('unavailable' in acquired) return acquired;
    const { projection, retire, revalidateSourceCurrentness } = acquired;
    return Object.freeze({
      projection,
      retire,
      sourceCurrentness: Object.freeze({
        sourceMember,
        isCurrent: revalidateSourceCurrentness,
      }),
    });
  };
}
