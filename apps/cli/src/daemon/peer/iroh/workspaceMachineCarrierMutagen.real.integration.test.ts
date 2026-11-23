import {
  computeWorkspaceSyncPolicyDigest,
  createDirectRouteGrantSigningInputV2,
  WorkspaceSyncTargetBootstrapPrepareV1Schema,
  WorkspaceSyncTargetBootstrapReleaseV1Schema,
  WorkspaceSyncTargetConflictRecoverV1Schema,
  WorkspaceSyncStatusV1Schema,
  type DirectRouteGrantRequestV2,
} from '@happier-dev/protocol';
import { parseProjectAccountSnapshotV1, type ProjectAccountSnapshotV1 } from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createIrohNodeNativeModule, loadIrohNodeNativeAddon } from '@happier-dev/iroh-native/node';
import { createIrohTestControllerFromNativeAddon } from '@happier-dev/iroh-native/test-controller';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

import {
  createDaemonWorkspaceSyncRuntime,
} from '@/daemon/startup/createDaemonWorkspaceSyncRuntime';
import {
  createProductionDaemonWorkspaceSyncRuntime,
  type ProductionDaemonWorkspaceSyncFactories,
  type ProductionDaemonWorkspaceSyncRuntime,
} from '@/daemon/startup/createProductionDaemonWorkspaceSyncRuntime';
import { createTrackedSessionHandoffCoordinator } from '@/daemon/actionOperations/createTrackedSessionHandoffCoordinator';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import {
  launchWorkspaceSyncLocalAgent,
  spawnWorkspaceSyncSidecar,
} from '@/daemon/startup/workspaceSyncNativeProcessLaunchers';
import type { ActiveProjectAccountRowsSnapshot, ProjectAccountSnapshotMutation, ProjectAccountRowsSnapshotListener } from '@/workspaces/projectAccountRows';
import { createWorkspaceRootOwnershipManager } from '@/workspaces/sync/workspaceSyncRootOwnership';
import { createWorkspaceSyncTargetAuthority } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { createWorkspaceSyncPeerIdentityValidator } from '@/workspaces/sync/transport/workspaceSyncPeerIdentity';
import { createWorkspaceSyncRelationshipOwner } from '@/workspaces/sync/workspaceSyncRelationshipOwner';
import { materializeWorkspaceSyncForOpen } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import type { WorkspaceSyncOwnedLocalAgent } from '@/workspaces/sync/workspaceSyncController';
import type {
  FiniteTransferMachineTunnel,
  WorkspaceSyncMachineTunnel,
  WorkspaceSyncMachineTunnelOpenInput,
} from '@/workspaces/sync/workspaceSyncMachineCarrierStream';
import { startPeerMediationLoopbackServer } from '../mediation/loopback/server';
import { createDaemonMachineIrohRuntime } from './daemonMachineIrohRuntime';
import { createWorkspaceMachineCarrierTunnelOpen } from './workspaceMachineCarrierTunnelOpen';

const accountId = 'account-mutagen-machine-composed';
const sourceMachineId = 'machine-mutagen-source';
const targetMachineId = 'machine-mutagen-target';
const relationshipId = 'relationship-mutagen-machine-composed';
const sourceWorkspaceRefId = 'workspace-mutagen-source';
const targetWorkspaceRefId = 'workspace-mutagen-target';
const nowMs = 2_000;
const runPerformanceAcceptance = process.env.HAPPIER_RUN_WORKSPACE_SYNC_PERFORMANCE === '1';
const performanceFileSizeBytes = Number.parseInt(
  process.env.HAPPIER_WORKSPACE_SYNC_PERFORMANCE_FILE_BYTES ?? String(1024 ** 3),
  10,
);
const performanceDeltaBytes = 4 * 1024;

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

