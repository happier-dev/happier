import { describe, expect, it } from 'vitest';

import {
  DaemonLocalServiceActionExecuteRequestV1Schema,
  DaemonLocalServiceActionExecuteResponseV1Schema,
} from '../local/services/actions/v1.js';
import {
  DaemonLocalServiceInventoryRefreshRequestV1Schema,
  DaemonLocalServiceInventoryRefreshResponseV1Schema,
  DaemonLocalServiceInventorySnapshotRequestV1Schema,
  DaemonLocalServiceInventorySnapshotResponseV1Schema,
} from '../local/services/inventory/v1.js';
import {
  DaemonLocalServiceLauncherSnapshotRequestV1Schema,
  DaemonLocalServiceLauncherSnapshotResponseV1Schema,
  DaemonLocalServiceLauncherStartRequestV1Schema,
  DaemonLocalServiceLauncherStartResponseV1Schema,
} from '../local/services/launcher/v1.js';
import {
  DaemonLocalServiceManagedSnapshotRequestV1Schema,
  DaemonLocalServiceManagedSnapshotResponseV1Schema,
} from '../local/services/managed/v1.js';
import {
  DaemonLocalServicePublicPreviewCopyUrlRequestV1Schema,
  DaemonLocalServicePublicPreviewCreateRequestV1Schema,
  DaemonLocalServicePublicPreviewRevokeRequestV1Schema,
  DaemonLocalServicePublicPreviewStatusRequestV1Schema,
} from '../local/services/public/v1.js';
import {
  RPC_ERROR_CODES,
  RPC_ERROR_MESSAGES,
  RPC_METHODS,
  SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
  SESSION_RPC_METHODS,
  isRpcMethodNotFoundResult,
  parseSocketRpcAuthorizationContext,
  resolveSocketRpcSessionWriteAuthorizationMethod,
} from './index.js';

