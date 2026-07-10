import { describe, expect, it } from 'vitest';

import type { RuntimeEventV1 } from '@happier-dev/plugin-sdk';

import { createClaudeBackendEngine } from './engine.js';
import {
  createEventsFixture,
  createPluginContextFixture,
  createTerminalHostFixture,
  expectRuntimeEnvelope,
} from './engine.testkit.js';

describe('createClaudeBackendEngine runtime issues', () => {
  it('publishes provider process-exit failures from Claude SessionEnd lifecycle evidence', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const engine = createClaudeBackendEngine(ctx);
    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      permissionMode: 'safe-yolo',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
      },
    });
    const created = sessionRuntime;
    const runtime = expectRuntimeEnvelope(created).operations;
    const runtimeEvents: RuntimeEventV1[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    await runtime.startOrLoadSession();
    runtime.beginTurnLifecycle();
    await runtime.sendTurnPrompt('trigger process exit');
    const completion = runtime.waitForTurnCompletion();
    await events.emit('@happier/session/provider-hook', {
      agentId: 'claude',
      sessionId: 'happy-session-1',
      eventName: 'UserPromptSubmit',
    });
    await events.emit('@happier/session/provider-hook', {
      agentId: 'claude',
      sessionId: 'happy-session-1',
      eventName: 'SessionEnd',
    });

    await expect(completion).rejects.toThrow(/process exited/iu);
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-start',
        sessionId: 'happy-session-1',
      }),
      expect.objectContaining({
        kind: 'turn-failed',
        sessionId: 'happy-session-1',
        issue: expect.objectContaining({
          source: 'agent_process_exit',
          code: 'claude.process_exited',
          agentId: 'claude',
        }),
      }),
    ]));
  });

  it('publishes terminal-host startup failures as turn failures and settles completion waiters', async () => {
    const terminalHost = createTerminalHostFixture();
    const startupError = Object.assign(
      new Error('zellij launched terminal pane disappeared after bootstrap cleanup'),
      {
        code: 'terminal_host_startup_failed',
        hostKind: 'zellij',
        reason: 'pane_disappeared_after_bootstrap_cleanup',
      },
    );
    (
      terminalHost.service.createOrAttachHost as unknown as {
        mockRejectedValueOnce(error: unknown): void;
      }
    ).mockRejectedValueOnce(startupError);
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const engine = createClaudeBackendEngine(ctx);
    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      permissionMode: 'safe-yolo',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;
    const runtimeEvents: RuntimeEventV1[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    runtime.beginTurnLifecycle();
    await expect(runtime.sendTurnPrompt('trigger host startup failure')).rejects.toThrow(/pane disappeared/iu);

    await expect(Promise.race([
      runtime.waitForTurnCompletion().then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
    ])).resolves.toBe('rejected');
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-start',
        sessionId: 'happy-session-1',
      }),
      expect.objectContaining({
        kind: 'turn-failed',
        sessionId: 'happy-session-1',
        issue: expect.objectContaining({
          source: 'agent_session_error',
          code: 'claude.provider.failure',
          agentId: 'claude',
        }),
      }),
    ]));
  });
});
