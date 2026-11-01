import type { ConnectedServiceId } from '@happier-dev/protocol';
import type { TrackedSession } from '@/daemon/types';
import type { ConnectedServiceRuntimeTarget } from '../runtimeRegistry/registry';

export function resolveConnectedServiceAuthGroupRequiredModelIds(input: Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  targets: ReadonlyArray<ConnectedServiceRuntimeTarget>;
  sessions: ReadonlyArray<TrackedSession>;
}>): ReadonlyArray<string> {
  const models = new Set<string>();
  for (const target of input.targets) {
    if (!target.activeBindings.some((binding) => binding.serviceId === input.serviceId && binding.groupId === input.groupId)) continue;
    const session = input.sessions.find((candidate) => candidate.happySessionId === target.sessionId
      && (candidate.pid === target.pid || candidate.sessionRunnerPid === target.pid));
    if (!session) continue;
    const metadata = session.happySessionMetadataFromLocalWebhook;
    const requested = metadata?.modelOverrideV1;
    const applied = metadata?.sessionAppliedModelV1;
    const native = metadata?.sessionModelsV1;
    const add = (model: string | null | undefined) => {
      const modelId = model?.trim();
      if (modelId && modelId !== 'default') models.add(modelId);
    };
    add(requested?.modelId);
    add(applied?.modelId);
    add(native?.currentModelId);
    // Spawn intent is useful before the first metadata report, but must not retain an old model
    // after the session publishes a newer selection (including an explicitly cleared override).
    const metadataUpdatedAt = Math.max(requested?.updatedAt ?? 0, applied?.updatedAt ?? 0, native?.updatedAt ?? 0);
    if (!metadataUpdatedAt || (session.spawnOptions?.modelUpdatedAt ?? 0) > metadataUpdatedAt) add(session.spawnOptions?.modelId);
  }
  return [...models];
}
