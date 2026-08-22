import type { PluginDevelopmentSourceRequest } from '@/plugins/authoring/sourceObserver';

import type {
  PluginChangeDecision,
  PluginChangeDecisionResult,
  PluginChangePendingReviewResult,
  PluginChangePendingSurface,
  PluginChangeRequest,
  PluginChangeRequestResult,
} from './changeContract';
import { requestUserPluginChange } from './changeClient';

export type DevelopmentChangeResult = Readonly<{
  ok: boolean;
  /**
   * Exact daemon-owned pending review. Consumers rejoin only through this
   * issued identity and never reconstruct a review from local source facts.
   */
  pendingReview?: PluginChangePendingReviewResult;
  diagnostics?: readonly Readonly<{ code: string; message: string }>[];
  /**
   * Committed generation identity, so callers can project `admitted` versus
   * `projected` from the daemon's own facts instead of inventing a second
   * lifecycle. Absent when the daemon never committed.
   */
  generation?: Readonly<{
    desired: string | null;
    applied: string | null;
    pendingSurfaces: readonly PluginChangePendingSurface[];
  }>;
}>;

function failed(code: string, message: string): DevelopmentChangeResult {
  return Object.freeze({ ok: false, diagnostics: Object.freeze([Object.freeze({ code, message })]) });
}

export async function requestPluginDevelopmentChange(
  request: PluginDevelopmentSourceRequest,
  dependencies: Readonly<{
    ensureDaemon?: () => Promise<void>;
    confirm?: (message: string) => Promise<boolean>;
    requestChange?: (
      request: PluginChangeRequest,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<PluginChangeRequestResult>;
    decideChange?: (
      decision: PluginChangeDecision,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<PluginChangeDecisionResult>;
    createInteractionId?: () => string;
    nowMs?: () => number;
  }> = {},
  options: Readonly<{
    signal?: AbortSignal;
    approval?: 'prompt' | 'none';
  }> = {},
): Promise<DevelopmentChangeResult> {
  const result = await requestUserPluginChange({
    request: {
      kind: 'development',
      ...(request.pluginId ? { pluginId: request.pluginId } : {}),
      sourceRootPath: request.projectRoot,
      ...(request.changedPaths ? { changedPaths: request.changedPaths } : {}),
      ...(request.sdkRegistryOrigin ? { sdkRegistryOrigin: request.sdkRegistryOrigin } : {}),
    },
    approval: options.approval ?? 'prompt',
    ...(options.signal ? { signal: options.signal } : {}),
  }, dependencies);
  if (result.kind === 'committed') {
    const generation = Object.freeze({
      desired: result.desiredGeneration,
      applied: result.appliedGeneration,
      pendingSurfaces: Object.freeze([...result.pendingSurfaces]),
    });
    return result.desiredGeneration === result.appliedGeneration
      ? Object.freeze({ ok: true, generation })
      : Object.freeze({
          ...failed('plugin_dev_adoption_pending', 'The daemon committed the development generation but has not applied it yet.'),
          generation,
        });
  }
  if (result.kind === 'cancelled') {
    return failed('plugin_dev_cancelled', 'Plugin development was cancelled before the candidate was applied.');
  }
  if (result.kind === 'failed') {
    return failed(
      result.code,
      result.message ?? `The daemon rejected the development change (${result.code}).`,
    );
  }
  if (result.kind === 'outcomeUnknown') {
    return failed(
      'plugin_dev_outcome_unknown',
      `The daemon may have applied the development change for ${result.pluginId}; inspect installed state before retrying.`,
    );
  }
  if (result.kind !== 'reviewRequired' && result.kind !== 'sourceRootReviewRequired') {
    return failed(`plugin_dev_${result.kind}`, `The daemon rejected the development change (${result.kind}).`);
  }

  return Object.freeze({
    ...failed('plugin_dev_review_pending', 'The daemon is still awaiting a plugin trust decision.'),
    pendingReview: result,
  });
}
