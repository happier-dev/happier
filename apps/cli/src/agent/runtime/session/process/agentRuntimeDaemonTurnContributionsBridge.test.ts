import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controlClientMock = vi.hoisted(() => ({
  dispatch: vi.fn(),
}));

vi.mock('@/daemon/controlClient', () => ({
  dispatchDaemonAgentRuntimeBridgeRequest: controlClientMock.dispatch,
}));

import {
  tryCreateDaemonAgentRuntimeTurnContributionsBridge,
} from './agentRuntimeDaemonBridgeClient';
import {
  HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY,
} from './agentRuntimeDaemonBridgeProtocol';
import {
  transformSessionInputThroughPluginHooks,
} from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';

describe('daemon Agent runtime turn-contribution child bridge', () => {
  let root = '';
  let tokenFilePath = '';

  beforeEach(async () => {
    controlClientMock.dispatch.mockReset();
    root = await mkdtemp(join(tmpdir(), 'happier-turn-contributions-'));
    tokenFilePath = join(root, 'handoff.json');
    await writeFile(tokenFilePath, JSON.stringify({
      v: 1,
      token: 'bridge-token',
      descriptor: {
        v: 1,
        pluginId: 'happier.agent.novel-reviewer',
        pluginVersion: '1.2.3',
        agentId: 'novel-reviewer',
        backendId: 'novel-reviewer',
        generation: 'generation-1',
        factoryControls: {
          continuation: false,
          goals: false,
          catalog: false,
          usageLimitRecovery: false,
        },
      },
    }), 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('is absent outside a daemon-spawned child instead of inventing authority', () => {
    expect(tryCreateDaemonAgentRuntimeTurnContributionsBridge({})).toBeNull();
  });

  it('parses the bounded daemon result and preserves explicit prompt selection', async () => {
    controlClientMock.dispatch.mockResolvedValue({
      ok: true,
      result: {
        kind: 'prompt',
        promptAssetBlocks: [{
          id: 'plugin_prompt_asset.happier.review.deepsec/review-prompt',
          scope: 'session',
          text: 'Review precisely.',
        }],
        toolPromptContributions: [],
      },
    });
    const bridge = tryCreateDaemonAgentRuntimeTurnContributionsBridge({
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    });
    if (!bridge) throw new Error('Expected a daemon child contribution bridge');

    await expect(bridge.resolvePrompt({
      sessionId: 'session-1',
      selectedAsset: {
        pluginId: 'happier.review.deepsec',
        localId: 'review-prompt',
      },
    })).resolves.toMatchObject({
      promptAssetBlocks: [{ text: 'Review precisely.' }],
    });
    expect(controlClientMock.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          sessionId: 'session-1',
          generation: 'generation-1',
        }),
        operation: expect.objectContaining({
          kind: 'session.turnContributions.resolve',
          request: {
            kind: 'prompt',
            selectedAsset: {
              pluginId: 'happier.review.deepsec',
              localId: 'review-prompt',
            },
          },
        }),
      }),
      {},
    );
  });

  it('rejects daemon errors and over-bound results without a local fallback', async () => {
    const bridge = tryCreateDaemonAgentRuntimeTurnContributionsBridge({
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    });
    if (!bridge) throw new Error('Expected a daemon child contribution bridge');

    controlClientMock.dispatch.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'plugin_generation_stale',
        message: 'retired',
      },
    });
    await expect(bridge.resolvePrompt({ sessionId: 'session-1' }))
      .rejects.toMatchObject({ code: 'plugin_generation_stale' });

    controlClientMock.dispatch.mockResolvedValueOnce({
      ok: true,
      result: {
        kind: 'prompt',
        promptAssetBlocks: Array.from({ length: 257 }, (_, index) => ({
          id: `asset-${index}`,
          scope: 'session',
          text: 'bounded',
        })),
        toolPromptContributions: [],
      },
    });
    await expect(bridge.resolvePrompt({ sessionId: 'session-1' }))
      .rejects.toThrow();
    expect(controlClientMock.dispatch).toHaveBeenCalledTimes(2);
  });

  it('routes session input transforms through the daemon-held plugin generation', async () => {
    const previousTokenFile =
      process.env[HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY];
    process.env[HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY] =
      tokenFilePath;
    controlClientMock.dispatch.mockResolvedValue({
      ok: true,
      result: {
        kind: 'transformSessionInput',
        payload: {
          sessionId: 'session-1',
          localId: 'input-1',
          text: 'Transformed by daemon',
          meta: {},
          timestampMs: 1,
        },
      },
    });
    try {
      await expect(transformSessionInputThroughPluginHooks({
        sessionId: 'session-1',
        localId: 'input-1',
        text: 'Original',
        meta: {},
        timestampMs: 1,
      })).resolves.toMatchObject({
        text: 'Transformed by daemon',
      });
      expect(controlClientMock.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: {
            kind: 'session.turnContributions.resolve',
            requestId: expect.any(String),
            request: {
              kind: 'transformSessionInput',
              payload: {
                sessionId: 'session-1',
                localId: 'input-1',
                text: 'Original',
                meta: {},
                timestampMs: 1,
              },
            },
          },
        }),
        {},
      );
    } finally {
      if (previousTokenFile === undefined) {
        delete process.env[HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY];
      } else {
        process.env[HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY] =
          previousTokenFile;
      }
    }
  });

  it('propagates cancellation to the daemon request owner', async () => {
    const bridge = tryCreateDaemonAgentRuntimeTurnContributionsBridge({
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    });
    if (!bridge) throw new Error('Expected a daemon child contribution bridge');
    controlClientMock.dispatch.mockImplementation(
      async (
        request: Readonly<{ operation: Readonly<{ kind: string }> }>,
        options?: Readonly<{ signal?: AbortSignal }>,
      ) => {
        if (request.operation.kind === 'request.cancel') {
          return { ok: true, result: null };
        }
        return await new Promise((_, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
    );
    const controller = new AbortController();
    const resolving = bridge.resolvePrompt({
      sessionId: 'session-1',
      signal: controller.signal,
    });
    controller.abort(new Error('cancel prompt resolution'));

    await expect(resolving).rejects.toThrow('cancel prompt resolution');
    expect(controlClientMock.dispatch).toHaveBeenCalledTimes(2);
    expect(controlClientMock.dispatch.mock.calls[1]?.[0]).toMatchObject({
      operation: {
        kind: 'request.cancel',
      },
    });
  });
});
