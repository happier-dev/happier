import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';

function createStaticBackend(responseText: string): AgentBackend {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = 'child_session_1' as SessionId;
  return {
    async startSession(): Promise<{ sessionId: SessionId }> {
      return { sessionId };
    },
    async sendPrompt(_sessionId: SessionId, _prompt: string): Promise<void> {
      handler?.({ type: 'model-output', fullText: responseText } as AgentMessage);
    },
    async cancel(_sessionId: SessionId): Promise<void> {},
    onMessage(next: AgentMessageHandler): void {
      handler = next;
    },
    async dispose(): Promise<void> {},
    async waitForResponseComplete(): Promise<void> {},
  };
}

describe('ExecutionRunManager execution-run registry integration', () => {
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  let happyHomeDir: string;

  beforeEach(() => {
    happyHomeDir = join(tmpdir(), `happier-cli-exec-run-mgr-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (existsSync(happyHomeDir)) {
      rmSync(happyHomeDir, { recursive: true, force: true });
    }
    if (originalHappyHomeDir === undefined) {
      delete process.env.HAPPIER_HOME_DIR;
    } else {
      process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
    }
  });

  it('writes a running marker on start and a terminal marker on completion', async () => {
    const { ExecutionRunManager } = await import('./ExecutionRunManager');
    const { listExecutionRunMarkers } = await import('@/daemon/executionRunRegistry');

    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () =>
        createStaticBackend(
          JSON.stringify({
            findings: [],
            summary: 'ok',
          }),
        ),
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendId: 'claude',
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    const running = await listExecutionRunMarkers();
    expect(running.some((m) => m.runId === started.runId)).toBe(true);

    await manager.waitForTerminal(started.runId);

    // Marker writes are best-effort and may lag the terminal promise. Poll briefly until the
    // terminal marker is visible to avoid brittle timing assumptions.
    let marker: any = null;
    for (let i = 0; i < 25; i += 1) {
      const markers = await listExecutionRunMarkers();
      marker = markers.find((m) => m.runId === started.runId) ?? null;
      if (marker?.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(marker).not.toBeNull();
    expect(marker?.status).toBe('succeeded');
    expect(marker?.intent).toBe('review');
    expect(marker?.backendId).toBe('claude');
    expect(typeof marker?.startedAtMs).toBe('number');
    expect(typeof marker?.updatedAtMs).toBe('number');
  });

  it('updates lastActivityAtMs for long-lived sends (best-effort)', async () => {
    const { ExecutionRunManager } = await import('./ExecutionRunManager');
    const { listExecutionRunMarkers } = await import('@/daemon/executionRunRegistry');

    let nowMs = 1_700_000_000_000;
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => createStaticBackend('ok'),
      sendAcp: () => {},
      getNowMs: () => nowMs,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendId: 'claude',
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    nowMs = 1_700_000_000_500;
    const sent = await manager.send(started.runId, { message: 'hello' });
    expect(sent.ok).toBe(true);

    const markers = await listExecutionRunMarkers();
    const marker = markers.find((m) => m.runId === started.runId) ?? null;
    expect(marker).not.toBeNull();
    expect(marker?.status).toBe('running');
    expect(marker?.lastActivityAtMs).toBe(nowMs);
    expect(marker?.updatedAtMs).toBe(nowMs);
  });
});
