import type { StoredCredentials } from '@/persistence';
import type { MemorySettingsV1 } from '@happier-dev/protocol/memory/memorySettings';
import type { MemoryExternalTranscriptSourceV1 } from '@happier-dev/protocol/memory/memorySearch';
import { createMemoryExternalTranscriptObservation } from '../externalTranscriptObservation';
import { createMemoryExternalTranscriptReader } from '../externalTranscriptSources';

/** Compose the real observation and reader in-process for source integration tests. */
export function createMemoryExternalTranscriptSources(input: Readonly<{
  credentials: StoredCredentials;
  onChange(refreshSources: boolean): void;
}>) {
  const daemon = createMemoryExternalTranscriptObservation(input);
  const reader = createMemoryExternalTranscriptReader({ onChange: input.onChange, resolveReader: async agentId => {
    const { acquireAuthoritativePluginRuntimeRegistryLease } = await import('@/plugins/runtime/reload/runtimeLease');
    const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    try {
      const runtime = lease.registry.agentRuntimesByAgentId.get(agentId);
      return runtime?.isCurrent() && !runtime.retirementSignal.aborted ? runtime.externalSessions ?? null : null;
    } finally { await lease.release(); }
  } });
  let indexSettings: MemorySettingsV1 | null = null;
  return {
    ...reader,
    attach: daemon.attach,
    async refresh(settings: MemorySettingsV1, signal: AbortSignal) {
      indexSettings = settings;
      await daemon.refresh(settings, signal);
      await reader.refresh(daemon.takeSnapshot(), settings, signal);
    },
    async inventory(signal: AbortSignal) {
      if (indexSettings) await reader.refresh(daemon.takeSnapshot(), indexSettings, signal);
      return reader.inventory(signal);
    },
    async readPage(request: Readonly<{ source: MemoryExternalTranscriptSourceV1; cursor?: string }>, settings: MemorySettingsV1, signal: AbortSignal) {
      if (!indexSettings) { await daemon.refresh(settings, signal); indexSettings = settings; }
      await reader.refresh(daemon.takeSnapshot(), settings, signal);
      return reader.readPage(request, settings, signal);
    },
    async dispose() { await reader.dispose(); await daemon.dispose(); },
  };
}
