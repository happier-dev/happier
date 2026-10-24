import { describe, expect, it, vi } from 'vitest';

import type { SessionTurnMutationV1 } from '@/api/session/mutations/sessionMutationTypes';
import type { SessionTurnLifecycle } from '@/agent/runtime/session/turn/types';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import * as runtimeIssueSurface from './surfacePrimarySessionRuntimeIssue';

function createLifecycleStub(overrides: Partial<SessionTurnLifecycle>): SessionTurnLifecycle {
  return {
    beginTurn: vi.fn(),
    attachProviderTurnId: vi.fn(),
    appendTranscriptAnchors: vi.fn(),
    completeTurn: vi.fn(),
    failTurn: vi.fn(),
    cancelTurn: vi.fn(),
    endSession: vi.fn(),
    markRollbackEligible: vi.fn(),
    markRolledBack: vi.fn(),
    touchActiveTurn: vi.fn(),
    hasActiveTurn: vi.fn(() => false),
    ...overrides,
  };
}

describe('surfacePrimarySessionRuntimeIssue', () => {
  it('exposes the accepted failed issue synchronously while durable failure publication is pending', async () => {
    let releaseWrite: () => void = () => {};
    const pendingWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const lifecycle = createSessionTurnLifecycle({ sessionId: 'surface-witness', enqueueSessionTurn: async (mutation) => {
      if (mutation.action === 'fail') await pendingWrite;
    } });
    await lifecycle.beginTurn({ provider: 'agy' });
    const witnesses: unknown[] = [];
    const pending = runtimeIssueSurface.surfacePrimarySessionRuntimeIssue({ provider: 'agy', cause: 'session_error',
      error: new Error('provider failed'), occurredAt: 1_000, session: { sessionTurnLifecycle: lifecycle },
      onFailureTurn: (failure) => { witnesses.push(failure.issue); } });
    expect(witnesses).toHaveLength(1);
    const duplicate = runtimeIssueSurface.surfacePrimarySessionRuntimeIssue({ provider: 'agy', cause: 'session_error',
      error: new Error('provider failed'), occurredAt: 2_000, session: { sessionTurnLifecycle: lifecycle },
      suppressUntrustedDuplicate: true, onFailureTurn: (failure) => { witnesses.push(failure.issue); } });
    expect(witnesses[1]).toEqual(witnesses[0]);
    releaseWrite();
    expect(await pending).toEqual(witnesses[0]);
    expect(await duplicate).toEqual(witnesses[0]);
  });

  it('surfaces provider failures as failed primary turn runtime issues', async () => {
    const sendAgentMessage = vi.fn();
    const failTurn = vi.fn();

    const issue = await runtimeIssueSurface.surfacePrimarySessionRuntimeIssue({
      provider: 'codex',
      providerTurnId: 'turn_1',
      sessionSeq: 7,
      occurredAt: 123,
      cause: 'status_error',
      error: new Error('401 raw token should not be stored'),
      session: { sendAgentMessage, sessionTurnLifecycle: createLifecycleStub({ failTurn }) },
    });

    expect(issue).toMatchObject({
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'provider_status_error',
      source: 'provider_status_error',
      occurredAt: 123,
      sessionSeq: 7,
      provider: 'codex',
      providerTurnId: 'turn_1',
      sanitizedPreview: 'Provider reported an error',
    });
    expect(JSON.stringify(issue)).not.toContain('raw token');
    expect(sendAgentMessage).not.toHaveBeenCalled();
    expect(failTurn).toHaveBeenCalledWith({
      provider: 'codex',
      providerTurnId: 'turn_1',
      issue,
    });
  });

  it('preserves sanitized model-not-found session error details', async () => {
    const failTurn = vi.fn();

    const issue = await runtimeIssueSurface.surfacePrimarySessionRuntimeIssue({
      provider: 'opencode',
      providerTurnId: 'turn_model',
      occurredAt: 456,
      cause: 'session_error',
      error: {
        name: 'UnknownError',
        message: 'OpenCode session failed',
        data: { message: 'Model not found: anthropic/claude-sonnet-4-6.' },
      },
      session: { sessionTurnLifecycle: createLifecycleStub({ failTurn }) },
    });

    expect(issue).toMatchObject({
      code: 'provider_session_error',
      source: 'provider_session_error',
      provider: 'opencode',
      providerTurnId: 'turn_model',
      sanitizedPreview: 'Model not found: anthropic/claude-sonnet-4-6',
    });
    expect(failTurn).toHaveBeenCalledWith(expect.objectContaining({ issue }));
  });

  it('preserves Pi provider-session diagnostics through session error surfacing', async () => {
    const failTurn = vi.fn();

    const issue = await runtimeIssueSurface.surfacePrimarySessionRuntimeIssue({
      provider: 'pi',
      providerTurnId: 'pi-turn-provider-session',
      occurredAt: 789,
      cause: 'session_error',
      error: new Error('Pi provider reported provider session failure after prompt acceptance'),
      session: { sessionTurnLifecycle: createLifecycleStub({ failTurn }) },
    });

    expect(issue).toMatchObject({
      code: 'provider_session_error',
      source: 'provider_session_error',
      provider: 'pi',
      providerTurnId: 'pi-turn-provider-session',
      sanitizedPreview: 'Pi provider reported provider session failure after prompt acceptance',
    });
    expect(failTurn).toHaveBeenCalledWith(expect.objectContaining({ issue }));
  });

  it('surfaces cancellation as cancelled primary turn state without a runtime issue', async () => {
    const sendAgentMessage = vi.fn();
    const cancelTurn = vi.fn();

    const issue = await runtimeIssueSurface.surfacePrimarySessionRuntimeIssue({
      provider: 'claude',
      cause: 'cancelled',
      session: { sendAgentMessage, sessionTurnLifecycle: createLifecycleStub({ cancelTurn }) },
    });

    expect(issue).toBeNull();
    expect(sendAgentMessage).not.toHaveBeenCalled();
    expect(cancelTurn).toHaveBeenCalledWith({
      provider: 'claude',
    });
  });

  it('surfaces an idle session-scoped failure as a begin+fail session turn when allocation is requested (silent host-death fix)', async () => {
    const mutations: SessionTurnMutationV1[] = [];
    const lifecycle = createSessionTurnLifecycle({
      sessionId: 's1',
      createId: () => 'idle-death',
      now: () => 555,
      enqueueSessionTurn: async (mutation) => {
        mutations.push(mutation);
      },
    });

    const issue = await runtimeIssueSurface.surfacePrimarySessionRuntimeIssue({
      provider: 'claude',
      cause: 'process_exit',
      occurredAt: 555,
      error: new Error('Claude unified terminal host is not alive'),
      session: { sessionTurnLifecycle: lifecycle },
      allocateTurnWhenIdle: true,
    });

    expect(issue).toMatchObject({
      scope: 'primary_session',
      status: 'failed',
      source: 'provider_process_exit',
    });
    expect(mutations.map((mutation) => mutation.action)).toEqual(['begin', 'fail']);
    expect(mutations[1]).toMatchObject({ provider: 'claude', issue });
  });

  it('keeps an idle session-scoped failure a no-op without the allocation opt-in (duplicate/late terminal reports)', async () => {
    const mutations: SessionTurnMutationV1[] = [];
    const lifecycle = createSessionTurnLifecycle({
      sessionId: 's1',
      createId: () => 'idle-late-report',
      now: () => 556,
      enqueueSessionTurn: async (mutation) => {
        mutations.push(mutation);
      },
    });

    await runtimeIssueSurface.surfacePrimarySessionRuntimeIssue({
      provider: 'claude',
      cause: 'process_exit',
      error: new Error('late duplicate exit report'),
      session: { sessionTurnLifecycle: lifecycle },
    });

    expect(mutations).toEqual([]);
  });

  it('records in-progress and completed session turn states through lifecycle helpers', async () => {
    const beginTurn = vi.fn();
    const completeTurn = vi.fn();

    expect(runtimeIssueSurface).not.toHaveProperty('recordPrimaryTurnInProgress');
    expect(runtimeIssueSurface).not.toHaveProperty('recordPrimaryTurnCompleted');

    await runtimeIssueSurface.recordSessionTurnInProgress({
      provider: 'codex',
      session: { sessionTurnLifecycle: createLifecycleStub({ beginTurn }) },
    });
    await runtimeIssueSurface.recordSessionTurnCompleted({
      provider: 'codex',
      providerTurnId: 'turn_1',
      session: { sessionTurnLifecycle: createLifecycleStub({ completeTurn }) },
    });

    expect(beginTurn).toHaveBeenCalledWith({
      provider: 'codex',
    });
    expect(completeTurn).toHaveBeenCalledWith({
      provider: 'codex',
      providerTurnId: 'turn_1',
    });
  });
});
