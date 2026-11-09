import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import { createReducer, reducer } from '@happier-dev/session-core';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { publishRuntimeSessionEvent } from '@/agent/runtime/session/transcripts/publishRuntimeSessionEvent';
import type { RuntimeTranscriptProjectionSession } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { createAcpRequestFailureLogRecord } from '@/agent/acp/withRetry';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createFxConfigOptionsFixture } from '@/agent/acp/testkit/fxConfigOptionsFixture';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from './createPublicAcpSession';

// Error captured through the real FX 0.0.14 ACP peer, 2026-10-28:
// .project/tmp/fx-vercel-fixes/FXMCP03-evidence/live-mac-final.log.
// The token suffix is a constructed privacy variant. Config payload provenance:
// .project/tmp/vercel-meeting/E-fx-live-probe.md §3 (2026-10-27).
const namedFailure = "Required MCP server 'broken' failed to start: FileNotFound; token=private-startup-token";

function fixture(dir: string, scenario: string) {
  const capture = join(dir, 'requests.json');
  const script = writeAcpTestAgentScript({ dir, fileName: 'agent.mjs', source: `
    import { createInterface } from 'node:readline';
    import { writeFileSync } from 'node:fs';
    const requests = [];
    const scenario = process.env.SCENARIO;
    let configOptions = ${JSON.stringify(createFxConfigOptionsFixture())};
    for await (const line of createInterface({ input: process.stdin })) {
      const r = JSON.parse(line); if (r.id === undefined) continue;
      requests.push({ method: r.method, params: r.params });
      writeFileSync(process.env.CAPTURE, JSON.stringify(requests));
      let result = {};
      let error;
      if (r.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      if (r.method === 'session/new' || r.method === 'session/load') {
        const broken = r.params.mcpServers.some(server => server.name === 'broken');
        if (scenario === 'unnamed') error = { code: -32602, message: 'Invalid session configuration; token=private-startup-token' };
        else if (scenario === 'unpassed') error = { code: -32602, message: "Required MCP server 'foreign' failed to start: missing" };
        else if (scenario === 'multiple') error = { code: -32602, message: "Required MCP server 'broken' failed to start: MCP server 'keep' failed to start: missing" };
        else if (scenario === 'persistent' || broken) error = { code: -32602, message: ${JSON.stringify(namedFailure)} };
        else result = { sessionId: 'native-session', configOptions };
      }
      if (r.method === 'session/set_config_option' && r.params.configId === 'model') {
        configOptions = configOptions.map(option => option.id === 'model' ? { ...option, currentValue: r.params.value } : option);
        result = { configOptions };
      }
      if (r.method === 'session/set_config_option' && r.params.configId === 'provider') {
        configOptions = configOptions.map(option => option.id === 'model'
          ? { ...option, currentValue: 'gateway-default', options: [{ value: 'gateway-default', name: 'Default' }, { value: 'gateway-model', name: 'Selected' }] }
          : option);
        result = { configOptions };
      }
      if (r.method === 'session/prompt') result = { stopReason: 'end_turn' };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, ...(error ? { error } : { result }) }) + '\\n');
    }
  ` });
  const signal = new AbortController().signal;
  const publications = createNativeAgentSessionPublications({ agentId: 'fixture', session: null,
    signal, isCurrent: () => true, supportsInFlightSteer: false });
  const normalized: NonNullable<ReturnType<typeof normalizeRawMessage>>[] = [];
  const session: RuntimeTranscriptProjectionSession = { sessionId: 'host-session',
    async enqueueAgentMessageCommitted(provider, body, options) {
      const message = normalizeRawMessage(options.localId, options.localId, 1,
        buildAcpAgentMessageEnvelope({ provider, body, meta: options.meta }), { seq: normalized.length + 1 });
      if (message) normalized.push(message);
      return { persisted: true, delivered: true, committedSequence: normalized.length };
    } };
  const dependencies: PublicAcpComposerDependencies = {
    pluginId: 'fixture', agentId: 'fixture', signal, isCurrent: () => true,
    systemTools: { resolve: async () => ({ toolId: 'fixture', launch: {
      kind: 'binary', executablePath: process.execPath, args: [script], env: { CAPTURE: capture, SCENARIO: scenario },
    } }) },
    interactions: { async request() { throw new Error('Unexpected interaction'); } },
    media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
    models: publications.services.models, modes: publications.services.modes,
    transcripts: { publishSessionEvent: event => publishRuntimeSessionEvent({ session, agentId: 'fixture', event }) },
  };
  return { dependencies, publications,
    requests: () => JSON.parse(readFileSync(capture, 'utf8')) as Array<{ method: string; params: { mcpServers?: Array<{ name: string }>; value?: string } }>,
    transcript: () => reducer(createReducer(), normalized, null).messages,
  };
}

const options = { transport: { kind: 'stdio' as const, executable: { kind: 'systemTool' as const, id: 'fixture' } },
  definition: { modelConfigOptionId: 'model', mcp: { policy: 'pass_through' as const } } };
const mcpServers = { broken: { command: 'not-installed' }, keep: { command: 'keep-server' } };

