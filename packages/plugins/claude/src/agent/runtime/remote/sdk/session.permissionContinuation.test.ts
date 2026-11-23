import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeContext, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

import type { ApiSessionClient } from '../../../../../../../../apps/cli/src/api/session/sessionClient.js';
import { ProviderEnforcedPermissionHandler } from '../../../../../../../../apps/cli/src/agent/permissions/providerEnforced/handler.js';
import { ServerBoundPermissionRpcHandlerManager } from '../../../../../../../../apps/cli/src/agent/permissions/testkit/serverBoundPermissionRpcHandlerManager.js';
import { createNativeAgentSessionServices } from '../../../../../../../../apps/cli/src/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions.js';
import { createMutableApiSessionClientFixture } from '../../../../../../../../apps/cli/src/testkit/backends/sessionFixtures.js';
import { createClaudeNativePermissionEngine } from '../../../permissions/nativePermissionEngine.js';
import type { PermissionResult } from '../../../sdk/types.js';
import { createEventsFixture, createPluginContextFixture, createSdkExecFixture, createTerminalHostFixture } from '../../engine.testkit.js';
import { createClaudeNativeSessionRuntimeFromOperations } from '../../nativeRuntime.js';
import { createClaudeAgentSdkTurnOperations } from './session.js';

describe('Claude SDK tool permission continuation', () => {
  it.each([
    { scenario: 'Read-only title refusal', mode: 'read-only', behavior: 'deny', choiceId: null, interrupt: false },
    { scenario: 'allowed title change', mode: 'default', behavior: 'allow', choiceId: null, interrupt: false },
    { scenario: 'host tool policy rejection', mode: 'default', behavior: 'deny', choiceId: null, interrupt: false, rejectBeforePermission: true },
    { scenario: 'approval card Deny', mode: 'default', behavior: 'deny', choiceId: 'deny', interrupt: false },
    { scenario: 'approval card Stop', mode: 'default', behavior: 'deny', choiceId: 'stop', interrupt: true },
  ] as const)('settles a turn after $scenario', async scenario => {
    const { mode, behavior, choiceId, interrupt } = scenario;
    const rejectBeforePermission = 'rejectBeforePermission' in scenario;
    const sessionId = 'permission-session';
    const turnId = 'permission-turn';
    const rpc = new ServerBoundPermissionRpcHandlerManager(sessionId);
    const session = createMutableApiSessionClientFixture({ sessionId, overrides: {
      // The fixture implements the authenticated RPC transport used by the handler.
      rpcHandlerManager: rpc as unknown as ApiSessionClient['rpcHandlerManager'],
    } });
    const permissionHandler = new ProviderEnforcedPermissionHandler(session, {
      logPrefix: '[Claude continuation test]', getWorkspaceWrites: () => 'allow',
    });
    permissionHandler.setPermissionMode(mode);
    const lifetime = new AbortController();
    const services = createNativeAgentSessionServices({
      sessionId, permissionHandler, pluginId: 'happier.agent.claude', contributionId: 'claude',
      runtimeId: 'claude-test-runtime', occurrenceId: 'claude-test-occurrence', isCurrent: () => true,
      signal: lifetime.signal, applyPermissionModeIntent: async nextMode => { permissionHandler.setPermissionMode(nextMode); },
    });
    const exec = createSdkExecFixture();
    const fixture = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
      exec: exec.service,
      toolExecution: {
        before: async (request: { input: unknown }) => rejectBeforePermission
          ? { status: 'rejected', code: 'plugin_policy_denied', message: 'Title change refused by policy' }
          : { status: 'continue', input: request.input },
      },
    });
    const operations = createClaudeAgentSdkTurnOperations({
      ctx: fixture, directory: '/tmp/claude-tool-permission', launchEnv: {}, happierSessionId: sessionId,
      permissionMode: mode, publishTranscriptMessages: true,
      permissionEngine: createClaudeNativePermissionEngine({ services } as AgentRuntimeContext),
    });
    const context = { session: { services: {
      activeInput: { bind: () => ({ dispose() {} }) }, models: { bind: () => ({ dispose() {} }) },
    } } } as unknown as AgentSessionRuntimeContext;
    const runtime = createClaudeNativeSessionRuntimeFromOperations(operations,
      { kind: 'create', sessionId, cwd: '/tmp/claude-tool-permission' }, context);
    const events: AgentSessionRuntimeEvent[] = [];
    const subscription = runtime.watch(event => events.push(event));
    const requestId = 'permission-request';
    const toolUseId = 'call_01a204c1f0f6728f994c9c0a092f4d83';
    const toolName = choiceId ? 'Bash' : 'mcp__happier__change_title';
    const input = choiceId ? { command: 'printf QA' } : { title: 'QA_DENIED_TITLE' };
    const assistantText = 'QA_AFTER_TOOL';
    const modelRequests: Array<{ toolResult: string; isError: boolean }> = [];
    const toolEffects: unknown[] = [];
    try {
      await runtime.send({ inputIds: ['permission-input'], delivery: { kind: 'newTurn', turnId },
        input: { text: choiceId ? 'Print QA with Bash. After the result, reply exactly QA_AFTER_TOOL.'
          : 'First call the Happier change_title tool to set the title to QA_DENIED_TITLE. After the result, reply exactly QA_AFTER_TOOL. Do not do anything else.' } });
      await exec.emit({ type: 'assistant', uuid: 'tool-call', message: {
        role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
      } });
      const permissionRequest = exec.emit({ type: 'control_request', request_id: requestId,
        request: { subtype: 'can_use_tool', tool_name: toolName, tool_use_id: toolUseId, input } });
      if (choiceId) {
        const requests = () => Object.entries(session.__getAgentState().requests ?? {});
        await vi.waitFor(() => expect(requests()).toHaveLength(1));
        const [id, request] = requests()[0]!;
        const respond = rpc.handlers.get('session.permission.respond');
        if (!respond || !request.nativeChoices) throw new Error('Expected a native approval card');
        await respond({ id, nativeChoice: { requirementId: request.nativeChoices.requirementId, choiceId } });
      }
      await permissionRequest;
      const readReply = () => exec.written.find((record): record is { response: { response: PermissionResult } } =>
        typeof record === 'object' && record !== null && Reflect.get(record, 'type') === 'control_response'
        && Reflect.get(record, 'response')?.request_id === requestId);
      await vi.waitFor(() => expect(readReply()?.response.response).toMatchObject({ behavior }));

      // Stand-in for the native Claude process: an interrupt emits the captured
      // failure shape. A regular tool result is included in the next model request.
      const permission = readReply()!.response.response;
      if (permission.behavior === 'allow') toolEffects.push(permission.updatedInput);
      const isError = permission.behavior === 'deny';
      const toolResult = isError ? permission.message : 'Title updated';
      await exec.emit({ type: 'user', uuid: 'tool-result', message: {
        role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: toolResult }],
      } });
      if (permission.behavior === 'deny' && permission.interrupt) {
        await exec.emit({ type: 'result', subtype: 'error_during_execution', is_error: true,
          errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'], queued_turn_count: 0 });
      } else {
        modelRequests.push({ toolResult, isError });
        await exec.emit({ type: 'assistant', uuid: 'follow-up', message: {
          role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: assistantText }],
        } });
        await exec.emit({ type: 'result', subtype: 'success', is_error: false, result: assistantText, queued_turn_count: 0 });
      }
      expect(toolEffects).toEqual(behavior === 'allow' ? [input] : []);
      if (interrupt) {
        expect(modelRequests).toEqual([]);
        await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ turnId, kind: 'turn-failed',
          diagnostic: expect.objectContaining({ code: 'claude_error_during_execution' }),
        })));
      } else {
        await vi.waitFor(() => expect(events.filter(event => event.turnId === turnId
          && (event.kind === 'turn-failed' || event.kind === 'turn-complete')).map(event => event.kind)).toEqual(['turn-complete']));
        expect(modelRequests).toEqual([{ toolResult: expect.any(String), isError: behavior === 'deny' }]);
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'tool-result', turnId, toolCallId: toolUseId, output: modelRequests[0]?.toolResult,
          ...(behavior === 'deny' ? { isError: true } : {}),
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'transcript-message-committed', turnId, role: 'assistant', text: assistantText,
        }));
      }
    } finally {
      lifetime.abort();
      subscription.dispose();
      await runtime.dispose();
      await permissionHandler.abortPendingRequestsAndFlush('test cleanup');
      await session.close();
    }
  });
});
