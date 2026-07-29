import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveConnectedAccountRequestAuthCapabilityPath,
} from '@happier-dev/plugin-sdk/experimental/cloud/request-auth';
import {
  MANAGED_PROVIDER_RUNTIME_ADAPTER as CLIPROXYAPI_MANAGED_PROVIDER_RUNTIME_ADAPTER,
} from '@happier-dev/plugins-cliproxyapi';

import {
  writeConnectedAccountRequestAuthCapabilityFile,
} from '@/daemon/connectedServices/requestAuth/capabilityFile';
import { writePrivateBearerFile } from '@/daemon/privateBearerFile';
import type { ManagedProviderRuntimeAdapterV1 } from '@/providers/managed/types';

import {
  inspectManagedProviderRuntimeAdapterRecovery,
  verifyManagedProviderRuntimeRecoveryHealth,
} from './managedRuntimeAdapterRecovery';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe('inspectManagedProviderRuntimeAdapterRecovery', () => {
  it('composes the bundled CLIProxyAPI adapter config with the daemon capability owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-cliproxyapi-recovery-'));
    roots.push(root);
    const materializationId = 'materialization-cliproxyapi-exact';
    const capabilityPath =
      resolveConnectedAccountRequestAuthCapabilityPath(root);
    const purpose = {
      consumer: {
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      },
      purpose: 'openai-upstream',
    } as const;
    await writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: root,
      materializationId,
      subjectScopeDigest: 'f'.repeat(64),
      httpPort: 43_123,
    });
    const preparation = await CLIPROXYAPI_MANAGED_PROVIDER_RUNTIME_ADAPTER.prepare({
      materializedRootDir: root,
      materializationId,
      wrapperBuildVersion: 'test-wrapper-v1',
      downstreamBearer: 'test-downstream-bearer',
      purposes: [purpose],
      protocols: ['openai-responses'],
      modelListEnabled: false,
      requestAuth: { capabilityPath },
    }, {
      writeExclusive: writePrivateBearerFile,
      remove: async (path) => {
        await rm(path, { force: true });
      },
    });

    const facts = await inspectManagedProviderRuntimeAdapterRecovery({
      runtimeAdapter: CLIPROXYAPI_MANAGED_PROVIDER_RUNTIME_ADAPTER,
      attachment: {
        v: 1,
        process: {
          pid: 702,
          processStartTimeMs: 1_717_171_717_702,
          processCommandHash: 'e'.repeat(64),
        },
        endpoint: { host: '127.0.0.1', port: 45_702 },
        materialization: { rootDir: root, materializationId },
      },
      purposes: [purpose],
      protocols: ['openai-responses'],
      modelListEnabled: false,
    });

    expect(facts).toEqual({
      materializedRootDir: resolve(root),
      materializationId,
      privateConfigPath: preparation.privateConfigPath,
      capabilityPath,
      expectedHealth: {
        v: 1,
        contractVersion: 'happier.cliproxyapi-managed/v1',
        sdkVersion: 'v7.2.95',
        wrapperBuildVersion: 'test-wrapper-v1',
        protocols: ['openai-responses'],
        purposes: [purpose],
        modelListEnabled: false,
        materializationId,
      },
    });
    await preparation.cleanup();
  });

  it('composes strict adapter config facts with the exact capability materialization identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-managed-recovery-'));
    roots.push(root);
    const materializationId = 'materialization-recovery-exact';
    const privateConfigPath = join(root, 'adapter-config.json');
    const capabilityPath =
      resolveConnectedAccountRequestAuthCapabilityPath(root);
    await writePrivateBearerFile({
      path: privateConfigPath,
      contents: '{"v":1,"adapter":"strict","wrapperBuildVersion":"0.2.9"}\n',
    });
    await writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: root,
      materializationId,
      subjectScopeDigest: 'a'.repeat(64),
      httpPort: 43_123,
    });
    const runtimeAdapter = {
      v: 1,
      catalogSource: {
        kind: 'transientModelEndpoint',
        contractVersion: 'contract-v1',
        sdkVersion: 'sdk-v1',
      },
      prepare: async () => {
        throw new Error('not used');
      },
      inspectRecovery: async (input, files) => (
        await files.read(privateConfigPath)
          === '{"v":1,"adapter":"strict","wrapperBuildVersion":"0.2.9"}\n'
        && input.materializedRootDir === resolve(root)
        && input.capabilityPath === capabilityPath
          ? {
              privateConfigPath,
              capabilityPath,
              expectedHealth: {
                v: 1 as const,
                contractVersion: 'contract-v1',
                sdkVersion: 'sdk-v1',
                wrapperBuildVersion: '0.2.9',
                protocols: input.protocols,
                purposes: input.purposes,
                modelListEnabled: input.modelListEnabled,
                materializationId: input.materializationId,
              },
            }
          : null
      ),
      verifyRecoveryHealth: (contents, expected) => {
        try {
          return JSON.stringify(JSON.parse(contents)) === JSON.stringify(expected);
        } catch {
          return false;
        }
      },
      resolveAgentEndpoint: () => 'http://127.0.0.1:45123/v1',
    } satisfies ManagedProviderRuntimeAdapterV1;
    const attachment = {
      v: 1 as const,
      process: {
        pid: 700,
        processStartTimeMs: 1_717_171_717_700,
        processCommandHash: 'b'.repeat(64),
      },
      endpoint: { host: '127.0.0.1' as const, port: 45_700 },
      materialization: { rootDir: root, materializationId },
    };

    const recoveryInput = {
      runtimeAdapter,
      attachment,
      purposes: [],
      protocols: ['openai-responses'],
      modelListEnabled: false,
    } as const;
    const facts = await inspectManagedProviderRuntimeAdapterRecovery(recoveryInput);
    expect(facts).toEqual({
      materializedRootDir: resolve(root),
      materializationId,
      privateConfigPath,
      capabilityPath,
      expectedHealth: {
        v: 1,
        contractVersion: 'contract-v1',
        sdkVersion: 'sdk-v1',
        wrapperBuildVersion: '0.2.9',
        protocols: ['openai-responses'],
        purposes: [],
        modelListEnabled: false,
        materializationId,
      },
    });
    const fetchFn = vi.fn(async () => new Response(
      JSON.stringify(facts?.expectedHealth),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    ));
    await expect(verifyManagedProviderRuntimeRecoveryHealth({
      runtimeAdapter,
      facts: facts!,
      host: '127.0.0.1',
      port: 45_700,
      path: '/healthz',
      fetchFn,
    })).resolves.toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:45700/healthz',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
      }),
    );
    await expect(verifyManagedProviderRuntimeRecoveryHealth({
      runtimeAdapter,
      facts: facts!,
      host: '127.0.0.1',
      port: 45_700,
      path: '/healthz',
      fetchFn: async () => new Response(JSON.stringify({
        ...facts!.expectedHealth,
        wrapperBuildVersion: '0.2.10',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    })).resolves.toBe(false);

    await expect(inspectManagedProviderRuntimeAdapterRecovery({
      runtimeAdapter,
      attachment: {
        ...attachment,
        materialization: {
          ...attachment.materialization,
          materializationId: 'stale-materialization',
        },
      },
      purposes: [],
      protocols: ['openai-responses'],
      modelListEnabled: false,
    })).resolves.toBeNull();

    await writeFile(capabilityPath, JSON.stringify({
      v: 1,
      materializationId,
      subjectScopeDigest: 'a'.repeat(64),
      capability: 'A'.repeat(43),
    }), { mode: 0o600 });
    await expect(
      inspectManagedProviderRuntimeAdapterRecovery(recoveryInput),
    ).resolves.toBeNull();
  });

  it('rejects adapter recovery facts whose private config escapes the materialization root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-managed-recovery-'));
    roots.push(root);
    const materializationId = 'materialization-recovery-contained';
    const capabilityPath =
      resolveConnectedAccountRequestAuthCapabilityPath(root);
    await writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: root,
      materializationId,
      subjectScopeDigest: 'c'.repeat(64),
      httpPort: 43_123,
    });
    const outsidePrivateConfigPath =
      resolve(root, '..', 'outside-managed-provider-config.json');
    const runtimeAdapter = {
      v: 1,
      catalogSource: {
        kind: 'transientModelEndpoint',
        contractVersion: 'contract-v1',
        sdkVersion: 'sdk-v1',
      },
      prepare: async () => {
        throw new Error('not used');
      },
      inspectRecovery: async (input) => ({
        privateConfigPath: outsidePrivateConfigPath,
        capabilityPath: input.capabilityPath,
        expectedHealth: {
          v: 1,
          contractVersion: 'contract-v1',
          sdkVersion: 'sdk-v1',
          wrapperBuildVersion: '0.2.9',
          protocols: input.protocols,
          purposes: input.purposes,
          modelListEnabled: input.modelListEnabled,
          materializationId: input.materializationId,
        },
      }),
      verifyRecoveryHealth: () => false,
      resolveAgentEndpoint: () => 'http://127.0.0.1:45123/v1',
    } satisfies ManagedProviderRuntimeAdapterV1;

    await expect(inspectManagedProviderRuntimeAdapterRecovery({
      runtimeAdapter,
      attachment: {
        v: 1,
        process: {
          pid: 701,
          processStartTimeMs: 1_717_171_717_701,
          processCommandHash: 'd'.repeat(64),
        },
        endpoint: { host: '127.0.0.1', port: 45_701 },
        materialization: { rootDir: root, materializationId },
      },
      purposes: [],
      protocols: ['openai-responses'],
      modelListEnabled: false,
    })).resolves.toBeNull();
  });
});
