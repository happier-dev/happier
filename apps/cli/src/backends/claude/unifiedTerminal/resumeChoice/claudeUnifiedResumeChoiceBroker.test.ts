import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE_REQUEST_SOURCE } from '@happier-dev/agents';
import { SESSION_RPC_METHODS, type StructuredQuestionResponseV1 } from '@happier-dev/protocol';
import { PUBLIC_RPC_HANDLER_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { createPermissionHandlerSessionStub } from '../../utils/permissionHandler.testkit';
import {
  CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION,
  ClaudeUnifiedResumeChoiceBroker,
} from './claudeUnifiedResumeChoiceBroker';

async function expectRejectsWithin<T>(promise: Promise<T>, ms = 250): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for rejection')), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        reject(new Error('expected promise to reject'));
      },
      (error) => {
        clearTimeout(timer);
        resolve(error);
      },
    );
  });
}

describe('ClaudeUnifiedResumeChoiceBroker', () => {
  it('resolves a modern structured answer through the receiver-enforced v1 router', async () => {
    const { session, client } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedResumeChoiceBroker(session, {
      createRequestId: () => 'claude_resume_choice_modern',
      nowMs: () => 123,
    });
    broker.activate();

    const pending = broker.requestResumeChoice();
    const structuredRpc = client.rpcHandlerManager.getHandler<StructuredQuestionResponseV1>(
      SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1,
    );
    await expect(structuredRpc?.({
      id: 'claude_resume_choice_modern',
      structuredAnswersV1: {
        [CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION]: ['Resume full session'],
      },
    })).resolves.toEqual({ ok: true });

    await expect(pending).resolves.toBe('resume_full_session');
    expect(client.getAgentStateSnapshot().completedRequests.claude_resume_choice_modern).toMatchObject({
      status: 'approved',
      source: CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE_REQUEST_SOURCE,
      structuredAnswersV1: {
        [CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION]: ['Resume full session'],
      },
      resumeChoice: 'resume_full_session',
    });
  });

  it('keeps an owned modern request retryable after semantic validation fails', async () => {
    const { session, client } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedResumeChoiceBroker(session, {
      createRequestId: () => 'claude_resume_choice_retry',
    });
    broker.activate();

    const pending = broker.requestResumeChoice();
    const structuredRpc = client.rpcHandlerManager.getHandler<StructuredQuestionResponseV1>(
      SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1,
    );
    await expect(structuredRpc?.({
      id: 'claude_resume_choice_retry',
      structuredAnswersV1: {
        [CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION]: ['Mystery mode'],
      },
    })).rejects.toMatchObject({
      rpcErrorCode: PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_INVALID,
    });
    expect(client.getAgentStateSnapshot().requests.claude_resume_choice_retry).toBeDefined();
    expect(client.getAgentStateSnapshot().completedRequests.claude_resume_choice_retry).toBeUndefined();
    expect(broker.hasPendingChoice()).toBe(true);

    await expect(structuredRpc?.({
      id: 'claude_resume_choice_retry',
      structuredAnswersV1: {
        [CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION]: ['Resume from summary'],
      },
    })).resolves.toEqual({ ok: true });
    await expect(pending).resolves.toBe('resume_from_summary');
  });

  it('rejects a modern answer for an unowned request without disturbing the owned waiter', async () => {
    const { session, client } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedResumeChoiceBroker(session, {
      createRequestId: () => 'claude_resume_choice_owned',
    });
    broker.activate();

    const pending = broker.requestResumeChoice();
    const structuredRpc = client.rpcHandlerManager.getHandler<StructuredQuestionResponseV1>(
      SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1,
    );
    await expect(structuredRpc?.({
      id: 'another_request',
      structuredAnswersV1: {
        [CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION]: ['Resume from summary'],
      },
    })).rejects.toMatchObject({
      rpcErrorCode: PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_RECEIVER_NOT_OWNER,
    });
    expect(client.getAgentStateSnapshot().requests.claude_resume_choice_owned).toBeDefined();

    broker.dispose();
    await expectRejectsWithin(pending);
  });

  it('publishes one source-marked AskUserQuestion and resolves a summary answer through the shared permission RPC', async () => {
    const { session, client } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedResumeChoiceBroker(session, {
      createRequestId: () => 'claude_resume_choice_1',
      nowMs: () => 123,
    });
    broker.activate();

    const choicePromise = broker.requestResumeChoice();
    const request = client.getAgentStateSnapshot().requests.claude_resume_choice_1 as any;

    expect(request).toMatchObject({
      tool: 'AskUserQuestion',
      kind: 'user_action',
      source: CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE_REQUEST_SOURCE,
      createdAt: 123,
    });
    expect(client.getAgentStateSnapshot().capabilities?.askUserQuestionAnswersInPermission).toBe(true);
    expect(broker.hasPendingChoice()).toBe(true);

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    await expect(permissionRpc?.({
      id: 'claude_resume_choice_1',
      approved: true,
      answers: { [CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION]: 'Resume from summary' },
    })).resolves.toEqual({ ok: true });

    await expect(choicePromise).resolves.toBe('resume_from_summary');
    expect(client.getAgentStateSnapshot().requests.claude_resume_choice_1).toBeUndefined();
    expect(client.getAgentStateSnapshot().completedRequests.claude_resume_choice_1).toMatchObject({
      status: 'approved',
      source: CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE_REQUEST_SOURCE,
      structuredAnswersV1: {
        [CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION]: ['Resume from summary'],
      },
      resumeChoice: 'resume_from_summary',
    });
    expect(broker.hasPendingChoice()).toBe(false);
  });

  it('reuses the pending request while the same visible dialog is waiting for a user answer', async () => {
    const { session, client } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedResumeChoiceBroker(session, {
      createRequestId: vi.fn()
        .mockReturnValueOnce('claude_resume_choice_1')
        .mockReturnValueOnce('claude_resume_choice_2'),
    });
    broker.activate();

    const first = broker.requestResumeChoice();
    const second = broker.requestResumeChoice();

    expect(Object.keys(client.getAgentStateSnapshot().requests)).toEqual(['claude_resume_choice_1']);

    await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'claude_resume_choice_1',
      approved: true,
      answers: { [CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION]: 'resume_full_session' },
    });

    await expect(first).resolves.toBe('resume_full_session');
    await expect(second).resolves.toBe('resume_full_session');
  });

  it('leaves the request retryable when an owned answer is malformed', async () => {
    const { session, client } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedResumeChoiceBroker(session, {
      createRequestId: () => 'claude_resume_choice_1',
    });
    broker.activate();

    const pending = broker.requestResumeChoice();
    const permissionRpc = client.rpcHandlerManager.getHandler('permission');

    await expect(permissionRpc?.({
      id: 'claude_resume_choice_1',
      approved: true,
      answers: { [CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION]: 'Use a mystery mode' },
    })).rejects.toMatchObject({
      rpcErrorCode: PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_INVALID,
    });

    expect(client.getAgentStateSnapshot().requests.claude_resume_choice_1).toBeDefined();
    expect(broker.hasPendingChoice()).toBe(true);

    await expect(permissionRpc?.({
      id: 'claude_resume_choice_1',
      approved: true,
      answers: { [CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION]: 'Resume from summary' },
    })).resolves.toEqual({ ok: true });
    await expect(pending).resolves.toBe('resume_from_summary');

    broker.dispose();
  });

  it('cancels the pending user action without sending a choice when disposed', async () => {
    const { session, client } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedResumeChoiceBroker(session, {
      createRequestId: () => 'claude_resume_choice_1',
      nowMs: () => 123,
    });
    broker.activate();

    const pending = broker.requestResumeChoice();
    broker.dispose();

    await expectRejectsWithin(pending);
    expect(client.getAgentStateSnapshot().requests.claude_resume_choice_1).toBeUndefined();
    expect(client.getAgentStateSnapshot().completedRequests.claude_resume_choice_1).toMatchObject({
      status: 'canceled',
      reason: 'claude_unified_resume_choice_broker_disposed',
      source: CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE_REQUEST_SOURCE,
    });
  });

  it('cancels the pending user action when the dialog is resolved manually in the terminal', async () => {
    const { session, client } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedResumeChoiceBroker(session, {
      createRequestId: () => 'claude_resume_choice_1',
    });
    broker.activate();

    const pending = broker.requestResumeChoice();
    broker.noteDialogResolvedInTerminal('resume_dialog_resolved_in_terminal');

    await expectRejectsWithin(pending);
    expect(client.getAgentStateSnapshot().completedRequests.claude_resume_choice_1).toMatchObject({
      status: 'canceled',
      reason: 'resume_dialog_resolved_in_terminal',
    });
    expect(broker.hasPendingChoice()).toBe(false);
  });
});
