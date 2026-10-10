import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { IrohError } from './errors';
import {
  createIrohNodeNativeModule,
  IrohNativeOperationError,
  loadIrohNodeNative,
  resolveDefaultIrohNodePackageRoot,
  resolveIrohNodeAddonArtifactName,
  resolveIrohNodeAddonPath,
  SUPPORTED_IROH_NODE_TARGETS,
} from './nodeNative';
import {
  IROH_NODE_NATIVE_EXPORTS,
  type IrohNodeNativeAddon,
} from './nodeNative.types';

/**
 * The `.node` addon is a genuine system boundary; a fake here only shapes the
 * JSON-string contract so envelope validation and request serialization are
 * exercised without a built artifact.
 */
function createFakeAddon(
  handler: (operation: string, request: string) => string,
): IrohNodeNativeAddon {
  return {
    getAvailability: () => ({
      available: true,
      os: 'test-os',
      arch: 'test-arch',
      engine: 'happier-iroh-native',
      surface: [...IROH_NODE_NATIVE_EXPORTS],
    }),
    createEndpoint: async (request: string) =>
      handler('createEndpoint', request),
    startHomeAcceptor: async (request: string) =>
      handler('startHomeAcceptor', request),
    stopHomeAcceptor: async (request: string) =>
      handler('stopHomeAcceptor', request),
    ensureHomeTunnel: async (request: string) =>
      handler('ensureHomeTunnel', request),
    releaseHomeTunnel: async (request: string) =>
      handler('releaseHomeTunnel', request),
    shutdownEndpoint: async (request: string) =>
      handler('shutdownEndpoint', request),
    getEndpointStatus: async (request: string) =>
      handler('getEndpointStatus', request),
    getTunnelStatus: async (request: string) =>
      handler('getTunnelStatus', request),
    startMachineAcceptor: async (request: string) =>
      handler('startMachineAcceptor', request),
    stopMachineAcceptor: async (request: string) =>
      handler('stopMachineAcceptor', request),
    getMachineAcceptorStatus: async (request: string) =>
      handler('getMachineAcceptorStatus', request),
    startMachineTunnel: async (request: string) =>
      handler('startMachineTunnel', request),
    startMachineHttpTunnel: async (request: string) =>
      handler('startMachineHttpTunnel', request),
    stopMachineTunnel: async (request: string) =>
      handler('stopMachineTunnel', request),
    getMachineTunnelStatus: async (request: string) =>
      handler('getMachineTunnelStatus', request),
  };
}

const okNull = JSON.stringify({ ok: true, result: null });

