import { resolveProviderPromptForDispatch } from '@/agent/runtime/prompt/resolveProviderPromptForDispatch';
import type { StructuredInputCatalogReaders } from '@/agent/runtime/prompt/resolveStructuredInputProviderContext';
import type { ReplaySeedSettlementResultV1 } from '@/agent/runtime/replaySeed/replaySeedV1';

/**
 * Codex's adapter onto the shared prompt-finalization owner. Codex is remote-dev's only
 * consumer of the structured-input envelope (`appServer/turnInput.ts`), so this is the path
 * whose dispatch metadata must carry resolved provider context (R-10) — on send and on steer,
 * both of which reach `buildCodexTurnInputForPrompt`.
 */
export async function resolveCodexQueuedPromptForDispatch(params: Readonly<{
  sessionClient: {
    getMetadataSnapshot: () => unknown;
    updateMetadata: (updater: (metadata: any) => any) => void | Promise<void>;
    refreshSessionSnapshotFromServerBestEffort?: (opts?: { reason: 'connect' | 'waitForMetadataUpdate' }) => Promise<void>;
  };
  text: string;
  localId: string | null;
  replaySeedAllowed: boolean;
  didBootstrap: boolean;
  metadata?: unknown;
  catalogs?: StructuredInputCatalogReaders;
}>): Promise<{
  text: string;
  metadata: unknown;
  didBootstrap: boolean;
  seedApplied: boolean;
  /** Call only after Codex accepted this prompt; see the replay-seed owner. */
  settleReplaySeedOnProviderAcceptance: () => Promise<ReplaySeedSettlementResultV1>;
}> {
  const resolution = await resolveProviderPromptForDispatch({
    session: params.sessionClient,
    userText: params.text,
    allowSeed: params.replaySeedAllowed,
    localId: params.localId,
    nowMs: Date.now(),
    refreshMetadataBeforeRead: !params.didBootstrap,
    meta: params.metadata,
    ...(params.catalogs ? { catalogs: params.catalogs } : {}),
  });

  return {
    text: resolution.providerPrompt,
    metadata: resolution.meta,
    didBootstrap: true,
    seedApplied: resolution.seedApplied,
    settleReplaySeedOnProviderAcceptance: resolution.settleReplaySeedOnProviderAcceptance,
  };
}