async function writeDeterministicFile(path: string, sizeBytes: number): Promise<void> {
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  for (let index = 0; index < chunk.length; index += 1) chunk[index] = index % 251;
  const handle = await open(path, 'w');
  try {
    let offset = 0;
    while (offset < sizeBytes) {
      const length = Math.min(chunk.length, sizeBytes - offset);
      await handle.write(chunk, 0, length, offset);
      offset += length;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function applyDeterministicDelta(
  path: string,
  sizeBytes: number,
): Promise<Readonly<{ offset: number; bytes: Buffer }>> {
  const delta = Buffer.alloc(performanceDeltaBytes, 0xa7);
  const offset = Math.max(0, Math.floor(sizeBytes / 2) - Math.floor(delta.length / 2));
  const handle = await open(path, 'r+');
  try {
    await handle.write(delta, 0, delta.length, offset);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { offset, bytes: delta };
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveDigest, rejectDigest) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', resolveDigest);
    stream.once('error', rejectDigest);
  });
  return hash.digest('hex');
}

async function waitForFileDigest(
  path: string,
  expectedSizeBytes: number,
  expectedDigest: string,
  description: string,
  deadlineMs = 20 * 60_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastSize = -1;
  let lastDigest = '';
  while (Date.now() < deadline) {
    const metadata = await stat(path).catch(() => null);
    lastSize = metadata?.size ?? -1;
    if (lastSize === expectedSizeBytes) {
      lastDigest = await digestFile(path);
      if (lastDigest === expectedDigest) return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for ${description}; size=${lastSize}; digest=${lastDigest}`);
}

async function waitForFileRegion(
  path: string,
  offset: number,
  expected: Buffer,
  description: string,
  deadlineMs = 20 * 60_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  const observed = Buffer.alloc(expected.length);
  while (Date.now() < deadline) {
    const handle = await open(path, 'r').catch(() => null);
    if (handle) {
      try {
        const { bytesRead } = await handle.read(observed, 0, observed.length, offset);
        if (bytesRead === expected.length && observed.equals(expected)) return;
      } finally {
        await handle.close();
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function recordPerformanceMeasurement(measurement: Readonly<Record<string, string | number>>): void {
  console.info(`[workspace-sync-performance] ${JSON.stringify(measurement)}`);
}

type LiveBinaries = Readonly<{
  manager: string;
  agent: string;
  custody: string;
}>;

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function requireLiveBinaries(): Promise<LiveBinaries> {
  const values = {
    manager: process.env.HAPPIER_MUTAGEN_LIVE_MANAGER_BIN,
    agent: process.env.HAPPIER_MUTAGEN_LIVE_AGENT_BIN,
    custody: process.env.HAPPIER_PROCESS_CUSTODY_LIVE_BIN,
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`The composed Mutagen/Iroh fixture requires source-built binaries; missing ${missing.join(', ')}`);
  }
  const binaries = {
    manager: resolve(values.manager!),
    agent: resolve(values.agent!),
    custody: resolve(values.custody!),
  };
  await Promise.all(Object.values(binaries).map(async (path) => await access(path)));
  return binaries;
}

const contentPolicyInput = Object.freeze({
  v: 1 as const,
  selection: 'all_files' as const,
  extraIgnorePatterns: [] as const,
  extraIncludePatterns: [] as const,
});

function projectSnapshot(
  snapshot: ProjectAccountSnapshotV1,
  graphRevision: number,
): ActiveProjectAccountRowsSnapshot {
  return {
    source: 'network',
    ...snapshot,
    graphRevision,
    organizations: [], rows: [],
    loadedAtMs: 1,
    scopeKey: relationshipId,
  };
}

function createGrantMint(
  signingSecretKey: Uint8Array,
  options: Readonly<{ corruptSignature?: boolean }> = {},
) {
  return async (request: DirectRouteGrantRequestV2) => {
    const { kind, ttlMs: _ttlMs, ...binding } = request;
    const grantScopeId = request.scope.kind === 'machine_rpc'
      ? request.scope.rpcScopeId
      : request.scope.kind === 'bounded_transfer'
        ? request.scope.mode === 'single'
          ? request.scope.transferId
          : request.scope.mode === 'scope'
            ? request.scope.transferScopeId
            : 'carrier'
        : request.scope.kind;
    const payload = {
      ...binding,
      grantId: `grant-${options.corruptSignature ? 'invalid' : 'valid'}-${grantScopeId}-${randomUUID()}`,
      accountId,
      iat: 1_000,
      exp: 301_000,
      aud: 'happier-daemon-route-grant' as const,
      proofKind: kind,
    };
    const signature = tweetnacl.sign.detached(
      Buffer.from(createDirectRouteGrantSigningInputV2(payload), 'utf8'),
      signingSecretKey,
    );
    if (options.corruptSignature) signature[0] ^= 0xff;
    return {
      payload,
      signature: {
        keyId: 'mutagen-composed-signing-key',
        alg: 'Ed25519' as const,
        valueBase64Url: base64url(signature),
      },
    };
  };
}

async function waitForContents(
  path: string,
  expected: string,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = await readFile(path, 'utf8').catch(() => null);
    if (last === expected) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out waiting for ${description}; last=${JSON.stringify(last)}`);
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

// The process boundary matters: shutdownEndpoint sends a QUIC close, whereas
// namespace retirement can terminate the host before that close is delivered.
// Only the native JSON ABI crosses IPC; the production decoder stays real.
async function startNativePeerProcess(addonPath: string, topology: 'direct' | 'relay', relayUrl: string | null) {
  const child = spawn(process.execPath, ['-e', String.raw`
    const addon = require(process.argv[1]);
    process.on('message', async ({ id, method, request }) => {
      try { process.send({ id, result: await addon[method](request) }); }
      catch (error) { process.send({ id, error: error.message }); }
    });
    (async () => {
      if (process.argv[2] === 'direct') await addon.forceDirectOnly();
      else await addon.forceRelayOnly(process.argv[3]);
      process.send({ ready: true });
    })().catch(error => { console.error(error); process.exit(1); });
  `, addonPath, topology, relayUrl ?? ''], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const pending = new Map<number, { resolve(value: string): void; reject(error: Error): void }>();
  let nextId = 0;
  child.on('message', (message: { id?: number; result?: string; error?: string }) => {
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request?.reject(new Error(message.error));
    else if (typeof message.result === 'string') request?.resolve(message.result);
    else request?.reject(new Error('Invalid native peer IPC response'));
  });
  child.on('exit', () => {
    for (const request of pending.values()) request.reject(new Error('Native peer process exited'));
    pending.clear();
  });
  await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => { throw new Error('Native peer process exited before ready'); }),
  ]);
  const localAddon = loadIrohNodeNativeAddon(addonPath);
  // Narrowly isolated IPC fixture for the genuine out-of-process native boundary.
  const invoke = (method: keyof typeof localAddon) => (request: string) => new Promise<string>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      child.send({ id, method, request });
    });
  const proxy: ReturnType<typeof loadIrohNodeNativeAddon> = {
    getAvailability: () => localAddon.getAvailability(),
    createEndpoint: invoke('createEndpoint'), startHomeAcceptor: invoke('startHomeAcceptor'),
    stopHomeAcceptor: invoke('stopHomeAcceptor'), ensureHomeTunnel: invoke('ensureHomeTunnel'),
    releaseHomeTunnel: invoke('releaseHomeTunnel'), shutdownEndpoint: invoke('shutdownEndpoint'),
    getEndpointStatus: invoke('getEndpointStatus'), getTunnelStatus: invoke('getTunnelStatus'),
    startMachineAcceptor: invoke('startMachineAcceptor'), stopMachineAcceptor: invoke('stopMachineAcceptor'),
    getMachineAcceptorStatus: invoke('getMachineAcceptorStatus'), startMachineTunnel: invoke('startMachineTunnel'),
    startMachineHttpTunnel: invoke('startMachineHttpTunnel'), stopMachineTunnel: invoke('stopMachineTunnel'),
    getMachineTunnelStatus: invoke('getMachineTunnelStatus'),
    ...(localAddon.waitMachineTunnelClosed ? { waitMachineTunnelClosed: invoke('waitMachineTunnelClosed') } : {}),
  };
  return {
    native: createIrohNodeNativeModule(proxy),
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    },
  };
}

