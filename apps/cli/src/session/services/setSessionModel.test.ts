import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateSessionMetadataForTarget } = vi.hoisted(() => ({
  updateSessionMetadataForTarget: vi.fn(),
}));

vi.mock('./updateSessionMetadataForTarget', () => ({ updateSessionMetadataForTarget }));

import { setSessionModel } from './setSessionModel';

const credentials = {
  token: 'token',
  encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
};

const providerMetadata = {
  flavor: 'codex',
  modelSelectionIntentV1: {
    v: 1,
    updatedAt: 10,
    selection: {
      agentTargetKey: 'backend:codex',
      providerConnectionId: 'pc_work',
      modelId: 'old-model',
    },
  },
} as const;

describe('setSessionModel', () => {
  beforeEach(() => {
    updateSessionMetadataForTarget.mockReset();
    updateSessionMetadataForTarget.mockImplementation(async (params) => ({
      ok: true,
      sessionId: 'sess-1',
      metadata: params.updater(providerMetadata),
      version: 2,
    }));
  });

  it('inherits the current provider connection when the action omits connection identity', async () => {
    await expect(setSessionModel({
      credentials,
      idOrPrefix: 'sess-1',
      modelId: 'default',
      updatedAt: 20,
    })).resolves.toMatchObject({
      ok: true,
      metadata: {
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 20,
          selection: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'pc_work',
            modelId: 'default',
          },
        },
      },
    });
  });

  it.each(['pc_other', null] as const)(
    'refuses a live source change to %s with the stable restart-required code',
    async (providerConnectionId) => {
      await expect(setSessionModel({
        credentials,
        idOrPrefix: 'sess-1',
        modelId: 'next-model',
        providerConnectionId,
        updatedAt: 20,
      })).resolves.toMatchObject({
        ok: false,
        code: 'provider_switch_unsupported',
      });
    },
  );
});
