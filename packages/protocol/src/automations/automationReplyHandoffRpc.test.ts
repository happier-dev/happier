import { describe, expect, it } from 'vitest';

import {
  AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1,
  AutomationReplyHandoffDispatchRequestV1Schema,
  AutomationReplyHandoffDispatchResultV1Schema,
} from './automationEventV1.js';

/** A synthetic out-of-tree bridge, so no first-party id is load-bearing here. */
const thirdPartyDeliveryActionRef = {
  pluginId: 'acme.slack-bridge',
  localId: 'automation/reply-deliver-v1',
} as const;

const request = {
  v: 1,
  kind: 'automation.replyHandoff.dispatch',
  target: {
    accountId: 'account-1',
    machineId: 'machine-1',
    machineInstallationId: 'installation-1',
    materializationId: 'materialization-1',
    actionRef: thirdPartyDeliveryActionRef,
  },
  handoff: {
    handoffId: 'handoff-1',
    runId: 'run-1',
    automationId: 'automation-1',
    accountCurrentness: {
      mode: 'plain',
      version: 7,
      contentKeyFingerprint: null,
    },
    resultEnvelope: {
      t: 'plain',
      v: {
        v: 1,
        correspondence: {
          accountId: 'account-1',
          automationId: 'automation-1',
          runId: 'run-1',
          handoffId: 'handoff-1',
        },
        result: { v: 1, kind: 'text', text: 'Completed.' },
      },
    },
    replyContextEnvelope: {
      t: 'plain',
      v: {
        v: 1,
        correspondence: {
          accountId: 'account-1',
          automationId: 'automation-1',
          runId: 'run-1',
          handoffId: 'handoff-1',
        },
        source: {
          kind: 'automationResult',
          automationRunId: 'run-1',
          resultId: 'handoff-1',
          automationId: 'automation-1',
          templateVersion: 1,
          resultDelivery: 'finalResult',
        },
        opaqueContext: { conversationId: 'conversation-1', messageId: 'message-1' },
      },
    },
  },
} as const;

describe('Automation reply-handoff daemon RPC contract', () => {
  it('carries only server-owned exact-target correspondence and a ciphertext-blind claim', () => {
    expect(AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1).toBe(
      'daemon.automations.replyHandoff.dispatch',
    );
    expect(AutomationReplyHandoffDispatchRequestV1Schema.parse(request)).toEqual(request);
    expect(AutomationReplyHandoffDispatchResultV1Schema.parse({
      kind: 'settled',
      settlement: { kind: 'accepted' },
      accountCurrentness: {
        mode: 'plain',
        version: 7,
        contentKeyFingerprint: null,
      },
      receiptEnvelope: {
        t: 'plain',
        v: {
          v: 1,
          correspondence: request.handoff.resultEnvelope.v.correspondence,
          result: { kind: 'accepted', custodyId: 'custody-1' },
        },
      },
    })).toEqual({
      kind: 'settled',
      settlement: { kind: 'accepted' },
      accountCurrentness: {
        mode: 'plain',
        version: 7,
        contentKeyFingerprint: null,
      },
      receiptEnvelope: {
        t: 'plain',
        v: {
          v: 1,
          correspondence: request.handoff.resultEnvelope.v.correspondence,
          result: { kind: 'accepted', custodyId: 'custody-1' },
        },
      },
    });
  });

  it('rejects caller spoofing and any target/action substitution before a daemon can invoke a plugin', () => {
    expect(AutomationReplyHandoffDispatchRequestV1Schema.safeParse({
      ...request,
      caller: { kind: 'automationRun', runId: 'forged-run' },
    }).success).toBe(false);
    expect(AutomationReplyHandoffDispatchRequestV1Schema.safeParse({
      ...request,
      input: {
        v: 1,
        handoffId: 'handoff-1',
        runId: 'run-1',
        automationId: 'automation-1',
      },
    }).success).toBe(false);
    expect(AutomationReplyHandoffDispatchRequestV1Schema.safeParse({
      ...request,
      target: { ...request.target, machineId: 'caller-selected-machine' },
    }).success).toBe(true);
    // The target ref stays a bounded qualified contribution identity, but it
    // names no plugin: the daemon fences a substituted target by resolving the
    // frozen materialization for that exact plugin, not by a wire literal.
    expect(AutomationReplyHandoffDispatchRequestV1Schema.safeParse({
      ...request,
      target: {
        ...request.target,
        actionRef: { pluginId: 'Not A Plugin Id', localId: 'automation/reply-deliver-v1' },
      },
    }).success).toBe(false);
    expect(AutomationReplyHandoffDispatchRequestV1Schema.safeParse({
      ...request,
      target: {
        ...request.target,
        actionRef: { pluginId: 'acme.slack-bridge', localId: 'Caller Selected Action' },
      },
    }).success).toBe(false);
    expect(AutomationReplyHandoffDispatchResultV1Schema.safeParse({
      kind: 'settled',
      settlement: { kind: 'accepted', custodyId: 'custody-1' },
      accountCurrentness: { mode: 'plain', version: 7, contentKeyFingerprint: null },
      receiptEnvelope: { t: 'encrypted', c: 'ciphertext' },
    }).success).toBe(false);
    expect(AutomationReplyHandoffDispatchResultV1Schema.safeParse({
      kind: 'settled',
      settlement: { kind: 'accepted' },
      accountCurrentness: { mode: 'plain', version: 7, contentKeyFingerprint: null },
      custodyId: 'custody-1',
      receiptEnvelope: { t: 'encrypted', c: 'ciphertext' },
    }).success).toBe(false);
    expect(AutomationReplyHandoffDispatchResultV1Schema.safeParse({
      kind: 'settled',
      settlement: { kind: 'blocked' },
      accountCurrentness: {
        mode: 'e2ee',
        version: 8,
        contentKeyFingerprint: 'aemk1_content',
      },
    }).success).toBe(true);
    expect(AutomationReplyHandoffDispatchResultV1Schema.safeParse({
      kind: 'settled',
      settlement: { kind: 'staleClaim' },
      accountCurrentness: { mode: 'plain', version: 8, contentKeyFingerprint: null },
    }).success).toBe(true);
    expect(AutomationReplyHandoffDispatchResultV1Schema.safeParse({
      kind: 'settled',
      settlement: { kind: 'accepted' },
      accountCurrentness: {
        mode: 'plain',
        version: 8,
        contentKeyFingerprint: 'aemk1_content',
      },
    }).success).toBe(false);
    expect(AutomationReplyHandoffDispatchResultV1Schema.safeParse({
      kind: 'settled',
      settlement: { kind: 'accepted' },
      accountCurrentness: { mode: 'plain', version: 8, contentKeyFingerprint: null },
      receiptEnvelope: { t: 'encrypted', c: 'ciphertext' },
    }).success).toBe(false);
    expect(AutomationReplyHandoffDispatchResultV1Schema.safeParse({
      kind: 'settled',
      settlement: { kind: 'accepted' },
      accountCurrentness: {
        mode: 'e2ee',
        version: 8,
        contentKeyFingerprint: 'aemk1_content',
      },
      receiptEnvelope: { t: 'plain', v: {} },
    }).success).toBe(false);
  });
});
