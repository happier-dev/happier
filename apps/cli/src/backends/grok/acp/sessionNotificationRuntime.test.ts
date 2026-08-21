import { describe, expect, it, vi } from 'vitest';

import type { AcpExtensionHandlerContext } from '@/agent/acp/AcpBackend';
import { createGrokSessionNotificationObserverForSession } from './sessionNotificationRuntime';

describe('Grok session notification runtime binding', () => {
  it('uses the canonical encrypted workflow-record/headline transport and work-state merge', async () => {
    let metadata: Record<string, unknown> = {
      sessionWorkStateV1: {
        v: 1,
        backendId: 'grok',
        updatedAt: 1,
        items: [{
          id: 'acp.plan.grok:todo-1',
          kind: 'todo',
          origin: 'vendor',
          status: 'pending',
          title: 'Existing plan item',
          updatedAt: 1,
        }],
      },
    };
    const upsertSessionSystemRecord = vi.fn(async () => undefined);
    const session = {
      sessionId: 'happier-session',
      updateMetadata: async (updater: (value: Record<string, unknown>) => Record<string, unknown>) => {
        metadata = updater(metadata);
      },
      upsertSessionSystemRecord,
      fetchSessionSystemRecord: vi.fn(async () => null),
      getStoredContentEncryptionContext: () => ({ mode: 'plain' as const }),
    };
    const observer = createGrokSessionNotificationObserverForSession(session as never);
    const context = {
      method: 'x.ai/session_notification',
      sessionId: 'grok-session',
      signal: new AbortController().signal,
      agentName: 'grok',
    } satisfies AcpExtensionHandlerContext;

    await observer({
      sessionId: 'grok-session',
      update: {
        sessionUpdate: 'workflow_updated',
        run_id: 'run-1',
        revision: 1,
        name: 'Ship',
        objective: 'Finish',
        status: 'active',
      },
    }, context);

    expect(upsertSessionSystemRecord).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'activity',
      kind: 'workflow_run.v1',
      localId: expect.stringContaining('run-1'),
      content: expect.objectContaining({ t: 'plain' }),
    }));
    expect(metadata).toHaveProperty('sessionWorkflowActivityHeadlineV1');
    expect(metadata).toHaveProperty('sessionAgentActivityHeadlineV1');

    await observer({
      sessionId: 'grok-session',
      update: {
        sessionUpdate: 'goal_updated',
        goal_id: 'goal-1',
        objective: 'Ship',
        status: 'active',
      },
    }, context);

    expect(metadata.sessionWorkStateV1).toMatchObject({
      items: [
        expect.objectContaining({ id: 'acp.plan.grok:todo-1' }),
        expect.objectContaining({ id: 'grok.goal:goal-1', kind: 'goal' }),
      ],
    });
  });
});
