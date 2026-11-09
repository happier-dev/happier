import { describe, expect, it } from 'vitest';

import { buildAgentRequestNotificationContent } from './agentRequestNotificationContent.js';
import { readNotificationQuestionAnswer } from '../push/notificationQuestionActions.js';
import { PUSH_NOTIFICATION_ACTION_IDS } from '../push/pushNotificationActions.js';

describe('buildAgentRequestNotificationContent', () => {
  it('offers a complete single-question choice mapping tied to the captured turn', () => {
    const content = buildAgentRequestNotificationContent({
      kind: 'user_action', sessionId: 'session-1', requestId: 'question-1', turnId: 'turn-1',
      toolName: 'AskUserQuestion',
      toolInput: { questions: [{ id: 'branch', question: 'Which branch?', options: [
        { id: 'wire-main', label: 'Main\n\tbranch', description: 'Stable\n\tcode' }, { choice: 'wire-release', label: 'Release' },
      ] }] },
    });
    expect(content).toMatchObject({
      body: 'Which branch?\n1. Main branch — Stable code\n2. Release',
      data: { turnId: 'turn-1', questionAnswerV1: { kind: 'choices', questionKey: 'branch', values: ['wire-main', 'wire-release'] } },
    });
    expect(readNotificationQuestionAnswer(content.data.questionAnswerV1, PUSH_NOTIFICATION_ACTION_IDS.questionChoice2V1, undefined))
      .toEqual({ branch: ['wire-release'] });
    expect(readNotificationQuestionAnswer(content.data.questionAnswerV1, PUSH_NOTIFICATION_ACTION_IDS.questionChoice3V1, undefined))
      .toBeNull();
    expect(readNotificationQuestionAnswer(undefined, PUSH_NOTIFICATION_ACTION_IDS.questionChoice2V1, undefined)).toBeNull();
  });

  it.each([
    { question: 'Notes?', selection: 'text', freeform: { allowEmpty: true } },
    { question: 'Notes?', selection: 'text', required: false },
  ])('offers a short text reply using the canonical empty-answer policy', (question) => {
    const content = buildAgentRequestNotificationContent({
      kind: 'user_action', sessionId: 'session-1', requestId: 'question-1', turnId: 'turn-1',
      toolName: 'AskUserQuestion', toolInput: { questions: [question] },
    });
    expect(content.data.questionAnswerV1).toEqual({ kind: 'text', questionKey: 'Notes?', allowEmpty: true });
    expect(readNotificationQuestionAnswer(content.data.questionAnswerV1, PUSH_NOTIFICATION_ACTION_IDS.questionTextV1, ''))
      .toEqual({ 'Notes?': [''] });
    expect(readNotificationQuestionAnswer(content.data.questionAnswerV1, PUSH_NOTIFICATION_ACTION_IDS.questionTextV1, 'x'.repeat(16_385)))
      .toBeNull();
  });

  it('keeps required short text empty-input rejection in the answer decoder', () => {
    const content = buildAgentRequestNotificationContent({
      kind: 'user_action', sessionId: 'session-1', requestId: 'question-1', turnId: 'turn-1',
      toolName: 'AskUserQuestion', toolInput: { questions: [{ question: 'Notes?', selection: 'text' }] },
    });
    expect(readNotificationQuestionAnswer(content.data.questionAnswerV1, PUSH_NOTIFICATION_ACTION_IDS.questionTextV1, '  ')).toBeNull();
    expect(readNotificationQuestionAnswer(content.data.questionAnswerV1, PUSH_NOTIFICATION_ACTION_IDS.questionTextV1, '  exact answer  '))
      .toEqual({ 'Notes?': ['  exact answer  '] });
  });

  it.each([
    { questions: [{ question: 'Notes?', freeform: { multiline: true } }] },
    { questions: [{ question: 'Notes?', freeform: { initialValue: 'Existing answer' } }] },
    { questions: [{ question: 'Choose?', multiSelect: true, options: ['a', 'b'] }] },
    { questions: [{ question: 'Choose?', options: ['a', 'b', 'c', 'd'] }] },
    { questions: [{ question: 'First?' }, { question: 'Second?' }] },
  ])('keeps a form that cannot fit native answers on the ordinary review path', (toolInput) => {
    const content = buildAgentRequestNotificationContent({
      kind: 'user_action', sessionId: 'session-1', requestId: 'question-1', turnId: 'turn-1',
      toolName: 'AskUserQuestion', toolInput,
    });
    expect(content.data.questionAnswerV1).toBeUndefined();
  });

  it('withholds inline question data without a captured turn or when message text is private', () => {
    const params = {
      kind: 'user_action' as const, sessionId: 'session-1', requestId: 'question-1',
      toolName: 'AskUserQuestion', toolInput: { questions: [{ question: 'Which secret branch?', options: ['private-value'] }] },
    };
    expect(buildAgentRequestNotificationContent(params).data.questionAnswerV1).toBeUndefined();
    const privateContent = buildAgentRequestNotificationContent({ ...params, turnId: 'turn-1', includeMessageText: false });
    expect(privateContent.data.questionAnswerV1).toBeUndefined();
    expect(JSON.stringify(privateContent)).not.toContain('Which secret branch?');
    expect(JSON.stringify(privateContent)).not.toContain('private-value');
  });

  it('keeps an above-cap push linked to the complete form even when explicit details were supplied', () => {
    const content = buildAgentRequestNotificationContent({
      kind: 'user_action',
      sessionId: 'session-1',
      requestId: 'request-five',
      toolName: 'AskUserQuestion',
      toolInput: { questions: Array.from({ length: 5 }, (_, index) => ({ question: `Question ${index}?` })) },
      toolDetails: 'Question 0?',
    });
    expect(content).toMatchObject({
      body: 'Agent needs your input for AskUserQuestion\nAnswer all 5 in Happier',
      toolDetails: 'Answer all 5 in Happier',
      data: { sessionId: 'session-1', requestId: 'request-five', type: 'user_action_request' },
    });
    expect(buildAgentRequestNotificationContent({
      kind: 'user_action',
      sessionId: 'session-1',
      requestId: 'request-five',
      toolName: 'AskUserQuestion',
      toolInput: { questions: Array.from({ length: 5 }, (_, index) => ({ question: `Question ${index}?` })) },
      includeMessageText: false,
    })).toMatchObject({ body: 'Agent needs your input for AskUserQuestion', toolDetails: null });
  });

  it('builds permission-request payloads with full tool details', () => {
    expect(
      buildAgentRequestNotificationContent({
        kind: 'permission',
        sessionId: 'session-1',
        sessionTitle: 'Fix prod issue',
        agentDisplayName: 'Claude',
        requestId: 'request-1',
        toolName: 'Bash',
        toolInput: { command: 'git status --short && echo secret-token' },
      }),
    ).toEqual({
      title: 'Fix prod issue',
      body: 'Claude asks permission to use Bash\nCommand: git status --short && echo secret-token',
      data: {
        sessionId: 'session-1',
        requestId: 'request-1',
        tool: 'Bash',
        type: 'permission_request',
        kind: 'permission',
      },
      toolDetails: 'Command: git status --short && echo secret-token',
    });
  });

  it('uses explicit tool details when provided and normalizes ask-user-question labels', () => {
    expect(
      buildAgentRequestNotificationContent({
        kind: 'user_action',
        sessionId: 'session-1',
        sessionTitle: '  Research   plan  ',
        agentDisplayName: 'Codex',
        requestId: 'request-2',
        toolName: 'ask_user_question',
        toolInput: {
          questions: [{ question: 'Which branch should I use?' }],
        },
        toolDetails: 'Custom details',
      }),
    ).toMatchObject({
      title: 'Research plan',
      body: 'Codex needs your input for AskUserQuestion\nCustom details',
      toolDetails: 'Custom details',
    });
  });

  it('uses safe fallback display text when session and agent labels are missing', () => {
    expect(
      buildAgentRequestNotificationContent({
        kind: 'permission',
        sessionId: 'session-permission-with-long-id',
        sessionTitle: '   ',
        agentDisplayName: '',
        requestId: 'request-3',
        toolName: 'Write',
        toolDetails: null,
      }),
    ).toMatchObject({
      title: 'Session session-',
      body: 'Agent asks permission to use Write',
      data: {
        sessionId: 'session-permission-with-long-id',
        requestId: 'request-3',
        tool: 'Write',
        type: 'permission_request',
        kind: 'permission',
      },
      toolDetails: null,
    });
  });
});