describe('public ACP startup recovery', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(['create', 'resume'] as const)('retries %s once with only the named passed server removed and writes a visible notice', async kind => {
    await withTempDir('happier-acp-mcp-recovery-', async dir => {
      const f = fixture(dir, 'recover');
      const debug = vi.spyOn(logger, 'debug');
      const request: AgentSessionOpenRequest = kind === 'resume'
        ? { kind, sessionId: 'host-session', cwd: dir, mcpServers, providerSessionId: 'native-session' }
        : { kind, sessionId: 'host-session', cwd: dir, mcpServers };
      const session = await createPublicAcpSession(request, options, f.dependencies);
      try {
        const starts = f.requests().filter(request => request.method === `session/${kind === 'create' ? 'new' : 'load'}`);
        expect(starts.map(request => request.params.mcpServers?.map(server => server.name))).toEqual([['broken', 'keep'], ['keep']]);
        const recoveryLogs = debug.mock.calls.filter(([message]) => message === '[AcpBackend] Retrying session without failed MCP server');
        expect(recoveryLogs).toMatchObject([[expect.any(String), { serverName: 'broken',
          operation: kind === 'create' ? 'NewSession' : 'LoadSession', requestErrorMessage: expect.stringContaining('FileNotFound') }]]);
        expect(JSON.stringify(recoveryLogs)).not.toContain('private-startup-token');
        expect(f.transcript()).toEqual([expect.objectContaining({ kind: 'agent-event',
          event: expect.objectContaining({ type: 'message', message: expect.stringContaining('broken'),
            capabilityNoticeV1: { v: 1, items: [expect.objectContaining({ detail: expect.stringContaining('Session continued without this server.') })] } }) })]);
        expect(JSON.stringify(f.transcript())).toContain('FileNotFound');
        expect(JSON.stringify(f.transcript())).toContain('Continuing');
        expect(JSON.stringify(f.transcript())).not.toContain('private-startup-token');
      } finally { await session.dispose(); f.publications.dispose(); }
    });
  });

  it.each(['unnamed', 'unpassed', 'multiple', 'persistent'])('surfaces sanitized %s failure without a blind identical retry', async scenario => {
    await withTempDir('happier-acp-mcp-rejected-', async dir => {
      const f = fixture(dir, scenario);
      try {
        const error: unknown = await createPublicAcpSession({ kind: 'create', sessionId: 'host-session', cwd: dir, mcpServers }, options, f.dependencies)
          .catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ code: -32602, diagnostic: { code: 'acp_session_start_failed', severity: 'error',
          message: expect.any(String), details: { requestErrorCode: -32602 } } });
        const record = createAcpRequestFailureLogRecord({ operation: 'StartSession', error });
        expect(record).toMatchObject({ requestErrorMessage: expect.stringContaining(scenario === 'unnamed' ? 'Invalid session configuration' : 'Required MCP server') });
        expect(JSON.stringify(record)).not.toContain('private-startup-token');
        expect(f.requests().filter(request => request.method === 'session/new')).toHaveLength(scenario === 'persistent' ? 2 : 1);
        expect(f.transcript()).toEqual([]); // A failed recovery must not claim that startup continued.
      } finally { f.publications.dispose(); }
    });
  });

  it.each(['foreign-model', 'gpt-6.1-sol', 'gpt-6-luna'])('uses only advertised initial model %s, otherwise leaves the agent default', async model => {
    await withTempDir('happier-acp-valid-model-', async dir => {
      const f = fixture(dir, 'models');
      const session = await createPublicAcpSession({ kind: 'create', sessionId: 'host-session', cwd: dir,
        configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: model, updatedAtMs: 1 },
          permissionIntent: { value: null, updatedAtMs: 0 }, options: {} } }, options, f.dependencies);
      try {
        const setters = f.requests().filter(request => request.method === 'session/set_config_option');
        expect(setters.map(request => request.params.value)).toEqual(model === 'foreign-model' ? [] : [model]);
        expect(f.publications.modelsSource.read().currentModelId).toBe(model === 'foreign-model' ? 'gpt-6.1-sol' : model);
      } finally { await session.dispose(); f.publications.dispose(); }
    });
  });

  it('validates the initial model against the catalog after provider configuration applies', async () => {
    await withTempDir('happier-acp-model-scope-', async dir => {
      const f = fixture(dir, 'models');
      const session = await createPublicAcpSession({ kind: 'create', sessionId: 'host-session', cwd: dir,
        configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: 'gateway-model', updatedAtMs: 1 },
          permissionIntent: { value: null, updatedAtMs: 0 }, options: { provider: { value: 'gateway', updatedAtMs: 1 } } } }, options, f.dependencies);
      try {
        expect(f.requests().filter(request => request.method === 'session/set_config_option').map(request => request.params.value))
          .toEqual(['gateway', 'gateway-model']);
        expect(f.publications.modelsSource.read().currentModelId).toBe('gateway-model');
      } finally { await session.dispose(); f.publications.dispose(); }
    });
  });

  it('rejects an explicit unadvertised live model without a plugin opt-in before sending a model setter', async () => {
    await withTempDir('happier-acp-live-model-', async dir => {
      const f = fixture(dir, 'models');
      const session = await createPublicAcpSession({ kind: 'create', sessionId: 'host-session', cwd: dir }, options, f.dependencies);
      try {
        const result = await session.updateConfiguration?.({ mode: { value: null, updatedAtMs: 0 },
          model: { value: 'foreign-model', updatedAtMs: 1, selectionSource: 'explicit' }, permissionIntent: { value: null, updatedAtMs: 0 }, options: {} });
        expect(result).toMatchObject({ status: 'rejected', diagnostic: { code: 'acp_model_not_available' } });
        expect(f.requests().filter(request => request.method === 'session/set_config_option')).toEqual([]);
        expect(f.publications.modelsSource.read().currentModelId).toBe('gpt-6.1-sol');
      } finally { await session.dispose(); f.publications.dispose(); }
    });
  });
});
