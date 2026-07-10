import { describe, expect, it, vi } from 'vitest';

import type { SessionStateFacet, SessionStateFieldWriteValue } from '@happier-dev/agents';
import type { RegisteredSessionStateFieldMutationV1 } from '../../../api/session/client/transport/mutations/sessionClientDurableMutationTypes';

const { updateSessionMetadataForTargetMock } = vi.hoisted(() => ({
  updateSessionMetadataForTargetMock: vi.fn(),
}));

vi.mock('@/session/services/updateSessionMetadataForTarget', () => ({
  updateSessionMetadataForTarget: (...args: unknown[]) => updateSessionMetadataForTargetMock(...args),
}));

describe('createCliRuntimeSessionStateBridge', () => {
  it('maps authentication failures from metadata updates to forbidden', async () => {
    updateSessionMetadataForTargetMock.mockRejectedValueOnce(Object.assign(new Error('not authenticated'), {
      code: 'not_authenticated',
      status: 403,
    }));

    const { createCliSessionStateMetadataUpdatePort } = await import('./metadataUpdatePort');
    const port = createCliSessionStateMetadataUpdatePort({
      credentials: { token: 'token' } as never,
    });

    await expect(port.update(
      'session-1',
      (metadata) => metadata,
      { reason: 'test-auth-failure' },
    )).resolves.toEqual({ ok: false, reason: 'forbidden' });
  });

  it('creates the load-bearing runtime session-state engine from provider facet capabilities', async () => {
    const applied: string[] = [];
    const facet: SessionStateFacet = {
      capabilities: {
        display: {
          title: {
            supported: true,
            happierToProvider: { supported: true, transport: 'runtime-hook' },
            providerToHappier: { supported: false as const },
          },
        },
      },
      applyHappierField: async (_ctx, field, value) => {
        applied.push(`${field}:${String(value)}`);
      },
      readField: async () => null,
    };
    updateSessionMetadataForTargetMock.mockImplementation(async ({ updater }: {
      updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
    }) => ({
      ok: true,
      version: 9,
      metadata: updater({ summary: { text: 'Old', updatedAt: 1 } }),
    }));

    const { createCliRuntimeSessionStateBridge } = await import('./bridge');
    const bridge = createCliRuntimeSessionStateBridge({
      credentials: { token: 'token' } as never,
      session: { sessionId: 'session-1' },
      facet,
    });

    await expect(bridge.writeHappierField({
      fieldId: 'display.title',
      value: 'New title',
      reason: 'user-mutation',
      metadataReason: 'test-title',
      mirrorToProvider: true,
    })).resolves.toEqual({
      ok: true,
      version: 9,
      provider: { ok: true },
    });

    expect(updateSessionMetadataForTargetMock).toHaveBeenCalledWith(expect.objectContaining({
      idOrPrefix: 'session-1',
      credentials: { token: 'token' },
    }));
    expect(applied).toEqual(['display.title:New title']);
  });

  it('routes durable runtime session-state fields through the registered-field outbox', async () => {
    const durableMutationOutbox = {
      enqueueRegisteredSessionStateFieldMutation: vi.fn(async (_mutation: RegisteredSessionStateFieldMutationV1) => undefined),
    };
    const metadataPortUpdate = vi.fn(async () => ({ ok: true as const, version: 9 }));
    const { createCliRuntimeSessionStateBridge } = await import('./bridge');
    const bridge = createCliRuntimeSessionStateBridge({
      credentials: { token: 'token' } as never,
      session: {
        sessionId: 'session-1',
        enqueueRegisteredSessionStateFieldMutation: async (mutation: RegisteredSessionStateFieldMutationV1) => {
          await durableMutationOutbox.enqueueRegisteredSessionStateFieldMutation(mutation);
        },
      },
      capabilities: {
        runtime: {
          workState: {
            supported: true,
            happierToProvider: { supported: false },
            providerToHappier: { supported: false },
          },
        },
      },
      metadataPort: {
        update: metadataPortUpdate,
      },
    });

    const workState: SessionStateFieldWriteValue<'runtime.workState'> = {
      v: 1,
      backendId: 'codex-app-server',
      updatedAt: 123,
      items: [],
    };

    await expect(bridge.writeHappierField({
      fieldId: 'runtime.workState',
      value: workState,
      reason: 'reconciliation',
      metadataReason: 'work-state',
    })).resolves.toEqual({ ok: true, version: 0 });

    expect(metadataPortUpdate).not.toHaveBeenCalled();
    expect(durableMutationOutbox.enqueueRegisteredSessionStateFieldMutation).toHaveBeenCalledWith(expect.objectContaining({
      fieldId: 'runtime.workState',
      deliveryClass: 'durable_required',
      source: 'runtime',
      op: {
        kind: 'set',
        value: workState,
      },
    }));
  });

  it('routes durable best-effort identity fields through the registered-field outbox when available', async () => {
    const enqueueRegisteredSessionStateFieldMutation = vi.fn(async (_mutation: RegisteredSessionStateFieldMutationV1) => undefined);
    const metadataPortUpdate = vi.fn(async () => ({ ok: true as const, version: 9 }));
    const { createCliRuntimeSessionStateBridge } = await import('./bridge');
    const bridge = createCliRuntimeSessionStateBridge({
      credentials: { token: 'token' } as never,
      session: {
        sessionId: 'session-1',
        enqueueRegisteredSessionStateFieldMutation,
      },
      metadataPort: {
        update: metadataPortUpdate,
      },
    });

    const providerSessionId: SessionStateFieldWriteValue<'identity.providerSessionId'> = {
      metadataKey: 'opencodeSessionId',
      value: 'ses-1',
    };

    await expect(bridge.writeHappierField({
      fieldId: 'identity.providerSessionId',
      value: providerSessionId,
      reason: 'reconciliation',
      metadataReason: 'provider-session-id',
    })).resolves.toEqual({ ok: true, version: 0 });

    expect(metadataPortUpdate).not.toHaveBeenCalled();
    expect(enqueueRegisteredSessionStateFieldMutation).toHaveBeenCalledWith(expect.objectContaining({
      fieldId: 'identity.providerSessionId',
      deliveryClass: 'durable_best_effort',
      source: 'runtime',
      op: {
        kind: 'set',
        value: providerSessionId,
      },
    }));
  });

  it('returns a typed delivery failure for durable runtime fields when no outbox enqueue is available', async () => {
    const metadataPortUpdate = vi.fn(async () => ({ ok: true as const, version: 9 }));
    const { createCliRuntimeSessionStateBridge } = await import('./bridge');
    const bridge = createCliRuntimeSessionStateBridge({
      credentials: { token: 'token' } as never,
      session: { sessionId: 'session-1' },
      capabilities: {
        runtime: {
          workState: {
            supported: true,
            happierToProvider: { supported: false },
            providerToHappier: { supported: false },
          },
        },
      },
      metadataPort: {
        update: metadataPortUpdate,
      },
    });

    const workState: SessionStateFieldWriteValue<'runtime.workState'> = {
      v: 1,
      backendId: 'codex-app-server',
      updatedAt: 123,
      items: [],
    };

    await expect(bridge.writeHappierField({
      fieldId: 'runtime.workState',
      value: workState,
      reason: 'reconciliation',
      metadataReason: 'work-state',
    })).resolves.toEqual({
      ok: false,
      reason: 'durable_delivery_unavailable',
      fieldId: 'runtime.workState',
      deliveryClass: 'durable_required',
    });

    expect(metadataPortUpdate).not.toHaveBeenCalled();
  });
});
