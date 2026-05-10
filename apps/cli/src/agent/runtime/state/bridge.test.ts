import { describe, expect, it, vi } from 'vitest';

import type { SessionStateFacet } from '@happier-dev/agents';

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
});