describe('Iroh Node/Bun addon resolution', () => {
  it('names the addon deterministically for every supported platform/arch target', () => {
    expect(resolveIrohNodeAddonArtifactName('darwin', 'arm64')).toBe(
      'happier-iroh-native-lifecycle.darwin-arm64.node',
    );
    expect(resolveIrohNodeAddonArtifactName('darwin', 'x64')).toBe(
      'happier-iroh-native-lifecycle.darwin-x64.node',
    );
    expect(resolveIrohNodeAddonArtifactName('linux', 'x64')).toBe(
      'happier-iroh-native-lifecycle.linux-x64.node',
    );
    expect(resolveIrohNodeAddonArtifactName('linux', 'arm64')).toBe(
      'happier-iroh-native-lifecycle.linux-arm64.node',
    );
    expect(resolveIrohNodeAddonArtifactName('win32', 'x64')).toBe(
      'happier-iroh-native-lifecycle.win32-x64.node',
    );
    expect([...SUPPORTED_IROH_NODE_TARGETS]).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'linux-arm64',
      'win32-x64',
    ]);
  });

  it('refuses platform/arch pairs without a build instead of guessing', () => {
    expect(() => resolveIrohNodeAddonArtifactName('sunos', 'x64')).toThrowError(
      /no Node\/Bun lifecycle addon for sunos-x64/,
    );
    expect(() =>
      resolveIrohNodeAddonArtifactName('darwin', 'ia32'),
    ).toThrowError(/no Node\/Bun lifecycle addon for darwin-ia32/);
  });

  it('resolves the artifact path deterministically under the package root', () => {
    expect(resolveIrohNodeAddonPath('/pkg', 'darwin', 'arm64')).toBe(
      join('/pkg', 'native', 'happier-iroh-native-lifecycle.darwin-arm64.node'),
    );
  });

  it('prefers the importing package and uses the executable-adjacent package only for bundled modules', () => {
    const modulePackage = '/workspace/packages/iroh-native';
    const packagedRoot = '/opt/happier/node_modules/@happier-dev/iroh-native';
    const existing = new Set([
      join(modulePackage, 'package.json'),
      join(packagedRoot, 'package.json'),
    ]);
    const pathExists = (path: string) => existing.has(path);

    expect(
      resolveDefaultIrohNodePackageRoot({
        moduleUrl: 'file:///workspace/packages/iroh-native/dist/nodeNative.js',
        executablePath: '/opt/happier/happier',
        pathExists,
      }),
    ).toBe(modulePackage);

    existing.delete(join(modulePackage, 'package.json'));
    expect(
      resolveDefaultIrohNodePackageRoot({
        moduleUrl: 'file:///virtual/bunfs/iroh-native/dist/nodeNative.js',
        executablePath: '/opt/happier/happier',
        pathExists,
      }),
    ).toBe(packagedRoot);
  });

  it('reports native_unavailable when the package has no target addon', () => {
    const result = loadIrohNodeNative('/nonexistent-iroh-native-package-root');
    expect(result.available).toBe(false);
    if (result.available)
      throw new Error('Expected the native addon to be unavailable');
    expect(result.reason).toBe('native_unavailable');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('resolves the physical native package beside a source-bundled Node chunk', () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'iroh-bundled-node-'));
    try {
      const packageRoot = join(
        runtimeRoot,
        'node_modules/@happier-dev/iroh-native',
      );
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          name: '@happier-dev/iroh-native',
          exports: { './package.json': './package.json' },
        }),
      );
      expect(
        resolveDefaultIrohNodePackageRoot({
          moduleUrl: pathToFileURL(
            join(runtimeRoot, 'package-dist/chunks/iroh.js'),
          ).href,
          executablePath: process.execPath,
        }),
      ).toBe(packageRoot);
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('reports native_unavailable (without a path) for unsupported triples', () => {
    const result = loadIrohNodeNative('/pkg', 'sunos', 'x64');
    expect(result.available).toBe(false);
    if (result.available)
      throw new Error('Expected the target triple to be unsupported');
    expect(result.reason).toBe('native_unavailable');
    expect(result.addonPath).toBeNull();
  });
});