describe('production handoff -> Mutagen manager -> broker -> controller -> native machine/1 -> rooted agent', () => {
  it.each([
    { topology: 'direct' as const, expectedPath: 'direct' as const, retirement: 'endpoint' as const },
    { topology: 'relay' as const, expectedPath: 'relay' as const, retirement: 'endpoint' as const },
    { topology: 'direct' as const, expectedPath: 'direct' as const, retirement: 'process' as const },
    { topology: 'relay' as const, expectedPath: 'relay' as const, retirement: 'process' as const },
    { topology: 'direct' as const, expectedPath: 'direct' as const, retirement: 'process_offline' as const },
  ])(
    'syncs over $topology, recovers a replacement peer $retirement, cancels, and rejects invalid grants',
    async ({ topology, expectedPath, retirement }) => {
      const outOfProcess = retirement !== 'endpoint';
      if (runPerformanceAcceptance
        && (!Number.isSafeInteger(performanceFileSizeBytes) || performanceFileSizeBytes < performanceDeltaBytes)) {
        throw new Error(`Invalid HAPPIER_WORKSPACE_SYNC_PERFORMANCE_FILE_BYTES=${performanceFileSizeBytes}`);
      }
      const binaries = await requireLiveBinaries();
      // Keep the nested broker socket below the macOS Unix-domain socket path limit.
      const fixtureRoot = await realpath(await mkdtemp('/tmp/hmic-'));
      const sourceHome = join(fixtureRoot, 's');
      const targetHome = join(fixtureRoot, 't');
      const sourceRoot = join(fixtureRoot, 'a');
      const targetRoot = join(fixtureRoot, 'b');
      const secondSourceRoot = join(fixtureRoot, 'a2');
      const secondTargetRoot = join(fixtureRoot, 'b2');
      const secondRelationshipId = `${relationshipId}-second`;
      let currentProject = parseProjectAccountSnapshotV1({
        workspaceRefs: [],
        relationships: [],
      });
      let currentProjectRevision = 1;
      const projectListeners = new Set<ProjectAccountRowsSnapshotListener>();
      const getProjectSnapshot = () => projectSnapshot(currentProject, currentProjectRevision);
      await Promise.all([
        mkdir(sourceHome, { recursive: true }),
        mkdir(targetHome, { recursive: true }),
        mkdir(sourceRoot, { recursive: true }),
        mkdir(targetRoot, { recursive: true }),
        mkdir(secondSourceRoot, { recursive: true }),
        mkdir(secondTargetRoot, { recursive: true }),
      ]);
      const performanceSourcePath = join(sourceRoot, 'performance.bin');
      const performanceTargetPath = join(targetRoot, 'performance.bin');
      let performanceInitialWriteMs = 0;
      let performanceInitialDigest = '';
      if (runPerformanceAcceptance) {
        const initialWriteStartedAt = process.hrtime.bigint();
        await writeDeterministicFile(performanceSourcePath, performanceFileSizeBytes);
        performanceInitialWriteMs = elapsedMs(initialWriteStartedAt);
        performanceInitialDigest = await digestFile(performanceSourcePath);
      }

      const addonPath = process.env.HAPPIER_TEST_IROH_NODE_ADDON_PATH?.trim();
      if (!addonPath) throw new Error('The composed Mutagen/Iroh fixture requires an explicit test-feature addon path');
      const rawAddon = loadIrohNodeNativeAddon(addonPath);
      const testController = createIrohTestControllerFromNativeAddon(rawAddon);
      if (topology === 'direct') await testController.forceDirectOnly();
      else await testController.forceRelayOnly();
      const native = createIrohNodeNativeModule(rawAddon);
      const nativeStartMachineTunnel = vi.spyOn(native, 'startMachineTunnel');
      const signingKeyPair = tweetnacl.sign.keyPair();
      const trustRoots = [{
        keyId: 'mutagen-composed-signing-key',
        publicKey: base64url(signingKeyPair.publicKey),
      }];
      const sourceRootOwnership = createWorkspaceRootOwnershipManager({
        lockDirectory: join(sourceHome, 'daemon', 'workspace-sync', 'root-ownership'),
      });
      const targetRootOwnership = createWorkspaceRootOwnershipManager({
        lockDirectory: join(targetHome, 'daemon', 'workspace-sync', 'root-ownership'),
      });
      const targetAgentDataDirectory = join(targetHome, 'daemon', 'workspace-sync', 'mutagen', 'data');
      await mkdir(targetAgentDataDirectory, { recursive: true, mode: 0o700 });
      const targetAgentStreams: WorkspaceSyncOwnedLocalAgent[] = [];
      const callMachineRpc = vi.fn(async () => {
        throw new Error('The composed target ingress must remain on the authenticated machine carrier');
      });
      const createTargetAuthority = () => createWorkspaceSyncTargetAuthority({
        localServerId: 'server-1',
        localMachineId: targetMachineId,
        getProjectSnapshot,
        callMachineRpc,
        bootstrap: {
          materializationDirectory: join(targetHome, 'daemon', 'workspace-sync', 'bootstrap'),
          rootOwnershipManager: targetRootOwnership,
        },
        resolutionMaterialDirectory: join(targetHome, 'daemon', 'workspace-sync', 'resolution-material'),
        openRootedAgent: async (request) => {
          const agent = await launchWorkspaceSyncLocalAgent({
            executablePath: binaries.agent,
            args: ['synchronizer', '--external', '--root', request.canonicalRoot],
            dataDirectory: targetAgentDataDirectory,
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.signal ? { signal: request.signal } : {}),
          });
          targetAgentStreams.push(agent);
          return agent;
        },
      });
      let targetAuthority = createTargetAuthority();
      let peerProcess: Awaited<ReturnType<typeof startNativePeerProcess>> | null = null;
      let sourceIroh: Awaited<ReturnType<typeof createDaemonMachineIrohRuntime>> | null = null;
      let targetIroh: Awaited<ReturnType<typeof createDaemonMachineIrohRuntime>> | null = null;
      let admission: Awaited<ReturnType<typeof startPeerMediationLoopbackServer>> | null = null;
      let sourceWorkspaceRuntime: ProductionDaemonWorkspaceSyncRuntime | null = null;
      // Home is an HTTP boundary. Keep child-Machine resolution and row decoding real:
      // both fixture Machines are ordinary native Machines, with no child projection.
      const home = createServer((request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/v1/account/encryption') {
          response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
          return;
        }
        const machineId = request.url?.split('/v1/machines/')[1];
        if (request.method === 'GET' && (machineId === sourceMachineId || machineId === targetMachineId)) {
          response.end(JSON.stringify({ machine: MachinePublishedRowV1Schema.parse({
            id: machineId,
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            storageMode: 'plain',
            active: true,
          }) }));
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'unknown_fixture_route' }));
      });
      try {
        await new Promise<void>((resolveListen) => home.listen(0, '127.0.0.1', resolveListen));
        const homeAddress = home.address();
        if (!homeAddress || typeof homeAddress === 'string') throw new Error('Missing fixture Home address');
        const homeUrl = `http://127.0.0.1:${homeAddress.port}`;
        sourceIroh = await createDaemonMachineIrohRuntime({
          happyHomeDir: sourceHome,
          relayConfig: { relayPolicy: 'disabled', relayUrls: [] },
          native,
        });
        if (outOfProcess) peerProcess = await startNativePeerProcess(addonPath, topology, testController.getTestRelayUrl());
        targetIroh = await createDaemonMachineIrohRuntime({
          happyHomeDir: targetHome,
          relayConfig: { relayPolicy: 'disabled', relayUrls: [] },
          native: peerProcess?.native ?? native,
        });
        expect(sourceIroh.available).toBe(true);
        expect(targetIroh.available).toBe(true);
        if (!sourceIroh.available || !targetIroh.available) return;

        const startTargetAdmission = async (peer: typeof targetIroh) => {
          if (!peer?.available) throw new Error('Target Iroh endpoint is unavailable');
          const currentAdmission = await startPeerMediationLoopbackServer({
            nowMs: () => nowMs,
            expected: {
              accountId,
              machineId: targetMachineId,
              flowKind: 'machine_rpc',
              routeKind: 'loopback_direct',
              endpointFingerprint: peer.endpoint.endpointId,
            },
            trustRoots,
            endpointExpiresAt: 301_000,
            irohMachineAdmission: {
              localEndpointId: peer.endpoint.endpointId,
              role: 'acceptor',
              allowedFlows: ['workspace_sync'],
              resolveApplicationTarget: async ({ handshake, signal }) => {
                if (handshake.flow !== 'workspace_sync' || handshake.initiator.kind !== 'machine') return null;
                const ingress = await targetAuthority.acquireWorkspaceSyncMachineIngress({
                  operationId: handshake.operationId,
                  sourceMachineId: handshake.initiator.machineId,
                  targetMachineId: handshake.target.machineId,
                  signal,
                }).catch((error: unknown) => {
                  throw Object.assign(new Error(
                    `Target rooted-agent ingress failed: ${error instanceof Error ? error.message : String(error)}`,
                  ), { code: 'peer_unavailable' });
                });
                return {
                  port: ingress.port,
                  localCapability: ingress.localCapability,
                };
              },
            },
          });
          await peer.startAttemptAcceptor({ admissionPort: Number(new URL(currentAdmission.url).port) });
          return currentAdmission;
        };
        admission = await startTargetAdmission(targetIroh);

        const targetMachine = {
          id: targetMachineId,
          operationProtocolCapabilitiesRevision: 7,
          operationProtocolCapabilities: {
            irohMachineEndpoint: { protocolVersions: [1], ...targetIroh.endpoint },
          },
        };
        const readTargetMachine = vi.fn(async () => targetMachine);
        const productionOpen = createWorkspaceMachineCarrierTunnelOpen({
          accountId,
          localMachineId: sourceMachineId,
          runtime: sourceIroh,
          resolveTrustRoots: () => trustRoots,
          readTargetMachine,
          mintGrant: createGrantMint(signingKeyPair.secretKey),
          nowMs: () => nowMs,
        });
        const observedPaths: Array<'direct' | 'relay' | 'unknown'> = [];
        // The opener seam is flow-overloaded, so the observing wrapper keeps both signatures
        // instead of collapsing to the last one and silently dropping the file-transfer flow.
        async function openMachineCarrierTunnel(
          input: Extract<WorkspaceSyncMachineTunnelOpenInput, { flow: 'file_transfer' }>,
        ): Promise<FiniteTransferMachineTunnel>;
        async function openMachineCarrierTunnel(
          input: Extract<WorkspaceSyncMachineTunnelOpenInput, { flow: 'workspace_sync' }>,
        ): Promise<WorkspaceSyncMachineTunnel>;
        async function openMachineCarrierTunnel(
          input: WorkspaceSyncMachineTunnelOpenInput,
        ): Promise<FiniteTransferMachineTunnel | WorkspaceSyncMachineTunnel> {
          const tunnel = await (input.flow === 'file_transfer'
            ? productionOpen(input)
            : productionOpen(input)
          ).catch((error: unknown) => {
            throw Object.assign(new Error(
              `Production machine opener failed: ${error instanceof Error ? error.message : String(error)}`,
            ), { code: 'peer_unavailable' });
          });
          observedPaths.push(tunnel.observedPath);
          return tunnel;
        }

        const publishProject = (snapshot: ProjectAccountSnapshotV1): void => {
          const previous = getProjectSnapshot();
          currentProject = parseProjectAccountSnapshotV1(snapshot);
          currentProjectRevision += 1;
          const next = getProjectSnapshot();
          for (const listener of projectListeners) listener(previous, next);
        };
        const mutateProjectSnapshot: ProjectAccountSnapshotMutation = async (mutate, signal) => {
          signal?.throwIfAborted();
          publishProject(parseProjectAccountSnapshotV1(await mutate(currentProject)));
          return { status: 'applied', version: currentProjectRevision, snapshot: currentProject };
        };
        const productionCallMachineRpc: ProductionDaemonWorkspaceSyncFactories['callMachineRpc'] = async (request) => {
          if (request.machineId !== targetMachineId) throw new Error(`Unexpected workspace-sync RPC target ${request.machineId}`);
          if (request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE) {
            return await targetAuthority.prepareBootstrapHere(
              WorkspaceSyncTargetBootstrapPrepareV1Schema.parse(request.request),
              request.signal,
            );
          }
          if (request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE) {
            return await targetAuthority.releaseBootstrapHere(
              WorkspaceSyncTargetBootstrapReleaseV1Schema.parse(request.request),
              request.signal,
            );
          }
          if (request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_RECOVER) {
            return await targetAuthority.recoverConflictResolutionHere(
              WorkspaceSyncTargetConflictRecoverV1Schema.parse(request.request),
              request.signal,
            );
          }
          throw new Error(`Unexpected workspace-sync RPC method ${request.method}`);
        };
        const productionFactories: Partial<ProductionDaemonWorkspaceSyncFactories> = {
          createDaemonRuntime: (dependencies) => createDaemonWorkspaceSyncRuntime({
            ...dependencies,
            resolveInstalledComponentPaths: () => ({
              currentPath: binaries.manager,
              resolvedCurrentPath: null,
            }),
            resolveArtifactPaths: () => ({
              managerPath: binaries.manager,
              agentPath: binaries.agent,
            }),
            assertArtifactPayload: () => ({
              engineVersion: 'source-built-mutagen-iroh-production-composed',
              protocolEpoch: 'external-stream-v1',
            }),
            resolveDataLayout: () => ({
              rootDir: join(sourceHome, 'm'),
              dataDir: join(sourceHome, 'm', 'd'),
              brokerDir: join(sourceHome, 'm', 'b'),
              stagingDir: join(sourceHome, 'm', 's'),
            }),
          }),
          createRootOwnershipManager: () => sourceRootOwnership,
          resolveRootOwnershipDirectory: () => join(sourceHome, 'daemon', 'workspace-sync', 'root-ownership'),
          createPeerIdentityValidator: () => createWorkspaceSyncPeerIdentityValidator({
            resolveExecutable: () => binaries.custody,
          }),
          getProjectSnapshot,
          subscribeProjectSnapshot: (listener) => {
            projectListeners.add(listener);
            return () => { projectListeners.delete(listener); };
          },
          callMachineRpc: productionCallMachineRpc,
          inspectLegacyState: async ({ activeServerDir }) => ({
            status: 'absent' as const,
            path: join(activeServerDir, 'workspace-replication'),
          }),
          refreshProjectRows: async () => getProjectSnapshot(),
          createRelationshipOwner: (options) => createWorkspaceSyncRelationshipOwner({
            ...options,
            mutateProjectSnapshot,
            readProjectSnapshot: async () => currentProject,
            createId: (() => {
              const ids = [sourceWorkspaceRefId, targetWorkspaceRefId, `${sourceWorkspaceRefId}-second`, `${targetWorkspaceRefId}-second`];
              return () => ids.shift() ?? `workspace-ref-${ids.length}`;
            })(),
            deriveRelationshipId: (operationId) => operationId === 'action-second-relationship' ? secondRelationshipId : relationshipId,
            nowMs: () => nowMs,
          }),
        };
        sourceWorkspaceRuntime = await runWithServerHttpBaseUrl(homeUrl, async () => await createProductionDaemonWorkspaceSyncRuntime({
          happyHomeDir: sourceHome,
          activeServerDir: join(sourceHome, 'servers', 'server-1'),
          activeServerId: 'server-1',
          localMachineId: sourceMachineId,
          releaseChannel: 'publicdev',
          credentials: { token: 'test-token', encryption: null },
          openMachineCarrierTunnel,
        }, productionFactories));
        sourceWorkspaceRuntime.start();

        const alphaPayload = `alpha-to-beta-${topology}-non-empty\n`;
        await writeFile(join(sourceRoot, 'alpha-to-beta.txt'), alphaPayload);
        const handoffStatus = (status: 'in_progress' | 'ready_for_cutover' | 'completed', phase: string) => ({
          handoffId: 'handoff-production-composed',
          sessionId: 'session-production-composed',
          sourceMachineId,
          targetMachineId,
          status,
          phase,
          transportStrategy: 'server_routed_stream' as const,
          recoveryActions: [],
        });
        type HandoffMachineCall = NonNullable<
          Parameters<typeof createTrackedSessionHandoffCoordinator>[0]['callMachine']
        >;
        const callHandoffMachine: HandoffMachineCall = vi.fn(async (request) => {
          if (request.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3) {
            return {
              handoffId: 'handoff-production-composed',
              status: handoffStatus('ready_for_cutover', 'staging_target'),
              remoteSessionId: 'remote-production-composed',
              directSource: { kind: 'claudeConfig', configDir: null, projectId: null },
              resume: {
                directory: targetRoot,
                agent: 'claude',
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                resume: 'remote-production-composed',
                transcriptStorage: 'persisted',
                approvedNewDirectoryCreation: true,
              },
            };
          }
          if (request.method === RPC_METHODS.SPAWN_HAPPY_SESSION) {
            return { type: 'success', spawnNonce: 'handoff:handoff-production-composed', sessionIdStatus: 'pending' };
          }
          if (request.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3) {
            return {
              handoffId: 'handoff-production-composed',
              status: handoffStatus('completed', 'finalizing'),
            };
          }
          if (request.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3) {
            return {
              handoffId: 'handoff-production-composed',
              status: { ...handoffStatus('completed', 'finalizing'), status: 'aborted' },
            };
          }
          throw new Error(`Unexpected handoff RPC method ${request.method}`);
        });
        const coordinate = createTrackedSessionHandoffCoordinator({
          expectedAccountServerId: 'server-1',
          readCredentials: async () => ({ token: 'test-token', encryption: null }),
          resolveSource: async () => ({
            ok: true,
            sourceMachineId,
            sourceRootPath: sourceRoot,
            sessionStorageMode: 'persisted',
          }),
          callMachine: callHandoffMachine,
          awaitTargetCustody: async () => ({ type: 'success', sessionId: 'session-production-composed' }),
          wait: async () => undefined,
          workspaceSyncAdapter: sourceWorkspaceRuntime.handoffAdapter,
        });
        const performanceInitialCopyStartedAt = process.hrtime.bigint();
        const handoffResult = await coordinate({
          operationId: 'action-production-composed',
          actionInput: {
            sessionId: 'session-production-composed',
            targetMachineId,
            targetPath: targetRoot,
            accountServerId: 'server-1',
            workspaceAction: {
              kind: 'create_relationship',
              mode: 'keep_both_in_sync',
              contentPolicy: {
                ...contentPolicyInput,
                policyDigest: computeWorkspaceSyncPolicyDigest(contentPolicyInput),
              },
              flushBeforeCommit: true,
            },
          },
          start: async () => ({
            ok: true,
            result: {
              handoffId: 'handoff-production-composed',
              targetPath: sourceRoot,
              endpointCandidates: [],
              status: handoffStatus('in_progress', 'preparing'),
            },
          }),
          signal: new AbortController().signal,
          publishOwnerUpdate: vi.fn(),
        });
        if (!handoffResult.ok) throw new Error(JSON.stringify(handoffResult));
        expect(handoffResult.result).toMatchObject({
          workspace: { kind: 'relationship', relationshipId, created: true },
        });
        expect(currentProject.relationships).toEqual([
          expect.objectContaining({ relationshipId, mode: 'keep_both_in_sync', enabled: true }),
        ]);

        if (runPerformanceAcceptance) {
          await waitForFileDigest(
            performanceTargetPath,
            performanceFileSizeBytes,
            performanceInitialDigest,
            `${topology} initial performance copy`,
          );
          const initialCopyMs = elapsedMs(performanceInitialCopyStartedAt);

          const deltaStartedAt = process.hrtime.bigint();
          const delta = await applyDeterministicDelta(performanceSourcePath, performanceFileSizeBytes);
          await waitForFileRegion(
            performanceTargetPath,
            delta.offset,
            delta.bytes,
            `${topology} 4 KiB delta region`,
          );
          const deltaMs = elapsedMs(deltaStartedAt);
          const deltaDigest = await digestFile(performanceSourcePath);
          await waitForFileDigest(
            performanceTargetPath,
            performanceFileSizeBytes,
            deltaDigest,
            `${topology} 4 KiB delta`,
          );
          recordPerformanceMeasurement({
            topology,
            fileBytes: performanceFileSizeBytes,
            deltaBytes: performanceDeltaBytes,
            initialWriteMs: performanceInitialWriteMs,
            initialCopyMs,
            deltaMs,
          });
        }
        await waitForContents(
          join(targetRoot, 'alpha-to-beta.txt'),
          alphaPayload,
          `${topology} alpha-to-beta Mutagen bytes`,
        );
        const betaPayload = `beta-to-alpha-${topology}-non-empty\n`;
        await writeFile(join(targetRoot, 'beta-to-alpha.txt'), betaPayload);
        await waitForContents(
          join(sourceRoot, 'beta-to-alpha.txt'),
          betaPayload,
          `${topology} beta-to-alpha Mutagen bytes`,
        );

        await writeFile(join(secondSourceRoot, 'initial.txt'), 'second relationship before restart\n');
        await materializeWorkspaceSyncForOpen(sourceWorkspaceRuntime.handoffAdapter, {
          operationId: 'action-second-relationship',
          accountServerId: 'server-1',
          sourceMachineId,
          targetMachineId,
          sourceRootPath: secondSourceRoot,
          targetRootPath: secondTargetRoot,
          action: {
            kind: 'create_relationship',
            mode: 'keep_both_in_sync',
            contentPolicy: { ...contentPolicyInput, policyDigest: computeWorkspaceSyncPolicyDigest(contentPolicyInput) },
            flushBeforeCommit: true,
          },
        });
        await waitForContents(join(secondTargetRoot, 'initial.txt'), 'second relationship before restart\n', 'second relationship initial bytes');

        const retiredEndpointId = targetIroh.endpoint.endpointId;
        const streamsBeforeRestart = targetAgentStreams.length;
        if (peerProcess) await peerProcess.kill();
        else await targetIroh.shutdown();
        targetIroh = null;
        await admission.stop();
        admission = null;
        await targetAuthority.releaseAllRetainedBootstraps();
        targetAuthority = createTargetAuthority();
        const restartPeer = async () => {
          if (outOfProcess) peerProcess = await startNativePeerProcess(addonPath, topology, testController.getTestRelayUrl());
          targetIroh = await createDaemonMachineIrohRuntime({
            happyHomeDir: outOfProcess ? targetHome : join(fixtureRoot, 't2'),
            relayConfig: { relayPolicy: 'disabled', relayUrls: [] },
            native: peerProcess?.native ?? native,
          });
          if (!targetIroh.available) throw new Error('Replacement Iroh endpoint is unavailable');
          if (outOfProcess) expect(targetIroh.endpoint.endpointId).toBe(retiredEndpointId);
          else expect(targetIroh.endpoint.endpointId).not.toBe(retiredEndpointId);
          admission = await startTargetAdmission(targetIroh);
          targetMachine.operationProtocolCapabilities.irohMachineEndpoint = { protocolVersions: [1], ...targetIroh.endpoint };
          targetMachine.operationProtocolCapabilitiesRevision += 1;
        };
        if (retirement !== 'process_offline') await restartPeer();
        const afterRestartPayload = `after-restart-${topology}\n`;
        await writeFile(join(sourceRoot, 'after-restart.txt'), afterRestartPayload);
        const flushOutcome = sourceWorkspaceRuntime.workspaceSync.controller.flush(relationshipId).then(
          () => ({ kind: 'flushed' as const }),
          (error: unknown) => ({ kind: 'failed' as const, error }),
        );
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          const outcome = await Promise.race([
            flushOutcome,
            new Promise<never>((_resolveDeadline, rejectDeadline) => {
              deadline = setTimeout(() => rejectDeadline(new Error('Flush remained pending after peer restart')), outOfProcess ? 60_000 : 10_000);
            }),
          ]);
          if (outcome.kind === 'failed') expect(outcome.error).toMatchObject({ code: 'engine_unavailable' });
          if (retirement === 'process_offline') expect(outcome.kind).toBe('failed');
        } finally {
          clearTimeout(deadline);
        }
        if (retirement === 'process_offline') await restartPeer();
        await writeFile(join(secondSourceRoot, 'after-restart.txt'), afterRestartPayload);
        // A transport refusal can leave normal engine recovery active. Model
        // one explicit user retry and require both sessions to flush cleanly.
        for (const id of [relationshipId, secondRelationshipId]) {
          let raw: unknown;
          try {
            raw = await sourceWorkspaceRuntime.workspaceSync.controller.flush(id);
          } catch (error) {
            expect(error).toMatchObject({ code: 'engine_unavailable' });
            raw = await sourceWorkspaceRuntime.workspaceSync.controller.flush(id);
          }
          const flushed = WorkspaceSyncStatusV1Schema.parse(raw);
          expect(flushed).toMatchObject({
            relationshipId: id,
            state: 'watching',
          });
          expect(flushed.lastCleanSyncAtMs).not.toBeNull();
        }
        await waitForContents(join(targetRoot, 'after-restart.txt'), afterRestartPayload, `${topology} replacement endpoint bytes`);
        await waitForContents(join(secondTargetRoot, 'after-restart.txt'), afterRestartPayload, `${topology} second relationship replacement bytes`);
        expect(targetAgentStreams.length).toBeGreaterThan(streamsBeforeRestart);

        const status = await sourceWorkspaceRuntime.workspaceSync.controller.get(relationshipId);
        expect(status).toMatchObject({
          relationshipId,
          mode: 'keep_both_in_sync',
        });
        expect(observedPaths.length).toBeGreaterThan(0);
        expect(observedPaths.every((path) => path === expectedPath)).toBe(true);
        expect(targetAgentStreams.length).toBeGreaterThan(0);
        expect(nativeStartMachineTunnel.mock.calls.length).toBeGreaterThan(0);

        const tunnelsBeforeInvalidGrant = nativeStartMachineTunnel.mock.calls.length;
        const agentsBeforeInvalidGrant = targetAgentStreams.length;
        const invalidOpen = createWorkspaceMachineCarrierTunnelOpen({
          accountId,
          localMachineId: sourceMachineId,
          runtime: sourceIroh,
          resolveTrustRoots: () => trustRoots,
          readTargetMachine,
          mintGrant: createGrantMint(signingKeyPair.secretKey, { corruptSignature: true }),
          nowMs: () => nowMs,
        });
        await expect(invalidOpen({
          operationId: relationshipId,
          sourceMachineId,
          targetMachineId,
          flow: 'workspace_sync',
        })).rejects.toMatchObject({ code: 'grant_bad_signature' });
        expect(nativeStartMachineTunnel).toHaveBeenCalledTimes(tunnelsBeforeInvalidGrant);
        expect(targetAgentStreams).toHaveLength(agentsBeforeInvalidGrant);
        expect(callMachineRpc).not.toHaveBeenCalled();

        await sourceWorkspaceRuntime.workspaceSync.controller.terminate(relationshipId);
        await sourceWorkspaceRuntime.workspaceSync.controller.terminate(secondRelationshipId);
        await expect(sourceWorkspaceRuntime.workspaceSync.controller.get(relationshipId)).resolves.toBeNull();
        await waitFor(
          () => targetAgentStreams.every((agent) => agent.stream.destroyed),
          'Target rooted Mutagen agent remained alive after relationship cancellation/half-close',
        );
        await sourceWorkspaceRuntime.stop();
        sourceWorkspaceRuntime = null;
      } finally {
        await sourceWorkspaceRuntime?.stop().catch(() => undefined);
        await sourceIroh?.shutdown().catch(() => undefined);
        await targetIroh?.shutdown().catch(() => undefined);
        await peerProcess?.kill();
        await admission?.stop().catch(() => undefined);
        await targetAuthority.releaseAllRetainedBootstraps().catch(() => undefined);
        await new Promise<void>((resolveClose, rejectClose) => home.close((error) => error ? rejectClose(error) : resolveClose()));
        await rm(fixtureRoot, { recursive: true, force: true });
        await testController.restoreAutomatic();
      }
    },
    runPerformanceAcceptance ? 30 * 60_000 : 180_000,
  );
});
