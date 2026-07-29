import type { PluginDevelopmentSourceRequest } from '@/plugins/authoring/sourceObserver';

import type {
  PluginChangeDecision,
  PluginChangeDecisionResult,
  PluginChangeRequest,
  PluginChangeRequestResult,
} from './changeContract';
import { requestUserPluginChange } from './changeClient';

type DevelopmentChangeResult = Readonly<{
  ok: boolean;
  diagnostics?: readonly Readonly<{ code: string; message: string }>[];
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
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<DevelopmentChangeResult> {
  const result = await requestUserPluginChange({
    request: {
      kind: 'development',
      pluginId: request.pluginId,
      sourceRootPath: request.projectRoot,
      ...(request.sdkRegistryOrigin ? { sdkRegistryOrigin: request.sdkRegistryOrigin } : {}),
    },
    approval: 'prompt',
    ...(options.signal ? { signal: options.signal } : {}),
  }, dependencies);
  if (result.kind === 'committed') {
    return result.desiredGeneration === result.appliedGeneration
      ? Object.freeze({ ok: true })
      : failed('plugin_dev_adoption_pending', 'The daemon committed the development generation but has not applied it yet.');
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
  if (result.kind !== 'reviewRequired') {
    return failed(`plugin_dev_${result.kind}`, `The daemon rejected the development change (${result.kind}).`);
  }

  return failed('plugin_dev_review_pending', 'The daemon is still awaiting a plugin trust decision.');
}