describe('typed operations over the C ABI JSON envelope', () => {
  it('returns validated typed results and serializes only defined request fields', async () => {
    const seen: Array<[string, string]> = [];
    const addon = createFakeAddon((operation, request) => {
      seen.push([operation, request]);
      if (operation !== 'createEndpoint') return okNull;
      return JSON.stringify({
        ok: true,
        result: {
          endpointHandle: 'ep-1',
          endpointId: 'endpoint-id',
          relayPolicy: 'disabled',
          relayMode: 'disabled',
          capProfile: 'homeInteractive',
          relayUrls: [],
        },
      });
    });
    const module = createIrohNodeNativeModule(addon);
    const created = await module.createEndpoint({ relayPolicy: 'disabled' });
    expect(created).toEqual({
      endpointHandle: 'ep-1',
      endpointId: 'endpoint-id',
      relayPolicy: 'disabled',
      relayMode: 'disabled',
      capProfile: 'homeInteractive',
      relayUrls: [],
    });
    expect(seen).toEqual([['createEndpoint', '{"relayPolicy":"disabled"}']]);

    await module.getEndpointStatus('ep-1');
    await module.releaseHomeTunnel('t-1');
    await module.shutdownEndpoint({ endpointHandle: 'ep-1' });
    expect(seen.slice(1)).toEqual([
      ['getEndpointStatus', '{"endpointHandle":"ep-1"}'],
      ['releaseHomeTunnel', '{"tunnelId":"t-1"}'],
      ['shutdownEndpoint', '{"endpointHandle":"ep-1"}'],
    ]);
  });

  it('passes ensureHomeTunnel hints through verbatim and validates the lease result', async () => {
    let captured = '';
    const lease = {
      tunnelId: 't-1',
      homeServerIdentityId: 'srv_home',
      homeEndpointId: 'ep',
      runtimeOrigin: 'http://127.0.0.1:41023/',
      carrier: 'iroh',
      observedPath: 'direct',
      startedAtMs: 1234,
      endpointHandle: 'c-1',
    };
    const addon = createFakeAddon((operation, request) => {
      if (operation !== 'ensureHomeTunnel') return okNull;
      captured = request;
      return JSON.stringify({ ok: true, result: lease });
    });
    const module = createIrohNodeNativeModule(addon);
    const started = await module.ensureHomeTunnel({
      endpointHandle: 'c-1',
      homeServerIdentityId: 'srv_home',
      endpointId: 'ep',
      directAddresses: ['127.0.0.1:4001'],
    });
    expect(started.tunnelId).toBe('t-1');
    expect(started.runtimeOrigin).toBe('http://127.0.0.1:41023/');
    expect(JSON.parse(captured)).toEqual({
      endpointHandle: 'c-1',
      homeServerIdentityId: 'srv_home',
      endpointId: 'ep',
      directAddresses: ['127.0.0.1:4001'],
    });
  });

  it('accepts a native lease on any literal IPv4 loopback address', async () => {
    const addon = createFakeAddon((operation) =>
      operation === 'ensureHomeTunnel'
        ? JSON.stringify({
            ok: true,
            result: {
              tunnelId: 't-loopback',
              homeServerIdentityId: 'srv_home',
              homeEndpointId: 'ep',
              runtimeOrigin: 'http://127.0.0.2:41023/',
              carrier: 'iroh',
              observedPath: 'direct',
              startedAtMs: 1234,
              endpointHandle: 'c-1',
            },
          })
        : JSON.stringify({ ok: true, result: null }),
    );
    const module = createIrohNodeNativeModule(addon);

    await expect(
      module.ensureHomeTunnel({
        endpointHandle: 'c-1',
        homeServerIdentityId: 'srv_home',
        endpointId: 'ep',
      }),
    ).resolves.toMatchObject({ runtimeOrigin: 'http://127.0.0.2:41023/' });
  });

  it('fails closed on a non-loopback runtime origin', async () => {
    const addon = createFakeAddon((operation) =>
      operation === 'ensureHomeTunnel'
        ? JSON.stringify({
            ok: true,
            result: {
              tunnelId: 't-1',
              homeServerIdentityId: 'srv_home',
              homeEndpointId: 'ep',
              runtimeOrigin: 'http://10.0.0.5:9999/',
              carrier: 'iroh',
              observedPath: 'direct',
              startedAtMs: 1,
              endpointHandle: 'c-1',
            },
          })
        : okNull,
    );
    const module = createIrohNodeNativeModule(addon);
    await expect(
      module.ensureHomeTunnel({
        endpointHandle: 'c-1',
        homeServerIdentityId: 'srv_home',
        endpointId: 'ep',
      }),
    ).rejects.toThrowError(/loopback/);
  });

  it('surfaces C ABI errors as typed errors with the native code preserved', async () => {
    const addon = createFakeAddon((operation) =>
      operation === 'createEndpoint'
        ? JSON.stringify({
            ok: false,
            error: {
              code: 'endpoint_config_conflict',
              message: 'already bound',
            },
          })
        : okNull,
    );
    const module = createIrohNodeNativeModule(addon);
    const failure: unknown = await module.createEndpoint({}).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(IrohNativeOperationError);
    expect(failure).toBeInstanceOf(IrohError);
    const operationError = failure as IrohNativeOperationError;
    expect(operationError.nativeCode).toBe('endpoint_config_conflict');
    expect(operationError.code).toBe('endpoint_config_conflict');
    expect(operationError.message).toBe('already bound');
  });

  it.each([
    ['endpoint-identity-invalid', 'endpoint_identity_invalid'],
    ['endpoint-identity-mismatch', 'identity_mismatch'],
    ['endpoint_key_unavailable', 'endpoint_key_unavailable'],
    ['relay_auth_failed', 'relay_auth_failed'],
    ['invalid-preamble', 'invalid_preamble'],
    ['unsupported-alpn', 'unsupported_alpn'],
    ['loopback_bind_failed', 'loopback_bind_failed'],
    ['home_unreachable', 'home_unreachable'],
    ['transport_timeout', 'transport_timeout'],
    ['transport_closed', 'transport_closed'],
    ['resource_limit', 'resource_limit'],
    ['machine-control-invalid', 'invalid_descriptor'],
    ['machine-admission-rejected', 'unknown'],
  ] as const)(
    'preserves the %s machine failure category',
    async (nativeCode, publicCode) => {
      const addon = createFakeAddon((operation) =>
        operation === 'startMachineTunnel'
          ? JSON.stringify({
              ok: false,
              error: { code: nativeCode, message: 'machine failure' },
            })
          : okNull,
      );
      const module = createIrohNodeNativeModule(addon);
      const failure = await module
        .startMachineTunnel({
          endpointHandle: 'e',
          endpointId: 'i',
          handshakeJson: '{}',
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(IrohNativeOperationError);
      expect((failure as IrohNativeOperationError).nativeCode).toBe(nativeCode);
      expect((failure as IrohNativeOperationError).code).toBe(publicCode);
    },
  );

  it('rejects malformed envelopes and drifted result shapes instead of returning raw JSON', async () => {
    const addon = createFakeAddon((operation, request) => {
      if (operation === 'ensureHomeTunnel') return 'not-json';
      if (operation === 'getTunnelStatus') {
        if (request.includes('missing'))
          return JSON.stringify({ ok: true, result: null });
        return JSON.stringify({ ok: true, result: { tunnelId: 5 } });
      }
      if (operation === 'getEndpointStatus') {
        if (request.includes('missing'))
          return JSON.stringify({ ok: true, result: null });
        return JSON.stringify({ ok: true, result: { endpointHandle: 7 } });
      }
      return okNull;
    });
    const module = createIrohNodeNativeModule(addon);
    await expect(
      module.ensureHomeTunnel({
        endpointHandle: 'e',
        homeServerIdentityId: 'h',
        endpointId: 'i',
      }),
    ).rejects.toThrowError(/non-JSON/);
    await expect(module.getTunnelStatus('t-1')).rejects.toMatchObject({
      code: 'unknown',
    });
    await expect(module.getEndpointStatus('e-1')).rejects.toMatchObject({
      code: 'unknown',
    });
    // Unknown handles stay typed null results, not errors.
    await expect(module.getTunnelStatus('missing')).resolves.toBeNull();
    await expect(module.getEndpointStatus('missing')).resolves.toBeNull();
  });

  it('rejects a guest HTTP lease that discloses the native capability', async () => {
    const addon = createFakeAddon((operation) =>
      operation === 'startMachineTunnel'
        ? JSON.stringify({
            ok: true,
            result: {
              machineTunnelId: 'guest-1',
              endpointHandle: 'e-1',
              localPort: 45123,
              localCapability: 'a'.repeat(64),
              connectionActive: true,
              remoteEndpointId: 'peer',
              observedPath: 'direct',
              startedAtMs: 99,
              lastErrorCode: null,
            },
          })
        : okNull,
    );
    const request = {
      endpointHandle: 'e-1',
      endpointId: 'peer',
      handshakeJson: '{}',
      nativeHttpLease: { openJson: '{}' },
    };
    await expect(
      createIrohNodeNativeModule(addon).startMachineTunnel(request),
    ).rejects.toThrowError(/capability/i);
  });

  it('validates the machine tunnel started result including the normalized remote endpoint', async () => {
    const addon = createFakeAddon((operation, request) => {
      if (operation !== 'startMachineTunnel') return okNull;
      // The dial request carries the authenticated peer and handshake plus the
      // optional local admission target. It never carries a peer-selected app
      // host or application port.
      expect(JSON.parse(request)).toEqual({
        endpointHandle: 'e-1',
        admissionPort: 46000,
        endpointId: 'peer-id',
        handshakeJson: '{}',
      });
      return JSON.stringify({
        ok: true,
        result: {
          machineTunnelId: 'mt-1',
          endpointHandle: 'e-1',
          localPort: 45123,
          localCapability: 'a'.repeat(64),
          connectionActive: true,
          remoteEndpointId: 'normalized-peer-id',
          observedPath: 'direct',
          startedAtMs: 99,
          lastErrorCode: null,
        },
      });
    });
    const module = createIrohNodeNativeModule(addon);
    const started = await module.startMachineTunnel({
      endpointHandle: 'e-1',
      admissionPort: 46000,
      endpointId: 'peer-id',
      handshakeJson: '{}',
    });
    expect(started.remoteEndpointId).toBe('normalized-peer-id');
    expect(started.machineTunnelId).toBe('mt-1');

    // A drifted result without the normalized remote identity fails closed.
    const drifted = createFakeAddon((operation) =>
      operation === 'startMachineTunnel'
        ? JSON.stringify({
            ok: true,
            result: {
              machineTunnelId: 'mt-2',
              endpointHandle: 'e-1',
              localPort: 45124,
              localCapability: 'b'.repeat(64),
              connectionActive: true,
              observedPath: 'direct',
              startedAtMs: 100,
              lastErrorCode: null,
            },
          })
        : okNull,
    );
    const driftedModule = createIrohNodeNativeModule(drifted);
    await expect(
      driftedModule.startMachineTunnel({
        endpointHandle: 'e-1',
        endpointId: 'peer',
        handshakeJson: '{}',
      }),
    ).rejects.toThrowError(/remoteEndpointId/);

    const invalidCapability = createFakeAddon((operation) =>
      operation === 'startMachineTunnel'
        ? JSON.stringify({
            ok: true,
            result: {
              machineTunnelId: 'mt-3',
              endpointHandle: 'e-1',
              localPort: 45125,
              localCapability: 'not-a-capability',
              connectionActive: true,
              remoteEndpointId: 'normalized-peer-id',
              observedPath: 'direct',
              startedAtMs: 101,
              lastErrorCode: null,
            },
          })
        : okNull,
    );
    await expect(
      createIrohNodeNativeModule(invalidCapability).startMachineTunnel({
        endpointHandle: 'e-1',
        endpointId: 'peer',
        handshakeJson: '{}',
      }),
    ).rejects.toThrowError(/localCapability/);
  });

  it('accepts a capability-free finite-transfer listener while retaining protected machine adapters', async () => {
    const finiteAddon = createFakeAddon((operation, request) => {
      if (operation !== 'startMachineTunnel') return okNull;
      expect(JSON.parse(request)).toMatchObject({
        handshakeJson: JSON.stringify({ v: 1, flow: 'finite_transfer' }),
      });
      return JSON.stringify({
        ok: true,
        result: {
          machineTunnelId: 'finite-1',
          endpointHandle: 'e-1',
          localPort: 45126,
          localCapability: null,
          connectionActive: true,
          remoteEndpointId: 'normalized-peer-id',
          observedPath: 'direct',
          startedAtMs: 102,
          lastErrorCode: null,
        },
      });
    });
    const finite = await createIrohNodeNativeModule(
      finiteAddon,
    ).startMachineTunnel({
      endpointHandle: 'e-1',
      endpointId: 'peer',
      handshakeJson: JSON.stringify({ v: 1, flow: 'finite_transfer' }),
    });
    expect(finite).not.toHaveProperty('localCapability');

    const protectedAddon = createFakeAddon((operation) => {
      if (operation !== 'startMachineTunnel') return okNull;
      return JSON.stringify({
        ok: true,
        result: {
          machineTunnelId: 'workspace-1',
          endpointHandle: 'e-1',
          localPort: 45127,
          localCapability: 'c'.repeat(64),
          connectionActive: true,
          remoteEndpointId: 'normalized-peer-id',
          observedPath: 'direct',
          startedAtMs: 103,
          lastErrorCode: null,
        },
      });
    });
    await expect(
      createIrohNodeNativeModule(protectedAddon).startMachineTunnel({
        endpointHandle: 'e-1',
        endpointId: 'peer',
        handshakeJson: JSON.stringify({ v: 1, flow: 'workspace_sync' }),
      }),
    ).resolves.toMatchObject({ localCapability: 'c'.repeat(64) });

    const unprotectedHttpAddon = createFakeAddon((operation) => {
      if (operation !== 'startMachineHttpTunnel') return okNull;
      return JSON.stringify({
        ok: true,
        result: {
          machineTunnelId: 'provider-1',
          endpointHandle: 'e-1',
          localPort: 45128,
          localCapability: null,
          connectionActive: true,
          remoteEndpointId: 'normalized-peer-id',
          observedPath: 'direct',
          startedAtMs: 104,
          lastErrorCode: null,
        },
      });
    });
    await expect(
      createIrohNodeNativeModule(unprotectedHttpAddon).startMachineHttpTunnel({
        endpointHandle: 'e-1',
        endpointId: 'peer',
        handshakeJson: JSON.stringify({ v: 1, kind: 'provider_broker' }),
      }),
    ).rejects.toThrowError(/localCapability/);
  });

  it('uses the existing native HTTP operation for fresh handshakes without serializing the callback', async () => {
    let serializedRequest = '';
    const handshakeProvider = async () =>
      JSON.stringify({ v: 1, kind: 'provider_broker', grantId: 'fresh' });
    const addon = {
      ...createFakeAddon(() => okNull),
      startMachineHttpTunnel: async (
        request: string,
        provider?: () => Promise<string>,
      ) => {
        serializedRequest = request;
        if (!provider) throw new Error('expected a fresh-handshake provider');
        expect(await provider()).toContain('"grantId":"fresh"');
        return JSON.stringify({
          ok: true,
          result: {
            machineTunnelId: 'provider-fresh-1',
            endpointHandle: 'e-1',
            localPort: 45129,
            localCapability: 'd'.repeat(64),
            connectionActive: true,
            remoteEndpointId: 'normalized-peer-id',
            observedPath: 'relay',
            startedAtMs: 105,
            lastErrorCode: null,
          },
        });
      },
    } satisfies IrohNodeNativeAddon;

    await expect(
      createIrohNodeNativeModule(addon).startMachineHttpTunnel({
        endpointHandle: 'e-1',
        endpointId: 'peer',
        handshakeJson: JSON.stringify({ v: 1, kind: 'provider_broker' }),
        handshakeProvider,
      }),
    ).resolves.toMatchObject({ machineTunnelId: 'provider-fresh-1' });
    expect(JSON.parse(serializedRequest)).not.toHaveProperty(
      'handshakeProvider',
    );
  });

  it('validates the acceptor start result including optional path telemetry', async () => {
    const addon = createFakeAddon((operation) => {
      if (operation !== 'startHomeAcceptor') return okNull;
      return JSON.stringify({
        ok: true,
        result: {
          endpointHandle: 's-1',
          reused: false,
          status: {
            running: true,
            connectionsAccepted: 0,
            connectionsActive: 0,
            streamsAccepted: 0,
            streamsRejected: 0,
            lastPath: {
              observedPath: 'direct',
              isRelay: false,
              remoteEndpointId: 'peer',
              atMs: 42,
            },
          },
        },
      });
    });
    const module = createIrohNodeNativeModule(addon);
    const started = await module.startHomeAcceptor({
      endpointHandle: 's-1',
      targetPort: 41000,
    });
    expect(started.reused).toBe(false);
    expect(started.status.running).toBe(true);
    expect(started.status).not.toHaveProperty('connectionsRefused');
    expect(started.status.lastPath).toEqual({
      observedPath: 'direct',
      isRelay: false,
      remoteEndpointId: 'peer',
      atMs: 42,
    });
  });
});
