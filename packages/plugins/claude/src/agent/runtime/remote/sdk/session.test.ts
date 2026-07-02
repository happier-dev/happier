import { describe, expect, it, vi } from 'vitest';

import {
  createSdkExecFixture,
  createEventsFixture,
  createPluginContextFixture,
  createTerminalHostFixture,
  expectRuntimeEnvelope,
} from '../../engine.testkit.js';
import { bindClaudeAgentSdkFallbackSession } from './session.js';

type InternalHostSessionParamsWithCredentials =
  Parameters<typeof bindClaudeAgentSdkFallbackSession>[0]['sessionParams'] & Readonly<{
    credentials: Readonly<{
      token: string;
      encryption: Readonly<{ type: 'legacy'; secret: Uint8Array }>;
    }>;
  }>;

describe('bindClaudeAgentSdkFallbackSession', () => {
  it('preserves host session credentials on the SDK fallback plan opts', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const credentials = {
      token: 'host-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const sessionParams: InternalHostSessionParamsWithCredentials = {
      cwd: '/tmp/claude-project',
      permissionMode: 'default',
      credentials,
    };

    const plan = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams,
    });

    expect(plan.opts).toMatchObject({ credentials });
  });

  it('forwards permission responses through the host session permission service', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const requestDecision = vi.fn(async () => ({ decision: 'approved' as const }));
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionPermissions: {
        requestDecision,
        getMode: () => 'default',
      },
    });

    const plan = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(await plan.config.createSessionRuntime({
      directory: '/tmp/claude-project',
    })).operations;

    await runtime.respondToPermission('perm-1', true);

    expect(requestDecision).toHaveBeenCalledWith({
      provider: 'claude',
      requestId: 'perm-1',
      approved: true,
    });
  });

  it('releases the in-flight SDK turn when Claude emits a result before process exit', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const plan = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(await plan.config.createSessionRuntime({
      directory: '/tmp/claude-project',
    })).operations;

    try {
      await runtime.sendTurnPrompt('first prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });
      await exec.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'claude-session-1',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await runtime.waitForTurnCompletion();

      await expect(runtime.sendTurnPrompt('second prompt')).resolves.toBeUndefined();

      expect(exec.spawnClient).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('applies a reasoning_effort runtime update to the next SDK query', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const plan = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(await plan.config.createSessionRuntime({
      directory: '/tmp/claude-project',
    })).operations;

    try {
      await runtime.updateSessionRuntimeConfig({
        configOption: { id: 'reasoning_effort', value: 'xhigh' },
      });
      await runtime.sendTurnPrompt('first prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      expect(exec.spawnClient.mock.calls[0]?.[0].launch.args).toEqual(expect.arrayContaining([
        '--effort',
        'xhigh',
      ]));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('applies an ultracode runtime update as a single inline --settings overlay on the next SDK query', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const plan = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(await plan.config.createSessionRuntime({
      directory: '/tmp/claude-project',
    })).operations;

    try {
      await runtime.updateSessionRuntimeConfig({ modelId: 'claude-opus-4-8' });
      await runtime.updateSessionRuntimeConfig({
        configOption: { id: 'ultracode', value: 'true' },
      });
      await runtime.sendTurnPrompt('first prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      const args = exec.spawnClient.mock.calls[0]?.[0].launch.args as string[];
      expect(args).toEqual(expect.arrayContaining(['--settings', '{"ultracode":true}']));
      expect(args.filter((arg) => arg === '--settings')).toHaveLength(1);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('keeps a [1m] model id unmutated through --model while resolving ultracode against the base model', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const plan = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(await plan.config.createSessionRuntime({
      directory: '/tmp/claude-project',
    })).operations;

    try {
      await runtime.updateSessionRuntimeConfig({ modelId: 'claude-fable-5[1m]' });
      await runtime.updateSessionRuntimeConfig({
        configOption: { id: 'ultracode', value: 'true' },
      });
      await runtime.sendTurnPrompt('first prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      const args = exec.spawnClient.mock.calls[0]?.[0].launch.args as string[];
      expect(args).toEqual(expect.arrayContaining(['--model', 'claude-fable-5[1m]']));
      expect(args).toEqual(expect.arrayContaining(['--settings', '{"ultracode":true}']));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('drops an ultracode request when the selected model cannot honor it', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const plan = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(await plan.config.createSessionRuntime({
      directory: '/tmp/claude-project',
    })).operations;

    try {
      await runtime.updateSessionRuntimeConfig({ modelId: 'claude-sonnet-4-6' });
      await runtime.updateSessionRuntimeConfig({
        configOption: { id: 'ultracode', value: 'true' },
      });
      await runtime.sendTurnPrompt('first prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      const args = exec.spawnClient.mock.calls[0]?.[0].launch.args as string[];
      expect(args).not.toContain('--settings');
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('does not publish SDK host status records as session runtime events', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const plan = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(await plan.config.createSessionRuntime({
      directory: '/tmp/claude-project',
    })).operations;
    const runtimeEvents: unknown[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    try {
      await runtime.sendTurnPrompt('prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      await exec.emit({
        type: 'status',
        status: 'running',
      });

      expect(runtimeEvents).toEqual([]);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });
});
