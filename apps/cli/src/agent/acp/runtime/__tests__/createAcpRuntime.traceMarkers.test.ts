import { describe, expect, it } from 'vitest';

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __resetToolTraceForTests } from '@/agent/tools/trace/toolTrace';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createAcpRuntime } from '../createAcpRuntime';
import {
  createApprovedPermissionHandler,
  createFakeAcpRuntimeBackend,
  createSessionClientWithMetadata,
} from '../createAcpRuntime.testkit';

describe('createAcpRuntime trace marker capture', () => {
  it('records ACP stub markers into tool trace when enabled', async () => {
    const prevTrace = process.env.HAPPIER_STACK_TOOL_TRACE;
    const prevTraceFile = process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
    const prevMarkers = process.env.HAPPIER_E2E_ACP_TRACE_MARKERS;

    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-trace-markers-'));
    const traceFile = join(dir, 'tooltrace.jsonl');

    try {
      process.env.HAPPIER_STACK_TOOL_TRACE = '1';
      process.env.HAPPIER_STACK_TOOL_TRACE_FILE = traceFile;
      process.env.HAPPIER_E2E_ACP_TRACE_MARKERS = '1';
      __resetToolTraceForTests();

      const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' });
      const { session } = createSessionClientWithMetadata();

      const runtime = createAcpRuntime({
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

      await runtime.startOrLoad({ resumeId: null });
      backend.emit({ type: 'model-output', textDelta: 'ACP_STUB_RUNNING primary=abc123' } as any);

      const raw = existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : '';
      expect(raw).toContain('ACP_STUB_RUNNING primary=abc123');
    } finally {
      if (prevTrace === undefined) delete (process.env as any).HAPPIER_STACK_TOOL_TRACE;
      else process.env.HAPPIER_STACK_TOOL_TRACE = prevTrace;

      if (prevTraceFile === undefined) delete (process.env as any).HAPPIER_STACK_TOOL_TRACE_FILE;
      else process.env.HAPPIER_STACK_TOOL_TRACE_FILE = prevTraceFile;

      if (prevMarkers === undefined) delete (process.env as any).HAPPIER_E2E_ACP_TRACE_MARKERS;
      else process.env.HAPPIER_E2E_ACP_TRACE_MARKERS = prevMarkers;

      __resetToolTraceForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not record ACP status running markers when e2e trace markers are disabled', async () => {
    const prevTrace = process.env.HAPPIER_STACK_TOOL_TRACE;
    const prevTraceFile = process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
    const prevMarkers = process.env.HAPPIER_E2E_ACP_TRACE_MARKERS;

    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-trace-status-running-disabled-'));
    const traceFile = join(dir, 'tooltrace.jsonl');

    try {
      process.env.HAPPIER_STACK_TOOL_TRACE = '1';
      process.env.HAPPIER_STACK_TOOL_TRACE_FILE = traceFile;
      delete (process.env as any).HAPPIER_E2E_ACP_TRACE_MARKERS;
      __resetToolTraceForTests();

      const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' });
      const { session } = createSessionClientWithMetadata();

      const runtime = createAcpRuntime({
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

      await runtime.startOrLoad({ resumeId: null });
      backend.emit({ type: 'status', status: 'running' } as any);

      const raw = existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : '';
      expect(raw).not.toContain('acp_status_running');
    } finally {
      if (prevTrace === undefined) delete (process.env as any).HAPPIER_STACK_TOOL_TRACE;
      else process.env.HAPPIER_STACK_TOOL_TRACE = prevTrace;

      if (prevTraceFile === undefined) delete (process.env as any).HAPPIER_STACK_TOOL_TRACE_FILE;
      else process.env.HAPPIER_STACK_TOOL_TRACE_FILE = prevTraceFile;

      if (prevMarkers === undefined) delete (process.env as any).HAPPIER_E2E_ACP_TRACE_MARKERS;
      else process.env.HAPPIER_E2E_ACP_TRACE_MARKERS = prevMarkers;

      __resetToolTraceForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records ACP status running markers into tool trace when enabled', async () => {
    const prevTrace = process.env.HAPPIER_STACK_TOOL_TRACE;
    const prevTraceFile = process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
    const prevMarkers = process.env.HAPPIER_E2E_ACP_TRACE_MARKERS;

    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-trace-status-running-'));
    const traceFile = join(dir, 'tooltrace.jsonl');

    try {
      process.env.HAPPIER_STACK_TOOL_TRACE = '1';
      process.env.HAPPIER_STACK_TOOL_TRACE_FILE = traceFile;
      process.env.HAPPIER_E2E_ACP_TRACE_MARKERS = '1';
      __resetToolTraceForTests();

      const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' });
      const { session } = createSessionClientWithMetadata();

      const runtime = createAcpRuntime({
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

      await runtime.startOrLoad({ resumeId: null });
      backend.emit({ type: 'status', status: 'running' } as any);

      const raw = existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : '';
      expect(raw).toContain('acp_status_running');
    } finally {
      if (prevTrace === undefined) delete (process.env as any).HAPPIER_STACK_TOOL_TRACE;
      else process.env.HAPPIER_STACK_TOOL_TRACE = prevTrace;

      if (prevTraceFile === undefined) delete (process.env as any).HAPPIER_STACK_TOOL_TRACE_FILE;
      else process.env.HAPPIER_STACK_TOOL_TRACE_FILE = prevTraceFile;

      if (prevMarkers === undefined) delete (process.env as any).HAPPIER_E2E_ACP_TRACE_MARKERS;
      else process.env.HAPPIER_E2E_ACP_TRACE_MARKERS = prevMarkers;

      __resetToolTraceForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not record ACP in-flight steer markers when e2e trace markers are disabled', async () => {
    const prevTrace = process.env.HAPPIER_STACK_TOOL_TRACE;
    const prevTraceFile = process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
    const prevMarkers = process.env.HAPPIER_E2E_ACP_TRACE_MARKERS;

    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-trace-in-flight-steer-disabled-'));
    const traceFile = join(dir, 'tooltrace.jsonl');

    try {
      process.env.HAPPIER_STACK_TOOL_TRACE = '1';
      process.env.HAPPIER_STACK_TOOL_TRACE_FILE = traceFile;
      delete (process.env as any).HAPPIER_E2E_ACP_TRACE_MARKERS;
      __resetToolTraceForTests();

      const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' }) as any;
      backend.sendSteerPrompt = async () => {};
      const { session } = createSessionClientWithMetadata();

      const runtime = createAcpRuntime({
        provider: 'codex',
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange: () => {},
        ensureBackend: async () => backend,
        inFlightSteer: { enabled: true },
      } as any);

      await runtime.startOrLoad({ resumeId: null });
      await runtime.steerPrompt('steer text');

      const raw = existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : '';
      expect(raw).not.toContain('acp_in_flight_steer');
    } finally {
      if (prevTrace === undefined) delete (process.env as any).HAPPIER_STACK_TOOL_TRACE;
      else process.env.HAPPIER_STACK_TOOL_TRACE = prevTrace;

      if (prevTraceFile === undefined) delete (process.env as any).HAPPIER_STACK_TOOL_TRACE_FILE;
      else process.env.HAPPIER_STACK_TOOL_TRACE_FILE = prevTraceFile;

      if (prevMarkers === undefined) delete (process.env as any).HAPPIER_E2E_ACP_TRACE_MARKERS;
      else process.env.HAPPIER_E2E_ACP_TRACE_MARKERS = prevMarkers;

      __resetToolTraceForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records ACP in-flight steer markers into tool trace when enabled', async () => {
    const prevTrace = process.env.HAPPIER_STACK_TOOL_TRACE;
    const prevTraceFile = process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
    const prevMarkers = process.env.HAPPIER_E2E_ACP_TRACE_MARKERS;

    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-trace-in-flight-steer-'));
    const traceFile = join(dir, 'tooltrace.jsonl');

    try {
      process.env.HAPPIER_STACK_TOOL_TRACE = '1';
      process.env.HAPPIER_STACK_TOOL_TRACE_FILE = traceFile;
      process.env.HAPPIER_E2E_ACP_TRACE_MARKERS = '1';
      __resetToolTraceForTests();

      const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' }) as any;
      backend.sendSteerPrompt = async () => {};
      const { session } = createSessionClientWithMetadata();

      const runtime = createAcpRuntime({
        provider: 'codex',
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange: () => {},
        ensureBackend: async () => backend,
        inFlightSteer: { enabled: true },
      } as any);

      await runtime.startOrLoad({ resumeId: null });
      await runtime.steerPrompt('steer text');

      const raw = existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : '';
      expect(raw).toContain('acp_in_flight_steer');
    } finally {
      if (prevTrace === undefined) delete (process.env as any).HAPPIER_STACK_TOOL_TRACE;
      else process.env.HAPPIER_STACK_TOOL_TRACE = prevTrace;

      if (prevTraceFile === undefined) delete (process.env as any).HAPPIER_STACK_TOOL_TRACE_FILE;
      else process.env.HAPPIER_STACK_TOOL_TRACE_FILE = prevTraceFile;

      if (prevMarkers === undefined) delete (process.env as any).HAPPIER_E2E_ACP_TRACE_MARKERS;
      else process.env.HAPPIER_E2E_ACP_TRACE_MARKERS = prevMarkers;

      __resetToolTraceForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
