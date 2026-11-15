import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';

import type { ConversationProviderFailureV1 } from '../diagnostics.js';

/** The two host-stamped invocation facts the caller check reads. */
export type ConversationInvocationCallerFactsV1 = Readonly<{
  surface: string;
  caller?: Readonly<{ kind: string; pluginId?: string }>;
}>;

/** Provider roles require a host-stamped plugin caller. */
export function assertConversationChannelsCoreCallerV1(
  context: ConversationInvocationCallerFactsV1,
  refusal: Readonly<{ code: string; message: string }> = {
    code: 'channels_core_caller_required',
    message:
      'Channel provider operations require a host-stamped plugin caller.',
  },
): void {
  if (
    context.surface !== 'plugin' ||
    context.caller?.kind !== 'plugin'
  ) {
    throw new PluginError(refusal);
  }
}

/** Cancellation and retired generations must never become provider retry work. */
export function rethrowConversationProviderLifecycleFailureV1(
  error: unknown,
  signal?: AbortSignal,
): void {
  if (
    signal?.aborted ||
    (isPluginError(error) && error.code === 'plugin_final_generation_retired')
  ) {
    throw error;
  }
}

/** Classify only failures before credential materialization reaches provider I/O. */
export function classifyConversationProviderMaterializationFailureV1(
  error: unknown,
  signal: AbortSignal,
  credentialDiagnostic?: string,
): ConversationProviderFailureV1 {
  rethrowConversationProviderLifecycleFailureV1(error, signal);
  if (
    !isPluginError(error) ||
    error.retryable ||
    error.code === 'plugin_service_unavailable'
  ) {
    return { kind: 'notReady', reason: 'network' };
  }
  return {
    kind: 'notReady',
    reason: 'credentialInvalid',
    ...(credentialDiagnostic === undefined
      ? {}
      : { diagnostic: credentialDiagnostic }),
  };
}
