import type { ConnectedServiceProjectionSnapshot } from '../accountGroups/generation/connectedServiceProjectionSnapshot';
import type { ConnectedServiceRuntimeTarget } from '../runtimeRegistry/target';

export function isExecutionRunConnectedServiceGenerationCurrent(input: Readonly<{
  runId: string;
  target: ConnectedServiceRuntimeTarget;
  projection: ConnectedServiceProjectionSnapshot;
}>): boolean {
  if (input.target.materializationKey !== input.runId || input.target.activeBindings.length === 0) return false;
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
