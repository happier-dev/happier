import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from './createPublicAcpSession';

it('preserves a configuration refusal cause alongside restart recovery and leaves the session usable', async () => {
  await withTempDir('acp-config-cause-', async directory => {
    // Only the native process is substituted; configuration and diagnostic projection stay real.
    const script = writeAcpTestAgentScript({ dir: directory, fileName: 'agent.mjs', source: `
      import { createInterface } from 'node:readline';
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line);
        if (request.id === undefined) continue;
        const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} }
          : request.method === 'session/new' ? { sessionId: 'native-config', models: {
              currentModelId: 'initial', availableModels: [{modelId: 'initial', name: 'Initial'}, {modelId: 'next', name: 'Next'}],
            } } : request.method === 'session/prompt' ? { stopReason: 'end_turn' } : {};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
      }
    ` });
    const failureCause = { phase: 'turn_start', failureReason: 'unclassified_provider_error',
      providerErrorCode: 'native_model_restart_required' } as const;
    const dependencies: PublicAcpComposerDependencies = {
      pluginId: 'fixture', agentId: 'fixture', signal: new AbortController().signal, isCurrent: () => true,
      systemTools: { resolve: async () => ({ toolId: 'fixture', launch: {
        kind: 'binary', executablePath: process.execPath, args: [script],
      } }) },
      interactions: { async request() { throw new Error('Unexpected interaction'); } },
      media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
    };
    const session = await createPublicAcpSession({ kind: 'create', sessionId: 'config-cause', cwd: directory }, {
      transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture' } },
      definition: { mcp: { policy: 'drop' }, models: { resolveModelUpdate: ({ modelId }) => {
        if (modelId === 'next') throw new PluginError({ code: 'native_model_restart_required',
          message: 'Restart to change the native model.', details: { status: 'requires_restart' }, failureCause });
        return { modelId };
      } } },
    }, dependencies);
    const configuration = (model: string) => ({ mode: { value: null, updatedAtMs: 0 },
      model: { value: model, updatedAtMs: 1 }, permissionIntent: { value: null, updatedAtMs: 0 }, options: {} });
    try {
      const result = await session.updateConfiguration!(configuration('next'));
      expect(result).toMatchObject({ status: 'rejected', diagnostic: { details: { status: 'requires_restart', failureCause } } });
      if (result.status !== 'rejected') throw new Error('Expected configuration refusal');
      expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: result.diagnostic }).failureCause).toEqual(failureCause);
      expect(await session.updateConfiguration!(configuration('initial'))).toMatchObject({ status: 'applied' });
    } finally { await session.dispose(); }
  });
});
