import type { ConnectedServiceProjectionSnapshot } from '../accountGroups/generation/connectedServiceProjectionSnapshot';
import type { ConnectedServiceRuntimeTarget } from '../runtimeRegistry/target';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ConnectedServiceQualifiedAuthGroupApi } from '../spawnBindingAccountApi';
import { resolveQualifiedConnectedAccountServiceForIngressServiceId } from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';

/** Read the selected Account's qualified metadata; V2 profile projections omit
 * plugin services. The existing generation predicate remains the sole decision. */
export async function readExecutionRunConnectedServiceGenerationCurrent(input: Readonly<{
  runId: string;
  target: ConnectedServiceRuntimeTarget;
  api: ConnectedServiceQualifiedAuthGroupApi;
}>): Promise<boolean> {
  const serviceIds = [...new Set(input.target.activeBindings.map(binding => binding.serviceId))];
  const snapshots = await Promise.all(serviceIds.map(async serviceId => {
    const service = resolveQualifiedConnectedAccountServiceForIngressServiceId(serviceId);
    if (!service) return null;
    const groupIds = [...new Set(input.target.activeBindings.filter(binding => binding.serviceId === serviceId)
      .flatMap(binding => binding.groupId === null ? [] : [binding.groupId]))];
    const [accounts, groups] = await Promise.all([
      input.api.listAccounts({ service }),
      Promise.all(groupIds.map(groupId => input.api.readGroup({ service, groupId }))),
    ]);
    return { serviceId, accounts: accounts.accounts, groups };
  }));
  const projection = {
    groups: snapshots.flatMap(snapshot => snapshot?.groups.flatMap(group => group ? [{
      serviceId: snapshot.serviceId, groupId: group.ref.groupId,
      activeProfileId: group.activeConnectedAccountId, generation: group.generation,
    }] : []) ?? []),
    resolveCredentialRevision: (serviceId: string, profileId: string) => {
      const account = snapshots.find(snapshot => snapshot?.serviceId === serviceId)?.accounts
        .find(account => account.ref.accountId === profileId);
      return account?.revisionSemantics === 'revisioned' ? account.credentialRevision : null;
    },
  };
  return isExecutionRunConnectedServiceGenerationCurrent({ ...input, projection });
}

export function isExecutionRunConnectedServiceGenerationCurrent(input: Readonly<{
  runId: string;
  target: ConnectedServiceRuntimeTarget;
  projection: Pick<ConnectedServiceProjectionSnapshot, 'groups' | 'resolveCredentialRevision'>;
}>): boolean {
  if (input.target.materializationKey !== input.runId) return false;
  if (input.target.activeBindings.length === 0) {
    // Brokered Team routes retain no local Account credential generation.
    // Their existing broker owner revalidates Team/source authority per request,
    // just as it does for the parent Session. Missing local material is still a
    // refusal for any route that actually requires a local credential.
    const parsed = ConnectedServiceBindingsV2Schema.safeParse(input.target.connectedServicesBindingsRaw);
    if (!parsed.success) return false;
    const bindings = Object.values(parsed.data.bindingsByServiceId);
    return bindings.some(binding => binding.source === 'team_resource' && binding.deliveryMode === 'brokered')
      && bindings.every(binding => binding.source === 'native'
        || binding.source === 'team_resource' && binding.deliveryMode === 'brokered');
  }
  return input.target.activeBindings.every((binding) => {
    const currentRevision = input.projection.resolveCredentialRevision(binding.serviceId, binding.profileId);
    if (currentRevision === null || currentRevision !== binding.credentialRevision) return false;
    if (binding.groupId === null) return binding.groupGeneration === null;
    const group = input.projection.groups.find((candidate) =>
      candidate.serviceId === binding.serviceId && candidate.groupId === binding.groupId);
    return Boolean(group)
      && group!.activeProfileId === binding.profileId
      && group!.generation === binding.groupGeneration;
  });
}
