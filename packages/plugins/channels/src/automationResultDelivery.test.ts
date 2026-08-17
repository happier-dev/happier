import { describe, expect, it } from 'vitest';

import { prepareConversationAutomationResultDelivery } from './automationResultDelivery.js';

const caller = {
  kind: 'automationRun',
  automationId: 'automation-1',
  runId: 'run-1',
  origin: 'conversation',
} as const;

const source = {
  kind: 'automationResult',
  automationRunId: 'run-1',
  resultId: 'handoff-1',
  automationId: 'automation-1',
  templateVersion: 3,
  resultDelivery: 'finalResult',
} as const;

function input() {
  return {
    v: 1,
    handoffId: 'handoff-1',
    runId: 'run-1',
    automationId: 'automation-1',
    source,
    result: { v: 1, kind: 'text', text: 'The Automation completed.' },
    opaqueContext: {
      v: 1,
      kind: 'conversationAutomationResultDelivery',
      connectionId: 'connection-1',
      bindingId: 'binding-1',
      bindingRevision: 9,
      connectionAuthorityEpoch: 4,
      bindingAuthorityEpoch: 7,
      endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
      reply: { providerMessageId: 'message-1' },
      linkPreviewPolicy: 'suppress',
    },
  } as const;
}

describe('Conversation Automation result delivery admission', () => {
  it('accepts only the host-stamped exact Run correspondence and retains the immutable reply route', () => {
    expect(prepareConversationAutomationResultDelivery({
      input: input(),
      caller,
    })).toEqual({
      kind: 'prepared',
      input: input(),
      route: {
        connectionId: 'connection-1',
        bindingId: 'binding-1',
        bindingRevision: 9,
        connectionAuthorityEpoch: 4,
        bindingAuthorityEpoch: 7,
        endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
        replyContext: { replyToMessageId: 'message-1' },
        linkPreviewPolicy: 'suppress',
      },
      source,
    });
  });

  it('passes the sealed source through unchanged instead of reconstructing it from route context', () => {
    const delivery = {
      ...input(),
      source: { ...source, templateVersion: 4 },
    };

    expect(prepareConversationAutomationResultDelivery({ input: delivery, caller })).toMatchObject({
      kind: 'prepared',
      source: delivery.source,
    });
  });

  it('replies to the observed inbound message, never the message that inbound itself replied to', () => {
    expect(prepareConversationAutomationResultDelivery({
      input: {
        ...input(),
        opaqueContext: {
          ...input().opaqueContext,
          reply: {
            providerMessageId: 'message-1',
            providerReplyToMessageId: 'earlier-message-1',
          },
        },
      },
      caller,
    })).toMatchObject({
      kind: 'prepared',
      route: { replyContext: { replyToMessageId: 'message-1' } },
    });
  });

  it.each([
    ['no caller', undefined],
    ['a plugin caller', {
      kind: 'plugin',
      pluginId: 'happier.channels',
      contribution: {
        id: 'automation/result-deliver-v1',
        qualifiedId: 'happier.channels/actions/automation/result-deliver-v1',
      },
      materialization: {
        pluginId: 'happier.channels',
        machineId: 'machine-1',
        materializationId: 'channels-1',
      },
    }],
    ['a non-Conversation Run', { ...caller, origin: 'event' }],
    ['a different Run', { ...caller, runId: 'run-2' }],
    ['a different Automation', { ...caller, automationId: 'automation-2' }],
  ] as const)('blocks %s without accepting a custody route', (_description, invalidCaller) => {
    expect(prepareConversationAutomationResultDelivery({
      input: input(),
      caller: invalidCaller,
    })).toEqual({ kind: 'blocked', code: 'unauthorizedCaller' });
  });

  it.each([
    ['source run does not equal outer run', { automationRunId: 'run-2' }],
    ['source result does not equal outer handoff', { resultId: 'handoff-2' }],
    ['source Automation does not equal outer Automation', { automationId: 'automation-2' }],
  ] as const)('rejects %s before a custody route exists', (_description, sourceOverride) => {
    expect(prepareConversationAutomationResultDelivery({
      input: { ...input(), source: { ...source, ...sourceOverride } },
      caller,
    })).toEqual({ kind: 'blocked', code: 'invalidCustodyRequest' });
  });

  it('blocks malformed or unrouteable Channel context instead of selecting a fallback destination', () => {
    expect(prepareConversationAutomationResultDelivery({
      input: {
        ...input(),
        opaqueContext: { ...input().opaqueContext, connectionId: 'connection-2', extra: true },
      },
      caller,
    })).toEqual({ kind: 'blocked', code: 'invalidCustodyRequest' });
    expect(prepareConversationAutomationResultDelivery({
      input: {
        ...input(),
        opaqueContext: {
          ...input().opaqueContext,
          automationTarget: {
            automationId: 'automation-1',
            templateVersion: 3,
            resultDelivery: 'finalResult',
          },
        },
      },
      caller,
    })).toEqual({ kind: 'blocked', code: 'invalidCustodyRequest' });
    expect(prepareConversationAutomationResultDelivery({
      input: { ...input(), result: { v: 1, kind: 'text', text: '' } },
      caller,
    })).toEqual({ kind: 'blocked', code: 'invalidCustodyRequest' });
  });

});
