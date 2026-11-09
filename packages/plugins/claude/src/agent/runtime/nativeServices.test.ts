import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import {
  createClaudeNativeAgentSdkContext,
  createClaudeNativeGoalWorkStatePublisher,
} from './nativeServices.js';
import { createClaudePermissionHookHandler } from './shared/permissionHookHandler.js';

describe('createClaudeNativeAgentSdkContext', () => {
  it('keeps external MCP catalog consent on its incumbent host permission path', async () => {
    // The host interaction transport is the external SDK boundary.
    const requestApproval: AgentSessionRuntimeContext['services']['interactions']['requestApproval'] = async (request) => {
      expect(request.nativeChoices).toBeUndefined();
      expect(request.allowSessionPersistence).toBe(true);
      return { requestId: 'mcp-session', kind: 'approval', status: 'approved', persistence: 'session' };
    };
    const context = {
      services: {
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, exec: {},
        interactions: { requestApproval },
      },
      session: { services: { toolExecution: {
        before: async (request: { input: Record<string, unknown> }) => ({ status: 'continue' as const, input: request.input }),
      } } },
    } as unknown as AgentSessionRuntimeContext;
    const handler = createClaudePermissionHookHandler(createClaudeNativeAgentSdkContext(context));
    const response = await handler({ hook_event_name: 'PermissionRequest', tool_name: 'mcp__docs__mutate',
      tool_use_id: 'mcp-call', tool_input: { page: 'draft' } });
    expect(response.hookSpecificOutput?.decision).toEqual({ behavior: 'allow' });
  });

  it.each(['default', 'acceptEdits', 'bypassPermissions', 'stop'] as const)(
    'applies the offered ExitPlan %s through the real native adapter and hook reply', async (selection) => {
      // The host interaction transport is the external SDK boundary.
      const requestApproval: AgentSessionRuntimeContext['services']['interactions']['requestApproval'] = async (request) => {
        const choiceId = selection === 'stop' ? 'stop' : `approve:${selection}`;
        const choice = request.nativeChoices?.choices.find((item) => item.id === choiceId);
        expect(choice).toMatchObject(selection === 'stop'
          ? { decision: 'abort', scope: 'session', response: { decision: 'abort', mode: 'read-only' } }
          : { decision: 'approved', scope: 'session', response: { mode: selection,
              updatedPermissions: [{ type: 'setMode', mode: selection, destination: 'session' }] } });
        if (!choice || !request.nativeChoices) throw new Error('Expected offered native ExitPlan choice');
        expect(request.nativeChoices.choices.some((item) => item.decision === 'approved_for_session'
          || item.response.updatedPermissions?.some((update) => update.type === 'addRules'))).toBe(false);
        const nativeChoice = { requirementId: request.nativeChoices.requirementId, choiceId };
        return selection === 'stop'
          ? { requestId: 'native-mode', kind: 'approval', status: 'userCancelled', nativeChoice }
          : { requestId: 'native-mode', kind: 'approval', status: 'approved', persistence: 'once', nativeChoice };
      };
      const context = {
        services: {
          logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, exec: {},
          interactions: { requestApproval },
        },
        session: { services: { toolExecution: {
          before: async (request: { input: Record<string, unknown> }) => ({ status: 'continue' as const, input: request.input }),
        } } },
      } as unknown as AgentSessionRuntimeContext;
      const handler = createClaudePermissionHookHandler(createClaudeNativeAgentSdkContext(context));
      const transport = { signal: new AbortController().signal };
      const response = await handler({ hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_use_id: 'plan-mode', tool_input: {} }, transport);
      const decision = selection === 'stop'
        ? { behavior: 'deny', interrupt: true }
        : { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: selection, destination: 'session' }] };
      expect(response.hookSpecificOutput?.decision).toMatchObject(decision);
    },
  );

  it('honors the host native approval through the SDK PermissionRequest hook', async () => {
    // Interception and interaction presentation cross the plugin's host SDK boundary.
    const requestApproval = vi.fn(async () => ({ status: 'approved' as const }));
    const context = {
      services: {
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        exec: {},
        interactions: { requestApproval },
      },
      session: { services: { toolExecution: {
        before: async (request: { input: Record<string, string> }) => ({ status: 'continue' as const, input: request.input }),
      } } },
    } as unknown as AgentSessionRuntimeContext;
    const handler = createClaudePermissionHookHandler(createClaudeNativeAgentSdkContext(context));

    const response = await handler({
      hook_event_name: 'PermissionRequest', tool_name: 'Bash',
      tool_input: { command: 'ls -d /usr/bin' },
    });

    expect(response.hookSpecificOutput?.decision).toEqual({ behavior: 'allow' });
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.objectContaining({ kind: 'tool', name: 'Bash', input: { command: 'ls -d /usr/bin' } }),
    }), undefined);
  });

  it('retains app-prompt question identity and canonical structured answers at the existing Session permission owner', async () => {
    // The host permission service and tool interception are the external SDK boundary.
    const requestDecision = vi.fn(async () => ({ decision: 'approved' as const, answers: { 'Which colors?': ['amber-id', 'blue-id'] } }));
    const context = {
      services: {
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, exec: {},
        sessions: { current: { permissions: { requestDecision } } },
        interactions: { askQuestions: async () => ({ requestId: 'host-generated-question', kind: 'questions', status: 'answered',
          answers: { 'which-colors': { kind: 'multipleChoice', answers: [{ kind: 'choice', choiceId: 'choice-1' }, { kind: 'choice', choiceId: 'choice-2' }] } },
        }) },
      },
      session: { services: { toolExecution: {
        before: async (request: { input: Record<string, unknown> }) => ({ status: 'continue' as const, input: request.input }),
      } } },
    } as unknown as AgentSessionRuntimeContext;
    const handler = createClaudePermissionHookHandler(createClaudeNativeAgentSdkContext(context));
    const response = await handler({ hook_event_name: 'PreToolUse', session_id: 'native-session',
      tool_use_id: 'toolu-question', tool_name: 'AskUserQuestion', tool_input: { questions: [{
        question: 'Which colors?', multiSelect: true, options: [{ label: 'Amber', value: 'amber-id' }, { label: 'Blue', value: 'blue-id' }],
      }] },
    });
    expect(response.hookSpecificOutput?.decision).toEqual(expect.objectContaining({ behavior: 'allow',
      updatedInput: expect.objectContaining({ answers: { 'Which colors?': 'Amber, Blue' } }),
    }));
    expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'toolu-question',
      toolCallId: 'toolu-question', source: 'claude_native_question', toolName: 'AskUserQuestion',
    }), expect.anything());
  });

  it('decodes each settled revision from the exact native home without exposing rotation material', async () => {
    let accessToken = 'old-access';
    let revision = 0;
    // Public host ports are the external boundary; exercise the real Claude adapter/parser.
    const refreshRuntimeAuth = vi.fn(async () => {
      accessToken = ++revision === 1 ? 'fresh-access' : 'next-access';
      return { status: 'refreshed' as const, result: { credentialRevision: `revision-${revision}` } };
    });
    const readFiles = vi.fn(async (paths: readonly string[]) => Object.fromEntries(paths.map(path => [path,
      new TextEncoder().encode(JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: 'private-rotation', scopes: ['user:inference'] } })),
    ])));
    const context = {
      services: { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, exec: {} },
      session: { services: { auth: { services: { refreshRuntimeAuth } }, nativeHome: { readFiles } } },
    } as unknown as AgentSessionRuntimeContext;
    const native = createClaudeNativeAgentSdkContext(context);
    const request = { agentId: 'claude', serviceId: 'claude-subscription', reason: 'credential_expired' };
    await expect(native.sessions.current.auth.services.refreshRuntimeAuth(request)).resolves.toEqual({
      status: 'refreshed', result: { accessToken: 'fresh-access', credentialRevision: 'revision-1' },
    });
    await expect(native.sessions.current.auth.services.refreshRuntimeAuth(request)).resolves.toEqual({
      status: 'refreshed', result: { accessToken: 'next-access', credentialRevision: 'revision-2' },
    });
    expect(readFiles.mock.calls).toEqual([[['.credentials.json']], [['.credentials.json']]]);
  });

  it('preserves committed identities and host refusals through the scoped transcript service', async () => {
    const request = {
      providerSessionId: 'claude-session-1',
      facts: [{ sourceMessageId: 'source-1', role: 'user' as const, localId: 'local-1' }],
    };
    const result = {
      committedSourceMessageIds: ['source-1'],
      hostAuthoredUserMessageIds: ['source-1'],
      coverage: { complete: true, unmappedUsers: 0, unmappedAgents: 0 },
    };
    // The plugin receives a bound host SDK service; host authority stays outside this adapter.
    const reconcileSourceIdentities = vi.fn(async () => result);
    const context = {
      services: {
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        exec: {},
      },
      session: { services: { transcripts: { reconcileSourceIdentities } } },
    } as unknown as AgentSessionRuntimeContext;
    const native = createClaudeNativeAgentSdkContext(context);

    await expect(native.agentRuntime.transcripts.reconcileSourceIdentities(request)).resolves.toEqual(result);
    expect(reconcileSourceIdentities).toHaveBeenCalledWith(request);

    const refusal = new Error('Transcript identity reconciliation is unavailable');
    reconcileSourceIdentities.mockRejectedValueOnce(refusal);
    await expect(native.agentRuntime.transcripts.reconcileSourceIdentities(request)).rejects.toBe(refusal);
  });

  it('delegates tool proposals to the host Session interception service', async () => {
    const before = vi.fn(async () => ({
      status: 'continue' as const,
      input: { path: 'host-selected.md' },
    }));
    const context = {
      services: {
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        exec: {},
      },
      session: { services: { toolExecution: { before } } },
    } as unknown as AgentSessionRuntimeContext;
    const native = createClaudeNativeAgentSdkContext(context);

    await expect(native.agentRuntime.toolExecution.before({
      callId: 'execution-run-call-1',
      name: 'Read',
      input: { path: 'README.md' },
    })).resolves.toEqual({
      status: 'continue',
      input: { path: 'host-selected.md' },
    });
    const refusal = new Error('Host tool interception unavailable');
    before.mockRejectedValueOnce(refusal);
    await expect(native.agentRuntime.toolExecution.before({
      callId: 'execution-run-call-2', name: 'Read', input: { path: 'README.md' },
    })).rejects.toBe(refusal);
  });

  it('does not discover workflow records outside a private native-session invocation', async () => {
    const context = {
      services: {
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        exec: {},
      },
      session: { services: {} },
    } as unknown as AgentSessionRuntimeContext;
    const native = createClaudeNativeAgentSdkContext(context);

    await expect(native.sessions.current.writeSystemRecord({
      namespace: 'activity',
      kind: 'workflow_run.v1',
      localId: 'workflow:outside-invocation',
      payload: {},
      reason: 'outside invocation must not receive a host port',
    })).rejects.toThrow(/unavailable outside a native session invocation/u);
  });

  it('publishes Claude goal snapshots through the declared native work-state source', async () => {
    const publish = vi.fn(async () => ({
      status: 'applied' as const,
      revision: 'revision-1',
      sourceSequence: 1,
    }));
    const publisher = vi.fn(() => ({ publish }));
    const context = { workState: { publisher } } as unknown as AgentSessionRuntimeContext;
    const publishGoal = createClaudeNativeGoalWorkStatePublisher(context);

    await publishGoal({
      v: 1,
      backendId: 'claude',
      agentId: 'claude',
      updatedAt: 123,
      primaryItemId: 'goal:claude',
      items: [{
        id: 'goal:claude',
        kind: 'goal',
        origin: 'vendor',
        status: 'active',
        title: 'Ship native Claude',
        backendId: 'claude',
        agentId: 'claude',
        vendorRef: 'goal-revision-1',
        tokensUsed: 42,
        updatedAt: 123,
      }],
    });

    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publisher).toHaveBeenCalledWith('goals');
    expect(publish).toHaveBeenCalledWith({
      sourceSequence: 1,
      observedAtMs: 123,
      primaryLocalId: 'goal:claude',
      items: [{
        localId: 'goal:claude',
        kind: 'goal',
        origin: 'vendor',
        status: 'active',
        title: 'Ship native Claude',
        providerRef: 'goal-revision-1',
        tokensUsed: 42,
        updatedAtMs: 123,
      }],
    });
  });

  it('does not acknowledge a refused native goal work-state publication', async () => {
    const publish = vi.fn(async () => ({ status: 'unavailable' as const,
      diagnostic: { code: 'agent_work_state_host_unavailable', severity: 'error' as const } }));
    // The plugin's public host publisher is the boundary; the Goal source and
    // native control remain real in the composed host registration regression.
    const context = { workState: { publisher: () => ({ publish }) },
      services: { logger: { warn: vi.fn() } } } as unknown as AgentSessionRuntimeContext;
    await expect(createClaudeNativeGoalWorkStatePublisher(context)({
      v: 1, backendId: 'claude', agentId: 'claude', updatedAt: 123, primaryItemId: null, items: [],
    })).rejects.toThrow('agent_work_state_host_unavailable');
  });

  it('refreshes runtime auth through the native host capability without general Session access or Agent identity', async () => {
    const refreshRuntimeAuth = vi.fn(async () => ({ status: 'refreshed' as const }));
    const controller = new AbortController();
    const context = {
      services: {
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        exec: {},
        sessions: {
          current: null,
        },
      },
      session: { services: { auth: { services: { refreshRuntimeAuth } } } },
    } as unknown as AgentSessionRuntimeContext;
    const native = createClaudeNativeAgentSdkContext(context);

    await expect(native.sessions.current.auth.services.refreshRuntimeAuth({
      agentId: 'claude',
      serviceId: 'anthropic',
      reason: 'credential_expired',
    }, { signal: controller.signal })).resolves.toEqual({ status: 'refreshed' });

    expect(refreshRuntimeAuth).toHaveBeenCalledWith({
      serviceId: 'anthropic',
      reason: 'credential_expired',
    }, { signal: controller.signal });
  });

  it('awaits the native host durable transcript publisher for typed Session events', async () => {
    let releasePublication!: () => void;
    const publication = new Promise<void>(resolve => { releasePublication = resolve; });
    const publishSessionEvent = vi.fn(async () => {
      await publication;
      return { status: 'custodied' as const };
    });
    const context = {
      services: {
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        exec: {},
      },
      session: {
        services: {
          transcripts: {
            fileFollow: {},
            publishSessionEvent,
          },
        },
      },
    } as unknown as AgentSessionRuntimeContext;
    const native = createClaudeNativeAgentSdkContext(context);
    const event = {
      type: 'terminal-composer-draft-blocked' as const,
      reason: 'idle_draft_guard' as const,
      stateAtMs: 123,
      message: 'Clear the terminal draft.',
    };

    let settled = false;
    const pendingPublication = native.agentRuntime.transcripts.publishSessionEvent(event).then(result => {
      settled = true;
      return result;
    });
    try {
      await vi.waitFor(() => expect(publishSessionEvent).toHaveBeenCalledWith(event));
      expect(settled).toBe(false);
    } finally {
      releasePublication();
    }
    await expect(pendingPublication).resolves.toEqual({ status: 'custodied' });
    expect(publishSessionEvent).toHaveBeenCalledWith(event);
    const refusal = new Error('Host transcript custody unavailable');
    publishSessionEvent.mockRejectedValueOnce(refusal);
    await expect(native.agentRuntime.transcripts.publishSessionEvent(event)).rejects.toBe(refusal);
  });

  it('uses the bound public SessionHandle for host-owned workflow records', async () => {
    const upsertSystemRecord = vi.fn(async () => ({
      id: 'record-1',
      address: {
        owner: 'host' as const,
        namespace: 'activity',
        kind: 'workflow_run.v1',
        localId: 'workflow:public-session-handle',
      },
      content: { v: 1 },
      revision: 'ssr1.AAAAAQ',
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
    }));
    const structuralWrite = vi.fn(async () => undefined);
    const context = {
      services: {
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        exec: {},
        sessions: {
          current: {
            upsertSystemRecord,
            readSystemRecord: vi.fn(async () => null),
          },
        },
      },
      session: {
        services: {
          systemRecords: { write: structuralWrite, read: vi.fn(async () => null) },
        },
      },
    } as unknown as AgentSessionRuntimeContext;
    const native = createClaudeNativeAgentSdkContext(context);

    await expect(native.sessions.current.writeSystemRecord({
      namespace: 'activity',
      kind: 'workflow_run.v1',
      localId: 'workflow:public-session-handle',
      payload: { v: 1 },
      reason: 'the public SessionHandle owns workflow-record custody',
    })).resolves.toBeUndefined();

    expect(upsertSystemRecord).toHaveBeenCalledWith({
      address: {
        owner: 'host',
        namespace: 'activity',
        kind: 'workflow_run.v1',
        localId: 'workflow:public-session-handle',
      },
      content: { v: 1 },
    });
    expect(structuralWrite).not.toHaveBeenCalled();
  });

  it('exposes only the typed workflow headline owner, not a whole-metadata writer', async () => {
    const publishHeadline = vi.fn(async () => undefined);
    const context = {
      services: {
        logger: {
          debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
        },
        exec: {},
      },
      session: {
        services: {
          workflowActivity: { publishHeadlines: publishHeadline },
        },
      },
    } as unknown as AgentSessionRuntimeContext;
    const native = createClaudeNativeAgentSdkContext(context);

    expect(native.sessions.current).not.toHaveProperty('writeMetadata');
    await native.sessions.current.workflowActivity.publishHeadlines({
      workflow: {
        v: 1,
        backendId: 'claude',
        activeRuns: [],
        updatedAt: 1,
      },
      agentActivity: {
        v: 1,
        backendId: 'claude',
        activeEntries: [],
        updatedAt: 1,
      },
    });
    expect(publishHeadline).toHaveBeenCalledWith({
      workflow: { v: 1, backendId: 'claude', activeRuns: [], updatedAt: 1 },
      agentActivity: { v: 1, backendId: 'claude', activeEntries: [], updatedAt: 1 },
    });
  });
});
