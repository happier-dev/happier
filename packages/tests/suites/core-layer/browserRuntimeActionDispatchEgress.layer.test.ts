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
import type { ExecutionRunState } from '../../../../apps/cli/src/agent/runtime/bridges/executionRun/executionRunTypes';
import { RpcHandlerManager } from '../../../../apps/cli/src/api/rpc/RpcHandlerManager';
import { createBrowserDiagnosticsActionRoutes } from '../../../../apps/cli/src/daemon/browser/diagnostics/actionRoutes';
import { redactBrowserDiagnosticsSnapshotForViewer } from '../../../../apps/cli/src/daemon/browser/diagnostics/snapshotEgress';
import { createBrowserDiagnosticsDaemonStore } from '../../../../apps/cli/src/daemon/browser/diagnostics/store';
import type { CliServerFeaturesSnapshot } from '../../../../apps/cli/src/features/serverFeaturesClient';
import { createExecutionRunRpcActionExecutor } from '../../../../apps/cli/src/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction';
import { registerExecutionRunRpcHandlers } from '../../../../apps/cli/src/rpc/handlers/executionRuns/registerExecutionRunRpcHandlers';

/**
 * Layer coverage for the browser runtime-action DISPATCH + agent-egress REDACTION path
 * (BRW-F9 read half).
 *
 * WHAT THIS PROVES. A `browser.diagnostics.snapshot` dispatch travels the real cross-boundary
 * chain in-process: the encrypted execution-run RPC envelope (`RpcHandlerManager` with a real
 * key), the real handler registration, the real execution-run action executor, the real daemon
 * diagnostics action routes, the real daemon diagnostics store, and the real protocol redaction
 * owner. The `owner` projection keeps the seeded reset token; the `agent` projection must not
 * contain it anywhere in its serialization.
 *
 * WHAT THIS DOES NOT PROVE — read this before citing it. The diagnostic event is HAND-AUTHORED
 * and injected straight into the daemon store; no collector, page, or browser produced it. The
 * "socket" is a fake whose `rpcCall` calls `rpc.handleRequest` in the same process, and the
 * execution-run bridge is a stub whose non-read methods throw. So this closes the dispatch and
 * redaction half of BRW-F9 and says nothing about the producer half — that is
 * `suites/core-e2e/browserAutomationProducer.slow.e2e.test.ts`, which is still unimplemented.
 * The file was previously named `browserProducerBacked.l6LiveQa.slow.e2e.test.ts` and tiered as a
 * slow e2e; both claimed a producer and a process boundary it never had.
 */

const SESSION_ID = 'session_browser_dispatch_layer';
const RUN_ID = 'run_browser_dispatch_layer';
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

  // `executionRunAction` admits the dispatch through `getRunInAuthoritativeScope`, which reads
  // `manager.get(runId)` and requires `sessionId` to match the RPC scope; it then reads
  // `permissionMode` off that state to build the runtime-action caller context. The predecessor
  // file stubbed `get` as `() => null`, so every dispatch short-circuited to
  // `execution_run_not_found` and the redaction assertions below were never reached.
  const runState = {
    runId: RUN_ID,
    callId: run.callId,
    sidechainId: run.sidechainId,
    sessionId: SESSION_ID,
    depth: 0,
    intent: run.intent,
    backendTarget: run.backendTarget,
    backendId: 'codex',
    instructions: 'browser runtime-action dispatch layer coverage',
    permissionMode: run.permissionMode,
    retentionPolicy: run.retentionPolicy,
    runClass: run.runClass,
    ioMode: run.ioMode,
    status: run.status,
    startedAtMs: run.startedAtMs,
  } satisfies ExecutionRunState;

  return {
    get: (runId: string) => (runId === RUN_ID ? runState : null),
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

describe('core layer: browser runtime-action dispatch and agent-egress redaction', () => {
  afterEach(() => {
    delete process.env.HAPPIER_BROWSER_ENABLED;
  });

  it('dispatches browser.diagnostics.snapshot through the encrypted execution-run RPC and redacts agent egress', async () => {
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
