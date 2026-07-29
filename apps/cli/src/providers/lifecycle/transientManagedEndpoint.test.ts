import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from '@happier-dev/plugins-cliproxyapi';
import type {
  QualifiedConnectedAccountPurposeV1,
} from '@happier-dev/protocol';
import type {
  ExecRuntimeServiceV1,
} from '@/plugins/runtime/exec/privateContract';
import type { LocalServiceDeclarationV1 } from '@/plugins/runtime/exec/privateContract';

import type {
  TrustedManagedLocalServiceOwnedRun,
} from '@/daemon/local/services/runtime';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type {
  ManagedProviderRuntimeAdapterV1,
  ResolvedFirstPartyManagedProviderFacet,
} from '@/providers/managed/types';

import { createProviderLaunchResourceScope } from './resourceScope';
import { prepareTransientManagedProviderEndpoint } from './transientManagedEndpoint';

const catalogPurpose: QualifiedConnectedAccountPurposeV1 = {
  consumer: {
    pluginId: 'happier.provider.cliproxyapi',
    localId: 'cliproxyapi',
  },
  purpose: 'openai-upstream',
};

const facet: ResolvedFirstPartyManagedProviderFacet = {
  managedEndpoint: {
    localService: {
      id: 'managed-provider',
      launch: {
        kind: 'packaged-runtime-binary',
        directorySegments: ['tools', 'unpacked'],
        executableBaseName: 'happier-cliproxyapi-managed',
        privateConfigPathFlag: '--config',
      },
      launchMode: {
        kind: 'assignAndInject',
        portPolicy: { kind: 'allocated' },
        environment: { inject: ['PORT', 'HOST'] },
      },
      hostPolicy: { kind: 'loopback', host: '127.0.0.1' },
      name: { strategy: 'fixed', name: 'Managed Provider' },
      healthCheck: { kind: 'http', path: '/healthz' },
      restart: { kind: 'never' },
      cleanup: { staleAfterMs: 60_000 },
    },
    protocols: ['openai-responses'],
  },
  connectedAccounts: [{
    purpose: catalogPurpose.purpose,
    service: {
      pluginId: 'happier.agent.codex',
      localId: 'openai-codex',
    },
    required: true,
  }],
  requestAuthUses: [{
    purpose: catalogPurpose.purpose,
    materialization: {
      kind: 'httpHeaders',
      origin: 'https://api.openai.com',
      headerNames: ['authorization'],
    },
  }],
};

function ownedRun(): TrustedManagedLocalServiceOwnedRun {
  return {
    serviceKey: 'managed-provider:catalog-probe-a',
    runId: 3,
    snapshot: {
      id: facet.managedEndpoint.localService.id,
      phase: 'running',
      port: 45_123,
      diagnostics: [],
    },
    process: {
      pid: 301,
      startedAt: 1_000,
      processStartTimeMs: 1_717_171_717_301,
      processCommandHash: 'a'.repeat(64),
    },
    host: '127.0.0.1',
    port: 45_123,
  };
}

