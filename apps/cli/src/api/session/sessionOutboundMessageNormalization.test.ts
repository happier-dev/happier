import { describe, expect, it, vi } from 'vitest';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { readHappierActionToolResultCandidates } from '@happier-dev/protocol/actions/happierActionToolResult';
import { resolveCodeBuddyAcpToolName } from '../../../../../packages/plugins/codebuddy/src/agent/runtime/factory';
import { buildAcpToolNameResolverInput } from '@/agent/acp/toolCalls/toolNameResolverInput';

import {
  normalizeAcpSessionMessageBody,
  normalizeCodexSessionMessageBody,
} from './sessionOutboundMessageNormalization';

const SOURCE = { protocol: 'acp', agent: { pluginId: 'example.agent', localId: 'test' } } as const;
const NATIVE_SOURCE = { ...SOURCE, protocol: 'native' } as const;

describe('normalizeAcpSessionMessageBody', () => {
  it.each(['acp', 'codex'] as const)(
    'keeps webhook capability URLs and setup secrets out of %s Session transcripts while retaining endpoint metadata', protocol => {
      for (const actionId of ['plugin.webhook.endpoint.ensure', 'plugin.webhook.endpoint.read'] as const) {
        for (const transport of ['action_execute', 'shell'] as const) {
          const caches = {
            toolCallCanonicalNameByProviderAndId: new Map<string, { rawToolName: string; canonicalToolName: string }>(),
            permissionToolCallRawInputByProviderAndId: new Map<string, unknown>(),
            toolCallInputByProviderAndId: new Map<string, unknown>(),
          };
          const endpointId = 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA';
          const contribution = { pluginId: 'example.monitor', localId: 'events' };
          const targetMaterialization = { machineId: 'machine', materializationId: 'materialization', pluginId: 'example.monitor' };
          const input = actionId === 'plugin.webhook.endpoint.read' ? { webhookEndpointId: endpointId } : {
            webhookContribution: contribution, targetMaterialization, sourceInstanceId: 'monitor',
            setup: { kind: 'capabilityUrlV1', checkId: 'uptime' }, idempotencyKey: 'ensure-monitor-endpoint-0001',
          };
          const envelope = { actionId, input };
          const toolCall = {
            type: 'tool-call' as const, callId: 'webhook', id: 'webhook-call',
            name: transport === 'shell' ? 'Bash' : 'mcp__happier__action_execute',
            input: transport === 'shell'
              ? { command: `happier tools call --source happier --tool action_execute --args-json '${JSON.stringify(envelope)}' --json` }
              : envelope,
          };
          if (protocol === 'acp') normalizeAcpSessionMessageBody({ source: SOURCE, ...caches, provider: 'claude', body: toolCall });
          else normalizeCodexSessionMessageBody({ source: NATIVE_SOURCE, ...caches, body: toolCall, debug: () => {} });
          const privateUrl = 'https://home.test/v1/plugins/webhooks/private-capability-fixture';
          const privateSecret = 'private-signed-webhook-setup-fixture';
          // MCP publishes dispatch.result directly; the executor's ok/result
          // envelope is not part of the native tool wire output.
          const native = JSON.stringify({
            webhookEndpointId: endpointId, revision: 1, publicUrl: privateUrl, readiness: 'ready',
            ...(actionId === 'plugin.webhook.endpoint.read'
              ? { contribution, targetMaterialization, sourceInstanceId: 'monitor', routing: 'accountEndpoint', createdAt: 1000 }
              : { oneTimeGeneratedSecret: privateSecret }),
          });
          const output = transport === 'shell'
            ? { stdout: JSON.stringify({ v: 1, ok: true, kind: 'tools_call', data: {
              source: 'happier', tool: 'action_execute', isError: false, output: JSON.parse(native),
            } }), stderr: '', exitCode: 0 }
            : { content: [{ type: 'text', text: native }], structuredContent: JSON.parse(native), tool_use_result: native };
          const toolResult = { type: 'tool-result' as const, callId: 'webhook', id: 'webhook-result', output };
          const result = protocol === 'acp'
            ? normalizeAcpSessionMessageBody({ source: SOURCE, ...caches, provider: 'claude', body: toolResult })
            : normalizeCodexSessionMessageBody({ source: NATIVE_SOURCE, ...caches, body: { ...toolResult, type: 'tool-call-result' }, debug: () => {} });
          const transcript = JSON.stringify(result);
          expect(transcript).not.toContain(privateUrl);
          expect(transcript).not.toContain(privateSecret);
          expect(transcript).toContain(endpointId);
        }
      }
    },
  );
  it.each(['acp', 'codex'] as const)(
    'keeps private clipboard operands and native result wrappers out of %s Session transcripts', protocol => {
      for (const actionId of ['computer.clipboard.read', 'computer.clipboard.write'] as const) {
        for (const transport of ['action_execute', 'shell', 'deferred'] as const) {
          if (protocol === 'codex' && transport === 'deferred') continue;
          const caches = {
            toolCallCanonicalNameByProviderAndId: new Map<string, { rawToolName: string; canonicalToolName: string }>(),
            permissionToolCallRawInputByProviderAndId: new Map<string, unknown>(),
            toolCallInputByProviderAndId: new Map<string, unknown>(),
          };
          const input = { machineId: 'machine', ...(actionId === 'computer.clipboard.write'
            ? { text: 'private-clipboard-fixture' } : {}) };
          const envelope = { actionId, input };
          const toolCall = {
            type: 'tool-call' as const, callId: 'clipboard', id: 'clipboard-call',
            name: transport === 'deferred' ? 'other' : transport === 'shell' ? 'Bash' : 'mcp__happier__action_execute',
            input: transport === 'deferred'
              ? { toolName: 'mcp__happier__action_execute', params: envelope, _acp: { kind: 'other', title: 'DeferExecuteTool' } }
              : transport === 'shell'
              ? { command: `happier tools call --source happier --tool action_execute --args-json '${JSON.stringify(envelope)}' --json` }
              : envelope,
          };
          const decodedTool = transport === 'deferred' ? resolveCodeBuddyAcpToolName({
            toolName: toolCall.name,
            toolCallId: toolCall.callId,
            input: buildAcpToolNameResolverInput(toolCall.input, 'DeferExecuteTool', 'other'),
            context: { toolCallCountSincePrompt: 1 },
          }) : null;
          if (transport === 'deferred' && (!decodedTool || typeof decodedTool === 'string')) {
            throw new Error('expected CodeBuddy deferred-tool decoding');
          }
          const admittedToolCall = decodedTool && typeof decodedTool !== 'string'
            ? { ...toolCall, name: decodedTool.toolName, input: decodedTool.input }
            : toolCall;
          const call = protocol === 'acp'
            ? normalizeAcpSessionMessageBody({ source: SOURCE, ...caches, provider: 'claude', body: admittedToolCall })
            : normalizeCodexSessionMessageBody({ source: NATIVE_SOURCE, ...caches, body: admittedToolCall, debug: () => {} });
          const native = JSON.stringify({ ok: true, result: { ok: true, text: 'private-clipboard-fixture' } });
          const toolResult = {
            type: 'tool-result' as const, callId: 'clipboard', id: 'clipboard-result', output: {
              content: [{ type: 'text', text: native }], structuredContent: JSON.parse(native), tool_use_result: native,
            },
          };
          const result = protocol === 'acp'
            ? normalizeAcpSessionMessageBody({ source: SOURCE, ...caches, provider: 'claude', body: toolResult })
            : normalizeCodexSessionMessageBody({ source: NATIVE_SOURCE, ...caches, body: { ...toolResult, type: 'tool-call-result' }, debug: () => {} });
          expect(JSON.stringify(call)).not.toContain('private-clipboard-fixture');
          expect(JSON.stringify(result)).not.toContain('private-clipboard-fixture');
        }
      }
    },
  );
  it.each(['pending', 'saved'] as const)('retains a skill create %s receipt through the native MCP transcript projection', phase => {
    const caches = {
      toolCallCanonicalNameByProviderAndId: new Map<string, { rawToolName: string; canonicalToolName: string }>(),
      permissionToolCallRawInputByProviderAndId: new Map<string, unknown>(),
      toolCallInputByProviderAndId: new Map<string, unknown>(),
    };
    normalizeAcpSessionMessageBody({ source: SOURCE, ...caches, provider: 'codex', body: {
      type: 'tool-call', callId: 'create', id: 'call', name: 'mcp__happier__action_execute',
      input: { actionId: 'skills.create', input: { name: 'review', files: [] } },
    } });
    const receipt = phase === 'pending'
      ? { kind: 'approval_request_created', artifactId: 'approval', actionId: 'skills.create' }
      : { ok: true, skillId: 'review', revision: '1:1', includedInSessionId: 'bot',
        summary: { name: 'Review', description: null }, inclusion: { ok: false, code: 'applies_to_new_sessions_only' }, incomplete: 'session_include' };
    const result = normalizeAcpSessionMessageBody({ source: SOURCE, ...caches, provider: 'codex', body: {
      type: 'tool-result', callId: 'create', id: 'result', output: { content: [{ type: 'text', text: JSON.stringify(receipt) }] },
    } });
    if (result.type !== 'tool-result') throw new Error('expected tool-result');
    expect(readHappierActionToolResultCandidates(result.output)).toContainEqual(receipt);
    if (phase === 'saved') expect(readHappierActionToolResultCandidates(result.output).some(candidate =>
      SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].safeParse(candidate).success)).toBe(true);
  });

  it('projects a failed title Action as a typed error instead of treating a JSON key as the title', () => {
    const caches = {
      toolCallCanonicalNameByProviderAndId: new Map<string, { rawToolName: string; canonicalToolName: string }>(),
      permissionToolCallRawInputByProviderAndId: new Map<string, unknown>(),
      toolCallInputByProviderAndId: new Map<string, unknown>(),
    };
    normalizeAcpSessionMessageBody({ source: SOURCE, ...caches, provider: 'claude', body: {
      type: 'tool-call', callId: 'title', name: 'mcp__happier__change_title',
      input: { title: 'Explore project directory' }, id: 'title-call',
    } });
    const failure = JSON.stringify({ errorCode: 'change_title_failed', error: 'target_unavailable' });
    const result = normalizeAcpSessionMessageBody({ source: SOURCE, ...caches, provider: 'claude', body: {
      type: 'tool-result', callId: 'title', id: 'title-result', isError: true,
      output: { content: failure, tool_use_result: `Error: ${failure}` },
    } });
    if (result.type !== 'tool-result') throw new Error('expected tool-result');
    expect(result.isError).toBe(true);
    expect(result.output).toMatchObject({ success: false, errorCode: 'change_title_failed', errorMessage: 'target_unavailable' });
    expect(result.output).not.toHaveProperty('title');
    expect(result.output).not.toHaveProperty('content');
    expect(result.output).not.toHaveProperty('tool_use_result');
  });

  it.each([
    { content: '/workspace/package.json\n', isError: false },
    { content: 'Exit code 127\nls: command not found', isError: true },
  ])('retains native shell report text in the canonical streams ($isError)', ({ content, isError }) => {
    const caches = {
      toolCallCanonicalNameByProviderAndId: new Map<string, { rawToolName: string; canonicalToolName: string }>(),
      permissionToolCallRawInputByProviderAndId: new Map<string, unknown>(),
      toolCallInputByProviderAndId: new Map<string, unknown>(),
    };
    normalizeAcpSessionMessageBody({ source: SOURCE, ...caches, provider: 'claude', body: {
      type: 'tool-call', callId: 'shell', name: 'Bash', input: { command: 'find /workspace -type f' }, id: 'shell-call',
    } });
    const result = normalizeAcpSessionMessageBody({ source: SOURCE, ...caches, provider: 'claude', body: {
      type: 'tool-result', callId: 'shell', id: 'shell-result', isError,
      output: { content, tool_use_result: isError ? `Error: ${content}` : { stdout: content, stderr: '' } },
    } });
    if (result.type !== 'tool-result') throw new Error('expected tool-result');
    expect(result.output).toMatchObject({ stdout: content });
  });

  it('uses the admitted native Agent source for calls and results while retaining local-control metadata', () => {
    const toolCallCanonicalNameByProviderAndId = new Map<string, { rawToolName: string; canonicalToolName: string }>();
    const call = normalizeCodexSessionMessageBody({ source: NATIVE_SOURCE,
      body: { type: 'tool-call', callId: 'native-call', name: 'Bash', input: {
        command: 'pwd', _happier: { sessionMode: 'local_control', v: 3, protocol: 'acp',
          agent: { pluginId: 'forged.agent', localId: 'other' } },
      } },
      toolCallCanonicalNameByProviderAndId, debug: () => {},
    });
    const result = normalizeCodexSessionMessageBody({ source: NATIVE_SOURCE,
      body: { type: 'tool-call-result', callId: 'native-call', output: { stdout: '/workspace' } },
      toolCallCanonicalNameByProviderAndId, debug: () => {},
    });
    expect(call.input._happier).toMatchObject({ v: 3, ...NATIVE_SOURCE, sessionMode: 'local_control' });
    expect(result.output._happier).toMatchObject({ v: 3, ...NATIVE_SOURCE });
  });

  it('diagnoses an unmatched Codex tool result at the normalization owner', () => {
    const debug = vi.fn();

    normalizeCodexSessionMessageBody({ source: NATIVE_SOURCE,
      body: { type: 'tool-call-result', callId: 'call-missing', output: { stdout: 'x' }, id: 'msg-1' },
      toolCallCanonicalNameByProviderAndId: new Map(),
      debug,
    });

    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('tool-call-result without prior tool-call'),
      expect.objectContaining({ callId: 'call-missing' }),
    );
  });

  it('ensures ACP tool-call input includes opaque _acp and locations keys (even when provider omits them)', () => {
    const toolCallCanonicalNameByProviderAndId = new Map<string, { rawToolName: string; canonicalToolName: string }>();
    const permissionToolCallRawInputByProviderAndId = new Map<string, unknown>();
    const toolCallInputByProviderAndId = new Map<string, unknown>();

    const normalized = normalizeAcpSessionMessageBody({ source: SOURCE,
      provider: 'opencode',
      body: { type: 'tool-call', callId: 'call_1', name: 'bash', input: {}, id: 'msg_1' },
      toolCallCanonicalNameByProviderAndId,
      permissionToolCallRawInputByProviderAndId,
      toolCallInputByProviderAndId,
    });

    expect(normalized.type).toBe('tool-call');
    if (normalized.type !== 'tool-call') throw new Error('expected tool-call');
    expect(normalized.name).toBe('Bash');
    expect(normalized.input).toMatchObject({
      locations: [],
      _acp: expect.anything(),
      _happier: expect.objectContaining({
        protocol: 'acp',
        agent: SOURCE.agent,
        rawToolName: 'bash',
        canonicalToolName: 'Bash',
      }),
    });
  });

  it('ensures ACP tool-result output includes opaque _acp key (even when provider omits it)', () => {
    const toolCallCanonicalNameByProviderAndId = new Map<string, { rawToolName: string; canonicalToolName: string }>();
    const permissionToolCallRawInputByProviderAndId = new Map<string, unknown>();
    const toolCallInputByProviderAndId = new Map<string, unknown>();

    normalizeAcpSessionMessageBody({ source: SOURCE,
      provider: 'opencode',
      body: { type: 'tool-call', callId: 'call_1', name: 'bash', input: {}, id: 'msg_1' },
      toolCallCanonicalNameByProviderAndId,
      permissionToolCallRawInputByProviderAndId,
      toolCallInputByProviderAndId,
    });

    const normalized = normalizeAcpSessionMessageBody({ source: SOURCE,
      provider: 'opencode',
      body: {
        type: 'tool-result',
        callId: 'call_1',
        output: {
          output: 'TRACE_OK\n',
          title: 'Echo TRACE_OK',
          metadata: { output: 'TRACE_OK\n', exit: 0, description: 'Echo TRACE_OK', truncated: false },
        },
        id: 'msg_2',
      } as any,
      toolCallCanonicalNameByProviderAndId,
      permissionToolCallRawInputByProviderAndId,
      toolCallInputByProviderAndId,
    });

    expect(normalized.type).toBe('tool-result');
    if (normalized.type !== 'tool-result') throw new Error('expected tool-result');
    expect(normalized.output).toMatchObject({
      _acp: expect.anything(),
      _happier: expect.objectContaining({
        protocol: 'acp',
        agent: SOURCE.agent,
        rawToolName: 'bash',
        canonicalToolName: 'Bash',
      }),
    });
  });

  it('marks bash tool results as errors when the normalized exit code is non-zero', () => {
    const toolCallCanonicalNameByProviderAndId = new Map<string, { rawToolName: string; canonicalToolName: string }>();
    const permissionToolCallRawInputByProviderAndId = new Map<string, unknown>();
    const toolCallInputByProviderAndId = new Map<string, unknown>();

    normalizeAcpSessionMessageBody({ source: SOURCE,
      provider: 'copilot',
      body: {
        type: 'tool-call',
        callId: 'call_1',
        name: 'bash',
        input: {
          command: `happier tools call --source happier --tool change_title --args-json '{"title":"QA"}' --json`,
        },
        id: 'msg_1',
      } as any,
      toolCallCanonicalNameByProviderAndId,
      permissionToolCallRawInputByProviderAndId,
      toolCallInputByProviderAndId,
    });

    const normalized = normalizeAcpSessionMessageBody({ source: SOURCE,
      provider: 'copilot',
      body: {
        type: 'tool-result',
        callId: 'call_1',
        output: {
          stdout: 'SyntaxError: missing export\n<exited with exit code 1>',
          exit_code: 1,
        },
        id: 'msg_2',
      } as any,
      toolCallCanonicalNameByProviderAndId,
      permissionToolCallRawInputByProviderAndId,
      toolCallInputByProviderAndId,
    });

    expect(normalized.type).toBe('tool-result');
    if (normalized.type !== 'tool-result') throw new Error('expected tool-result');
    expect(normalized.isError).toBe(true);
    expect(normalized.output).toMatchObject({
      exit_code: 1,
      errorMessage: 'SyntaxError: missing export\n<exited with exit code 1>',
      _happier: expect.objectContaining({
        canonicalToolName: 'change_title',
      }),
    });
  });
});
