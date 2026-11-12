import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { withTempDir } from '@/testkit/fs/tempDir';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createRuntimeFailureTranscriptProjector } from '@/agent/runtime/session/transcripts/runtimeFailureTranscript';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from './createPublicAcpSession';
import { expect, it } from 'vitest';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { createPublicAcpDiagnostic } from './diagnostic';

it('retains a redacted ACP provider rejection through the published Session issue', () => {
  const error = Object.assign(new Error('Gateway rejected request Authorization: Bearer synthetic-private-token'), {
    code: -32603, data: { headers: { authorization: 'PRIVATE_BODY' } },
  });
  const diagnostic = createPublicAcpDiagnostic('acp_turn_failed', error.message, error);
  const issue = SessionRuntimeIssueV1Schema.parse(classifyPrimarySessionRuntimeIssue({
    cause: 'session_error', provider: 'gemini', error: diagnostic,
  }));
  expect(issue.failureCause).toMatchObject({ phase: 'turn', failureReason: 'unclassified_provider_error',
    providerErrorCode: -32603, providerErrorMessage: expect.stringContaining('Gateway rejected request') });
  expect(issue.sanitizedPreview).toContain('Gateway rejected request');
  expect(JSON.stringify({ diagnostic, issue })).not.toMatch(/synthetic-private-token|PRIVATE_BODY/);
});

it('preserves a more specific native phase and reason instead of replacing them', () => {
  const error = Object.assign(new Error('Sign in required'), { code: -32000,
    failureCause: { phase: 'authentication', failureReason: 'authentication_required' } });
  const diagnostic = createPublicAcpDiagnostic('acp_turn_failed', error.message, error);
  const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: diagnostic });
  expect(issue.failureCause).toMatchObject({ phase: 'authentication', failureReason: 'authentication_required' });
});


it.each([false, true])('carries a multiline backend refusal through ACP and transcript publication, then recovers (request dump=%s)', async requestDump => {
  await withTempDir('gemini-acp-refusal-', async directory => {
    // Only the external native process and transcript persistence are substituted.
    const script = writeAcpTestAgentScript({ dir: directory, fileName: 'gemini.mjs', source: `
      import { createInterface } from 'node:readline';
      let prompts = 0;
      for await (const line of createInterface({ input: process.stdin })) {
        const r = JSON.parse(line); if (r.id === undefined) continue;
        let result = {};
        if (r.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
        if (r.method === 'session/new') result = { sessionId: 'native-gemini' };
        if (r.method === 'session/prompt' && ++prompts === 1) {
          if (${requestDump}) {
            process.stderr.write('Error handling request { id: 2, method: "session/prompt" } { message: "APIError: Unable to connect" }\\n');
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: -32603,
            message: 'Error handling request {\\n  "message": "Cannot connect to API",\\n  "authorization": "Bearer synthetic-private-token"\\n}',
            data: { limitCategory: 'validation_failed', body: 'PRIVATE_BODY' },
          } }) + '\\n');
          continue;
        }
        if (r.method === 'session/prompt') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: 'native-gemini', update: { sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'RECOVERED_OK' } },
          } }) + '\\n');
          result = { stopReason: 'end_turn' };
        }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }) + '\\n');
      }
    ` });
    const dependencies: PublicAcpComposerDependencies = {
      pluginId: 'happier.agent.gemini', agentId: 'gemini', signal: new AbortController().signal, isCurrent: () => true,
      systemTools: { resolve: async () => ({ toolId: 'gemini-cli', launch: { kind: 'binary', executablePath: process.execPath, args: [script] } }) },
      interactions: { async request() { throw new Error('Unexpected interaction'); } },
      media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
    };
    const session = await createPublicAcpSession({ kind: 'create', sessionId: 'session', cwd: directory },
      { transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'gemini-cli' } } }, dependencies);
    const events: AgentSessionRuntimeEvent[] = [];
    const watch = session.watch(event => { events.push(event); });
    try {
      await session.send({ inputIds: ['input'], input: { text: 'No tools' }, delivery: { kind: 'newTurn', turnId: 'first' } });
      await expect.poll(() => events.some(event => event.kind === 'turn-failed')).toBe(true);
      const failure = events.find(event => event.kind === 'turn-failed');
      if (!failure || failure.kind !== 'turn-failed') throw new Error('Missing turn failure');
      const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'gemini', error: failure.diagnostic });
      expect(issue).toMatchObject({ source: 'agent_session_error', failureCause: { phase: 'turn',
        providerErrorCode: -32603, providerErrorMessage: expect.stringContaining('Cannot connect to API') } });
      const writes: unknown[] = [];
      const project = createRuntimeFailureTranscriptProjector({ provider: 'gemini', providerName: 'Gemini',
        session: { sessionId: 'session', enqueueAgentMessageCommitted: async (_provider, body, options) => {
          writes.push({ body, meta: options.meta });
          return { persisted: true, delivered: true, committedSequence: writes.length };
        } } });
      await project(failure);
      expect(writes).toContainEqual(expect.objectContaining({ meta: expect.objectContaining({ runtimeIssueV1:
        expect.objectContaining({ sanitizedPreview: expect.stringContaining('Cannot connect to API'),
          failureCause: expect.objectContaining({ providerErrorCode: -32603,
            providerErrorMessage: expect.stringContaining('Cannot connect to API') }) }) }) }));
      expect(JSON.stringify(writes)).not.toMatch(/synthetic-private-token|PRIVATE_BODY/);
      await session.send({ inputIds: ['retry'], input: { text: 'Try again' }, delivery: { kind: 'newTurn', turnId: 'retry' } });
      await expect.poll(() => events.some(event => event.kind === 'turn-complete' && event.turnId === 'retry')).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', text: 'RECOVERED_OK' }));
    } finally { watch.dispose(); await session.dispose(); }
  });
});
