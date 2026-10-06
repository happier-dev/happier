import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import { resolveBackendExecutionSurfaces, type BackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import type { TerminalHostHandle } from '@happier-dev/agents';
import type { TrackedSession } from '../types';

/** Runtime selection stays factory-owned; daemon continuation owns its launch intent. */
export async function resolveDaemonSessionTerminalPresentation(
  surfaces: Pick<BackendExecutionSurfaces, 'resolveTerminalPresentation'>,
  selection: Parameters<NonNullable<BackendExecutionSurfaces['resolveTerminalPresentation']>>[0],
  originalExistingSessionId?: string,
  retainedTerminalRecovery?: 'adopt',
): Promise<Awaited<ReturnType<NonNullable<BackendExecutionSurfaces['resolveTerminalPresentation']>>>> {
  const presentation = await surfaces.resolveTerminalPresentation?.(selection) ?? { kind: 'none' };
  if (originalExistingSessionId?.trim() && retainedTerminalRecovery === 'adopt'
    && presentation.kind !== 'none' && presentation.retainedTerminalRecovery === 'adopt') {
    return { ...presentation, kind: 'managed_terminal', startingMode: 'remote' };
  }
  return presentation.kind === 'provider_attach' && originalExistingSessionId?.trim()
    ? { ...presentation, startingMode: 'remote' }
    : presentation;
}

/** Reuse the admitted runtime descriptor, never today's account runtime default. */
export async function resolveTrackedSessionTerminalPresentation(
  tracked: TrackedSession,
  hostKind: TerminalHostHandle['kind'] | 'plain',
): Promise<Awaited<ReturnType<NonNullable<BackendExecutionSurfaces['resolveTerminalPresentation']>>> | null> {
  const metadata = tracked.happySessionMetadataFromLocalWebhook;
  const options = tracked.spawnOptions;
  const target = options?.backendTarget ?? resolveBackendTargetFromSessionMetadata(metadata ?? {});
  const descriptor = readRuntimeDescriptorV1FromMetadata(metadata ?? {}) ?? options?.runtimeDescriptorV1;
  const directory = options?.directory ?? metadata?.path;
  if (!target || !descriptor || !directory) return null;
  const surfaces = await resolveBackendExecutionSurfaces(target);
  return await resolveDaemonSessionTerminalPresentation(surfaces, {
    cwd: directory,
    requestedHost: hostKind,
    runtimeDescriptorV1: descriptor,
    launchEnvironment: { values: options?.environmentVariables ?? {}, unset: [] },
    configuration: {
      options: Object.fromEntries(Object.entries(options?.sessionConfigOptionOverrides?.overrides ?? {})
        .map(([id, option]) => [id, { value: option.value, updatedAtMs: option.updatedAt }])),
    },
  }, options?.existingSessionId);
}
