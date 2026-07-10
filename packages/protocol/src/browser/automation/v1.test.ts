import { describe, expect, it } from 'vitest';

async function loadAutomationModule(): Promise<Record<string, unknown> | null> {
  const path = './v1.js';
  return import(path).catch(() => null) as Promise<Record<string, unknown> | null>;
}

const baseRequest = {
  v: 1,
  automationRequestId: 'automation_request_1',
  browserSessionId: 'browser_session_1',
  viewId: 'browser_view_1',
  navigationGeneration: 4,
  requestedBy: 'agent',
  requesterRef: {
    kind: 'session',
    id: 'session_1',
  },
  timeoutMs: 2_000,
} as const;

describe('browser automation protocol contracts', () => {
  it('requires active leases for mutating actions while allowing bound read-only requests', async () => {
    const mod = await loadAutomationModule();

    expect(mod?.BrowserAutomationActionRequestV1Schema).toBeTypeOf('object');
    if (!mod?.BrowserAutomationActionRequestV1Schema) return;

    const schema = mod.BrowserAutomationActionRequestV1Schema as {
      safeParse: (value: unknown) => { success: boolean; data?: unknown };
    };

    expect(schema.safeParse({
      ...baseRequest,
      actionKind: 'snapshot',
    }).success).toBe(true);

    expect(schema.safeParse({
      ...baseRequest,
      actionKind: 'click',
      payload: {
        locator: {
          kind: 'css',
          value: 'button[type=submit]',
        },
      },
    }).success).toBe(false);

    const mutating = schema.safeParse({
      ...baseRequest,
      actionKind: 'click',
      leaseId: 'lease_1',
      expectedControlEpoch: 8,
      payload: {
        locator: {
          kind: 'css',
          value: 'button[type=submit]',
        },
      },
    });

    expect(mutating.success).toBe(true);
  });

  it('models eval actions as BRW-10 eval requests carried by a BRW-14 lease', async () => {
    const mod = await loadAutomationModule();

    expect(mod?.BrowserAutomationActionRequestV1Schema).toBeTypeOf('object');
    if (!mod?.BrowserAutomationActionRequestV1Schema) return;

    const schema = mod.BrowserAutomationActionRequestV1Schema as {
      safeParse: (value: unknown) => { success: boolean; data?: unknown };
    };

    const parsed = schema.safeParse({
      ...baseRequest,
      actionKind: 'evaluate',
      leaseId: 'lease_eval_1',
      expectedControlEpoch: 1,
      payload: {
        diagnosticsEvalRequest: {
          v: 1,
          evalRequestId: 'eval_1',
          viewId: baseRequest.viewId,
          navigationGeneration: baseRequest.navigationGeneration,
          tier: 'injectedPage',
          expression: 'document.title',
          objectGroupId: 'automation_eval_1',
          diagnosticsInteractionEnabled: true,
        },
      },
    });

    expect(parsed.success).toBe(true);

    const invalid = schema.safeParse({
      ...baseRequest,
      actionKind: 'evaluate',
      leaseId: 'lease_eval_1',
      expectedControlEpoch: 1,
      payload: {
        expression: 'document.cookie',
      },
    });

    expect(invalid.success).toBe(false);
  });

  it('keeps timeline entries bounded and rejects inline evidence payloads', async () => {
    const mod = await loadAutomationModule();

    expect(mod?.BrowserAutomationTimelineV1Schema).toBeTypeOf('object');
    expect(mod?.BrowserAutomationTimelineEntryV1Schema).toBeTypeOf('object');
    if (!mod?.BrowserAutomationTimelineV1Schema || !mod.BrowserAutomationTimelineEntryV1Schema) return;

    const entrySchema = mod.BrowserAutomationTimelineEntryV1Schema as {
      safeParse: (value: unknown) => { success: boolean; data?: unknown };
    };
    const timelineSchema = mod.BrowserAutomationTimelineV1Schema as {
      safeParse: (value: unknown) => { success: boolean; data?: unknown };
    };

    const entry = {
      v: 1,
      timelineEntryId: 'entry_1',
      automationRequestId: 'automation_request_1',
      browserSessionId: 'browser_session_1',
      viewId: 'browser_view_1',
      actionKind: 'type',
      requesterKind: 'agent',
      status: 'succeeded',
      adapterKind: 'localPreview',
      fidelity: 'injectedPage',
      trustedInput: false,
      queuedAtMs: 1,
      startedAtMs: 2,
      finishedAtMs: 3,
      durationMs: 1,
      navigationGenerationBefore: 4,
      navigationGenerationAfter: 4,
      controlEpochBefore: 0,
      controlEpochAfter: 0,
      targetSummary: {
        locatorKind: 'css',
        textLength: 12,
      },
      resultSummary: {
        valueChanged: true,
      },
    };

    expect(entrySchema.safeParse(entry).success).toBe(true);
    expect(entrySchema.safeParse({
      ...entry,
      resultSummary: {
        screenshotDataUri: 'data:image/png;base64,inline',
      },
    }).success).toBe(false);

    expect(timelineSchema.safeParse({
      v: 1,
      browserSessionId: 'browser_session_1',
      viewId: 'browser_view_1',
      maxEntries: 500,
      entries: Array.from({ length: 501 }, (_, index) => ({
        ...entry,
        timelineEntryId: `entry_${index}`,
        automationRequestId: `automation_request_${index}`,
      })),
    }).success).toBe(false);
  });

  it('accepts user-canceled automation results and timeline entries as canonical protocol evidence', async () => {
    const mod = await loadAutomationModule();

    expect(mod?.BrowserAutomationActionResultV1Schema).toBeTypeOf('object');
    expect(mod?.BrowserAutomationTimelineEntryV1Schema).toBeTypeOf('object');
    if (!mod?.BrowserAutomationActionResultV1Schema || !mod.BrowserAutomationTimelineEntryV1Schema) return;

    const resultSchema = mod.BrowserAutomationActionResultV1Schema as {
      safeParse: (value: unknown) => { success: boolean; data?: unknown };
    };
    const entrySchema = mod.BrowserAutomationTimelineEntryV1Schema as {
      safeParse: (value: unknown) => { success: boolean; data?: unknown };
    };

    expect(resultSchema.safeParse({
      v: 1,
      automationRequestId: 'automation_request_cancel_1',
      status: 'canceled',
      durationMs: 12,
      adapterKind: 'localPreview',
      fidelity: 'injectedPage',
      trustedInput: false,
      navigationGenerationBefore: 4,
      navigationGenerationAfter: 4,
      controlEpochBefore: 2,
      controlEpochAfter: 3,
      errorCode: 'user_canceled',
    }).success).toBe(true);

    expect(entrySchema.safeParse({
      v: 1,
      timelineEntryId: 'entry_cancel_1',
      automationRequestId: 'automation_request_cancel_1',
      browserSessionId: 'browser_session_1',
      viewId: 'browser_view_1',
      actionKind: 'click',
      requesterKind: 'user',
      status: 'canceled',
      adapterKind: 'localPreview',
      fidelity: 'injectedPage',
      trustedInput: false,
      queuedAtMs: 1,
      startedAtMs: 2,
      finishedAtMs: 14,
      durationMs: 12,
      navigationGenerationBefore: 4,
      navigationGenerationAfter: 4,
      controlEpochBefore: 2,
      controlEpochAfter: 3,
      reasonCode: 'user_canceled',
    }).success).toBe(true);
  });

  it('redacts action details before timeline storage', async () => {
    const mod = await loadAutomationModule();

    expect(mod?.redactBrowserAutomationTimelineDetails).toBeTypeOf('function');
    if (typeof mod?.redactBrowserAutomationTimelineDetails !== 'function') return;

    const redact = mod.redactBrowserAutomationTimelineDetails as (value: unknown) => unknown;
    const redacted = redact({
      selector: '#password',
      text: 'hunter2',
      password: 'secret',
      url: 'https://example.test/login?token=secret#fragment',
      nested: {
        authorization: 'Bearer secret',
      },
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).toContain('textLength');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('authorization');
    expect(serialized).not.toContain('token=');
  });

  it('preserves locator values for action results while still dropping unsafe detail keys', async () => {
    const mod = await loadAutomationModule();

    expect(mod?.redactBrowserAutomationActionResultDetails).toBeTypeOf('function');
    if (typeof mod?.redactBrowserAutomationActionResultDetails !== 'function') return;

    const redact = mod.redactBrowserAutomationActionResultDetails as (value: unknown) => unknown;
    const redacted = redact({
      interactiveElements: [
        { role: 'button', name: 'Submit', selector: '#submit' },
      ],
      target: { locator: 'role=button[name="Submit"]' },
      text: 'hunter2',
      password: 'secret',
      url: 'https://example.test/login?token=secret#fragment',
      nested: {
        authorization: 'Bearer secret',
      },
    });
    const serialized = JSON.stringify(redacted);
    const redactedRecord = redacted as {
      interactiveElements?: Array<{ selector?: string }>;
      target?: { locator?: string };
    };

    expect(redactedRecord.interactiveElements?.[0]?.selector).toBe('#submit');
    expect(redactedRecord.target?.locator).toBe('role=button[name="Submit"]');
    expect(serialized).toContain('textLength');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('authorization');
    expect(serialized).not.toContain('token=');
  });
});
