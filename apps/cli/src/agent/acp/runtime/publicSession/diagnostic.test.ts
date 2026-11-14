import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { withTempDir } from '@/testkit/fs/tempDir';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createRuntimeFailureTranscriptProjector } from '@/agent/runtime/session/transcripts/runtimeFailureTranscript';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from './createPublicAcpSession';
import { expect, it } from 'vitest';
import { sanitizeNativeAgentSessionBoundaryError } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
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


it.each([false, true, 'recorded' as const])('carries a multiline backend refusal through ACP and transcript publication, then recovers (request dump=%s)', async requestDump => {
  // Native privacy projection retains the public first line, never request-dump contents.
  const expectedMessage = requestDump === 'recorded' ? 'Cannot connect to API' : 'Error handling request {';
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
          if (${requestDump === true}) {
            process.stderr.write('Error handling request { id: 2, method: "session/prompt" } { message: "APIError: Unable to connect" }\\n');
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: -32603,
            message: ${requestDump === 'recorded' ? JSON.stringify('Internal error: Cannot connect to API: Unable to connect. Is the computer able to access the url?') : JSON.stringify('Error handling request {\n  "message": "Cannot connect to API",\n  "authorization": "Bearer synthetic-private-token"\n}')},
            data: ${JSON.stringify(requestDump === 'recorded' ? { service: 'session', errorName: 'APIError' } : { limitCategory: 'validation_failed', body: 'PRIVATE_BODY' })},
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
        providerErrorCode: -32603, providerErrorMessage: expect.stringContaining(expectedMessage) } });
      if (requestDump === 'recorded') {
        expect(issue.failureCause?.providerErrorMessage).toContain('service=session');
        expect(issue.failureCause?.providerErrorMessage).toContain('errorName=APIError');
      }
      const writes: unknown[] = [];
      const project = createRuntimeFailureTranscriptProjector({ provider: 'gemini', providerName: 'Gemini',
        session: { sessionId: 'session', enqueueAgentMessageCommitted: async (_provider, body, options) => {
          writes.push({ body, meta: options.meta });
          return { persisted: true, delivered: true, committedSequence: writes.length };
        } } });
      await project(failure);
      expect(writes).toContainEqual(expect.objectContaining({ meta: expect.objectContaining({ runtimeIssueV1:
        expect.objectContaining({ sanitizedPreview: expect.stringContaining(expectedMessage),
          failureCause: expect.objectContaining({ providerErrorCode: -32603,
            providerErrorMessage: expect.stringContaining(expectedMessage) }) }) }) }));
      expect(JSON.stringify(writes)).not.toMatch(/synthetic-private-token|PRIVATE_BODY/);
      await session.send({ inputIds: ['retry'], input: { text: 'Try again' }, delivery: { kind: 'newTurn', turnId: 'retry' } });
      await expect.poll(() => events.some(event => event.kind === 'turn-complete' && event.turnId === 'retry')).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', text: 'RECOVERED_OK' }));
    } finally { watch.dispose(); await session.dispose(); }
  });
});


it('retains native startup detail through public ACP opening and the host sanitizer', async () => {
  await withTempDir('acp-start-native-cause-', async directory => {
    const script = writeAcpTestAgentScript({ dir: directory, fileName: 'start-refusal.mjs', source: `
      import { createInterface } from 'node:readline';
      for await (const line of createInterface({ input: process.stdin })) {
        const r = JSON.parse(line); if (r.id === undefined) continue;
        const response = r.method === 'initialize'
          ? { result: { protocolVersion: 1, agentCapabilities: {} } }
          : { error: { code: -32603, message: 'Native onboarding refused token=synthetic-private-token', data: {} } };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, ...response }) + '\\n');
      }
    ` });
    const failure: unknown = await createPublicAcpSession({ kind: 'create', sessionId: 'startup', cwd: directory }, {
      transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture-cli' } },
    }, {
      pluginId: 'acme.startup', agentId: 'startup', signal: new AbortController().signal, isCurrent: () => true,
      systemTools: { resolve: async () => ({ toolId: 'fixture-cli', launch: { kind: 'binary', executablePath: process.execPath, args: [script] } }) },
      interactions: { async request() { throw new Error('Unexpected interaction'); } },
      media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
    }).then(async session => { await session.dispose(); throw new Error('Unexpected startup success'); }, error => error);
    const sanitized = sanitizeNativeAgentSessionBoundaryError(failure, true);
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: 'client_start', error: sanitized });
    expect(issue.failureCause).toMatchObject({ providerErrorCode: -32603,
      providerErrorMessage: expect.stringContaining('Native onboarding refused') });
    expect(JSON.stringify({ issue, diagnostic: (sanitized as Error & { diagnostic?: unknown }).diagnostic }))
      .not.toContain('synthetic-private-token');
  });
});



it('retains the native process refusal when its ACP transport closes during startup', async () => {
  await withTempDir('acp-closed-native-cause-', async directory => {
    const script = writeAcpTestAgentScript({ dir: directory, fileName: 'closed.mjs', source:
      "process.stderr.write('Error: No such device or address (os error 6) token=synthetic-private-token\\n'); process.exit(1);" });
    const failure: unknown = await createPublicAcpSession({ kind: 'create', sessionId: 'startup', cwd: directory }, {
      transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture-cli' } },
    }, {
      pluginId: 'acme.startup', agentId: 'startup', signal: new AbortController().signal, isCurrent: () => true,
      systemTools: { resolve: async () => ({ toolId: 'fixture-cli', launch: { kind: 'binary', executablePath: process.execPath, args: [script] } }) },
      interactions: { async request() { throw new Error('Unexpected interaction'); } },
      media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
    }).then(async session => { await session.dispose(); throw new Error('Unexpected startup success'); }, error => error);
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: 'client_start',
      error: sanitizeNativeAgentSessionBoundaryError(failure, true) });
    expect(issue.failureCause).toMatchObject({ phase: 'client_start', providerErrorCode: 'os_error_6', providerErrorMessage: expect.stringContaining('No such device or address') });
    expect(JSON.stringify(issue)).not.toContain('synthetic-private-token');
  });
});


