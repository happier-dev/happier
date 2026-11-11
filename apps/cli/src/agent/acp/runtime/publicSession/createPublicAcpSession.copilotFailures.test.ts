import { expect, it } from 'vitest';
import type { AgentAcpRuntimeDefinition, AgentExecutionRunEvent, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { COPILOT_ACP_RUNTIME_DEFINITION } from '../../../../../../../packages/plugins/copilot/src/agent/acp/definition';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { createRuntimeFailureTranscriptProjector } from '@/agent/runtime/session/transcripts/runtimeFailureTranscript';
import type { RuntimeTranscriptProjectionSession } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { withTempDir } from '@/testkit/fs/tempDir';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createPublicAcpSession, createPublicAcpExecutionRun, type PublicAcpComposerDependencies } from './createPublicAcpSession';

it.each([
  { kind: 'create', reply: 'Error: 400 Bad Request', failed: true },
  { kind: 'resume', reply: 'Error: 400 Bad Request', failed: true },
  { kind: 'execution', reply: 'Error: 400 Bad Request', failed: true },
  { kind: 'create', reply: 'The server replied Error: 400 Bad Request.', failed: false },
  { kind: 'create', reply: '"Error: 400 Bad Request"', failed: false },
  { kind: 'create', reply: '```\nError: 400 Bad Request\n```', failed: false },
] as const)('preserves Copilot HTTP failure evidence through $kind (failed: $failed, reply: $reply)', async ({ kind, reply, failed }) => {
  await withTempDir('copilot-acp-failure-', async directory => {
    // Only the native process is substituted. Its recorded error-as-answer and
    // end_turn shape pass through the real Copilot definition and ACP decoder.
    const script = writeAcpTestAgentScript({ dir: directory, fileName: 'copilot.mjs', source: `
      import { createInterface } from 'node:readline';
      let prompts = 0;
      for await (const line of createInterface({ input: process.stdin })) {
        const r = JSON.parse(line); if (r.id === undefined) continue;
        let result = {};
        if (r.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
        if (r.method === 'session/new') result = { sessionId: 'native-copilot' };
        if (r.method === 'session/prompt') {
          const text = ++prompts === 1 ? ${JSON.stringify(reply)} : 'RECOVERED_OK';
          // Fragmentation must not change classification of the final native diagnostic.
          for (const part of [text.slice(0, 8), text.slice(8)]) process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-copilot',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part } } },
          }) + '\\n');
          result = { stopReason: 'end_turn' };
        }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }) + '\\n');
      }
    ` });
    const signal = new AbortController().signal;
    const dependencies: PublicAcpComposerDependencies = {
      pluginId: 'happier.agent.copilot', agentId: 'copilot', signal, isCurrent: () => true,
      systemTools: { resolve: async () => ({ toolId: 'copilot-cli', launch: { kind: 'binary', executablePath: process.execPath, args: [script] } }) },
      interactions: { async request() { throw new Error('Unexpected interaction'); } },
      media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
    };
    const outputProjections: string[] = [];
    const definition: AgentAcpRuntimeDefinition = COPILOT_ACP_RUNTIME_DEFINITION;
    const options = { transport: { kind: 'stdio' as const, executable: { kind: 'systemTool' as const, id: 'copilot-cli' } }, definition: { ...definition, sessionUpdates: { ...definition.sessionUpdates,
      project: definition.sessionUpdates?.project ?? (() => null),
      projectOutputDiagnostic(text: string) {
        outputProjections.push(text);
        return definition.sessionUpdates?.projectOutputDiagnostic?.(text) ?? null;
      },
    } } };
    if (kind === 'execution') {
      const run = await createPublicAcpExecutionRun({ kind: 'create', runId: 'run', cwd: directory,
        profile: { pluginId: 'happier.agent.copilot', localId: 'copilot' }, localInputId: 'input', input: { text: 'No tools. Reply QA_OK.' } }, options, dependencies);
      const events: AgentExecutionRunEvent[] = [];
      const watch = run.watch(event => { events.push(event); });
      try {
        await expect.poll(() => events.some(event => event.kind === 'run-failed' || event.kind === 'run-complete')).toBe(true);
        const failure = events.find(event => event.kind === 'run-failed');
        expect(failure).toMatchObject({ diagnostic: { code: 'acp_turn_failed', details: { failureCause: { providerErrorCode: 400, phase: 'turn' } } } });
        expect(outputProjections).toEqual([reply]);
        expect(events.some(event => event.kind === 'run-complete')).toBe(false);
        expect(events.filter(event => event.kind === 'output-delta').map(event => event.kind === 'output-delta' ? event.text : '').join('')).toBe('Error: 400 Bad Request');
      } finally { watch.dispose(); await run.dispose(); }
      return;
    }
    const session = await createPublicAcpSession({ kind, sessionId: 'session', cwd: directory,
      ...(kind === 'resume' ? { providerSessionId: 'native-copilot' } : {}) }, options, dependencies);
    const events: AgentSessionRuntimeEvent[] = [];
    const watch = session.watch(event => { events.push(event); });
    try {
      await session.send({ inputIds: ['input'], input: { text: 'No tools. Reply QA_OK.' }, delivery: { kind: 'newTurn', turnId: 'first' } });
      await expect.poll(() => events.some(event => event.kind === 'turn-failed' || event.kind === 'turn-complete')).toBe(true);
      if (!failed) {
        expect(events.some(event => event.kind === 'turn-complete')).toBe(true);
        expect(events.some(event => event.kind === 'turn-failed')).toBe(false);
        return;
      }
      const failure = events.find(event => event.kind === 'turn-failed');
      expect(failure).toMatchObject({ diagnostic: { code: 'acp_turn_failed' } });
      expect(outputProjections).toEqual([reply]);
      if (!failure || failure.kind !== 'turn-failed') throw new Error('Missing native failure');
      expect(classifyPrimarySessionRuntimeIssue({ provider: 'copilot', cause: 'session_error', error: failure.diagnostic })).toMatchObject({
        failureCause: { phase: 'turn', providerErrorCode: 400, providerErrorMessage: '400 Bad Request' },
      });
      const mutations: unknown[] = [];
      const writes: unknown[] = [];
      const projectionSession: RuntimeTranscriptProjectionSession = { sessionId: 'session',
        enqueueAgentMessageCommitted: async (_provider, body, options) => {
          writes.push({ body, meta: options.meta });
          return { persisted: true, delivered: true, committedSequence: writes.length };
        } };
      const projectFailure = createRuntimeFailureTranscriptProjector({ session: projectionSession, provider: 'copilot', providerName: 'Copilot' });
      const lifecycle = createSessionTurnLifecycle({ agentId: 'copilot',
        session: { sessionId: 'session', enqueueSessionTurnMutation: async mutation => { mutations.push(mutation); } },
        onAcceptedTurnFailure: async (event, issue) => { await projectFailure(event, { issue }); } });
      for (const event of events) lifecycle.observeRuntimeEvent(event);
      await lifecycle.drainAcceptedLifecycle();
      lifecycle.dispose();
      expect(mutations).toContainEqual(expect.objectContaining({ action: 'fail', issue: expect.objectContaining({
        failureCause: expect.objectContaining({ providerErrorCode: 400, phase: 'turn' }),
      }) }));
      expect(writes).toContainEqual(expect.objectContaining({ body: expect.objectContaining({ type: 'turn_failed' }),
        meta: expect.objectContaining({ runtimeIssueV1: expect.objectContaining({ failureCause: expect.objectContaining({ providerErrorCode: 400 }) }) }) }));
      expect(events.some(event => event.kind === 'turn-complete')).toBe(false);
      expect(events.filter(event => event.kind === 'message-delta' && event.channel === 'assistant').map(event => event.kind === 'message-delta' ? event.text : '').join('')).toBe('Error: 400 Bad Request');
      await session.send({ inputIds: ['recovery'], input: { text: 'Try again' }, delivery: { kind: 'newTurn', turnId: 'recovery' } });
      await expect.poll(() => events.some(event => event.kind === 'turn-complete' && event.turnId === 'recovery')).toBe(true);
      expect(outputProjections).toEqual([reply, 'RECOVERED_OK']);
    } finally { watch.dispose(); await session.dispose(); }
  });
});
