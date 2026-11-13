import { expect, it } from 'vitest';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from './createPublicAcpSession';

it.each(['transport', 'projection'] as const)('retains the native cause when steer %s fails after primary input acceptance', async failurePhase => {
  const failureCause = { code: 'provider_endpoint_unavailable', phase: 'turn_start', failureReason: 'permission_denied', httpStatus: 503 } as const;
  await withTempDir('acp-steer-cause-', async directory => {
    const script = writeAcpTestAgentScript({ dir: directory, fileName: 'agent.mjs', source: `
      import { createInterface } from 'node:readline';
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line);
        if (request.id === undefined) continue;
        if (request.method === 'session/prompt') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: 'native-steer', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } },
          } }) + '\\n');
          continue;
        }
        const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} }
          : request.method === 'session/new' ? { sessionId: 'native-steer' } : {};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
          ...(request.method === 'acme/steer' ? { error: { code: -32042, message: 'Native steer refused' } } : { result }),
        }) + '\\n');
      }
    ` });
    const dependencies: PublicAcpComposerDependencies = {
      pluginId: 'fixture', agentId: 'fixture', signal: new AbortController().signal, isCurrent: () => true,
      systemTools: { resolve: async () => ({ toolId: 'fixture', launch: {
        kind: 'binary', executablePath: process.execPath, args: [script],
      } }) },
      interactions: { async request() { throw new Error('Unexpected interaction'); } },
      media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
    };
    const session = await createPublicAcpSession({ kind: 'create', sessionId: 'steer-cause', cwd: directory }, {
      transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture' } },
      definition: { mcp: { policy: 'drop' }, delivery: { steer: {
        method: 'acme/steer', buildParams: ({ providerSessionId }) => {
          if (failurePhase === 'projection') throw Object.assign(new Error('Native steer projection refused'), { failureCause });
          return { sessionId: providerSessionId };
        },
        isAccepted: () => false, isRejected: () => false,
      } } },
    }, dependencies);
    const events: AgentSessionRuntimeEvent[] = [];
    const subscription = session.watch(event => events.push(event));
    try {
      await session.send({ inputIds: ['primary'], input: { text: 'hello' }, delivery: { kind: 'newTurn', turnId: 'turn' } });
      await expect.poll(() => events.some(event => event.kind === 'message-delta')).toBe(true);
      const result = await session.send({ inputIds: ['steer'], input: { text: 'continue' }, delivery: { kind: 'steer', turnId: 'turn' } });
      if (failurePhase === 'projection') {
        expect(result).toMatchObject({ status: 'rejected', diagnostic: { details: { failureCause } } });
        return;
      }
      await session.drainPendingPublications();
      expect(events).toContainEqual(expect.objectContaining({ kind: 'input-custody-unknown', inputIds: ['steer'], issue: expect.objectContaining({
        details: expect.objectContaining({ requestErrorCode: -32042, failureCause: expect.objectContaining({ providerErrorCode: -32042 }) }),
      }) }));
    } finally { subscription.dispose(); await session.dispose(); }
  });
});
