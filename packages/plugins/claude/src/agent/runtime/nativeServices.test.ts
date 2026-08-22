import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import {
  createClaudeNativeAgentSdkContext,
  createClaudeNativeGoalWorkStatePublisher,
} from './nativeServices.js';

describe('createClaudeNativeAgentSdkContext', () => {
  it('preserves execution-run tool proposals when no session interception scope exists', async () => {
    const context = {
      services: {
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        exec: {},
      },
    };
    const native = createClaudeNativeAgentSdkContext(context as never);

    await expect(native.agentRuntime.toolExecution.before({
      callId: 'execution-run-call-1',
      name: 'Read',
      input: { path: 'README.md' },
    })).resolves.toEqual({
      status: 'continue',
      input: { path: 'README.md' },
    });
  });

  it('does not discover workflow records outside a private native-session invocation', async () => {
    const context = {
      services: {
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        exec: {},
      },
      session: { services: {} },
    } as unknown as AgentSessionRuntimeContext;
    const native = createClaudeNativeAgentSdkContext(context, context);

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

    publishGoal({
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

  it('refreshes runtime auth through the common Session handle without forwarding Agent identity', async () => {
    const refreshRuntimeAuth = vi.fn(async () => ({ status: 'refreshed' as const }));
    const controller = new AbortController();
    const context = {
      services: {
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        exec: {},
        sessions: {
          current: { auth: { services: { refreshRuntimeAuth } } },
        },
      },
      session: { services: {} },
    } as unknown as AgentSessionRuntimeContext;
    const native = createClaudeNativeAgentSdkContext(context, context);

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
    const publishSessionEvent = vi.fn(async () => ({ status: 'custodied' as const }));
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
    const native = createClaudeNativeAgentSdkContext(context, context);
    const event = {
      type: 'terminal-composer-draft-blocked' as const,
      reason: 'idle_draft_guard' as const,
      stateAtMs: 123,
      message: 'Clear the terminal draft.',
    };

    await expect(
      native.agentRuntime.transcripts.publishSessionEvent(event),
    ).resolves.toEqual({ status: 'custodied' });
    expect(publishSessionEvent).toHaveBeenCalledWith(event);
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
    const native = createClaudeNativeAgentSdkContext(context, context);

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
    const native = createClaudeNativeAgentSdkContext(context, context);

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
    expect(publishHeadline).toHaveBeenCalledOnce();
  });
});