describe('transient managed Provider endpoint', () => {
  it('materializes a credential-free operation-owned endpoint and releases its exact run', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-managed-probe-test-'));
    const events: string[] = [];
    let adapterInput: Parameters<ManagedProviderRuntimeAdapterV1['prepare']>[0] | null = null;
    const runtimeAdapter: ManagedProviderRuntimeAdapterV1 = {
      v: 1,
      catalogSource: {
        kind: 'transientModelEndpoint',
        contractVersion: 'happier.cliproxyapi-managed/v1',
        sdkVersion: 'v7.2.95',
      },
      prepare: vi.fn(async (input) => {
        adapterInput = input;
        events.push('prepare');
        return {
          materializedRootDir: input.materializedRootDir,
          materializationId: input.materializationId,
          privateConfigPath: join(input.materializedRootDir, 'config.json'),
          expectedReadiness: {
            contractVersion: 'happier.cliproxyapi-managed/v1',
            sdkVersion: 'v7.2.95',
          },
          prepared: {
            downstreamBearer: input.downstreamBearer,
            protocols: input.protocols,
            purposes: input.purposes,
            readiness: {
              outputTee: { onChunk: vi.fn() },
              wait: vi.fn(async () => {
                events.push('readiness');
                return {
                  contractVersion: 'happier.cliproxyapi-managed/v1',
                  sdkVersion: 'v7.2.95',
                  protocols: input.protocols,
                  purposes: input.purposes,
                };
              }),
            },
          },
          cleanup: vi.fn(async () => {
            events.push('cleanup:adapter');
          }),
        };
      }),
      resolveAgentEndpoint: vi.fn(({ host, port }) => {
        events.push('resolve-endpoint');
        return `http://${host}:${port}/v1`;
      }),
    };
    const contribution = {
      provenance: 'first_party',
      source: { kind: 'bundled' },
      pluginId: 'happier.provider.cliproxyapi',
      identity: {
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      },
      definition: CLIPROXYAPI_PROVIDER_CONTRIBUTION,
      managed: facet,
      managedRuntimeAdapter: runtimeAdapter,
    } as const satisfies ResolvedProviderContribution;
    const run = ownedRun();
    const startOwned = vi.fn(async (input) => {
      events.push('start');
      expect(input.context).toEqual({
        pluginId: contribution.identity.pluginId,
        contributionId: contribution.identity.localId,
        operationId: 'catalog-probe-a',
        title: contribution.definition.name,
      });
      return run;
    });
    const ownedCleanups: Array<() => void | Promise<void>> = [];
    const stopOwned = vi.fn(async () => {
      events.push('cleanup:stop');
      for (const cleanup of [...ownedCleanups].reverse()) {
        await cleanup();
      }
      return { status: 'stopped' as const };
    });
    const scope = createProviderLaunchResourceScope();
    const exec: Pick<ExecRuntimeServiceV1, 'spawn'> = {
      spawn: vi.fn(async () => {
        throw new Error('local-service owner is mocked at its process boundary');
      }),
    };

    try {
      const result = await prepareTransientManagedProviderEndpoint({
        operationId: 'catalog-probe-a',
        contribution,
        facet,
        runtimeAdapter,
        purposes: [catalogPurpose],
        endpointTemplateId: 'cliproxyapi-openai-responses',
        protocol: 'openai-responses',
        materializationBaseDir: baseDir,
        managedLocalServicesEnabled: true,
        isAuthorizationCurrent: () => true,
        revalidateBeforeEffect: async () => true,
        localServices: {
          startOwned,
          readOwnedRun: () => run,
          registerOwnedCleanup: (_ownedRun, cleanup) => {
            ownedCleanups.push(cleanup);
            return true;
          },
          stopOwned,
        },
        exec,
        launchResourceScope: scope,
      }, {
        resolveRuntimeLaunch: vi.fn(async (): Promise<LocalServiceDeclarationV1> => ({
          ...facet.managedEndpoint.localService,
          launch: {
            kind: 'binary',
            executablePath: '/opt/happier/happier-cliproxyapi-managed',
            args: ['--config', '/private/config.json'],
          },
        })),
      });

      expect(result).toMatchObject({
        ok: true,
        normalizedUrl: 'http://127.0.0.1:45123/v1',
        run: { runId: 3, port: 45_123 },
      });
      expect(result.ok && result.downstreamBearer).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(adapterInput).toMatchObject({
        protocols: ['openai-responses'],
        purposes: [catalogPurpose],
        modelListEnabled: true,
      });
      expect(events).toEqual([
        'prepare',
        'start',
        'readiness',
        'resolve-endpoint',
      ]);

      await scope.release();
      expect(events.slice(-2)).toEqual(['cleanup:stop', 'cleanup:adapter']);
      expect(stopOwned).toHaveBeenCalledWith(run);
    } finally {
      await scope.release();
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('denies forged managed inputs before preparing or starting a runtime', async () => {
    const runtimeAdapter = {
      v: 1,
      catalogSource: {
        kind: 'transientModelEndpoint',
        contractVersion: 'happier.cliproxyapi-managed/v1',
        sdkVersion: 'v7.2.95',
      },
      prepare: vi.fn(),
      resolveAgentEndpoint: vi.fn(),
    } as unknown as ManagedProviderRuntimeAdapterV1;
    const contribution = {
      provenance: 'first_party',
      source: { kind: 'bundled' },
      pluginId: 'happier.provider.cliproxyapi',
      identity: {
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      },
      definition: CLIPROXYAPI_PROVIDER_CONTRIBUTION,
      managed: facet,
      managedRuntimeAdapter: runtimeAdapter,
    } as const satisfies ResolvedProviderContribution;
    const startOwned = vi.fn();

    await expect(prepareTransientManagedProviderEndpoint({
      operationId: 'catalog-probe-a',
      contribution,
      facet: { ...facet, connectedAccounts: [{ purpose: 'forged', service: contribution.identity }] },
      runtimeAdapter,
      purposes: [catalogPurpose],
      endpointTemplateId: 'cliproxyapi-openai-responses',
      protocol: 'openai-responses',
      materializationBaseDir: '/tmp/unused',
      managedLocalServicesEnabled: true,
      isAuthorizationCurrent: () => true,
      revalidateBeforeEffect: async () => true,
      localServices: {
        startOwned,
        readOwnedRun: vi.fn(),
        registerOwnedCleanup: vi.fn(() => true),
        stopOwned: vi.fn(),
      },
      exec: { spawn: vi.fn() },
      launchResourceScope: createProviderLaunchResourceScope(),
    })).resolves.toEqual({
      ok: false,
      code: 'managed_provider_execution_denied',
    });
    expect(runtimeAdapter.prepare).not.toHaveBeenCalled();
    expect(startOwned).not.toHaveBeenCalled();
  });

  it('denies empty or foreign serving purpose sets before runtime preparation', async () => {
    const runtimeAdapter = {
      v: 1,
      catalogSource: {
        kind: 'transientModelEndpoint',
        contractVersion: 'happier.cliproxyapi-managed/v1',
        sdkVersion: 'v7.2.95',
      },
      prepare: vi.fn(),
      resolveAgentEndpoint: vi.fn(),
    } as unknown as ManagedProviderRuntimeAdapterV1;
    const contribution = {
      provenance: 'first_party',
      source: { kind: 'bundled' },
      pluginId: 'happier.provider.cliproxyapi',
      identity: {
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      },
      definition: CLIPROXYAPI_PROVIDER_CONTRIBUTION,
      managed: facet,
      managedRuntimeAdapter: runtimeAdapter,
    } as const satisfies ResolvedProviderContribution;
    const startOwned = vi.fn();

    for (const purposes of [
      [],
      [{
        ...catalogPurpose,
        consumer: {
          pluginId: 'happier.provider.other',
          localId: 'other',
        },
      }],
    ]) {
      await expect(prepareTransientManagedProviderEndpoint({
        operationId: 'catalog-probe-a',
        contribution,
        facet,
        runtimeAdapter,
        purposes,
        endpointTemplateId: 'cliproxyapi-openai-responses',
        protocol: 'openai-responses',
        materializationBaseDir: '/tmp/unused',
        managedLocalServicesEnabled: true,
        isAuthorizationCurrent: () => true,
        revalidateBeforeEffect: async () => true,
        localServices: {
          startOwned,
          readOwnedRun: vi.fn(),
          registerOwnedCleanup: vi.fn(() => true),
          stopOwned: vi.fn(),
        },
        exec: { spawn: vi.fn() },
        launchResourceScope: createProviderLaunchResourceScope(),
      })).resolves.toEqual({
        ok: false,
        code: 'managed_provider_execution_denied',
      });
    }
    expect(runtimeAdapter.prepare).not.toHaveBeenCalled();
    expect(startOwned).not.toHaveBeenCalled();
  });
});
