import { randomBytes, randomUUID } from 'node:crypto';

import {
  BrowserDiagnosticsSnapshotV1Schema,
  FeaturesResponseSchema,
  type BrowserDiagnosticEventV1,
  type ExecutionRunPublicState,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { dispatchRuntimeActionE2E } from '../../src/testkit/liveQa/runtimeActionE2E';
import type { SocketCollector } from '../../src/testkit/socketClient';

import { resolveExecutionRunPolicy } from '../../../../apps/cli/src/agent/executionRuns/policy/executionRunPolicy';
import type { ExecutionRunHostBridgeContract } from '../../../../apps/cli/src/agent/runtime/bridges/executionRun/executionRunBridgeContract';
import { RpcHandlerManager } from '../../../../apps/cli/src/api/rpc/RpcHandlerManager';
import { createBrowserDiagnosticsActionRoutes } from '../../../../apps/cli/src/daemon/browser/diagnostics/actionRoutes';
import { redactBrowserDiagnosticsSnapshotForViewer } from '../../../../apps/cli/src/daemon/browser/diagnostics/snapshotEgress';
import { createBrowserDiagnosticsDaemonStore } from '../../../../apps/cli/src/daemon/browser/diagnostics/store';
import type { CliServerFeaturesSnapshot } from '../../../../apps/cli/src/features/serverFeaturesClient';
import { createExecutionRunRpcActionExecutor } from '../../../../apps/cli/src/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction';
import { registerExecutionRunRpcHandlers } from '../../../../apps/cli/src/rpc/handlers/executionRuns/registerExecutionRunRpcHandlers';

const SESSION_ID = 'session_browser_dispatch_e2e';
const RUN_ID = 'run_browser_dispatch_e2e';
const BROWSER_SESSION_ID = 'browser_session_dispatch_e2e';
const VIEW_ID = 'browser_view_dispatch_e2e';

function unusedExecutionRunBridgeMethod(): never {
  throw new Error('browser runtime-action dispatch must not use execution-run profile actions');
}

function createExecutionRunBridgeWithRun(): ExecutionRunHostBridgeContract {
  const run = {
    runId: RUN_ID,
    callId: 'call_browser_dispatch_e2e',
    sidechainId: 'sidechain_browser_dispatch_e2e',
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    permissionMode: 'default',
    retentionPolicy: 'ephemeral',
    runClass: 'bounded',
    ioMode: 'request_response',
    status: 'running',
    startedAtMs: 1,
  } satisfies ExecutionRunPublicState;

  return {
    get: () => null,
    getRunningCount: () => 0,
    getStructuredMeta: () => null,
    getLatestToolResult: () => null,
    waitForTerminal: async () => unusedExecutionRunBridgeMethod(),
    getPublic: (runId: string) => (runId === RUN_ID ? run : null),
    listPublic: () => [run],
    listPublicForRequest: () => [run],
    getDepthByRunId: () => null,
    getDepthByCallId: () => null,
    start: async () => unusedExecutionRunBridgeMethod(),
    send: async () => unusedExecutionRunBridgeMethod(),
    ensure: async () => unusedExecutionRunBridgeMethod(),
    ensureOrStart: async () => unusedExecutionRunBridgeMethod(),
    startTurnStream: async () => unusedExecutionRunBridgeMethod(),
    readTurnStream: async () => unusedExecutionRunBridgeMethod(),
    cancelTurnStream: async () => unusedExecutionRunBridgeMethod(),
    stop: async () => unusedExecutionRunBridgeMethod(),
    respondToPermissionRequest: async () => unusedExecutionRunBridgeMethod(),
    applyAction: async () => unusedExecutionRunBridgeMethod(),
  };
}

function readyServerFeatures(features: Record<string, unknown>): CliServerFeaturesSnapshot {
  return {
    status: 'ready',
    features: FeaturesResponseSchema.parse({ features }),
  };
}

const BROWSER_DIAGNOSTICS_RUNTIME_ACTIONS_ENABLED = readyServerFeatures({
  browser: {
    enabled: true,
    viewTargets: { enabled: true },
    internal: { enabled: true },
    sidecar: { enabled: true },
    diagnostics: { enabled: true },
    context: { enabled: true },
    automation: { enabled: true },
    recording: { enabled: true, attachments: { enabled: true } },
  },
});

function createRuntimeActionSocket(params: Readonly<{
  secret: Uint8Array;
  diagnostics: ReturnType<typeof createBrowserDiagnosticsActionRoutes>;
}>): SocketCollector {
  const policy = resolveExecutionRunPolicy({
    defaults: {
      maxConcurrentRuns: null,
      boundedTimeoutMs: null,
      reviewBoundedTimeoutMs: null,
      maxTurns: null,
      maxDepth: 3,
    },
  });
  const actionExecutor = createExecutionRunRpcActionExecutor({
    manager: createExecutionRunBridgeWithRun(),
    context: {
      sessionId: SESSION_ID,
      cwd: '/workspace',
      browserDiagnostics: params.diagnostics,
      getServerFeaturesSnapshot: () => BROWSER_DIAGNOSTICS_RUNTIME_ACTIONS_ENABLED,
    },
    policy,
    isExecutionRunsEnabled: () => true,
  });
  const rpc = new RpcHandlerManager({
    scopePrefix: SESSION_ID,
    encryptionKey: params.secret,
    encryptionVariant: 'legacy',
    logger: () => undefined,
  });
  registerExecutionRunRpcHandlers(rpc, {
    sessionId: SESSION_ID,
    cwd: '/workspace',
    parentProvider: 'codex',
    sendAcp: async () => undefined,
    policy,
    actionExecutor,
  });

  const ui = {
    rpcCall: async <TResponse = unknown>(method: string, encryptedParams: string): Promise<TResponse> => {
      const encryptedResponse = await rpc.handleRequest({ method, params: encryptedParams });
      if (typeof encryptedResponse !== 'string') {
        throw new Error('Expected encrypted execution-run RPC response');
      }
      return { ok: true, result: encryptedResponse } as TResponse;
    },
  };

  // The L6 helper only needs rpcCall; RpcHandlerManager still owns decryption and handler dispatch.
  return ui as unknown as SocketCollector;
}

describe('core e2e: browser runtime-action dispatch via execution.run.action', () => {
  afterEach(() => {
    delete process.env.HAPPIER_BROWSER_ENABLED;
  });

  it.skip('TODO real managed Chrome sidecar: navigates, clicks, types, and snapshots through real browser automation producers', async () => {
    throw new Error(
      [
        'TODO real managed Chrome sidecar: run browser.automation.navigate/click/type/snapshot against',
        'a launched Chromium sidecar and assert snapshot.interactiveElements[].selector is producer output.',
      ].join(' '),
    );
  });

  it.skip('TODO real managed Chrome recording producer: records to an artifact using browser.recording.start/stop', async () => {
    throw new Error(
      [
        'TODO real managed Chrome recording producer: run browser.recording.start/stop with a live',
        'Chromium/CDP screencast-capable sidecar and assert the finalized recording artifact exists.',
      ].join(' '),
    );
  });

  it('dispatches browser.diagnostics.snapshot through the L6 helper and redacts agent egress', async () => {
    const secret = new Uint8Array(randomBytes(32));
    const token = `tok_${randomUUID().replaceAll('-', '')}`;
    const tokenUrl = `https://app.example/reset/${token}?token=${token}`;
    const store = createBrowserDiagnosticsDaemonStore({
      machineId: 'machine_browser_dispatch_e2e',
      now: () => 20_000,
    });
    const event = {
      v: 1,
      eventId: 'event_browser_dispatch_token',
      browserSessionId: BROWSER_SESSION_ID,
      viewId: VIEW_ID,
      navigationGeneration: 1,
      capturedAtMs: 19_000,
      family: 'console',
      kind: 'console.entry',
      fidelity: 'injectedPage',
      trusted: false,
      collector: { collectorId: 'collector_browser_dispatch', nonce: 'nonce_browser_dispatch', version: '1.0.0' },
      data: {
        level: 'log',
        argCount: 1,
        textAvailable: true,
        text: `reset link: ${tokenUrl}`,
      },
      redaction: {
        level: 'none',
        queryRedacted: false,
        headersRedacted: false,
        truncated: false,
      },
    } satisfies BrowserDiagnosticEventV1;

    expect(store.publishEvent(event)).toEqual({ status: 'accepted' });

    const ownerSnapshot = redactBrowserDiagnosticsSnapshotForViewer(
      store.getViewSnapshot({ browserSessionId: BROWSER_SESSION_ID, viewId: VIEW_ID }),
      'owner',
    );
    expect(JSON.stringify(ownerSnapshot)).toContain(tokenUrl);
    expect(ownerSnapshot.events[0]?.redaction.level).toBe('none');

    const diagnostics = createBrowserDiagnosticsActionRoutes({ store });
    const ui = createRuntimeActionSocket({ secret, diagnostics });
    const response = await dispatchRuntimeActionE2E(
      { ui, sessionId: SESSION_ID, runId: RUN_ID, secret, timeoutMs: 10_000 },
      'browser.diagnostics.snapshot',
      { browserSessionId: BROWSER_SESSION_ID, viewId: VIEW_ID },
    );

    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error(`diagnostics dispatch failed: ${response.errorCode}`);
    }
    const snapshot = BrowserDiagnosticsSnapshotV1Schema.parse(response.result);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({
      eventId: 'event_browser_dispatch_token',
      redaction: { level: 'metadataOnly' },
      data: {
        level: 'log',
        argCount: 1,
        textAvailable: true,
      },
    });
    expect(snapshot.events[0]?.data).not.toHaveProperty('text');
    const agentSerialized = JSON.stringify(snapshot);
    expect(agentSerialized).not.toContain(token);
    expect(agentSerialized).not.toContain(`/reset/${token}`);
    expect(agentSerialized).not.toContain(`token=${token}`);
  });
});
