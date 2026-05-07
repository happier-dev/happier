import type { Metadata } from '@/api/types';
import { logger } from '@/ui/logger';

import { probeClaudeHelpText } from './probeClaudeHelpText';
import { resolveClaudeSessionModelsState } from './resolveClaudeSessionModelsState';

export async function publishClaudeSessionModelsMetadataBestEffort(params: Readonly<{
  cwd: string;
  timeoutMs: number;
  currentModelId: string;
  session: Readonly<{
    ensureMetadataSnapshot: (opts: Readonly<{ timeoutMs: number }>) => Promise<unknown>;
    updateMetadata: (updater: (prev: Metadata) => Metadata) => Promise<void>;
  }>;
  nowMs?: () => number;
  probeHelpText?: (params: Readonly<{ cwd: string; timeoutMs: number }>) => Promise<string | null>;
}>): Promise<void> {
  const currentModelId = String(params.currentModelId ?? '').trim();
  if (!currentModelId) return;

  const snapshot = await params.session.ensureMetadataSnapshot({ timeoutMs: 60_000 }).catch(() => null);
  if (!snapshot) return;

  const state = await resolveClaudeSessionModelsState({
    cwd: params.cwd,
    timeoutMs: params.timeoutMs,
    currentModelId,
    nowMs: params.nowMs ?? (() => Date.now()),
    probeHelpText: params.probeHelpText ?? probeClaudeHelpText,
  }).catch(() => null);
  if (!state) return;

  try {
    await params.session.updateMetadata((prev) => ({
      ...prev,
      sessionModelsV1: state,
      acpSessionModelsV1: state,
    }));
  } catch (error) {
    logger.debug('[claude] Failed to publish session models metadata (non-fatal)', error);
  }
}