describe('rpc wire compatibility', () => {
  it('pins negotiation literals used by mixed-version daemon and ui clients', () => {
    expect(RPC_ERROR_CODES).toEqual({
      METHOD_NOT_AVAILABLE: 'RPC_METHOD_NOT_AVAILABLE',
      METHOD_NOT_FOUND: 'RPC_METHOD_NOT_FOUND',
      FORBIDDEN: 'RPC_FORBIDDEN',
    });
    expect(RPC_ERROR_MESSAGES).toEqual({
      METHOD_NOT_AVAILABLE: 'RPC method not available',
      METHOD_NOT_FOUND: 'Method not found',
      FORBIDDEN: 'Forbidden',
    });
  });

  it('treats both legacy message-only and current coded method-not-found results as unsupported', () => {
    expect(isRpcMethodNotFoundResult({
      errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
      error: 'future daemon payload',
    })).toBe(true);
    expect(isRpcMethodNotFoundResult({
      error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND,
    })).toBe(true);
    expect(isRpcMethodNotFoundResult({
      error: `${RPC_ERROR_MESSAGES.METHOD_NOT_FOUND}: daemon.executionRuns.list`,
    })).toBe(false);
  });

  it('pins execution-run and replay method literals consumed across rpc boundaries', () => {
    expect(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST).toBe('daemon.executionRuns.list');
    expect(RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY).toBe('session.continueWithReplay');
    expect(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE).toBe(
      'daemon.extensions.contributionRegistryProjection.describe',
    );
    expect(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ).toBe('daemon.plugins.uiArtifacts.bytes.read');
    expect(RPC_METHODS.DAEMON_PLUGIN_UI_REACT_NATIVE_CRASH_REPORT_SUBMIT).toBe(
      'daemon.plugins.ui.reactNativeCrashReports.submit',
    );
    expect(RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT).toBe(
      'daemon.localServices.inventory.snapshot',
    );
    expect(RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH).toBe(
      'daemon.localServices.inventory.refresh',
    );
    expect(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT).toBe(
      'daemon.localServices.launcher.snapshot',
    );
    expect(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START).toBe(
      'daemon.localServices.launcher.start',
    );
    expect(RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE).toBe(
      'daemon.localServices.actions.execute',
    );
    expect(RPC_METHODS.DAEMON_LOCAL_SERVICES_MANAGED_SNAPSHOT).toBe(
      'daemon.localServices.managed.snapshot',
    );
    expect(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT).toBe('daemon.localServices.preview.snapshot');
    expect(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS).toBe(
      'daemon.localServices.publicPreview.status',
    );
    expect(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE).toBe(
      'daemon.localServices.publicPreview.create',
    );
    expect(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_REVOKE).toBe(
      'daemon.localServices.publicPreview.revoke',
    );
    expect(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_COPY_URL).toBe(
      'daemon.localServices.publicPreview.copyUrl',
    );
    expect(RPC_METHODS.DAEMON_BROWSER_CONTEXT_DISPATCH).toBe('daemon.browser.context.dispatch');
    expect(RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT).toBe('daemon.browser.diagnostics.snapshot');
    expect(RPC_METHODS.DAEMON_BROWSER_RECORDING_START).toBe('daemon.browser.recording.start');
    expect(RPC_METHODS.DAEMON_BROWSER_RECORDING_STOP).toBe('daemon.browser.recording.stop');
    expect(RPC_METHODS.DAEMON_BROWSER_RECORDING_CANCEL).toBe('daemon.browser.recording.cancel');
    expect(RPC_METHODS.DAEMON_BROWSER_RECORDING_STATUS).toBe('daemon.browser.recording.status');
    expect(RPC_METHODS.DAEMON_BROWSER_RECORDING_LIST).toBe('daemon.browser.recording.list');
    expect(RPC_METHODS.DAEMON_BROWSER_RECORDING_CLEANUP).toBe('daemon.browser.recording.cleanup');
    expect(RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_SNAPSHOT).toBe('daemon.devices.simulator.preview.snapshot');
    expect(RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_ACTION).toBe('daemon.devices.simulator.preview.action');
    expect(SESSION_RPC_METHODS.EXECUTION_RUN_START).toBe('execution.run.start');
    expect(SESSION_RPC_METHODS.EXECUTION_RUN_LIST).toBe('execution.run.list');
    expect((SESSION_RPC_METHODS as any).SESSION_TERMINAL_COMPOSER_CLEAR).toBe('session.terminalComposer.clear');
  });

  it('exposes only the live session generation-apply seam', () => {
    expect((RPC_METHODS as Record<string, string>).DAEMON_CONNECTED_SERVICE_AUTH_GROUP_GENERATION_APPLY).toBeUndefined();
    expect((SESSION_RPC_METHODS as Record<string, string>).SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION).toBe(
      'session.connectedServiceAuth.applyGeneration',
    );
  });

  it('classifies and parses session-write socket RPC authorization context', () => {
    expect(SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE).toBe('session.write');
    expect(resolveSocketRpcSessionWriteAuthorizationMethod(
      RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART,
    )).toBe(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART);
    expect(resolveSocketRpcSessionWriteAuthorizationMethod(
      `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART}`,
    )).toBe(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART);
    expect(resolveSocketRpcSessionWriteAuthorizationMethod(
      RPC_METHODS.STOP_SESSION,
    )).toBe(RPC_METHODS.STOP_SESSION);
    expect(resolveSocketRpcSessionWriteAuthorizationMethod(
      `machine-1:${RPC_METHODS.STOP_SESSION}`,
    )).toBe(RPC_METHODS.STOP_SESSION);
    expect(resolveSocketRpcSessionWriteAuthorizationMethod(
      RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL,
    )).toBeNull();
    expect(parseSocketRpcAuthorizationContext({
      kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
      sessionId: ' sess_1 ',
    })).toEqual({
      kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
      sessionId: 'sess_1',
    });
    expect(parseSocketRpcAuthorizationContext({
      kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
      sessionId: '',
    })).toBeNull();
  });

  it('parses Local Services inventory rpc envelopes for snapshot and refresh results', () => {
    expect(DaemonLocalServiceInventorySnapshotRequestV1Schema.parse({
      machineId: 'machine-a',
    })).toEqual({
      machineId: 'machine-a',
    });

    expect(DaemonLocalServiceInventoryRefreshRequestV1Schema.parse({
      machineId: 'machine-a',
    })).toEqual({
      machineId: 'machine-a',
    });

    const successSnapshot = {
      v: 1,
      machineId: 'machine-a',
      generatedAt: 3_000,
      refreshState: 'idle',
      entries: [],
      diagnostics: [],
    } as const;
    expect(DaemonLocalServiceInventorySnapshotResponseV1Schema.parse({
      protocolVersion: 1,
      snapshot: successSnapshot,
    }).snapshot.refreshState).toBe('idle');

    expect(DaemonLocalServiceInventoryRefreshResponseV1Schema.parse({
      protocolVersion: 1,
      snapshot: {
        ...successSnapshot,
        generatedAt: 3_500,
        refreshState: 'error',
        diagnostics: [{
          code: 'scan_failed',
          message: 'scanner unavailable',
          severity: 'error',
        }],
      },
    }).snapshot.refreshState).toBe('error');

    expect(DaemonLocalServiceInventorySnapshotResponseV1Schema.safeParse({
      protocolVersion: 1,
      snapshot: successSnapshot,
      controlServerToken: 'must-not-leak',
    }).success).toBe(false);
  });

  it('parses Local Services launcher snapshot and action execute rpc envelopes', () => {
    expect(DaemonLocalServiceLauncherSnapshotRequestV1Schema.parse({
      machineId: 'machine-a',
      sessionId: 'session-a',
    })).toEqual({
      machineId: 'machine-a',
      sessionId: 'session-a',
    });

    expect(DaemonLocalServiceLauncherSnapshotResponseV1Schema.parse({
      protocolVersion: 1,
      snapshot: {
        v: 1,
        machineId: 'machine-a',
        sessionId: 'session-a',
        updatedAt: 4_000,
        targets: [],
      },
    }).snapshot.machineId).toBe('machine-a');

    expect(DaemonLocalServiceLauncherStartRequestV1Schema.parse({
      machineId: 'machine-a',
      targetId: 'managed:web',
    })).toEqual({
      machineId: 'machine-a',
      targetId: 'managed:web',
    });

    expect(DaemonLocalServiceLauncherStartResponseV1Schema.parse({
      protocolVersion: 1,
      machineId: 'machine-a',
      targetId: 'managed:web',
      status: 'succeeded',
      snapshot: {
        v: 1,
        machineId: 'machine-a',
        updatedAt: 4_000,
        targets: [],
      },
    }).targetId).toBe('managed:web');

    const actionRequest = DaemonLocalServiceActionExecuteRequestV1Schema.parse({
      requestId: 'request-a',
      target: {
        kind: 'inventory_entry',
        inventoryEntryId: 'inventory-a',
        machineId: 'machine-a',
      },
      action: 'forget',
    });
    expect(actionRequest.action).toBe('forget');

    expect(DaemonLocalServiceActionExecuteResponseV1Schema.parse({
      protocolVersion: 1,
      result: {
        v: 1,
        requestId: 'request-a',
        action: 'forget',
        status: 'succeeded',
        auditEvents: [{
          v: 1,
          eventId: 'event-a',
          requestId: 'request-a',
          machineId: 'machine-a',
          action: 'forget',
          result: 'succeeded',
          recordedAt: 4_100,
        }],
      },
    }).result.status).toBe('succeeded');

    expect(DaemonLocalServiceActionExecuteResponseV1Schema.parse({
      protocolVersion: 1,
      result: {
        v: 1,
        requestId: 'request-b',
        action: 'terminate_detected',
        status: 'failed',
        reasonCode: 'process_not_found',
        auditEvents: [],
      },
    }).result.reasonCode).toBe('process_not_found');

    expect(DaemonLocalServiceActionExecuteResponseV1Schema.safeParse({
      protocolVersion: 1,
      result: {
        v: 1,
        requestId: 'request-b',
        action: 'terminate_detected',
        status: 'failed',
        auditEvents: [],
      },
    }).success).toBe(false);
  });

  it('parses Local Services managed runtime snapshot rpc envelopes', () => {
    expect(DaemonLocalServiceManagedSnapshotRequestV1Schema.parse({
      machineId: 'machine-a',
    })).toEqual({
      machineId: 'machine-a',
    });

    const response = DaemonLocalServiceManagedSnapshotResponseV1Schema.parse({
      protocolVersion: 1,
      snapshot: {
        v: 1,
        machineId: 'machine-a',
        generatedAt: 4_000,
        refreshState: 'idle',
        rows: [{
          v: 1,
          id: 'managed-a',
          owner: { kind: 'plugin', pluginId: 'plugin-a' },
          phase: 'running',
          launchMode: 'detectAfterLaunch',
          process: { pid: 123, startedAt: 1_000 },
          routeName: 'plugin-a-web',
          supportedActions: ['restart_managed'],
          diagnostics: [],
        }],
        diagnostics: [],
      },
    });

    expect(response.snapshot.rows[0]?.supportedActions).toEqual(['restart_managed']);
    expect(DaemonLocalServiceManagedSnapshotResponseV1Schema.safeParse({
      protocolVersion: 1,
      snapshot: response.snapshot,
      launch: { kind: 'binary', executablePath: '/bin/sh' },
    }).success).toBe(false);
  });

  it('parses Local Services public preview rpc control envelopes', () => {
    expect(DaemonLocalServicePublicPreviewStatusRequestV1Schema.parse({
      machineId: 'machine-a',
      sessionId: 'session-a',
      previewId: 'preview-a',
    })).toEqual({
      machineId: 'machine-a',
      sessionId: 'session-a',
      previewId: 'preview-a',
    });

    expect(DaemonLocalServicePublicPreviewCreateRequestV1Schema.parse({
      machineId: 'machine-a',
      sessionId: 'session-a',
      previewId: 'preview-a',
      mode: 'secret_link',
      ttlMs: 300_000,
    })).toEqual({
      machineId: 'machine-a',
      sessionId: 'session-a',
      previewId: 'preview-a',
      mode: 'secret_link',
      ttlMs: 300_000,
    });

    expect(DaemonLocalServicePublicPreviewRevokeRequestV1Schema.parse({
      machineId: 'machine-a',
      sessionId: 'session-a',
      previewId: 'preview-a',
      exposureId: 'exposure-a',
    })).toEqual({
      machineId: 'machine-a',
      sessionId: 'session-a',
      previewId: 'preview-a',
      exposureId: 'exposure-a',
    });

    expect(DaemonLocalServicePublicPreviewCopyUrlRequestV1Schema.parse({
      machineId: 'machine-a',
      sessionId: 'session-a',
      previewId: 'preview-a',
      exposureId: 'exposure-a',
    })).toEqual({
      machineId: 'machine-a',
      sessionId: 'session-a',
      previewId: 'preview-a',
      exposureId: 'exposure-a',
    });
  });
});
