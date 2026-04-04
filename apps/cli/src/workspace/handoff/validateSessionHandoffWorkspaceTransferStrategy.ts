import type { SessionHandoffTransportStrategy } from '@happier-dev/protocol';

import type { SessionHandoffWorkspaceTransferInput } from './sessionHandoffWorkspaceTransferInput';

export type SessionHandoffWorkspaceTransferStrategyValidationResult = Readonly<
  | { ok: true }
  | {
      ok: false;
      errorCode: 'unsupported_workspace_transfer_strategy';
      error: string;
      reasonCode:
        | 'server_routed_transfer_unavailable'
        | 'direct_peer_and_server_routed_unavailable'
        | 'ignored_globs_require_include_selected';
    }
>;

export function validateSessionHandoffWorkspaceTransferStrategy(params: Readonly<{
  workspaceTransfer?: SessionHandoffWorkspaceTransferInput;
  negotiatedTransportStrategy?: SessionHandoffTransportStrategy;
  hasServerRoutedTransferChannel?: boolean;
  hasDirectPeerTransfer?: boolean;
  allowLocalPrepareReuse?: boolean;
}>): SessionHandoffWorkspaceTransferStrategyValidationResult {
  if (!params.workspaceTransfer?.enabled) {
    return { ok: true };
  }

  if (
    params.workspaceTransfer.includeIgnoredMode !== 'include_selected'
    && params.workspaceTransfer.ignoredIncludeGlobs.length > 0
  ) {
    return {
      ok: false,
      errorCode: 'unsupported_workspace_transfer_strategy',
      error: 'Workspace transfer ignoredIncludeGlobs require includeIgnoredMode=include_selected',
      reasonCode: 'ignored_globs_require_include_selected',
    };
  }

  if (params.allowLocalPrepareReuse) {
    return { ok: true };
  }

  if (params.negotiatedTransportStrategy === 'server_routed_stream' && params.hasServerRoutedTransferChannel === false) {
    return {
      ok: false,
      errorCode: 'unsupported_workspace_transfer_strategy',
      error: 'Workspace transfer is unavailable for the negotiated transport strategy',
      reasonCode: 'server_routed_transfer_unavailable',
    };
  }

  if (
    params.negotiatedTransportStrategy === 'direct_peer'
    && params.hasDirectPeerTransfer === false
    && params.hasServerRoutedTransferChannel === false
  ) {
    return {
      ok: false,
      errorCode: 'unsupported_workspace_transfer_strategy',
      error: 'Workspace transfer is unavailable for the negotiated transport strategy',
      reasonCode: 'direct_peer_and_server_routed_unavailable',
    };
  }

  return { ok: true };
}

export function assertSupportedSessionHandoffWorkspaceTransferStrategy(params: Readonly<{
  workspaceTransfer?: SessionHandoffWorkspaceTransferInput;
}>): void {
  const validation = validateSessionHandoffWorkspaceTransferStrategy(params);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
}
