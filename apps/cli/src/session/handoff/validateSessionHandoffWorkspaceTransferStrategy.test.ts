import { describe, expect, it } from 'vitest';

import { validateSessionHandoffWorkspaceTransferStrategy } from './validateSessionHandoffWorkspaceTransferStrategy';

const enabledWorkspaceTransfer = {
  enabled: true,
  strategy: 'sync_changes' as const,
  conflictPolicy: 'create_sibling_copy' as const,
  includeIgnoredMode: 'exclude' as const,
  ignoredIncludeGlobs: [],
};

describe('validateSessionHandoffWorkspaceTransferStrategy', () => {
  it('allows handoff when workspace transfer is disabled', () => {
    expect(
      validateSessionHandoffWorkspaceTransferStrategy({
        workspaceTransfer: {
          ...enabledWorkspaceTransfer,
          enabled: false,
        },
      }),
    ).toEqual({ ok: true });
  });

  it('rejects workspace transfer when server-routed transport is negotiated without a receive channel', () => {
    expect(
      validateSessionHandoffWorkspaceTransferStrategy({
        workspaceTransfer: enabledWorkspaceTransfer,
        negotiatedTransportStrategy: 'server_routed_stream',
        hasServerRoutedTransferChannel: false,
      }),
    ).toEqual({
      ok: false,
      errorCode: 'unsupported_workspace_transfer_strategy',
      error: 'Workspace transfer is unavailable for the negotiated transport strategy',
      reasonCode: 'server_routed_transfer_unavailable',
    });
  });

  it('rejects workspace transfer when direct-peer is negotiated without direct-peer transport or server-routed fallback', () => {
    expect(
      validateSessionHandoffWorkspaceTransferStrategy({
        workspaceTransfer: enabledWorkspaceTransfer,
        negotiatedTransportStrategy: 'direct_peer',
        hasDirectPeerTransfer: false,
        hasServerRoutedTransferChannel: false,
      }),
    ).toEqual({
      ok: false,
      errorCode: 'unsupported_workspace_transfer_strategy',
      error: 'Workspace transfer is unavailable for the negotiated transport strategy',
      reasonCode: 'direct_peer_and_server_routed_unavailable',
    });
  });

  it('allows direct-peer workspace transfer when server-routed fallback remains available', () => {
    expect(
      validateSessionHandoffWorkspaceTransferStrategy({
        workspaceTransfer: enabledWorkspaceTransfer,
        negotiatedTransportStrategy: 'direct_peer',
        hasDirectPeerTransfer: false,
        hasServerRoutedTransferChannel: true,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects ignored globs when includeIgnoredMode is not include_selected', () => {
    expect(
      validateSessionHandoffWorkspaceTransferStrategy({
        workspaceTransfer: {
          ...enabledWorkspaceTransfer,
          ignoredIncludeGlobs: ['dist/**'],
        },
      }),
    ).toEqual({
      ok: false,
      errorCode: 'unsupported_workspace_transfer_strategy',
      error: 'Workspace transfer ignoredIncludeGlobs require includeIgnoredMode=include_selected',
      reasonCode: 'ignored_globs_require_include_selected',
    });
  });
});
