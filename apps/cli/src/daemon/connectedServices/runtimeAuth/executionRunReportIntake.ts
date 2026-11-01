import type { createRuntimeAuthFailureReportIntake } from '@/daemon/controlServer';
import type { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { handleConnectedServiceRuntimeAuthFailure } from './handleConnectedServiceRuntimeAuthFailure';

type SessionIntake = ReturnType<typeof createRuntimeAuthFailureReportIntake>;
type IntakeDependencies = Parameters<typeof createRuntimeAuthFailureReportIntake>[0];

export function createExecutionRunRuntimeAuthFailureReportIntake(input: Readonly<{
  runtimeRegistry: Pick<ConnectedServiceRuntimeRegistry, 'listTargetRegistrations' | 'isCurrentTargetRegistration'>;
  sessionIntake: SessionIntake;
  switchCoordinator: Parameters<typeof handleConnectedServiceRuntimeAuthFailure>[0]['switchCoordinator'];
  resolveResumePromptMode: NonNullable<IntakeDependencies['resolveConnectedServiceRuntimeAuthResumePromptMode']>;
  isShuttingDown: () => boolean;
}>): SessionIntake {
  return async (body) => {
    // The existing report address is the materialization's run key, never its parent sessionId.
    const registration = input.runtimeRegistry.listTargetRegistrations().find((candidate) => (
      candidate.key.kind === 'execution_run' && candidate.key.runKey === body.sessionId
    ));
    if (!registration) return await input.sessionIntake(body);
    if (input.isShuttingDown()) {
      return { ok: true, result: { status: 'daemon_lifecycle_unavailable', reason: 'recovery_deferred_shutdown' } };
    }
    const reported = body.classification;
    const binding = registration.target.activeBindings.find((candidate) => candidate.serviceId === reported.serviceId);
    if (
      !binding
      || (reported.groupId !== null && reported.groupId !== binding.groupId)
      || (reported.profileId !== null && reported.profileId !== binding.profileId)
      || (reported.groupGeneration != null && reported.groupGeneration !== binding.generation)
      || (reported.credentialRevision != null && reported.credentialRevision !== binding.credentialRevision)
    ) {
      return { ok: true, result: { status: 'selection_mismatch' } };
    }
    const classification = { ...reported, groupId: binding.groupId };
    const resumePromptMode = await input.resolveResumePromptMode({
      classification,
      ...(body.resumePromptMode ? { explicit: body.resumePromptMode } : {}),
    });
    if (input.isShuttingDown() || !input.runtimeRegistry.isCurrentTargetRegistration(registration)) {
      return { ok: true, result: { status: 'selection_mismatch' } };
    }
    const selection = binding.groupId === null
      ? { kind: 'profile' as const, serviceId: binding.serviceId, profileId: binding.profileId }
      : { kind: 'group' as const, serviceId: binding.serviceId, groupId: binding.groupId, activeProfileId: binding.profileId };
    return {
      ok: true,
      resumePromptMode,
      // Only the shared pool decision runs here. Run waiting/continuation belongs to the run controller.
      result: await handleConnectedServiceRuntimeAuthFailure({
        selection,
        classification,
        switchesThisTurn: body.switchesThisTurn ?? 0,
        switchCoordinator: input.switchCoordinator,
      }),
    };
  };
}
