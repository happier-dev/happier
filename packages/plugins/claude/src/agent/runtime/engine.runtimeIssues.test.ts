import { describe, expect, it } from 'vitest';

import type { RuntimeEventV1 } from '@happier-dev/protocol/runtime';

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
    const plan = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      permissionMode: 'safe-yolo',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
      },
    });
    const created = await (plan as Readonly<{
      config: Readonly<{
        createSessionRuntime(params: Readonly<{
          directory: string;
          session: Readonly<{ sessionId: string }>;
          getPermissionMode: () => string;
        }>): Promise<unknown>;
      }>;
    }>).config.createSessionRuntime({
      directory: '/tmp/claude-project',
      session: { sessionId: 'happy-session-1' },
      getPermissionMode: () => 'safe-yolo',
    });
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
      providerId: 'claude',
      sessionId: 'happy-session-1',
      eventName: 'UserPromptSubmit',
    });
    await events.emit('@happier/session/provider-hook', {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      eventName: 'SessionEnd',
    });

    await expect(completion).rejects.toThrow(/process exited/iu);
    expect(runtimeEvents).toEqual([
      expect.objectContaining({
        kind: 'turn-failed',
        sessionId: 'happy-session-1',
        issue: expect.objectContaining({
          source: 'provider_process_exit',
          code: 'claude.process_exited',
          provider: 'claude',
        }),
      }),
    ]);
  });
});
