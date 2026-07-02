import { describe, expect, it } from 'vitest';

import { existsSync, readFileSync } from 'node:fs';

import { __resetToolTraceForTests } from '@/agent/tools/trace/toolTrace';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createSessionClientWithMetadata } from '@/testkit/backends/sessionFixtures';
import { withToolTraceFile } from '@/testkit/logger/toolTraceFile';

import { createAcpRuntime } from '../createAcpRuntime';

async function withTraceMarkerCapture(
  prefix: string,
  traceMarkersEnabled: boolean,
  fn: (traceFile: string) => Promise<void>,
): Promise<void> {
  await withToolTraceFile(prefix, fn, {
    env: {
      HAPPIER_E2E_ACP_TRACE_MARKERS: traceMarkersEnabled ? '1' : undefined,
    },
  });
}

function createTraceMarkerRuntime(backend: ReturnType<typeof createFakeAcpRuntimeBackend>) {
  const { session } = createSessionClientWithMetadata();

  return createAcpRuntime({
    provider: 'codex',
    directory: '/tmp',
    session,
    messageBuffer: new MessageBuffer(),
    mcpServers: {},
    permissionHandler: createApprovedPermissionHandler(),
    onThinkingChange: () => {},
    ensureBackend: async () => backend,
    inFlightSteer: { enabled: true },
  });
}

describe('createAcpRuntime trace marker capture', () => {
  it('records ACP stub markers into tool trace when enabled', async () => {
    await withTraceMarkerCapture('happier-acp-trace-markers-', true, async (traceFile) => {
      const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' });
      const runtime = createTraceMarkerRuntime(backend);

      await runtime.startOrLoad({ resumeId: null });
      backend.emit({ type: 'model-output', textDelta: 'ACP_STUB_RUNNING primary=abc123' } as any);

      const raw = existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : '';
      expect(raw).toContain('ACP_STUB_RUNNING primary=abc123');
    });
  });

  it('does not record ACP status running markers when e2e trace markers are disabled', async () => {
    await withTraceMarkerCapture(
      'happier-acp-trace-status-running-disabled-',
      false,
      async (traceFile) => {
      const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' });
      const runtime = createTraceMarkerRuntime(backend);

      await runtime.startOrLoad({ resumeId: null });
      runtime.beginTurn();
      backend.emit({ type: 'status', status: 'running' } as any);

      const raw = existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : '';
      expect(raw).not.toContain('acp_status_running');
    });
  });

  it('records ACP status running markers into tool trace when enabled', async () => {
    await withTraceMarkerCapture('happier-acp-trace-status-running-', true, async (traceFile) => {
      const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' });
      const runtime = createTraceMarkerRuntime(backend);

      await runtime.startOrLoad({ resumeId: null });
      runtime.beginTurn();
      backend.emit({ type: 'status', status: 'running' } as any);

      const raw = existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : '';
      expect(raw).toContain('acp_status_running');
    });
  });

  it('does not record ACP in-flight steer markers when e2e trace markers are disabled', async () => {
    await withTraceMarkerCapture(
      'happier-acp-trace-in-flight-steer-disabled-',
      false,
      async (traceFile) => {
      const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' }) as any;
      backend.sendSteerPrompt = async () => {};
      const runtime = createTraceMarkerRuntime(backend) as any;

      await runtime.startOrLoad({ resumeId: null });
      await runtime.steerPrompt('steer text');

      const raw = existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : '';
      expect(raw).not.toContain('acp_in_flight_steer');
    });
  });

  it('records ACP in-flight steer markers into tool trace when enabled', async () => {
    await withTraceMarkerCapture('happier-acp-trace-in-flight-steer-', true, async (traceFile) => {
      const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' }) as any;
      backend.sendSteerPrompt = async () => {};
      const runtime = createTraceMarkerRuntime(backend) as any;

      await runtime.startOrLoad({ resumeId: null });
      await runtime.steerPrompt('steer text');

      const raw = existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : '';
      expect(raw).toContain('acp_in_flight_steer');
    });
  });
});
