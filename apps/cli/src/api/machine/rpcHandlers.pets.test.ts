import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DaemonPetDiscoverResponseV1Schema,
  FeaturesResponseSchema,
  PET_DAEMON_RPC_METHODS,
} from '@happier-dev/protocol';

import { createRpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerMachineRpcHandlers } from './rpcHandlers';

const createdRoots = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happier-rpc-pets-'));
  createdRoots.add(root);
  return root;
}

function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

afterEach(() => {
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  createdRoots.clear();
});

describe('registerMachineRpcHandlers pets', () => {
  it('registers daemon pet RPC handlers', () => {
    const rpcHandlerManager = createRpcHandlerManager({
      scopePrefix: '',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      encryptionMode: 'plain',
      logger: () => {},
    });
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    expect(rpcHandlerManager.hasHandler('pets.discoverPackages')).toBe(true);
    expect(rpcHandlerManager.hasHandler(PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES)).toBe(true);
    expect(rpcHandlerManager.hasHandler(PET_DAEMON_RPC_METHODS.VALIDATE_PACKAGE)).toBe(true);
    expect(rpcHandlerManager.hasHandler('pets.importLocalPackage')).toBe(true);
    expect(rpcHandlerManager.hasHandler(PET_DAEMON_RPC_METHODS.IMPORT_LOCAL_PACKAGE)).toBe(true);
    expect(rpcHandlerManager.hasHandler(PET_DAEMON_RPC_METHODS.IMPORT_ACCOUNT_PACKAGE)).toBe(true);
    expect(rpcHandlerManager.hasHandler('pets.forgetLocalPackage')).toBe(true);
    expect(rpcHandlerManager.hasHandler(PET_DAEMON_RPC_METHODS.FORGET_LOCAL_PACKAGE)).toBe(true);
    expect(rpcHandlerManager.hasHandler('pets.readPreviewAsset')).toBe(true);
    expect(rpcHandlerManager.hasHandler(PET_DAEMON_RPC_METHODS.READ_PREVIEW_ASSET)).toBe(true);
  });

  it('denies daemon pet RPC handlers when the active server disables pets.companion', async () => {
    const rpcHandlerManager = createRpcHandlerManager({
      scopePrefix: '',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      encryptionMode: 'plain',
      logger: () => {},
    });
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });
    const disabledFeatures = FeaturesResponseSchema.parse({
      features: {
        pets: {
          companion: { enabled: false },
          sync: { enabled: false },
        },
      },
      capabilities: {},
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify(disabledFeatures),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );

    try {
      await expect(
        rpcHandlerManager.invokeLocal(PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES, {}),
      ).resolves.toMatchObject({
        ok: false,
        errorCode: 'feature_disabled',
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('denies account pet imports when the active server disables pets.sync', async () => {
    const root = tempRoot();
    const codexHome = join(root, 'codex-home');
    const packagePath = join(codexHome, 'pets', 'blink');
    await mkdir(packagePath, { recursive: true });
    await writeFile(join(packagePath, 'pet.json'), JSON.stringify({
      id: 'blink',
      displayName: 'Blink',
      description: 'Happier companion pet',
      spritesheetPath: 'spritesheet.png',
    }));
    await writeFile(join(packagePath, 'spritesheet.png'), pngHeader(1536, 1872));

    const rpcHandlerManager = createRpcHandlerManager({
      scopePrefix: '',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      encryptionMode: 'plain',
      logger: () => {},
    });
    let uploadCalls = 0;
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
      deps: {
        createAccountPet: async () => {
          uploadCalls += 1;
          return { ok: false, errorCode: 'internal_error', error: 'should_not_upload' };
        },
      },
    });

    const disabledSyncFeatures = FeaturesResponseSchema.parse({
      features: {
        pets: {
          companion: { enabled: true },
          sync: { enabled: false },
        },
      },
      capabilities: {},
    });
    const previousFetch = globalThis.fetch;
    const previousHome = process.env.HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.CODEX_HOME = codexHome;
    globalThis.fetch = async () => new Response(
      JSON.stringify(disabledSyncFeatures),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );

    try {
      const discovered = DaemonPetDiscoverResponseV1Schema.parse(await rpcHandlerManager.invokeLocal(
        PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES,
        {
        includeManagedLocal: false,
        },
      ));
      expect(discovered).toMatchObject({ ok: true });
      if (!discovered.ok) throw new Error('expected discover to succeed');

      await expect(
        rpcHandlerManager.invokeLocal(PET_DAEMON_RPC_METHODS.IMPORT_ACCOUNT_PACKAGE, {
          sourceKey: discovered.pets[0]?.sourceKey,
          petsSyncEnabled: true,
        }),
      ).resolves.toMatchObject({
        ok: false,
        errorCode: 'feature_disabled',
      });
      expect(uploadCalls).toBe(0);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }
  });
});
