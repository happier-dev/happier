import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BrowserDiagnosticsSnapshotV1Schema,
  FeaturesResponseSchema,
  type BrowserDiagnosticEventV1,
} from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchRuntimeActionE2E } from '../../src/testkit/liveQa/runtimeActionE2E';
import type { RpcSocket } from '../../src/testkit/syntheticAgent/rpcClient';

import type { ExecutionRunHostBridge } from '../../../../apps/cli/src/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import type { ExecutionRunState } from '../../../../apps/cli/src/agent/runtime/bridges/executionRun/executionRunTypes';
import { RpcHandlerManager } from '../../../../apps/cli/src/api/rpc/RpcHandlerManager';
import { reloadConfiguration } from '../../../../apps/cli/src/configuration';
import { retainExecutionRunState } from '../../../../apps/cli/src/daemon/executionRunRegistry';
import { createBrowserDiagnosticsActionRoutes } from '../../../../apps/cli/src/daemon/browser/diagnostics/actionRoutes';
import { redactBrowserDiagnosticsSnapshotForViewer } from '../../../../apps/cli/src/daemon/browser/diagnostics/snapshotEgress';
import { createBrowserDiagnosticsDaemonStore } from '../../../../apps/cli/src/daemon/browser/diagnostics/store';
import type { CliServerFeaturesSnapshot } from '../../../../apps/cli/src/features/serverFeaturesClient';
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
 * "socket" is a fake whose `emitWithAck` calls `rpc.handleRequest` in the same process. A real
 * execution-run bridge recovers a Session-owned terminal run from real device-local storage;
 * no agent process is launched. So this closes the dispatch and
 * redaction half of BRW-F9 and says nothing about the producer half — that is
 * `suites/core-e2e/browserAutomationProducer.slow.e2e.test.ts`, which is still unimplemented.
 * The file was previously named `browserProducerBacked.l6LiveQa.slow.e2e.test.ts` and tiered as a
 * slow e2e; both claimed a producer and a process boundary it never had.
 */

const SESSION_ID = 'session_browser_dispatch_layer';
const RUN_ID = 'run_browser_dispatch_layer';
// Session runtime Actions address that Session's daemon browser workspace.
const BROWSER_SESSION_ID = SESSION_ID;
const VIEW_ID = 'browser_view_dispatch_e2e';

async function retainSessionOwnedRun(): Promise<void> {
  // Runtime Actions require an authoritative Session-owned run, not a running agent process.
  // Seed through the canonical retained-state writer, then let the real bridge recover it.
  // This exercises the same recovery that executionRunAction performs before admitting dispatch.
  const runState = {
    runId: RUN_ID,
    callId: 'call_browser_dispatch_e2e',
    sidechainId: 'sidechain_browser_dispatch_e2e',
    sessionId: SESSION_ID,
    depth: 0,
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    backendId: 'codex',
    instructions: 'browser runtime-action dispatch layer coverage',
    permissionMode: 'default',
    retentionPolicy: 'ephemeral',
    runClass: 'bounded',
    ioMode: 'request_response',
    status: 'succeeded',
    startedAtMs: 1,
    finishedAtMs: 2,
  } satisfies ExecutionRunState;
  await retainExecutionRunState(runState);
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
  cwd: string;
  onManagerCreated: (manager: ExecutionRunHostBridge) => void;
}>): RpcSocket {
  const rpc = new RpcHandlerManager({
    scopePrefix: SESSION_ID,
    encryptionKey: params.secret,
    encryptionVariant: 'legacy',
    logger: () => undefined,
  });
  registerExecutionRunRpcHandlers(rpc, {
    sessionId: SESSION_ID,
    cwd: params.cwd,
    parentProvider: 'codex',
    sendAcp: async () => undefined,
    browserDiagnostics: params.diagnostics,
    getServerFeaturesSnapshot: () => BROWSER_DIAGNOSTICS_RUNTIME_ACTIONS_ENABLED,
    onManagerCreated: params.onManagerCreated,
  });

  const ui = {
    emit: () => {},
    emitWithAck: async <TResponse = unknown>(_event: string, data: unknown): Promise<TResponse> => {
      // The fake network accepts the canonical caller's request payload.
      const request = data as { method: string; params: unknown };
      const encryptedResponse = await rpc.handleRequest(request);
      if (typeof encryptedResponse !== 'string') {
        throw new Error('Expected encrypted execution-run RPC response');
      }
      return { ok: true, result: encryptedResponse } as TResponse;
    },
  };

  // Only the network boundary is replaced; canonical caller/codec and real responder still run.
  return ui;
}

describe('core layer: browser runtime-action dispatch and agent-egress redaction', () => {
  let directory: string;
  let manager: ExecutionRunHostBridge | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'happier-browser-dispatch-layer-'));
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
    reloadConfiguration();
  });

  afterEach(async () => {
    await manager?.dispose();
    manager = undefined;
    vi.unstubAllEnvs();
    reloadConfiguration();
    rmSync(directory, { recursive: true, force: true });
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
    await retainSessionOwnedRun();
    const ui = createRuntimeActionSocket({
      secret, diagnostics, cwd: directory,
      onManagerCreated: (created) => { manager = created; },
    });
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

    // A valid view in another browser workspace cannot be read through this Session's Run.
    await expect(dispatchRuntimeActionE2E(
      { ui, sessionId: SESSION_ID, runId: RUN_ID, secret, timeoutMs: 10_000 },
      'browser.diagnostics.snapshot',
      { browserSessionId: 'another_session', viewId: VIEW_ID },
    )).rejects.toThrow(/execution_run_invalid_action_input/);
  });
});
