import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createEnvKeyScope } from '@/testkit/env/envScope';

import { registerMachineRpcHandlers } from './rpcHandlers';

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
  it('reads and writes the shared marketplace source registry file', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'happier-marketplace-rpc-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
    envScope.patch({
      HAPPIER_HOME_DIR: happyHomeDir,
      HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: 'https://marketplace.example.test/catalog.json',
    });
    try {
      const mgr = createRpcHandlerManager();
      registerMachineRpcHandlers({
        rpcHandlerManager: mgr as any,
        handlers: {
          spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
          stopSession: async () => true,
          requestShutdown: () => {},
        },
        deps: {
          promptAssetsHappierHomeDir: () => happyHomeDir,
        },
      });

      const get = mgr.handlers.get(RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_GET);
      const set = mgr.handlers.get(RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_SET);
      if (!get || !set) {
        throw new Error('expected marketplace source registry handlers');
      }

      await expect(get({})).resolves.toEqual(expect.objectContaining({
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

      const next = {
        t: 'happier_marketplace_source_registry_v1',
        schemaVersion: 1,
        sources: [
          {
            id: 'marketplace:abc123',
            title: 'Curated marketplace',
            sourceUrl: 'https://marketplace.example.test/catalog.json',
            enabled: true,
            origin: 'curated' as const,
          },
        ],
      };
      await expect(set(next)).resolves.toEqual(next);
      expect(JSON.parse(readFileSync(join(happyHomeDir, 'extensions', 'plugins', 'state', 'marketplace-source-registry.v1.json'), 'utf8'))).toEqual(next);
      await expect(get({})).resolves.toEqual(next);
    } finally {
      envScope.restore();
      rmSync(happyHomeDir, { recursive: true, force: true });
    }
  });
});
