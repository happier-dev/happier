import { afterEach, describe, expect, it, vi } from 'vitest';
import type { createIrohNodeNativeModule } from '@happier-dev/iroh-native/node';
import { existsSync, readFileSync } from 'node:fs';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
// Collect the real graph before test lifetimes, as the adjacent enrollment suite does.
import './remoteTerminalEnrollment';
import '@/cli/commands/auth/enrollRemote';
import '@happier-dev/cli-common/systemTasks';

const nativeBoundary = vi.hoisted(() => ({ addon: null as unknown }));
// Substitute only loading the OS addon. The real loader/ABI parser, session,
// carrier policy, enrollment, CLI dispatch and controller failure reader run.
vi.mock('node:module', async importOriginal => {
  const actual = await importOriginal<typeof import('node:module')>();
  return { ...actual, createRequire: (url: string | URL) => new Proxy(actual.createRequire(url), {
    apply(target, thisArg, args: unknown[]) {
      if (nativeBoundary.addon && typeof args[0] === 'string' && args[0].endsWith('.node')) return nativeBoundary.addon;
      return Reflect.apply(target, thisArg, args);
    },
  }) };
});
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: (path: import('node:fs').PathLike) => nativeBoundary.addon
    && String(path).endsWith('.node') ? true : actual.existsSync(path) };
});

type Addon = Parameters<typeof createIrohNodeNativeModule>[0];
function addonFailure(code: string): Addon {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected OS addon call'); };
  return {
    getAvailability: () => ({ available: true, os: 'fixture', arch: 'fixture', engine: 'fixture', surface: [] }),
    createEndpoint: vi.fn(async () => JSON.stringify({ ok: true, result: { endpointHandle: 'helper',
      endpointId: 'b'.repeat(64), relayPolicy: 'automatic', relayMode: 'disabled',
      capProfile: 'homeInteractive', relayUrls: [] } })),
    ensureHomeTunnel: vi.fn(async () => JSON.stringify({ ok: false, error: { code, message: 'private-native-detail' } })),
    shutdownEndpoint: vi.fn(async () => JSON.stringify({ ok: true, result: null })),
    startHomeAcceptor: unexpected, stopHomeAcceptor: unexpected, releaseHomeTunnel: unexpected,
    getEndpointStatus: unexpected, getTunnelStatus: unexpected, startMachineAcceptor: unexpected,
    stopMachineAcceptor: unexpected, getMachineAcceptorStatus: unexpected, startMachineTunnel: unexpected,
    startMachineHttpTunnel: unexpected, stopMachineTunnel: unexpected, getMachineTunnelStatus: unexpected,
  };
}

const origin = 'http://happier-agent-qa-l12-c.localhost:3039';
const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_home_runtime', canonicalServerUrl: origin,
  revision: 1, endpoints: [{ kind: 'https' as const, url: origin }, { kind: 'iroh' as const, endpointId: 'a'.repeat(64) }] };

