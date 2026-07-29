import { describe, expect, it, vi } from 'vitest';

import { deliverExecutionRunSessionStateField } from './sessionStateDelivery';

describe('execution-run Runtime Activity write boundary', () => {
  it('rejects the aggregate registered field before enqueue', async () => {
    const enqueueRegisteredSessionStateFieldMutation = vi.fn(async () => undefined);
    await expect(deliverExecutionRunSessionStateField({
      target: { sessionId: 'session-1', enqueueRegisteredSessionStateFieldMutation },
      fieldId: 'runtime.activity',
      value: { state: 'active', activeCount: 1 },
    })).resolves.toEqual({
      status: 'unsupported',
      fieldId: 'runtime.activity',
      reason: 'scope_not_supported',
    });
    expect(enqueueRegisteredSessionStateFieldMutation).not.toHaveBeenCalled();
  });

  it('rejects the host-owned external-Agent projection before enqueue', async () => {
    const enqueueRegisteredSessionStateFieldMutation = vi.fn(async () => undefined);
    await expect(deliverExecutionRunSessionStateField({
      target: { sessionId: 'session-1', enqueueRegisteredSessionStateFieldMutation },
      fieldId: 'runtime.externalAgent',
      value: {
        v: 1,
        qualifiedLinkIdentity: {
          v: 1,
          agent: { pluginId: 'happier.claude', localId: 'claude' },
          source: { kind: 'claudeConfig', contractVersion: 1 },
        },
        linkGeneration: 'link-generation-7',
        status: 'working',
        observedAtMs: 100,
        expiresAtMs: 150,
      },
    })).resolves.toEqual({
      status: 'unsupported',
      fieldId: 'runtime.externalAgent',
      reason: 'scope_not_supported',
    });
    expect(enqueueRegisteredSessionStateFieldMutation).not.toHaveBeenCalled();
  });
});
