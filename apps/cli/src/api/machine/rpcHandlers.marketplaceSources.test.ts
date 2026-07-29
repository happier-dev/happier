import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD } from '@happier-dev/protocol/marketplace/internal';
import { createEnvKeyScope } from '@/testkit/env/envScope';

import { registerMachineMarketplaceSourcesRpcHandlers } from './rpcHandlers.marketplaceSources';
import type { PluginChangeDecision, PluginChangeDecisionResult } from '@/plugins/daemon/changeContract';

type Handler = (data: unknown) => Promise<any>;

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

describe('rpcHandlers (marketplace sources)', () => {
  it('passes UI-created present-user evidence through without minting or replacing it', async () => {
    const decideChange = vi.fn(async (decision: unknown) => ({
      kind: 'committed' as const,
      pluginId: 'acme.example',
      desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1',
      pendingSurfaces: [],
      decision,
    }));
    const mgr = createRpcHandlerManager();
    registerMachineMarketplaceSourcesRpcHandlers({
      rpcHandlerManager: mgr as any,
      deps: {
        decidePluginChange: decideChange,
      },
    });

    const decide = mgr.handlers.get(HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD);
    expect(decide).toBeTypeOf('function');
    await expect(decide?.({
      v: 1,
      pendingChangeId: 'pending-1',
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'ui-interaction-1',
        occurredAtMs: 42,
      },
      optionalSelections: [{ accessId: 'workspace', selected: false }],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.example' });
    expect(decideChange).toHaveBeenCalledWith({
      pendingChangeId: 'pending-1',
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'ui-interaction-1',
        occurredAtMs: 42,
      },
      optionalSelections: [{ accessId: 'workspace', selected: false }],
    });
  });

  it('requires the strict UI evidence shape and never treats a transport receipt as evidence', async () => {
    const decideChange = vi.fn();
    const mgr = createRpcHandlerManager();
    registerMachineMarketplaceSourcesRpcHandlers({
      rpcHandlerManager: mgr as any,
      deps: {
        decidePluginChange: decideChange,
      },
    });
    const decide = mgr.handlers.get(HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD);
    expect(decide).toBeTypeOf('function');

    await expect(decide?.({
      v: 1,
      pendingChangeId: 'pending-1',
      decision: 'installAndTrust',
      optionalSelections: [],
      receipt: 'peer.rpc.direct_call_succeeded',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'invalid_request',
    });
    expect(decideChange).not.toHaveBeenCalled();
  });

  it.each([
    ['cancelled', { v: 1, pendingChangeId: 'pending-cancel', decision: 'cancel' }],
    ['expired', {
      v: 1,
      pendingChangeId: 'pending-expired',
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'ui-expired', occurredAtMs: 10 },
      optionalSelections: [],
    }],
    ['conflict', {
      v: 1,
      pendingChangeId: 'pending-conflict',
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'ui-conflict', occurredAtMs: 11 },
      optionalSelections: [],
    }],
  ] as const)('passes through a %s daemon decision outcome', async (kind, request) => {
    const outcome: PluginChangeDecisionResult = kind === 'conflict'
      ? { kind, pluginId: 'acme.example' }
      : { kind };
    const decideChange = vi.fn(async (_decision: PluginChangeDecision): Promise<PluginChangeDecisionResult> => outcome);
    const mgr = createRpcHandlerManager();
    registerMachineMarketplaceSourcesRpcHandlers({
      rpcHandlerManager: mgr as any,
      deps: {
        decidePluginChange: decideChange,
      },
    });
    const decide = mgr.handlers.get(HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD);
    expect(decide).toBeTypeOf('function');
    await expect(decide?.(request)).resolves.toEqual(outcome);
    if (request.decision === 'cancel') {
      expect(decideChange).toHaveBeenCalledWith({
        pendingChangeId: request.pendingChangeId,
        decision: 'cancel',
      });
    }
  });

  it('reads and writes the shared marketplace source registry file', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'happier-marketplace-rpc-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
    envScope.patch({
      HAPPIER_HOME_DIR: happyHomeDir,
      HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: 'https://marketplace.example.test/catalog.json',
    });
    try {
      const mgr = createRpcHandlerManager();
      registerMachineMarketplaceSourcesRpcHandlers({
        rpcHandlerManager: mgr as any,
        deps: {
          happyHomeDir,
        },
      });

      const get = mgr.handlers.get(RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_GET);
      const set = mgr.handlers.get(RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_SET);
      const query = mgr.handlers.get(RPC_METHODS.DAEMON_MARKETPLACE_INDEX_QUERY);
      if (!get || !set || !query) {
        throw new Error('expected marketplace source registry handlers');
      }

      const initial = await get({});
      expect(initial).toEqual(expect.objectContaining({
        t: 'happier_marketplace_source_registry_v1',
        schemaVersion: 1,
        sources: [
          expect.objectContaining({
            title: 'Happier curated marketplace',
            sourceUrl: 'https://marketplace.example.test/catalog.json',
            enabled: true,
            origin: 'curated',
            description: 'Official curated source',
          }),
        ],
      }));

      const initialRegistry = initial as { sources: Array<Record<string, unknown>> };
      const next = {
        t: 'happier_marketplace_source_registry_v1',
        schemaVersion: 1,
        sources: [
          {
            ...initialRegistry.sources[0],
            title: 'Curated marketplace',
            registryProfileId: 'registry_private',
          },
        ],
      };
      await expect(set(next)).resolves.toEqual(next);
      expect(JSON.parse(readFileSync(join(happyHomeDir, 'plugins', 'plugins', 'state', 'marketplace-source-registry.v1.json'), 'utf8'))).toEqual(next);
      await expect(get({})).resolves.toEqual(next);
      await expect(set({
        ...next,
        sources: [
          ...next.sources,
          {
            id: 'marketplace:evil00000000',
            title: 'Attacker curated source',
            sourceUrl: 'https://evil.example.test/catalog.json',
            enabled: true,
            origin: 'curated',
          },
        ],
      })).resolves.toEqual({
        ok: false,
        errorCode: 'invalid_request',
        error: 'invalid_request',
      });
      await expect(query({ limit: 101 })).resolves.toEqual({
        ok: false,
        errorCode: 'invalid_request',
        error: 'invalid_request',
      });
    } finally {
      envScope.restore();
      rmSync(happyHomeDir, { recursive: true, force: true });
    }
  });
});
