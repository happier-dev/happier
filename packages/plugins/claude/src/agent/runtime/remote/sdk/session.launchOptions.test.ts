import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createEventsFixture, createPluginContextFixture, createSdkExecFixture, createSessionHooksFixture, createTerminalHostFixture } from '../../engine.testkit.js';
import { createClaudeAgentSdkTurnOperations } from './session.js';

describe('Claude SDK turn/control launch parity', () => {
  it.each([
    { uid: 1000, sandbox: undefined, bubblewrap: undefined, allowed: true },
    { uid: 0, sandbox: undefined, bubblewrap: undefined, allowed: false },
    { uid: 0, sandbox: '0', bubblewrap: 'true', allowed: false },
    { uid: 0, sandbox: '1', bubblewrap: undefined, allowed: true },
    { uid: 0, sandbox: undefined, bubblewrap: '1', allowed: true },
  ])('resumes turn/control queries with the same bypass eligibility ($uid/$sandbox/$bubblewrap)', async ({ uid, sandbox, bubblewrap, allowed }) => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const uidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' });
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => uid });
    try {
      const exec = createSdkExecFixture();
      const spawn = exec.spawnClient.getMockImplementation()!;
      const launches: Array<{ args: readonly string[]; env: unknown }> = [];
      exec.spawnClient.mockImplementation(async (...input) => {
        const launch = input[0].launch;
        const args = await Promise.all(launch.args.map(async (arg: string, index: number) =>
          ['--mcp-config', '--append-system-prompt-file'].includes(launch.args[index - 1])
            ? await readFile(arg, 'utf8') : arg));
        launches.push({ args, env: launch.env });
        return await spawn(...input);
      });
      const hooks = createSessionHooksFixture();
      const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service,
        { exec: exec.service, sessionHooks: hooks.service });
      const operations = createClaudeAgentSdkTurnOperations({
        ctx, directory: '/tmp/claude-launch-parity', launchEnv: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          ...(sandbox === undefined ? {} : { IS_SANDBOX: sandbox }),
          ...(bubblewrap === undefined ? {} : { CLAUDE_CODE_BUBBLEWRAP: bubblewrap }) },
        permissionMode: 'plan', happierSessionId: 'launch-parity', initialModelId: 'claude-sonnet-4-6',
        initialEffort: 'high', supportsEffort: true, supportsSystemPromptSnapshotOff: true,
        startupInstructions: 'Keep the same startup prefix.', settingSources: ['user', 'project'],
        mcpServers: { fixture: { type: 'stdio', command: '/fixture/mcp' } },
        advancedOptions: { fallbackModel: 'claude-haiku-4-5', maxTurns: 4 },
        publishSdkMessages: true,
      });
      try {
        operations.beginProviderTurn('turn-1');
        await operations.sendProviderTurnPrompt('Normal turn');
        await exec.emit({ type: 'system', subtype: 'init', session_id: 'native-parity' });
        await exec.emit({ type: 'result', subtype: 'success', session_id: 'native-parity', is_error: false });
        await operations.waitForProviderTurnCompletion({ timeoutMs: null });
        const refresh = operations.updateProviderConfiguration({ configOption: { id: 'context_usage_refresh', value: 1 } });
        await vi.waitFor(() => expect(exec.processes).toHaveLength(2));
        const process = exec.processes[1]!;
        await vi.waitFor(() => expect(process.written).toContainEqual(expect.objectContaining({
          type: 'control_request', request: { subtype: 'get_context_usage' },
        })));
        const request = process.written.find(record => Reflect.get(record as object, 'request')?.subtype === 'get_context_usage') as { request_id: string };
        await process.emit({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id,
          response: { totalTokens: 40, maxTokens: 200_000, model: 'claude-sonnet-4-6', categories: [] } } });
        await refresh;
        const [turn, control] = launches;
        expect(turn!.args.includes('--allow-dangerously-skip-permissions')).toBe(allowed);
        expect(turn!.args).toEqual(expect.arrayContaining(['--permission-mode', 'plan']));
        const withoutResume = (args: readonly string[]) => args.filter((_, i) => args[i] !== '--resume' && args[i - 1] !== '--resume');
        expect(withoutResume(control!.args)).toEqual(withoutResume(turn!.args));
        expect(control!.args).toEqual(expect.arrayContaining(['--resume', 'native-parity', '--include-partial-messages']));
        expect(control!.env).toEqual(turn!.env);
        await expect(operations.compact({ compactionId: 'parity-compact', trigger: 'idle' })).resolves.toEqual({ status: 'admitted' });
        const compact = launches[2]!;
        expect(withoutResume(compact.args)).toEqual(withoutResume(turn!.args));
        expect(compact.env).toEqual(turn!.env);
        await exec.processes[2]!.emit({ type: 'system', subtype: 'compact_boundary', session_id: 'native-parity' });
        await exec.processes[2]!.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-parity' });
      } finally { await operations.disposeProviderSession(); }
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
      if (uidDescriptor) Object.defineProperty(process, 'getuid', uidDescriptor);
      else Reflect.deleteProperty(process, 'getuid');
    }
  });
});