describe('remote enrollment carrier composition', () => {
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_HOME_CARRIER_POLICY']);
  afterEach(() => { nativeBoundary.addon = null; env.restore(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

  it.each([
    { publicDescriptor: true, identityMatches: true, path: 'unreachable' },
    { publicDescriptor: false, identityMatches: true, path: 'unreachable' },
    { publicDescriptor: false, identityMatches: false, path: 'unreachable' },
    { publicDescriptor: false, identityMatches: true, path: 'relay' },
  ] as const)('verifies first contact before pairing (public descriptor=$publicDescriptor, identity matches=$identityMatches, native=$path)', async ({ publicDescriptor, identityMatches, path }) => {
    await withTempDir('happier-enrollment-fallback-', async homeDir => {
      env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: origin, HAPPIER_HOME_CARRIER_POLICY: 'automatic' });
      vi.resetModules();
      const selectedDescriptor = path === 'relay' ? { ...descriptor, endpoints: [descriptor.endpoints[0]!,
        { kind: 'iroh' as const, endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test/'] }] } : descriptor;
      const addon: Addon = { ...addonFailure('home_unreachable'), ...(path === 'relay' ? {
        ensureHomeTunnel: vi.fn(async () => JSON.stringify({ ok: true, result: {
          tunnelId: 'home-tunnel', endpointHandle: 'helper', homeServerIdentityId: descriptor.homeServerIdentityId,
          homeEndpointId: 'a'.repeat(64), runtimeOrigin: 'http://127.0.0.1:48123',
          observedPath: 'relay', carrier: 'iroh', startedAtMs: 1,
        } })),
        releaseHomeTunnel: vi.fn(async () => JSON.stringify({ ok: true, result: null })),
      } : {}) };
      nativeBoundary.addon = addon;
      const fetchBoundary = vi.fn<typeof fetch>(async () => Response.json({ features: {},
        capabilities: { serverIdentity: { serverIdentityId: identityMatches ? descriptor.homeServerIdentityId : 'srv_other_home' } },
        ...(publicDescriptor ? { homeConnectionDescriptor: descriptor } : {}) }));
      vi.stubGlobal('fetch', fetchBoundary);
      const { default: axios, AxiosHeaders } = await import('axios');
      const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { state: 'requested', expiresAt: Date.now() + 240_000 },
        status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } });
      const { resolveHomeTargetFromDescriptor } = await import('@happier-dev/cli-common/homeTarget');
      const { runRemoteTerminalEnrollment } = await import('./remoteTerminalEnrollment');
      const { normalizeServerHttpBaseUrl } = await import('@/api/client/serverHttpBaseUrl');
      let paired = false;
      const enrollment = runRemoteTerminalEnrollment({ target: resolveHomeTargetFromDescriptor({ descriptor: selectedDescriptor, authority: 'trusted_enrollment' }),
        timeoutMs: 5000, onPairingRequest(request) {
          expect(request.homeServerIdentityId).toBe(descriptor.homeServerIdentityId);
          paired = true;
          throw new Error('pairing-reached');
        },
      });
      if (identityMatches) await expect(enrollment).rejects.toThrow('pairing-reached');
      else await expect(enrollment).rejects.toMatchObject({ code: 'AUTH_ENROLL_REMOTE_CARRIER_UNAVAILABLE',
        carrierFailure: { attemptedCarrier: 'https', reason: 'identity_mismatch',
          irohAttempt: { outcome: 'unavailable', reason: 'home_unreachable' } } });
      expect(paired).toBe(identityMatches);
      expect(fetchBoundary).toHaveBeenCalledTimes(path === 'relay' || !identityMatches ? 1 : 2);
      expect(post).toHaveBeenCalledTimes(identityMatches ? 1 : 0);
      if (identityMatches) expect(String(post.mock.calls[0]?.[0])).toBe(`${path === 'relay' ? 'http://127.0.0.1:48123' : normalizeServerHttpBaseUrl(origin)}/v1/auth/request`);
      expect(addon.ensureHomeTunnel).toHaveBeenCalledOnce();
      expect(addon.shutdownEndpoint).toHaveBeenCalledOnce();
    });
  });

  it.each(['acquisition', 'fallback', 'https', 'iroh'] as const)('preserves the failed carrier through the actual guest CLI and controller without re-polling (%s)', async carrier => {
    await withTempDir('happier-enrollment-carrier-', async homeDir => {
      env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: origin, HAPPIER_HOME_CARRIER_POLICY: 'automatic' });
      vi.resetModules();
      const addon: Addon = { ...addonFailure(carrier === 'acquisition' ? 'identity_mismatch' : 'home_unreachable'),
        ...(carrier === 'iroh' ? {
          ensureHomeTunnel: vi.fn(async () => JSON.stringify({ ok: true, result: {
            tunnelId: 'home-tunnel', endpointHandle: 'helper', homeServerIdentityId: descriptor.homeServerIdentityId,
            homeEndpointId: 'a'.repeat(64), runtimeOrigin: 'http://127.0.0.1:48123',
            observedPath: 'relay', carrier: 'iroh', startedAtMs: 1,
          } })),
          releaseHomeTunnel: vi.fn(async () => JSON.stringify({ ok: true, result: null })),
        } : {}),
      };
      nativeBoundary.addon = addon;
      const fetchBoundary = vi.fn<typeof fetch>(async () => { throw new TypeError('private-network-detail'); });
      if (carrier === 'https') fetchBoundary.mockResolvedValueOnce(Response.json({ features: {},
        capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } } }));
      vi.stubGlobal('fetch', fetchBoundary);
      vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
        yield Buffer.from(JSON.stringify({ kind: 'descriptor', descriptor, authority: 'trusted_enrollment' }));
      });
      const chunks: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk, encodingOrCallback, callback) => {
        chunks.push(String(chunk)); (typeof encodingOrCallback === 'function' ? encodingOrCallback : callback)?.(); return true;
      });
      vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('test_exit'); });
      const { handleAuthCliCommand } = await import('@/cli/commands/auth');
      await expect(handleAuthCliCommand({ args: ['auth', 'enroll-remote', '--json-lines', '--home-target-stdin'],
        rawArgv: [], terminalRuntime: null })).rejects.toThrow('test_exit');
      const envelope = JSON.parse(chunks.join(''));
      const code = carrier === 'acquisition' || carrier === 'fallback' ? 'AUTH_ENROLL_REMOTE_CARRIER_UNAVAILABLE' : 'HOME_FEATURES_NETWORK';
      const attemptedCarrier = carrier === 'https' || carrier === 'fallback' ? 'https' : 'iroh';
      const reason = carrier === 'acquisition' ? 'identity_mismatch' : carrier === 'fallback' ? 'unavailable' : 'transport';
      const irohAttempt = carrier === 'https' || carrier === 'fallback'
        ? { outcome: 'unavailable', reason: 'home_unreachable' } : undefined;
      expect(envelope).toMatchObject({ ok: false, error: { code, carrierFailure: { attemptedCarrier, reason,
        ...(irohAttempt ? { irohAttempt } : {}) } } });
      const { logger } = await import('@/ui/logger');
      const log = existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8') : '';
      const carrierLog = log.split('\n').filter(line => line.includes('[AUTH ENROLLMENT] Carrier failure')).join('\n');
      expect(carrierLog).toContain(code);
      if (irohAttempt) expect(carrierLog).toContain('home_unreachable');
      expect(carrierLog).not.toMatch(/private-native-detail|private-network-detail|srv_home_runtime|localhost/);
      expect(chunks.join('')).not.toMatch(/private-native-detail|private-network-detail|srv_home_runtime|localhost/);
      const { runRemoteHomeEnrollmentFlow, createHappierJsonExecutorFromTextRunner } = await import('@happier-dev/cli-common/systemTasks');
      const { readRemoteEnrollmentCommandFailure } = await import('@happier-dev/protocol/ssh/commandFailure');
      const { ActionOperationFailureV1Schema } = await import('@happier-dev/protocol/actions/operations/v1');
      const result = await runRemoteHomeEnrollmentFlow({ homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
        executor: createHappierJsonExecutorFromTextRunner(async (_args, options) => {
          options?.onStdoutChunk?.(chunks.join('')); return { status: 1, stdout: chunks.join(''), stderr: '' };
        }), approvePairingRequest: async () => { throw new Error('Unexpected approval'); },
      }).catch((error: unknown) => error);
      expect(result).toMatchObject({ code: 'remote_command_failed',
        message: expect.stringContaining(`attemptedCarrier ${attemptedCarrier}; carrierReason ${reason}`) });
      if (irohAttempt) expect(result).toMatchObject({ message: expect.stringContaining('irohOutcome unavailable; irohReason home_unreachable') });
      if (!(result instanceof Error) || !('code' in result)) throw result;
      const presented = readRemoteEnrollmentCommandFailure(result.code, result.message);
      expect(presented?.message).toBe(result.message);
      expect(ActionOperationFailureV1Schema.parse({ errorCode: presented?.code, error: presented?.message }).error).toBe(result.message);
      expect(addon.ensureHomeTunnel).toHaveBeenCalledOnce();
      expect(addon.shutdownEndpoint).toHaveBeenCalledOnce();
      expect(fetchBoundary).toHaveBeenCalledTimes(carrier === 'acquisition' ? 0 : carrier === 'https' ? 2 : 1);
    });
  });
});
