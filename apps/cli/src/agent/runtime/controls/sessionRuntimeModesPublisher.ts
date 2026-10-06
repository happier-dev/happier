import type { Metadata } from '@/api/types';
import { readSessionModesMetadata } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { SessionOwnerModeCatalogV2 } from '@happier-dev/protocol';
import type { AgentSessionModesSnapshot, AgentSessionModesSource } from '@happier-dev/plugin-sdk/agents/runtime';
import { publishSessionControlsMetadataBestEffort } from './publishSessionControlsMetadataBestEffort';

type SessionModesState = SessionOwnerModeCatalogV2;

/** Project observed inventory and accepted current facts; desired mode overrides are not evidence. */
export function projectSessionRuntimeModes(params: Readonly<{
  agentId: string;
  snapshot: AgentSessionModesSnapshot;
  previous?: SessionModesState | null;
}>): SessionModesState | null {
  const previous = params.previous?.agentId === params.agentId ? params.previous : null;
  if (params.snapshot.modes === null && !params.snapshot.currentModeId) return previous;
  const currentModeId = params.snapshot.currentModeId || previous?.currentModeId;
  const modes = params.snapshot.modes ?? previous?.availableModes;
  if (!modes) return null;
  return {
    v: 2,
    agentId: params.agentId,
    updatedAt: params.snapshot.observedAt ?? previous?.updatedAt ?? 0,
    currentModeId: currentModeId ?? null,
    availableModes: [...modes],
  };
}

export function createSessionRuntimeModesPublisher(params: Readonly<{
  agentId: string;
  source: AgentSessionModesSource;
  session: Readonly<{
    getMetadataSnapshot(): Metadata | null;
    updateMetadataAsCurrentPublisher(updater: (current: Metadata) => Metadata): Promise<void> | void;
  }>;
}>): Readonly<{ flush(): Promise<void>; stopAndDrain(): Promise<void>; dispose(): void }> {
  let stopped = false;
  let pending = Promise.resolve();
  let terminalError: unknown = null;
  let subscription: ReturnType<AgentSessionModesSource['subscribe']> | null = null;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    void subscription?.dispose();
    subscription = null;
  };
  const publish = (snapshot: AgentSessionModesSnapshot): void => {
    if (stopped) return;
    pending = pending.then(async () => {
      if (stopped || terminalError !== null) return;
      const metadata = params.session.getMetadataSnapshot();
      const previous = readSessionModesMetadata(metadata);
      const state = projectSessionRuntimeModes({ agentId: params.agentId, snapshot, previous });
      if (!state || JSON.stringify(state) === JSON.stringify(metadata?.sessionModesV2)) return;
      await publishSessionControlsMetadataBestEffort({
        session: { updateMetadata: (updater) => params.session.updateMetadataAsCurrentPublisher(updater) },
        metadataSnapshot: metadata,
        sessionModesStateV2: state,
      });
    }).catch((error: unknown) => {
      // The canonical metadata writer reports terminal transport failures by default.
      terminalError ??= error;
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'session_publisher_authority_lost') stop();
    });
  };
  publish(params.source.read());
  subscription = params.source.subscribe(publish);
  if (stopped) void subscription.dispose();
  const flush = async (): Promise<void> => {
    await pending;
    if (terminalError !== null) throw terminalError;
  };
  return Object.freeze({
    flush,
    async stopAndDrain() { stop(); await flush(); },
    dispose: stop,
  });
}
