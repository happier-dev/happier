import { describe, expect, it } from 'vitest';

import { classifyConversationCommand } from './commands.js';
import {
  CONVERSATION_NON_ADMISSION_REASONS,
  decideConversationCommandPolicy,
  isConversationSenderFeedbackEligible,
  settleCompetingNewSessionCommand,
} from './commandPolicy.js';

describe('Channels command policy', () => {
  it('keeps the sender-feedback matrix closed to allowed attributable non-authorization failures', () => {
    for (const reason of [
      'messageTooOld',
      'messageTooLarge',
      'unsupportedContent',
      'notAddressed',
      'malformedCommand',
    ] as const) {
      expect(isConversationSenderFeedbackEligible({
        senderFeedback: 'eligibleRefusals',
        actorPrincipalId: 'person-1',
        actorAllowed: true,
        reason,
      })).toBe(true);
    }

    for (const reason of [
      'actorNotAllowed',
      'integrationSelf',
      'commandNotAuthorized',
      'targetUnavailable',
    ] as const) {
      expect(isConversationSenderFeedbackEligible({
        senderFeedback: 'eligibleRefusals',
        actorPrincipalId: 'person-1',
        actorAllowed: true,
        reason,
      })).toBe(false);
    }
    expect(isConversationSenderFeedbackEligible({
      senderFeedback: 'eligibleRefusals',
      actorPrincipalId: null,
      actorAllowed: true,
      reason: 'messageTooOld',
    })).toBe(false);
    expect(isConversationSenderFeedbackEligible({
      senderFeedback: 'off',
      actorPrincipalId: 'person-1',
      actorAllowed: true,
      reason: 'messageTooOld',
    })).toBe(false);
    expect(CONVERSATION_NON_ADMISSION_REASONS).toContain('unsupportedEdit');
    expect(isConversationSenderFeedbackEligible({
      senderFeedback: 'eligibleRefusals',
      actorPrincipalId: 'person-1',
      actorAllowed: true,
      reason: 'unsupportedEdit' as never,
    })).toBe(false);
  });

  it('treats forwarded pairing/approval text as ordinary content and never grants bots those commands', () => {
    expect(decideConversationCommandPolicy({
      command: classifyConversationCommand('/allow request-1 session'),
      actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'forwarded',
      actorAllowed: true,
      allowBotSenders: false,
      targetKind: 'session',
      approvalCommandsEnabled: true,
      newSessionEnabled: true,
      senderFeedback: 'eligibleRefusals',
    })).toEqual({ kind: 'ordinaryText' });
    expect(decideConversationCommandPolicy({
      command: classifyConversationCommand('/allow request-1 request extra'),
      actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'viaBot',
      actorAllowed: true,
      allowBotSenders: false,
      targetKind: 'session',
      approvalCommandsEnabled: true,
      newSessionEnabled: true,
      senderFeedback: 'eligibleRefusals',
    })).toEqual({ kind: 'ordinaryText' });

    expect(decideConversationCommandPolicy({
      command: classifyConversationCommand('/answer input-1 [{"questionIndex":0,"values":["Safe"]}]'),
      actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'forwarded',
      actorAllowed: true,
      allowBotSenders: false,
      targetKind: 'session',
      // This only admits the binding's external mediator. It is deliberately
      // unrelated to the permission maximum scope; AskUserQuestion has no
      // permission grant scope.
      approvalCommandsEnabled: true,
      newSessionEnabled: true,
      senderFeedback: 'eligibleRefusals',
    })).toEqual({ kind: 'ordinaryText' });

    expect(decideConversationCommandPolicy({
      command: classifyConversationCommand('/pair ABCD2345'),
      actor: { principalId: 'bot-1', kind: 'bot', isIntegrationSelf: false },
      contentProvenance: 'original',
      actorAllowed: true,
      allowBotSenders: true,
      targetKind: 'session',
      approvalCommandsEnabled: true,
      newSessionEnabled: true,
      senderFeedback: 'eligibleRefusals',
    })).toEqual({
      kind: 'terminal',
      disposition: 'rejected',
      reason: 'commandNotAuthorized',
      senderFeedbackEligible: false,
    });
    expect(decideConversationCommandPolicy({
      command: classifyConversationCommand('/answer input-1 [{"questionIndex":0,"values":["Safe"]}]'),
      actor: { principalId: 'bot-1', kind: 'bot', isIntegrationSelf: false },
      contentProvenance: 'original',
      actorAllowed: true,
      allowBotSenders: true,
      targetKind: 'session',
      approvalCommandsEnabled: true,
      newSessionEnabled: true,
      senderFeedback: 'eligibleRefusals',
    })).toEqual({
      kind: 'terminal',
      disposition: 'rejected',
      reason: 'commandNotAuthorized',
      senderFeedbackEligible: false,
    });
  });

  it('allows an allowlisted opted-in bot to use /new but never an integration-self sender', () => {
    expect(decideConversationCommandPolicy({
      command: classifyConversationCommand('/new investigate this'),
      actor: { principalId: 'bot-1', kind: 'bot', isIntegrationSelf: false },
      contentProvenance: 'original',
      actorAllowed: true,
      allowBotSenders: true,
      targetKind: 'session',
      approvalCommandsEnabled: true,
      newSessionEnabled: true,
      senderFeedback: 'off',
    })).toEqual({ kind: 'newSession', initialPrompt: 'investigate this' });

    expect(decideConversationCommandPolicy({
      command: classifyConversationCommand('/new investigate this'),
      actor: { principalId: 'self', kind: 'integration', isIntegrationSelf: true },
      contentProvenance: 'original',
      actorAllowed: true,
      allowBotSenders: true,
      targetKind: 'session',
      approvalCommandsEnabled: true,
      newSessionEnabled: true,
      senderFeedback: 'eligibleRefusals',
    })).toEqual({
      kind: 'terminal',
      disposition: 'rejected',
      reason: 'integrationSelf',
      senderFeedbackEligible: false,
    });
  });

  it('keeps AskUserQuestion answers independent from permission approval scope', () => {
    const common = {
      actor: { principalId: 'person-1', kind: 'human' as const, isIntegrationSelf: false },
      contentProvenance: 'original' as const,
      actorAllowed: true,
      allowBotSenders: false,
      targetKind: 'session' as const,
      approvalCommandsEnabled: false,
      newSessionEnabled: false,
      senderFeedback: 'eligibleRefusals' as const,
    };

    expect(decideConversationCommandPolicy({
      ...common,
      command: classifyConversationCommand('/answer input-1 [{"questionIndex":0,"values":["Safe"]}]'),
    })).toEqual({
      kind: 'userActionAnswer',
      requestId: 'input-1',
      answers: [{ questionIndex: 0, values: ['Safe'] }],
    });
    expect(decideConversationCommandPolicy({
      ...common,
      command: classifyConversationCommand('/answer input-1 not-json'),
    })).toEqual({
      kind: 'terminal',
      disposition: 'rejected',
      reason: 'malformedCommand',
      senderFeedbackEligible: true,
    });
    expect(decideConversationCommandPolicy({
      ...common,
      targetKind: 'automation',
      command: classifyConversationCommand('/answer input-1 [{"questionIndex":0,"values":["Safe"]}]'),
    })).toEqual({
      kind: 'terminal',
      disposition: 'rejected',
      reason: 'commandNotAuthorized',
      senderFeedbackEligible: false,
    });
    expect(decideConversationCommandPolicy({
      ...common,
      targetKind: 'automation',
      command: classifyConversationCommand('/answer input-1 not-json'),
    })).toEqual({
      kind: 'terminal',
      disposition: 'rejected',
      reason: 'malformedCommand',
      senderFeedbackEligible: false,
    });
  });

  it('never executes /new on Automation and does not leak disabled policy', () => {
    const common = {
      actor: { principalId: 'person-1', kind: 'human' as const, isIntegrationSelf: false },
      contentProvenance: 'original' as const,
      actorAllowed: true,
      allowBotSenders: false,
      approvalCommandsEnabled: false,
      senderFeedback: 'eligibleRefusals' as const,
    };
    expect(decideConversationCommandPolicy({
      ...common,
      command: classifyConversationCommand('/new should remain text'),
      targetKind: 'automation',
      newSessionEnabled: false,
    })).toEqual({ kind: 'ordinaryText' });
    expect(decideConversationCommandPolicy({
      ...common,
      command: classifyConversationCommand('/new secret prompt'),
      targetKind: 'session',
      newSessionEnabled: false,
    })).toEqual({
      kind: 'terminal',
      disposition: 'rejected',
      reason: 'commandNotAuthorized',
      senderFeedbackEligible: false,
    });
    expect(decideConversationCommandPolicy({
      ...common,
      command: classifyConversationCommand('/allow'),
      targetKind: 'session',
      approvalCommandsEnabled: false,
      newSessionEnabled: false,
    })).toEqual({
      kind: 'terminal',
      disposition: 'rejected',
      reason: 'malformedCommand',
      senderFeedbackEligible: false,
    });
  });

  it('terminally settles a losing /new occurrence without admitting its prompt', () => {
    expect(settleCompetingNewSessionCommand({
      ingressObligationId: 'ingress-2',
      initialPrompt: 'must not be admitted',
      createBusyResponse: true,
    })).toEqual({
      ingress: {
        phase: 'terminal',
        disposition: 'rotationBusy',
      },
      initialPromptDisposition: 'discarded',
      controlResponse: {
        controlId: 'ingress-2',
        controlKind: 'newSession',
      },
    });
  });
});
