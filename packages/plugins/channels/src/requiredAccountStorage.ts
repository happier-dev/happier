import {
  requireAccountStorage,
  type PluginAccountStorageConsumerContext,
  type PluginAccountStorageScope,
} from '@happier-dev/plugin-sdk/storage';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginDynamicResourceInvocationOptionsV1 } from '@happier-dev/plugin-sdk/resources';

const CHANNELS_RESOURCE_ACCOUNT_STORAGE_ERRORS = {
  connections: {
    code: 'channels_connections_resource_account_storage_unavailable',
    message: 'The Channels connections Resource requires admitted Account storage.',
  },
  bindings: {
    code: 'channels_bindings_resource_account_storage_unavailable',
    message: 'The Channels bindings Resource requires admitted Account storage.',
  },
  pairing: {
    code: 'channels_pairing_resource_account_storage_unavailable',
    message: 'The Channels pairing Resource requires admitted Account storage.',
  },
  transcriptActivities: {
    code: 'channels_transcript_activities_resource_account_storage_unavailable',
    message: 'The Channels transcript Activity Resource requires admitted Account storage.',
  },
  sessionConversations: {
    code: 'channels_session_conversations_resource_account_storage_unavailable',
    message: 'The Channels Session conversations Resource requires admitted Account storage.',
  },
} as const;

const CHANNELS_RESOURCE_SESSION_CONTEXT_ERRORS = {
  transcriptActivities: {
    code: 'channels_transcript_activities_resource_session_context_required',
    message: 'The Channels transcript Activity Resource requires a host-stamped Session context.',
  },
  sessionConversations: {
    code: 'channels_session_conversations_resource_session_context_required',
    message: 'The Channels Session conversations Resource requires a host-stamped Session context.',
  },
} as const;

export function requireChannelsResourceAccountStorage(
  options: PluginDynamicResourceInvocationOptionsV1,
  resource: keyof typeof CHANNELS_RESOURCE_ACCOUNT_STORAGE_ERRORS,
): PluginAccountStorageScope {
  if (options.accountStorage === undefined) {
    throw new PluginError(CHANNELS_RESOURCE_ACCOUNT_STORAGE_ERRORS[resource]);
  }
  return options.accountStorage;
}

/**
 * The one Channels reader of the host-stamped Session identity a Session-scoped
 * dynamic Resource is invoked with. The generic Resource host owns scope
 * admission; this guard only keeps a malformed direct invocation typed and
 * fail-closed under the invoking Resource's own error identity.
 */
export function requireChannelsResourceSessionId(
  options: PluginDynamicResourceInvocationOptionsV1,
  resource: keyof typeof CHANNELS_RESOURCE_SESSION_CONTEXT_ERRORS,
): string {
  if (options.context.kind !== 'session') {
    throw new PluginError(CHANNELS_RESOURCE_SESSION_CONTEXT_ERRORS[resource]);
  }
  return options.context.sessionId;
}

/**
 * Channels declares Account storage as required. The host normally refuses an invocation
 * before it reaches this plugin when that capability is unavailable; this
 * explicit guard keeps a malformed direct invocation typed and fail-closed.
 *
 * The check itself belongs to the SDK owner (`requireAccountStorage`), which is
 * where the repeated checks are consolidated. Only this plugin's
 * error identity is local, because that is the only part that was ever
 * different — and callers assert on it.
 */
export function requireChannelsAccountStorage(
  context: PluginAccountStorageConsumerContext,
): PluginAccountStorageScope {
  return requireAccountStorage(context, {
    code: 'channels_account_storage_unavailable',
    message: 'Channels requires admitted Account storage.',
  });
}