it('retains the authentication timeout stage through public ACP opening', async () => {
  await withTempDir('acp-auth-timeout-cause-', async directory => {
    const script = writeAcpTestAgentScript({ dir: directory, fileName: 'auth.mjs', source: `
      import { createInterface } from 'node:readline';
      for await (const line of createInterface({ input: process.stdin })) {
        const r = JSON.parse(line); if (r.id === undefined || r.method === 'authenticate') continue;
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: {
          protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'login', name: 'Login' }]
        } }) + '\\n');
      }
    ` });
    const failure: unknown = await createPublicAcpSession({ kind: 'create', sessionId: 'startup', cwd: directory }, {
      transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture-cli' } },
      definition: { auth: { methodId: 'login' }, mcp: { policy: 'drop' }, timeouts: { initMs: 2_000 } },
    }, {
      pluginId: 'acme.startup', agentId: 'startup', signal: new AbortController().signal, isCurrent: () => true,
      systemTools: { resolve: async () => ({ toolId: 'fixture-cli', launch: { kind: 'binary', executablePath: process.execPath, args: [script] } }) },
      interactions: { async request() { throw new Error('Unexpected interaction'); } },
      media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
    }).then(async session => { await session.dispose(); throw new Error('Unexpected startup success'); }, error => error);
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: 'client_start',
      error: sanitizeNativeAgentSessionBoundaryError(failure, true) });
    expect(issue.failureCause).toMatchObject({ phase: 'authentication', providerErrorCode: 'acp_authenticate_timeout' });
  });
});

it.each([false, true])('publishes native refusal stop reason and sanitized error, then recovers (error=%s)', async hasError => {
  await withTempDir('acp-refusal-cause-', async directory => {
    const script = writeAcpTestAgentScript({ dir: directory, fileName: 'refusal.mjs', source: `
      import { createInterface } from 'node:readline';
      let prompts = 0;
      for await (const line of createInterface({ input: process.stdin })) {
        const r = JSON.parse(line); if (r.id === undefined) continue;
        let result = {};
        if (r.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {} };
        if (r.method === 'session/new') result = { sessionId: 'native-refusal' };
        if (r.method === 'session/prompt') result = ++prompts === 1
          ? { stopReason: 'refusal', ...(${hasError} ? { error: { code: 'vendor_refused', message: 'Native refusal token=synthetic-private-token', data: 'PRIVATE_BODY' } } : {}) }
          : { stopReason: 'end_turn' };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }) + '\\n');
      }
    ` });
    const session = await createPublicAcpSession({ kind: 'create', sessionId: 'session', cwd: directory }, {
      transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture-cli' } },
    }, {
      pluginId: 'acme.refusal', agentId: 'refusal', signal: new AbortController().signal, isCurrent: () => true,
      systemTools: { resolve: async () => ({ toolId: 'fixture-cli', launch: { kind: 'binary', executablePath: process.execPath, args: [script] } }) },
      interactions: { async request() { throw new Error('Unexpected interaction'); } },
      media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
    });
    const events: AgentSessionRuntimeEvent[] = [];
    const watch = session.watch(event => { events.push(event); });
    try {
      await session.send({ inputIds: ['first'], input: { text: 'Hello' }, delivery: { kind: 'newTurn', turnId: 'first' } });
      await expect.poll(() => events.some(event => event.kind === 'turn-failed')).toBe(true);
      const failure = events.find(event => event.kind === 'turn-failed');
      if (!failure || failure.kind !== 'turn-failed') throw new Error('Missing native refusal');
      expect(failure.diagnostic).toMatchObject({ code: 'acp_turn_refused', details: { stopReason: 'refusal' } });
      const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: failure.diagnostic });
      expect(issue.failureCause).toMatchObject({ providerErrorCode: hasError ? 'vendor_refused' : 'refusal' });
      if (hasError) expect(issue.failureCause?.providerErrorMessage).toContain('Native refusal');
      const writes: unknown[] = [];
      const project = createRuntimeFailureTranscriptProjector({ provider: 'codebuddy', providerName: 'CodeBuddy',
        session: { sessionId: 'session', enqueueAgentMessageCommitted: async (_provider, body, options) => {
          writes.push({ body, meta: options.meta });
          return { persisted: true, delivered: true, committedSequence: writes.length };
        } } });
      await project(failure);
      expect(writes).toContainEqual(expect.objectContaining({ meta: expect.objectContaining({ runtimeIssueV1:
        expect.objectContaining({ failureCause: expect.objectContaining({ providerErrorCode: hasError ? 'vendor_refused' : 'refusal' }) }) }) }));
      expect(JSON.stringify({ failure, issue, writes })).not.toMatch(/synthetic-private-token|PRIVATE_BODY/);
      await session.send({ inputIds: ['next'], input: { text: 'Again' }, delivery: { kind: 'newTurn', turnId: 'next' } });
      await expect.poll(() => events.some(event => event.kind === 'turn-complete' && event.turnId === 'next')).toBe(true);
    } finally { watch.dispose(); await session.dispose(); }
  });
});
