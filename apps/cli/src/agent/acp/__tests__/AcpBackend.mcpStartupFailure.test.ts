import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/agent/core';
import { withTempDir } from '@/testkit/fs/tempDir';
import { AcpBackend } from '../AcpBackend';
import { createAcpTestTransportHandler, writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { createAcpRequestFailureLogRecord } from '../withRetry';
import { createTestAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { ACPMessageData, SessionEventMessage } from '@/api/session/sessionMessageTypes';
import type { SessionTurnMutationV1 } from '@/api/session/mutations/sessionMutationTypes';

// fx 0.0.14 wire rejection, observed by O-FX on macOS 2026-10-28:
// FXMCP-CONTRACT.md; E-fx-live-probe.md pins the companion session/new protocol.
const reason = "Required MCP server 'broken' failed to start: connection refused";

describe('AcpBackend MCP startup rejection (real process boundary)', () => {
  it.each(['named', 'unpassed'] as const)('publishes a startup %s outcome to the transcript with the real session lifecycle', async (scenario) => {
    await withTempDir('happier-acp-mcp-transcript-', async (cwd) => {
      const { backend } = createBackend(cwd, scenario);
      const events: SessionEventMessage[] = [];
      const messages: ACPMessageData[] = [];
      const mutations: SessionTurnMutationV1[] = [];
      const runtime = createTestAcpRuntime({
        provider: 'fx', directory: cwd, mcpServers: {}, messageBuffer: new MessageBuffer(),
        permissionHandler: createApprovedPermissionHandler(), onThinkingChange: () => {},
        ensureBackend: async () => backend,
        session: createBasicSessionClientWithOverrides({
          sendSessionEvent: (event) => { events.push(event); },
          sendAgentMessage: (_provider, message) => { messages.push(message); },
          sessionTurnLifecycle: createSessionTurnLifecycle({ sessionId: 'startup-test',
            enqueueSessionTurn: async (mutation) => { mutations.push(mutation); } }),
        }),
      });
      try {
        if (scenario === 'named') {
          await expect(runtime.startOrLoad({})).resolves.toBe('started');
          expect(events).toContainEqual({ type: 'message', message: expect.stringContaining('Continued without MCP server "broken"') });
        } else {
          await expect(runtime.startOrLoad({})).rejects.toThrow(/foreign/);
          await expect.poll(() => messages.filter((message) => message.type === 'turn_failed')).toHaveLength(1);
          expect(messages).toContainEqual(expect.objectContaining({
            type: 'turn_failed', issue: expect.objectContaining({ sanitizedPreview: expect.stringContaining("MCP server 'foreign-broken'") }),
          }));
          expect(mutations.filter((mutation) => mutation.action === 'fail')).toHaveLength(1);
        }
      } finally {
        await runtime.reset();
      }
    });
  });

  it.each([['new', 'named'], ['load', 'named'], ['new', 'named-internal']] as const)('continues session/%s (%s) once without only the named server, with a notice', async (operation, scenario) => {
    await withTempDir('happier-acp-mcp-rejection-', async (cwd) => {
      const { backend, requests } = createBackend(cwd, scenario);
      const messages: AgentMessage[] = [];
      backend.onMessage((message) => messages.push(message));
      try {
        await expect(operation === 'new' ? backend.startSession() : backend.loadSession('resumed')).resolves.toMatchObject({
          sessionId: operation === 'new' ? 'started' : 'resumed',
        });
        expect(await requests()).toEqual([['broken', 'healthy'], ['healthy']]);
        expect(messages).toContainEqual({
          type: 'event', name: 'message',
          payload: { message: expect.stringMatching(/continued without MCP server ['"]broken['"].*connection refused/i) },
        });
        expect(messages.filter((message) => message.type === 'status' && message.status === 'error')).toEqual([]);
      } finally {
        await backend.dispose();
      }
    });
  });

  it.each([
    ['unnamed', [['broken', 'healthy']]],
    ['unpassed', [['broken', 'healthy']]],
    ['ambiguous', [['broken', 'healthy']]],
    ['persistent', [['broken', 'healthy'], ['healthy']]],
  ] as const)('fails %s rejection with the provider reason and no blind retries', async (scenario, expectedRequests) => {
    await withTempDir('happier-acp-mcp-rejection-', async (cwd) => {
      const { backend, requests } = createBackend(cwd, scenario);
      const messages: AgentMessage[] = [];
      backend.onMessage((message) => messages.push(message));
      try {
        await expect(backend.startSession()).rejects.toThrow(/rejected|failed to start/);
        expect(await requests()).toEqual(expectedRequests);
        expect(messages.filter((message) => message.type === 'status' && message.status === 'error')).toHaveLength(1);
        expect(messages.filter((message) => message.type === 'event' && message.name === 'message')).toEqual([]);
      } finally {
        await backend.dispose();
      }
    });
  });

  it('uses the existing issue preview producer for bounded, sanitized rejection messages and logs', () => {
    const secret = 'must-not-appear-in-provider-diagnostic';
    const error = Object.assign(new Error(`${reason}; Authorization: Bearer ${secret}\n${'x'.repeat(3_000)}`), { code: -32602 });
    const issue = classifyPrimarySessionRuntimeIssue({ provider: 'fx', cause: 'session_error', error });
    expect(issue.sanitizedPreview).toContain(reason);
    expect(issue.sanitizedPreview).not.toContain(secret);
    expect(issue.sanitizedPreview?.length).toBeLessThanOrEqual(2_000);
    const log = createAcpRequestFailureLogRecord({ operation: 'NewSession', error });
    expect(log).toMatchObject({ requestErrorCode: -32602, sanitizedPreview: issue.sanitizedPreview });
    expect(JSON.stringify(log)).not.toContain(secret);
  });
});

function createBackend(cwd: string, scenario: string) {
  const requestPath = join(cwd, 'requests.jsonl');
  const scriptPath = writeAcpTestAgentScript({
    dir: cwd, fileName: 'mcp-rejection-agent.mjs',
    source: `
      import { appendFileSync } from 'node:fs';
      import { createInterface } from 'node:readline';
      const scenario = ${JSON.stringify(scenario)};
      const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
      createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        if (request.method === 'initialize') return send(request.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
        if (request.method !== 'session/new' && request.method !== 'session/load') return send(request.id, {});
        const names = request.params.mcpServers.map(server => server.name);
        appendFileSync(${JSON.stringify(requestPath)}, JSON.stringify(names) + '\\n');
        // ACP v1 stdio has no type discriminator. fx 0.0.14 rejects type:"stdio"
        // before connecting any server (live source probe, 2026-10-28).
        if (request.params.mcpServers.some(server => 'type' in server)) {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Unsupported MCP server transport' } }) + '\\n');
          return;
        }
        if (scenario.startsWith('named') && !names.includes('broken')) return send(request.id, { sessionId: request.params.sessionId ?? 'started' });
        const message = scenario === 'unnamed' ? 'Session rejected: invalid configuration'
          : scenario === 'unpassed' ? "Required MCP server 'foreign-broken' failed to start: connection refused"
          : scenario === 'ambiguous' ? "MCP servers 'broken' and 'healthy' failed to start"
          : ${JSON.stringify(reason)};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: scenario === 'named-internal' ? -32603 : -32602, message } }) + '\\n');
      });
    `,
  });
  return {
    backend: new AcpBackend({
      agentName: 'test', cwd, command: process.execPath, args: [scriptPath],
      mcpServers: { broken: { command: 'unreachable-mcp' }, healthy: { command: 'healthy-mcp' } },
      transportHandler: createAcpTestTransportHandler(),
    }),
    requests: async (): Promise<string[][]> => (await readFile(requestPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)),
  };
}
