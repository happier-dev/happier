// Lane 06 amendment A9 — the real browser finite Machine transfer journey.
//
// This is the Machine stage of the ONE Chromium proof harness. It reuses the
// A7.3 page, the A7.3 native relay/acceptor fixture, and the A7.3 runner, and
// adds only the other side of a transfer:
//
//   real Chromium
//     → production `resolveMachineCarrierRoute` (the transfer route owner)
//     → production browser machine carrier
//         · signed V2 grant minted by the CANONICAL server mint owner,
//           requested over the production Home carrier
//         · relay-only `happier/machine/1` dial on the one SharedWorker endpoint
//     → the real native `happier/machine/1` acceptor
//     → the CANONICAL daemon admission owner
//     → canonical daemon import/export RPC and direct-transfer lifecycle owners
//
// Nothing about acceptance is invented here. The acceptor is the production
// Rust one; the admission decision is `startPeerMediationLoopbackServer` with
// its `irohMachineAdmission` route (the same owner the daemon runs), which
// verifies the handshake, the signed grant, the endpoint binding and the role
// through `verifyMachineCarrierHandshakeV1`; and the grant is signed by
// `mintDirectRouteGrantV2` with a key resolved through
// `resolvePeerMediationGrantSigningConfig`. Both are loaded from source through
// isolated `tsx` namespaces, because each app resolves its own `@/` alias.
//
// The Home is ingress-less by construction, exactly as in A7.3: its canonical
// URL is a `.invalid` origin that resolves nowhere, so every byte the browser
// exchanges with it — including the grant request — could only have come over
// the Iroh carrier.
//
// A verdict is PASS only when every observation in `REQUIRED_A74_OBSERVATIONS`
// was actually recorded true. A stage that never ran cannot pass.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server as SocketIoServer } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  buildAndLoadBrowserIrohTestAddon,
  createBrowserIrohNativeHomeFixture,
  listen,
  waitFor,
} from '../../../../packages/iroh-native/scripts/browserIrohNativeHomeFixture.mjs';
import { ensureProductionCarrierSeamBundle } from './runProductionCarrierPageSeam.mjs';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

/**
 * The A7.4 finite-transfer observations. Every one of
 * them must be recorded true by a run before it may print PASS.
 */
export const REQUIRED_A74_OBSERVATIONS = [
  'exactRelayToRealMachineAcceptor',
  'signedGrantBindsInitiatorTargetAndFiniteTransferPurpose',
  'replacementWorkerMintsFreshEndpointAndLaterGrantBindsIt',
  'productionImportPrepareEncryptedChunksFinalizeReceiptAndDestinationBytes',
  'productionExportPrepareEncryptedChunksManifestResultAndDestinationBytes',
  'productionImportCancellationAbortsOwnedSessionWithoutDestination',
  'productionExportCancellationCleansDestination',
  'attachmentGrantUsesFiniteTransferCarrierPurpose',
  'productionAttachmentImportPrepareEncryptedChunksFinalizeReceiptAndDestinationBytes',
  'productionAttachmentCancellationAndTerminalFailureDoNotFallback',
  'wrongPeerRoleEndpointOrGrantRejectedBeforeApplicationBytes',
  'corruptedSignedGrantRejectedBeforeApplicationBytes',
  'terminalSelectedIrohFailureDoesNotFallbackForImportOrExport',
  'browserReportsRelayOnlyNeverDirect',
  'releaseClosesOwnedMachineStream',
  'terminalCleanupStopsPreparedTransferOwner',
];

/** The production seam page commands this journey drives. */
export const REQUIRED_MACHINE_JOURNEY_PAGE_COMMANDS = [
  'seedMachineTransferHome',
  'publishMachineDescriptor',
  'resolveMachineRoute',
  'acquireMachineCarrier',
  'productionDirectImport',
  'productionDirectExport',
  'machineRequest',
  'releaseMachineCarrier',
];

/** The machine lifecycle this journey needs from the one shared native fixture. */
export const REQUIRED_MACHINE_FIXTURE_OPERATIONS = ['startMachine', 'machineAcceptorStatus'];

/**
 * The daemon side is canonical, not re-implemented. These paths are asserted by
 * the contract test so a future edit cannot quietly swap in a hand-rolled
 * acceptor or a hand-signed grant and still print PASS.
 */
export const CANONICAL_DAEMON_OWNERS = {
  admissionModule: 'apps/cli/src/daemon/peer/mediation/loopback/server.ts',
  grantMintModule: 'apps/server/sources/app/machines/peer/mediation/mintDirectRouteGrantV1.ts',
  rpcManagerModule: 'apps/cli/src/api/rpc/RpcHandlerManager.ts',
  importRpcModule: 'apps/cli/src/api/machine/rpcHandlers.directTransferImports.ts',
  exportRpcModule: 'apps/cli/src/api/machine/rpcHandlers.directTransferExports.ts',
  lifecycleModule: 'apps/cli/src/machines/transfer/directTransferServerLifecycle.ts',
  payloadSourceModule: 'apps/cli/src/machines/transfer/transferPayloadSource.ts',
  workspaceSourceModule: 'apps/cli/src/transfers/targets/resolveWorkspaceFileDownloadSource.ts',
};

/** The Home this journey adopts. `.invalid` never resolves (RFC 2606). */
const CANONICAL_HOME_URL = 'https://a74-ingressless-home.happier.invalid';
const HOME_IDENTITY = 'srv_a74_ingressless_home';
const ACCOUNT_ID = 'account-a74-browser-machine';
const MACHINE_ID = 'machine-a74-target';
/** A machine id the acceptor does not own, published at the acceptor's endpoint. */
const IMPOSTOR_MACHINE_ID = 'machine-a74-impostor';
const GRANT_SIGNING_KEY_ID = 'a74-route-grant-key';
const TRANSFER_FLOW = 'file_transfer';
const ATTACHMENT_TRANSFER_FLOW = 'attachment_transfer';
const FINITE_TRANSFER_CARRIER_FLOW = 'finite_transfer';
const TRANSFER_MAX_BYTES = 1_048_576;

/** A request that must NOT reach the machine is given this long to prove it. */
const MUST_NOT_COMPLETE_MS = 8_000;
/** How long the journey waits for a machine-side or browser-side state change. */
const OBSERVE_TIMEOUT_MS = 20_000;
/** The bound on any one page command; see the A7.3 journey for why it exists. */
const PAGE_COMMAND_TIMEOUT_MS = 60_000;

function bail(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function sha256(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/**
 * A token in the shape the production credential path parses: the account this
 * Home authenticated is read from the payload's `sub`, and the account the
 * canonical mint and the canonical admission owner both bind is that same one.
 */
function accountToken(accountId) {
  const payload = Buffer.from(JSON.stringify({ sub: accountId }), 'utf8').toString('base64');
  return `header.${payload}.signature`;
}

/**
 * Loads the canonical daemon admission owner and the canonical server grant
 * mint from source.
 *
 * `apps/cli` and `apps/server` each resolve `@/` to their own root, so they are
 * loaded through two isolated `tsx` namespaces rather than one global loader
 * that could only satisfy one of them.
 */
async function loadCanonicalDaemonOwners() {
  const { register } = await import('tsx/esm/api');
  const originalWorkingDirectory = process.cwd();
  let admission;
  let mint;
  let rpcManager;
  let importRpc;
  let exportRpc;
  let lifecycle;
  let payloadSource;
  let workspaceSource;
  let clientCompatibility;
  try {
    // tsx resolves tsconfig `paths` from the active package working directory.
    // Load each package completely before switching to the other package's `@/`
    // owner; the namespaces keep the already-loaded graphs isolated.
    process.chdir(resolve(repoRoot, 'apps/cli'));
    const cli = register({ namespace: 'happier-a74-cli', tsconfig: 'tsconfig.json' });
    [admission, rpcManager, importRpc, exportRpc, lifecycle, payloadSource, workspaceSource] = await Promise.all([
      cli.import(resolve(repoRoot, CANONICAL_DAEMON_OWNERS.admissionModule), import.meta.url),
      cli.import(resolve(repoRoot, CANONICAL_DAEMON_OWNERS.rpcManagerModule), import.meta.url),
      cli.import(resolve(repoRoot, CANONICAL_DAEMON_OWNERS.importRpcModule), import.meta.url),
      cli.import(resolve(repoRoot, CANONICAL_DAEMON_OWNERS.exportRpcModule), import.meta.url),
      cli.import(resolve(repoRoot, CANONICAL_DAEMON_OWNERS.lifecycleModule), import.meta.url),
      cli.import(resolve(repoRoot, CANONICAL_DAEMON_OWNERS.payloadSourceModule), import.meta.url),
      cli.import(resolve(repoRoot, CANONICAL_DAEMON_OWNERS.workspaceSourceModule), import.meta.url),
    ]);
    process.chdir(resolve(repoRoot, 'apps/server'));
    const server = register({ namespace: 'happier-a74-server', tsconfig: 'tsconfig.json' });
    [mint, clientCompatibility] = await Promise.all([
      server.import(resolve(repoRoot, CANONICAL_DAEMON_OWNERS.grantMintModule), import.meta.url),
      server.import(
        resolve(repoRoot, 'apps/server/sources/app/clientCompatibility/accountStoredContentCompatibility.ts'),
        import.meta.url,
      ),
    ]);
  } finally {
    process.chdir(originalWorkingDirectory);
  }
  if (typeof admission.startPeerMediationLoopbackServer !== 'function') {
    bail('the canonical daemon admission owner does not export startPeerMediationLoopbackServer');
  }
  if (typeof mint.mintDirectRouteGrantV2 !== 'function') {
    bail('the canonical server grant owner does not export mintDirectRouteGrantV2');
  }
  return {
    admission,
    mint,
    rpcManager,
    importRpc,
    exportRpc,
    lifecycle,
    payloadSource,
    workspaceSource,
    clientCompatibility,
  };
}

/** Runs one page command; a command that never settles is a named failure. */
async function command(page, name, argument) {
  let timer = null;
  const evaluated = page.evaluate(
    ([commandName, commandArgument]) => window.__happierProductionCarrierSeam[commandName](commandArgument),
    [name, argument ?? null],
  );
  evaluated.catch(() => {});
  try {
    return await Promise.race([
      evaluated,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`page command ${name} did not settle within ${PAGE_COMMAND_TIMEOUT_MS}ms`)),
          PAGE_COMMAND_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function requireCommand(page, name, argument) {
  const reply = await command(page, name, argument);
  if (reply?.ok !== true) {
    bail(`page command ${name} failed: ${JSON.stringify(reply)}`);
  }
  return reply;
}

/**
 * The Home this browser is signed in to: server features, the canonical V2
 * grant mint, and the counters that make "no ordinary fallback happened" an
 * observation rather than an inference.
 *
 * Only the HTTP shell is fixture; the grant itself is minted by the canonical
 * server owner with a key resolved by the canonical signing-config owner.
 */
function startHomeApplication({ mint, signingKey, invokeMachineRpc, storedContentRequirements }) {
  const state = {
    requests: [],
    /** Every grant exchange, so a refusal names itself instead of being inferred. */
    grantExchanges: [],
    mintedGrants: [],
    mintRejections: [],
    /** Anything an ordinary server-relayed or user-socket transfer would touch. */
    fallbackTransferRequests: [],
    socketUpgrades: 0,
    machineRpcInvocations: [],
    corruptNextMintedGrant: false,
  };

  const signing = mint.resolvePeerMediationGrantSigningConfig({
    HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: GRANT_SIGNING_KEY_ID,
    HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: base64Url(signingKey.secretKey),
  });
  if (!signing.ok) {
    bail(`the canonical grant signing config rejected the journey key: ${JSON.stringify(signing)}`);
  }

  const features = {
    features: {
      encryption: {
        plaintextStorage: { enabled: true },
        accountOptOut: { enabled: true },
      },
      machines: {
        enabled: true,
        peerMediation: { enabled: true },
        transfer: {
          enabled: true,
          directPeer: { enabled: true },
          serverRouted: { enabled: false },
        },
      },
    },
    capabilities: {
      accountStoredContentCompatibility: storedContentRequirements,
      serverIdentity: { serverIdentityId: HOME_IDENTITY },
      encryption: {
        storagePolicy: 'optional',
        allowAccountOptOut: true,
        defaultAccountMode: 'plain',
        plainAccountSettingsAtRest: 'server_sealed',
        plainAccountCredentialsAtRest: 'server_sealed',
      },
    },
  };

  const server = createServer((request, response) => {
    const url = new URL(String(request.url ?? '/'), 'http://home.invalid').pathname;
    state.requests.push({ method: request.method, url });
    if (request.headers.upgrade) state.socketUpgrades += 1;
    // Any ordinary transfer path is a fallback this gate forbids after the
    // Iroh route was selected, so it is recorded rather than served.
    if (/^\/v1\/(transfers|files)/u.test(url)) {
      state.fallbackTransferRequests.push({ method: request.method, url });
      response.writeHead(404).end();
      return;
    }
    if (url === '/v1/auth/ping' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    // A scoped Machine control RPC reads the Home's authenticated Machine row
    // to resolve its persisted content mode. Serve the same published plain
    // marker as the real Home route; omitting the row prevents the production
    // transfer owner from reaching prepare, grant minting, or machine/1.
    if (url === `/v1/machines/${MACHINE_ID}` && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        machine: {
          id: MACHINE_ID,
          kind: 'persistent',
          dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        },
      }));
      return;
    }
    if (url === '/v1/features' || url === '/v1/features/authenticated') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(features));
      return;
    }
    if (url === '/v1/machines/peer/mediation/route-grants' && request.method === 'POST') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (error) {
          state.grantExchanges.push({ outcome: 'unparseable_request', detail: String(error) });
          response.writeHead(400).end();
          return;
        }
        // The canonical server mint, with exactly the client-supplied binding.
        // The journey never edits the binding: a grant that does not bind what
        // the browser asked for is a defect this gate must be able to see.
        const minted = mint.mintDirectRouteGrantV2({
          accountId: ACCOUNT_ID,
          machineId: body.machineId,
          flowKind: body.flowKind,
          routeKind: body.routeKind,
          scope: body.scope,
          ...(body.endpointFingerprint ? { endpointFingerprint: body.endpointFingerprint } : {}),
          nowMs: Date.now(),
          ttlMs: body.ttlMs,
          serverGateEnabled: true,
          signingKey: {
            keyId: signing.keyId,
            secretKey: signing.secretKey,
            expiresAt: signing.capability.expiresAt,
          },
          ...(body.iroh ? { iroh: body.iroh } : {}),
          ephemeralPublicKeyBase64Url: body.ephemeralPublicKeyBase64Url,
        });
        if (!minted.ok) {
          state.mintRejections.push({ request: body, reasonCode: minted.reasonCode });
          state.grantExchanges.push({ outcome: 'mint_rejected', reasonCode: minted.reasonCode, request: body });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ v: 2, ok: false, reasonCode: minted.reasonCode }));
          return;
        }
        state.mintedGrants.push(minted.grant);
        const deliverCorruptedGrant = state.corruptNextMintedGrant;
        state.corruptNextMintedGrant = false;
        const grant = deliverCorruptedGrant
          ? {
              ...minted.grant,
              signature: {
                ...minted.grant.signature,
                valueBase64Url: `${minted.grant.signature.valueBase64Url.startsWith('A') ? 'B' : 'A'}`
                  + minted.grant.signature.valueBase64Url.slice(1),
              },
            }
          : minted.grant;
        state.grantExchanges.push({
          outcome: 'minted',
          grantId: minted.grant.payload.grantId,
          deliveredCorrupted: deliverCorruptedGrant,
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ v: 2, ok: true, grant }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  server.httpAllowHalfOpen = true;

  const io = new SocketIoServer(server, {
    path: '/v1/updates/',
    transports: ['websocket'],
    cors: { origin: true, credentials: false },
  });
  io.on('connection', (socket) => {
    socket.on('rpc-call', async (data, callback) => {
      const method = typeof data?.method === 'string' ? data.method : '';
      const prefix = `${MACHINE_ID}:`;
      if (!method.startsWith(prefix)) {
        callback?.({ ok: false, error: 'unexpected machine RPC target' });
        return;
      }
      const daemonMethod = method.slice(prefix.length);
      const directControlMethods = new Set([
        RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE,
        RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
        RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
        RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE,
      ]);
      if (!directControlMethods.has(daemonMethod)) {
        state.fallbackTransferRequests.push({ method: 'RPC', url: daemonMethod });
      }
      try {
        const result = await invokeMachineRpc(daemonMethod, data?.params);
        state.machineRpcInvocations.push({ method: daemonMethod, payload: data?.params, result });
        callback?.({ ok: true, result });
      } catch (error) {
        callback?.({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  });

  state.server = server;
  state.io = io;
  state.trustRoots = [{ keyId: signing.keyId, publicKey: signing.capability.publicKey }];
  return state;
}

async function reserveLoopbackPort() {
  const probe = createNetServer();
  await new Promise((resolveListen, rejectListen) => {
    probe.once('error', rejectListen);
    probe.listen(0, '127.0.0.1', resolveListen);
  });
  const address = probe.address();
  const port = address && typeof address !== 'string' ? address.port : null;
  await new Promise((resolveClose) => probe.close(resolveClose));
  if (!port) throw new Error('could not reserve a loopback direct-transfer port');
  return port;
}

/**
 * Decides the verdict from what a run actually observed. PASS requires every
 * required observation to be present AND true, and no failure.
 */
export function evaluateBrowserMachineTransferJourney({ observations = {}, failures = [] }) {
  const reasons = [];
  for (const name of REQUIRED_A74_OBSERVATIONS) {
    if (!(name in observations)) {
      reasons.push(`observation never ran: ${name}`);
      continue;
    }
    if (observations[name] !== true) reasons.push(`observation failed: ${name}`);
  }
  reasons.push(...failures);
  return { verdict: reasons.length === 0 ? 'PASS' : 'FAIL', reasons };
}

/**
 * Full RPC records stay in-memory for journey assertions. Prepared-transfer
 * responses contain bearer credentials, so emitted evidence keeps only the
 * operation and stable outcome.
 */
export function summarizeMachineRpcInvocationsForEvidence(invocations) {
  return invocations.map((invocation) => {
    const result = invocation?.result;
    const summary = {
      method: invocation?.method,
      success: result?.success === true,
    };
    if (typeof result?.errorCode === 'string') {
      summary.errorCode = result.errorCode;
    }
    return summary;
  });
}

/**
 * Runs the A7.4 finite-transfer journey through prepare, encrypted chunks,
 * finalize/receipt, destination effects, cancellation, and terminal no-fallback
 * behavior in the canonical direct import/export owners.
 *
 * `openJourneyPage` is supplied by the harness and returns a real Chromium page
 * already at the Metro-built production seam page. Everything native, the Home,
 * the machine, the admission server and the relay are owned here and released
 * in `finally`.
 */
export async function runBrowserMachineTransferJourney({
  webOutputRoot,
  openJourneyPage,
  replaceJourneyPage,
  pageErrors,
}) {
  const failures = [];
  const observations = {};
  const report = {};

  const observe = (name, ok, detail) => {
    observations[name] = ok === true;
    report[name] = detail;
    if (ok !== true) failures.push(`${name}: ${JSON.stringify(detail)}`);
  };

  // 1. The page: built and graph-checked by the same owner A7.3 uses.
  const built = await ensureProductionCarrierSeamBundle({ webOutputRoot });
  report.pageBundle = built.report;

  // 2. The canonical daemon owners, from current source.
  const owners = await loadCanonicalDaemonOwners();

  // 3. The real native side: current-source addon, the one local test relay, a
  //    real Home acceptor and a real machine/1 acceptor.
  const { addon, addonPath } = buildAndLoadBrowserIrohTestAddon({
    extraOperations: ['startMachineAcceptor', 'stopMachineAcceptor', 'getMachineAcceptorStatus'],
  });
  const signingKey = tweetnacl.sign.keyPair();
  const uploadPayload = Buffer.from(
    Array.from({ length: (512 * 1024) + 1 }, (_value, index) => (index * 53 + 7) % 241),
  );
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-browser-machine-transfer-'));
  const targetRoot = join(fixtureRoot, 'target');
  await mkdir(targetRoot, { recursive: true });
  const reservedDirectTransferPort = await reserveLoopbackPort();
  const directTransferLifecycle = owners.lifecycle.createDirectTransferServerLifecycle({
    bindPort: reservedDirectTransferPort,
    bindHost: '127.0.0.1',
    listenerClasses: ['loopback_http'],
    advertisedHosts: ['127.0.0.1'],
    idleStopMs: 120_000,
  });
  const directTransferPort = await directTransferLifecycle.ensureListening();
  const rpcHandlerManager = new owners.rpcManager.RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain' });
  owners.importRpc.registerMachineDirectTransferImportRpcHandlers({
    rpcHandlerManager,
    prepareImportSession: directTransferLifecycle.prepareImportSession,
    abortImportSession: directTransferLifecycle.abortImportSession,
  });
  owners.exportRpc.registerMachineDirectTransferExportRpcHandlers({
    rpcHandlerManager,
    prepareExportSession: async (input) => {
      if (input.t !== 'workspace_file_download_v1') throw new Error('journey supports workspace file export only');
      const resolved = await owners.workspaceSource.resolveWorkspaceFileDownloadSource({
        workingDirectory: input.workingDirectory,
        path: input.path,
        asZip: input.asZip,
        sessionRpcTransferMaxBytes: null,
      });
      if (!resolved.success) throw new Error(resolved.error);
      const payloadSource = owners.payloadSource.createFileTransferPayloadSource({
        filePath: resolved.source.filePath,
        sizeBytes: resolved.source.sizeBytes,
        name: resolved.source.name,
      });
      const published = await directTransferLifecycle.publishTransferWhenReady({
        transferId: `browser-export:${randomUUID()}`,
        payloadSource,
      });
      return {
        transferId: published.transferId,
        endpointCandidates: published.endpointCandidates,
        expiresAt: published.expiresAt,
        name: resolved.source.name,
        sizeBytes: resolved.source.sizeBytes,
      };
    },
    releaseExportSession: (transferId) => directTransferLifecycle.clearPublishedTransfer(transferId),
  });
  const home = startHomeApplication({
    mint: owners.mint,
    signingKey,
    invokeMachineRpc: async (method, payload) => await rpcHandlerManager.invokeLocal(method, payload),
    storedContentRequirements: owners.clientCompatibility.CURRENT_ACCOUNT_STORED_CONTENT_REQUIREMENTS,
  });

  let fixture = null;
  let admissionServer = null;
  const acquiredLeaseKeys = [];

  try {
    const homePort = await listen(home.server);
    fixture = await createBrowserIrohNativeHomeFixture({ addon });
    const homeEndpoint = await fixture.startHome({ label: 'a74-home', targetPort: homePort });

    // The canonical daemon admission owner, bound to this machine's identity.
    // It is what decides every admission; the fixture only carries the bytes.
    const machineTarget = await fixture.startMachine({
      label: 'a74-machine',
      resolveAdmissionPort: async (machineEndpointId) => {
        admissionServer = await owners.admission.startPeerMediationLoopbackServer({
          nowMs: () => Date.now(),
          expected: {
            accountId: ACCOUNT_ID,
            machineId: MACHINE_ID,
            flowKind: 'bounded_transfer',
            routeKind: 'loopback_direct',
            endpointFingerprint: machineEndpointId,
          },
          trustRoots: home.trustRoots,
          endpointExpiresAt: Date.now() + 3_600_000,
          irohMachineAdmission: {
            localEndpointId: machineEndpointId,
            role: 'acceptor',
            allowedFlows: [FINITE_TRANSFER_CARRIER_FLOW],
            // The already-verified stream's local owner. The peer never names a
            // destination; this is the machine's own transfer application.
            resolveApplicationTarget: () => ({ port: directTransferPort }),
          },
        });
        return Number(new URL(admissionServer.url).port);
      },
    });

    report.identities = {
      addonPath,
      relayUrl: fixture.relayUrl,
      homeEndpointId: homeEndpoint.endpointId,
      machineEndpointId: machineTarget.endpointId,
      admissionUrl: admissionServer?.url ?? null,
      homeApplicationPort: homePort,
      machineApplicationPort: directTransferPort,
      canonicalServerUrl: CANONICAL_HOME_URL,
      grantSigningKeyId: GRANT_SIGNING_KEY_ID,
    };

    let page = await openJourneyPage();
    const token = accountToken(ACCOUNT_ID);

    // 4. This browser is signed in to the ingress-less Home and knows the target
    //    machine's published Iroh endpoint — through the production adoption,
    //    credential, machine-state and runtime-origin owners.
    const seeded = await requireCommand(page, 'seedMachineTransferHome', {
      homeServerIdentityId: HOME_IDENTITY,
      canonicalServerUrl: CANONICAL_HOME_URL,
      homeEndpointId: homeEndpoint.endpointId,
      homeRelayUrls: [fixture.relayUrl],
      token,
      accountId: ACCOUNT_ID,
      machineId: MACHINE_ID,
      machineEndpointId: machineTarget.endpointId,
      machineRelayUrls: [fixture.relayUrl],
    });
    report.seed = seeded;
    if (seeded.publishedHomeCarrier !== true) {
      bail(`the production runtime-origin owner refused the Home carrier: ${JSON.stringify(seeded)}`);
    }

    // 5. The production transfer route selects the relay-only browser machine
    //    carrier. Anything else means Iroh was never selected at all.
    // Server-feature discovery is an ordinary asynchronous Home request, so the
    // first decision a freshly seeded browser makes can legitimately precede it.
    // The route is polled until it settles, exactly as an app screen would wait,
    // rather than being read once and called `standard`.
    let route = null;
    const routeDeadline = Date.now() + OBSERVE_TIMEOUT_MS;
    for (;;) {
      route = await requireCommand(page, 'resolveMachineRoute', {
        machineId: MACHINE_ID,
        serverId: seeded.serverId,
      });
      if (route.kind === 'iroh_peer' || Date.now() >= routeDeadline) break;
      await sleep(500);
    }
    report.machineRoute = route;
    if (route.kind !== 'iroh_peer' || route.carrierKind !== 'browser_stream') {
      bail(`the production route did not select the browser machine carrier: ${JSON.stringify(route)}`);
    }

    // 6. Canonical direct import: prepare over the Home control plane, then
    // encrypted multi-chunk upload and target-owned finalize/receipt.
    const importedPath = 'payload.bin';
    const importedAbsolutePath = join(targetRoot, importedPath);
    const importReply = await requireCommand(page, 'productionDirectImport', {
      machineId: MACHINE_ID,
      serverId: seeded.serverId,
      workingDirectory: targetRoot,
      path: importedPath,
      payloadBase64: uploadPayload.toString('base64'),
    });
    const importedBytes = await readFile(importedAbsolutePath).catch(() => null);
    const acceptorAfterImport = await fixture.machineAcceptorStatus(machineTarget);
    observe(
      'exactRelayToRealMachineAcceptor',
      acceptorAfterImport?.running === true
        && acceptorAfterImport.streamsAccepted >= 1
        && acceptorAfterImport.lastPath?.observedPath === 'relay',
      {
        configuredRelayUrl: fixture.relayUrl,
        acceptor: acceptorAfterImport,
      },
    );

    observe(
      'productionImportPrepareEncryptedChunksFinalizeReceiptAndDestinationBytes',
      importReply.result?.success === true
        && importReply.result?.sizeBytes === uploadPayload.byteLength
        && importReply.result?.sha256 === sha256(uploadPayload)
        && importedBytes !== null
        && Buffer.compare(importedBytes, uploadPayload) === 0,
      {
        result: importReply.result,
        readCalls: importReply.readCalls,
        destinationBytes: importedBytes?.byteLength ?? null,
        destinationSha256: importedBytes ? sha256(importedBytes) : null,
      },
    );

    // 7. The daemon-verified grant binds carrier authority; the prepared
    //    transfer capability above remains the operation and byte authority.
    const prepareImport = home.machineRpcInvocations.find(
      (invocation) => invocation.method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE,
    );
    const preparedUploadId = prepareImport?.result?.uploadId ?? null;
    const grant = home.mintedGrants.find(
      (candidate) => candidate?.payload?.iroh?.operationKind === FINITE_TRANSFER_CARRIER_FLOW,
    ) ?? null;
    const browserInitiatorEndpointId = grant?.payload?.iroh?.initiator?.endpointId ?? null;
    observe(
      'signedGrantBindsInitiatorTargetAndFiniteTransferPurpose',
      grant?.payload?.accountId === ACCOUNT_ID
        && grant?.payload?.routeKind === 'iroh_peer'
        && grant?.payload?.flowKind === 'bounded_transfer'
        && grant?.payload?.machineId === MACHINE_ID
        && grant?.payload?.endpointFingerprint === machineTarget.endpointId
        && grant?.payload?.iroh?.initiator?.kind === 'account_client'
        && typeof browserInitiatorEndpointId === 'string'
        && browserInitiatorEndpointId.length > 0
        && browserInitiatorEndpointId !== machineTarget.endpointId
        && browserInitiatorEndpointId !== homeEndpoint.endpointId
        && seeded.homeCarrierEndpointId === homeEndpoint.endpointId
        && grant?.payload?.iroh?.target?.machineId === MACHINE_ID
        && grant?.payload?.iroh?.target?.endpointId === machineTarget.endpointId
        && grant?.payload?.iroh?.operationKind === FINITE_TRANSFER_CARRIER_FLOW
        && grant?.payload?.scope?.kind === 'bounded_transfer'
        && grant?.payload?.scope?.mode === 'carrier'
        && !('transferId' in grant.payload.scope)
        && !('maxBytes' in grant.payload.scope)
        && grant?.signature?.keyId === GRANT_SIGNING_KEY_ID
        && acceptorAfterImport?.lastPath?.remoteEndpointId === browserInitiatorEndpointId,
      {
        mintedGrantCount: home.mintedGrants.length,
        payload: grant?.payload ?? null,
        signatureKeyId: grant?.signature?.keyId ?? null,
        browserInitiatorEndpointId,
        preparedUploadId,
        acceptorProvedRemoteEndpointId: acceptorAfterImport?.lastPath?.remoteEndpointId ?? null,
        machineEndpointId: machineTarget.endpointId,
      },
    );

    // 8. Canonical direct export: prepare, encrypted chunks, manifest check,
    // destination close/result, and exact read-back bytes.
    const exportReply = await requireCommand(page, 'productionDirectExport', {
      machineId: MACHINE_ID,
      serverId: seeded.serverId,
      workingDirectory: targetRoot,
      path: importedPath,
      maxBytes: uploadPayload.byteLength,
    });
    const exportedBytes = Buffer.from(String(exportReply.destinationBase64 ?? ''), 'base64');
    const exportRelease = home.machineRpcInvocations.findLast(
      (invocation) => invocation.method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE,
    );
    observe(
      'productionExportPrepareEncryptedChunksManifestResultAndDestinationBytes',
      exportReply.result?.ok === true
        && exportReply.result?.sizeBytes === uploadPayload.byteLength
        && exportReply.selectedRoute === 'iroh_peer'
        && exportRelease?.result?.success === true
        && Buffer.compare(exportedBytes, uploadPayload) === 0,
      {
        result: exportReply.result,
        release: exportRelease ?? null,
        writeCalls: exportReply.writeCalls,
        receivedBytes: exportedBytes.byteLength,
        receivedSha256: sha256(exportedBytes),
      },
    );

    // 9. Cancellation is owned at both canonical execution boundaries.
    const cancelledImportPath = 'cancelled.bin';
    const cancelledImport = await requireCommand(page, 'productionDirectImport', {
      machineId: MACHINE_ID,
      serverId: seeded.serverId,
      workingDirectory: targetRoot,
      path: cancelledImportPath,
      payloadBase64: uploadPayload.toString('base64'),
      cancelAfterReadCalls: 1,
    });
    const cancelAbort = home.machineRpcInvocations.findLast(
      (invocation) => invocation.method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
    );
    observe(
      'productionImportCancellationAbortsOwnedSessionWithoutDestination',
      cancelledImport.result?.success === false
        && cancelAbort?.result?.success === true
        && await stat(join(targetRoot, cancelledImportPath)).then(() => false, () => true),
      {
        result: cancelledImport.result,
        readCalls: cancelledImport.readCalls,
        abort: cancelAbort ?? null,
      },
    );

    const cancelledExport = await requireCommand(page, 'productionDirectExport', {
      machineId: MACHINE_ID,
      serverId: seeded.serverId,
      workingDirectory: targetRoot,
      path: importedPath,
      maxBytes: uploadPayload.byteLength,
      cancelAfterWrite: true,
    });
    const cancelledExportRelease = home.machineRpcInvocations.findLast(
      (invocation) => invocation.method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE,
    );
    observe(
      'productionExportCancellationCleansDestination',
      cancelledExport.result?.ok === false
        && cancelledExport.cleanupCalls >= 1
        && cancelledExportRelease?.result?.success === true
        && cancelledExport.destinationBase64 === '',
      {
        result: cancelledExport.result,
        release: cancelledExportRelease ?? null,
        cleanupCalls: cancelledExport.cleanupCalls,
        writeCalls: cancelledExport.writeCalls,
      },
    );

    // 10. Once Iroh is selected, direct-owner failures are terminal and no
    // ordinary relay/user-socket payload transfer may begin.
    const failedImport = await requireCommand(page, 'productionDirectImport', {
      machineId: MACHINE_ID,
      serverId: seeded.serverId,
      workingDirectory: targetRoot,
      path: 'declared-short.bin',
      payloadBase64: uploadPayload.toString('base64'),
      declaredSizeBytes: uploadPayload.byteLength - 1,
    });
    const failedExport = await requireCommand(page, 'productionDirectExport', {
      machineId: MACHINE_ID,
      serverId: seeded.serverId,
      workingDirectory: targetRoot,
      path: importedPath,
      maxBytes: uploadPayload.byteLength,
      failDestinationWrite: true,
    });
    observe(
      'terminalSelectedIrohFailureDoesNotFallbackForImportOrExport',
      failedImport.result?.errorCode === 'machine_carrier_transport_failed'
        && failedExport.result?.errorCode === 'machine_carrier_transport_failed'
        && home.fallbackTransferRequests.length === 0,
      {
        failedImport: failedImport.result,
        failedExport: failedExport.result,
        homeFallbackTransferRequests: home.fallbackTransferRequests,
      },
    );

    // 11. The same Chromium, SharedWorker endpoint, Machine acceptor, grant
    //     owner, and direct-transfer engine now exercise the attachment family.
    //     The application request shape differs from the file case while both
    //     share the one truthful finite-transfer carrier purpose.
    const attachmentMessageLocalId = 'a74-browser-attachment';
    const attachmentFileName = 'relay-attachment.bin';
    const attachmentImport = await requireCommand(page, 'productionDirectImport', {
      machineId: MACHINE_ID,
      serverId: seeded.serverId,
      transferKind: 'attachment',
      workingDirectory: targetRoot,
      messageLocalId: attachmentMessageLocalId,
      fileName: attachmentFileName,
      uploadLocation: 'workspace',
      workspaceRootPath: targetRoot,
      workspaceRelativeDir: '.happier/uploads',
      vcsIgnoreStrategy: 'none',
      vcsIgnoreWritesEnabled: false,
      payloadBase64: uploadPayload.toString('base64'),
    });
    const attachmentPath = attachmentImport.result?.path ?? null;
    const attachmentBytes = typeof attachmentPath === 'string'
      ? await readFile(resolve(targetRoot, attachmentPath)).catch(() => null)
      : null;
    const attachmentPrepare = home.machineRpcInvocations.findLast(
      (invocation) => invocation.method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE,
    );
    const attachmentUploadId = attachmentPrepare?.result?.uploadId ?? null;
    const attachmentGrant = home.mintedGrants.findLast(
      (candidate) => candidate?.payload?.iroh?.operationKind === FINITE_TRANSFER_CARRIER_FLOW,
    ) ?? null;
    observe(
      'attachmentGrantUsesFiniteTransferCarrierPurpose',
      typeof attachmentUploadId === 'string'
        && attachmentGrant?.payload?.scope?.kind === 'bounded_transfer'
        && attachmentGrant?.payload?.scope?.mode === 'carrier'
        && !('transferId' in attachmentGrant.payload.scope)
        && !('maxBytes' in attachmentGrant.payload.scope)
        && attachmentGrant?.payload?.iroh?.operationKind === FINITE_TRANSFER_CARRIER_FLOW
        && attachmentGrant?.payload?.iroh?.target?.machineId === MACHINE_ID
        && attachmentGrant?.payload?.iroh?.target?.endpointId === machineTarget.endpointId,
      {
        preparedUploadId: attachmentUploadId,
        grantPayload: attachmentGrant?.payload ?? null,
      },
    );
    observe(
      'productionAttachmentImportPrepareEncryptedChunksFinalizeReceiptAndDestinationBytes',
      attachmentImport.result?.success === true
        && attachmentImport.result?.sizeBytes === uploadPayload.byteLength
        && attachmentImport.result?.sha256 === sha256(uploadPayload)
        && typeof attachmentPath === 'string'
        && attachmentPath.includes(`/${attachmentMessageLocalId}/`)
        && attachmentImport.readCalls > 1
        && attachmentBytes !== null
        && Buffer.compare(attachmentBytes, uploadPayload) === 0,
      {
        result: attachmentImport.result,
        readCalls: attachmentImport.readCalls,
        destinationBytes: attachmentBytes?.byteLength ?? null,
        destinationSha256: attachmentBytes ? sha256(attachmentBytes) : null,
      },
    );

    const cancelledAttachmentMessageLocalId = 'a74-cancelled-attachment';
    const cancelledAttachment = await requireCommand(page, 'productionDirectImport', {
      machineId: MACHINE_ID,
      serverId: seeded.serverId,
      transferKind: 'attachment',
      workingDirectory: targetRoot,
      messageLocalId: cancelledAttachmentMessageLocalId,
      fileName: 'cancelled-attachment.bin',
      uploadLocation: 'workspace',
      workspaceRootPath: targetRoot,
      workspaceRelativeDir: '.happier/uploads',
      vcsIgnoreStrategy: 'none',
      vcsIgnoreWritesEnabled: false,
      payloadBase64: uploadPayload.toString('base64'),
      cancelAfterReadCalls: 1,
    });
    const failedAttachment = await requireCommand(page, 'productionDirectImport', {
      machineId: MACHINE_ID,
      serverId: seeded.serverId,
      transferKind: 'attachment',
      workingDirectory: targetRoot,
      messageLocalId: 'a74-failed-attachment',
      fileName: 'declared-short-attachment.bin',
      uploadLocation: 'workspace',
      workspaceRootPath: targetRoot,
      workspaceRelativeDir: '.happier/uploads',
      vcsIgnoreStrategy: 'none',
      vcsIgnoreWritesEnabled: false,
      payloadBase64: uploadPayload.toString('base64'),
      declaredSizeBytes: uploadPayload.byteLength - 1,
    });
    const cancelledAttachmentDestination = join(
      targetRoot,
      '.happier',
      'uploads',
      'messages',
      cancelledAttachmentMessageLocalId,
    );
    observe(
      'productionAttachmentCancellationAndTerminalFailureDoNotFallback',
      cancelledAttachment.result?.success === false
        && cancelledAttachment.readCalls > 1
        && await stat(cancelledAttachmentDestination).then(() => false, () => true)
        && failedAttachment.result?.errorCode === 'machine_carrier_transport_failed'
        && home.fallbackTransferRequests.length === 0,
      {
        cancelled: cancelledAttachment.result,
        cancelledReadCalls: cancelledAttachment.readCalls,
        failed: failedAttachment.result,
        homeFallbackTransferRequests: home.fallbackTransferRequests,
      },
    );

    // 12. The canonical admission owner rejects a handshake that does not bind
    //     this machine's role/identity, and it rejects it BEFORE any
    //     application byte: the machine application must see nothing new.
    //
    //     Two distinct mis-bindings are exercised: a grant whose target machine
    //     the acceptor does not own (rejected by admission, after a real dial),
    //     and a target endpoint that is not the machine's at all (rejected by
    //     the transport, before any admission).
    const rpcRequestsBeforeRejections = home.machineRpcInvocations.length;
    const acceptorBeforeRejections = await fixture.machineAcceptorStatus(machineTarget);

    // The Home still mints through the canonical signer; this fixture boundary
    // corrupts only the copy delivered to Chromium. The production browser
    // carrier signs its proof over that exact received grant, then the real
    // daemon admission owner must reject the bad server signature before the
    // prepared-transfer application receives a byte.
    home.corruptNextMintedGrant = true;
    const corruptedGrantAttempt = await command(page, 'acquireMachineCarrier', {
      leaseKey: 'corrupted-grant',
      machineId: MACHINE_ID,
      serverId: seeded.serverId,
      operationId: 'a74-corrupted-grant-operation',
      flow: TRANSFER_FLOW,
      maxBytes: TRANSFER_MAX_BYTES,
    });
    const corruptedGrantRejected = await waitFor(
      async () => {
        const status = await fixture.machineAcceptorStatus(machineTarget);
        return status?.streamsRejected > (acceptorBeforeRejections?.streamsRejected ?? 0);
      },
      OBSERVE_TIMEOUT_MS,
    );
    const acceptorAfterCorruptedGrant = await fixture.machineAcceptorStatus(machineTarget);
    observe(
      'corruptedSignedGrantRejectedBeforeApplicationBytes',
      corruptedGrantAttempt?.ok === false
        && corruptedGrantRejected === true
        && acceptorAfterCorruptedGrant?.streamsAccepted === acceptorBeforeRejections?.streamsAccepted
        && home.machineRpcInvocations.length === rpcRequestsBeforeRejections,
      {
        attempt: corruptedGrantAttempt,
        acceptorBefore: acceptorBeforeRejections,
        acceptorAfter: acceptorAfterCorruptedGrant,
        machineRpcRequestsBefore: rpcRequestsBeforeRejections,
        machineRpcRequestsAfter: home.machineRpcInvocations.length,
      },
    );

    await requireCommand(page, 'publishMachineDescriptor', {
      serverId: seeded.serverId,
      // A machine id this acceptor does not own, published at the acceptor's
      // own endpoint: the dial reaches the real acceptor, and the canonical
      // admission owner is what refuses it.
      machineId: IMPOSTOR_MACHINE_ID,
      machineEndpointId: machineTarget.endpointId,
      machineRelayUrls: [fixture.relayUrl],
    });
    const impostorAttempt = await command(page, 'acquireMachineCarrier', {
      leaseKey: 'impostor',
      machineId: IMPOSTOR_MACHINE_ID,
      serverId: seeded.serverId,
      operationId: 'a74-impostor-operation',
      flow: TRANSFER_FLOW,
      maxBytes: TRANSFER_MAX_BYTES,
    });

    // A well-formed EndpointId that is not the machine's: the Home's. Nothing
    // there speaks `happier/machine/1`, so no admission can even be attempted.
    await requireCommand(page, 'publishMachineDescriptor', {
      serverId: seeded.serverId,
      machineId: 'machine-a74-wrong-endpoint',
      machineEndpointId: homeEndpoint.endpointId,
      machineRelayUrls: [fixture.relayUrl],
    });
    const wrongEndpointAttempt = await command(page, 'acquireMachineCarrier', {
      leaseKey: 'wrong-endpoint',
      machineId: 'machine-a74-wrong-endpoint',
      serverId: seeded.serverId,
      operationId: 'a74-wrong-endpoint-operation',
      flow: TRANSFER_FLOW,
      maxBytes: TRANSFER_MAX_BYTES,
    });
    const acceptorAfterRejections = await waitFor(
      async () => {
        const status = await fixture.machineAcceptorStatus(machineTarget);
        return status?.streamsRejected > (acceptorBeforeRejections?.streamsRejected ?? 0);
      },
      OBSERVE_TIMEOUT_MS,
    );
    const acceptorRejectionStatus = await fixture.machineAcceptorStatus(machineTarget);
    observe(
      'wrongPeerRoleEndpointOrGrantRejectedBeforeApplicationBytes',
      impostorAttempt?.ok === false
        && wrongEndpointAttempt?.ok === false
        && acceptorAfterRejections === true
        && acceptorRejectionStatus?.streamsAccepted === acceptorBeforeRejections?.streamsAccepted
        && home.machineRpcInvocations.length === rpcRequestsBeforeRejections,
      {
        impostorAttempt,
        wrongEndpointAttempt,
        corruptedGrantAttempt,
        acceptorBefore: acceptorBeforeRejections,
        acceptorAfter: acceptorRejectionStatus,
        machineRpcRequestsBefore: rpcRequestsBeforeRejections,
        machineRpcRequestsAfter: home.machineRpcInvocations.length,
      },
    );

    // 13. Relay-only. The acceptor's own path snapshot is the transport's
    //     account of how the browser reached it, and a browser must never
    //     appear as a direct peer.
    observe(
      'browserReportsRelayOnlyNeverDirect',
      acceptorAfterImport?.lastPath?.observedPath === 'relay'
        && acceptorAfterImport?.lastPath?.isRelay === true
        && acceptorRejectionStatus?.lastPath?.observedPath !== 'direct'
        && seeded.homeCarrierObservedPath !== 'direct',
      {
        acceptorPathAfterAcquire: acceptorAfterImport?.lastPath ?? null,
        acceptorPathAfterRejections: acceptorRejectionStatus?.lastPath ?? null,
        homeCarrierObservedPath: seeded.homeCarrierObservedPath,
      },
    );

    // 14. Release closes the machine stream and its connection, and the
    //     released lease can carry nothing more. The cancellation observation
    //     above intentionally closes its transfer stream, so use a fresh
    //     admitted lease here: otherwise this check would merely observe the
    //     earlier abort rather than falsifying a broken release owner.
    await requireCommand(page, 'acquireMachineCarrier', {
      leaseKey: 'release',
      machineId: MACHINE_ID,
      serverId: seeded.serverId,
      operationId: 'a74-release-operation',
      flow: TRANSFER_FLOW,
      maxBytes: TRANSFER_MAX_BYTES,
    });
    acquiredLeaseKeys.push('release');
    const acceptorBeforeRelease = await fixture.machineAcceptorStatus(machineTarget);
    await requireCommand(page, 'releaseMachineCarrier', 'release');
    acquiredLeaseKeys.splice(acquiredLeaseKeys.indexOf('release'), 1);
    const releasedStreamClosed = await waitFor(
      async () => {
        const status = await fixture.machineAcceptorStatus(machineTarget);
        return typeof status?.streamsActive === 'number'
          && typeof acceptorBeforeRelease?.streamsActive === 'number'
          && status.streamsActive < acceptorBeforeRelease.streamsActive;
      },
      OBSERVE_TIMEOUT_MS,
    );
    const acceptorAfterRelease = await fixture.machineAcceptorStatus(machineTarget);
    // The released lease is still reachable from the page on purpose: the
    // refusal must come from the production closed-connection owner.
    const requestAfterRelease = await command(page, 'machineRequest', {
      leaseKey: 'release',
      method: 'GET',
      path: '/machine-transfers/direct/released-lease-must-not-send',
      giveUpAfterMs: MUST_NOT_COMPLETE_MS,
    });
    // The endpoint's own Iroh connection is NOT part of this observation: A7.2
    // and A8 make the shared endpoint outlive its last lease deliberately, so
    // the acceptor's `connectionsActive` is recorded as a fact rather than
    // asserted to reach zero — asserting that would gate on behavior the
    // amendment forbids.
    observe(
      'releaseClosesOwnedMachineStream',
      acceptorBeforeRelease?.streamsAccepted > acceptorAfterImport?.streamsAccepted
        && releasedStreamClosed === true
        && typeof acceptorBeforeRelease?.streamsActive === 'number'
        && acceptorAfterRelease?.streamsActive === acceptorBeforeRelease.streamsActive - 1
        && requestAfterRelease?.ok === true
        && requestAfterRelease?.settled === 'rejected'
        && requestAfterRelease?.status === undefined
        && requestAfterRelease?.bodyBase64 === undefined,
      {
        acceptorBeforeRelease,
        acceptorAfterRelease,
        requestAfterRelease,
      },
    );

    // 13. A SharedWorker owns its EndpointId only for that worker lifetime.
    // Close the browser context that owns the first worker, create a replacement
    // inside the same Chromium process, and drive a later production import so
    // the canonical Home mint proves it used the replacement identity.
    if (typeof replaceJourneyPage !== 'function') {
      bail('the Machine journey did not provide a replacement-worker page owner');
    }
    page = await replaceJourneyPage(page);
    const replacementSeed = await requireCommand(page, 'seedMachineTransferHome', {
      homeServerIdentityId: HOME_IDENTITY,
      canonicalServerUrl: CANONICAL_HOME_URL,
      homeEndpointId: homeEndpoint.endpointId,
      homeRelayUrls: [fixture.relayUrl],
      token,
      accountId: ACCOUNT_ID,
      machineId: MACHINE_ID,
      machineEndpointId: machineTarget.endpointId,
      machineRelayUrls: [fixture.relayUrl],
    });
    const mintedGrantCountBeforeReplacement = home.mintedGrants.length;
    const replacementPayload = Buffer.from('replacement-worker-grant-binding');
    const replacementImport = await requireCommand(page, 'productionDirectImport', {
      machineId: MACHINE_ID,
      serverId: replacementSeed.serverId,
      workingDirectory: targetRoot,
      path: 'replacement-worker.bin',
      payloadBase64: replacementPayload.toString('base64'),
    });
    const replacementPrepare = home.machineRpcInvocations.findLast(
      (invocation) => invocation.method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE,
    );
    const replacementUploadId = replacementPrepare?.result?.uploadId ?? null;
    const replacementGrant = home.mintedGrants.slice(mintedGrantCountBeforeReplacement).findLast(
      (candidate) => candidate?.payload?.iroh?.operationKind === FINITE_TRANSFER_CARRIER_FLOW,
    ) ?? null;
    const replacementEndpointId = replacementGrant?.payload?.iroh?.initiator?.endpointId ?? null;
    const acceptorAfterReplacement = await fixture.machineAcceptorStatus(machineTarget);
    observe(
      'replacementWorkerMintsFreshEndpointAndLaterGrantBindsIt',
      replacementImport.result?.success === true
        && typeof replacementEndpointId === 'string'
        && replacementEndpointId.length > 0
        && replacementEndpointId !== browserInitiatorEndpointId
        && replacementGrant?.payload?.iroh?.initiator?.kind === 'account_client'
        && replacementGrant?.payload?.iroh?.initiator?.endpointId === replacementEndpointId
        && replacementGrant?.payload?.scope?.kind === 'bounded_transfer'
        && replacementGrant?.payload?.scope?.mode === 'carrier'
        && !('transferId' in replacementGrant.payload.scope)
        && !('maxBytes' in replacementGrant.payload.scope)
        && replacementGrant?.payload?.iroh?.target?.machineId === MACHINE_ID
        && replacementGrant?.payload?.iroh?.target?.endpointId === machineTarget.endpointId
        && replacementGrant?.payload?.iroh?.operationKind === FINITE_TRANSFER_CARRIER_FLOW
        && replacementSeed.homeCarrierEndpointId === homeEndpoint.endpointId
        && acceptorAfterReplacement?.lastPath?.remoteEndpointId === replacementEndpointId,
      {
        originalEndpointId: browserInitiatorEndpointId,
        replacementEndpointId,
        replacementUploadId,
        replacementGrantPayload: replacementGrant?.payload ?? null,
        acceptorRemoteEndpointId: acceptorAfterReplacement?.lastPath?.remoteEndpointId ?? null,
      },
    );

    if (pageErrors.length > 0) {
      failures.push(`browser page errors: ${pageErrors.join(' | ')}`);
    }

    for (const leaseKey of [...acquiredLeaseKeys]) {
      await command(page, 'releaseMachineCarrier', leaseKey);
    }
    acquiredLeaseKeys.length = 0;
  } catch (error) {
    // A stage that could not run is a FAIL with everything observed so far
    // still reported, rather than an opaque throw that discards the evidence
    // explaining why it could not run.
    failures.push(`journey aborted: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // Both applications' own records, always reported: on a failed run they are
    // the evidence that says which side refused and why.
    report.homeApplication = {
      requestPaths: home.requests.map((request) => `${request.method} ${request.url}`),
      grantExchanges: home.grantExchanges,
      mintRejections: home.mintRejections,
      socketUpgrades: home.socketUpgrades,
      fallbackTransferRequests: home.fallbackTransferRequests,
      machineRpcInvocations: summarizeMachineRpcInvocationsForEvidence(home.machineRpcInvocations),
    };
    const lifecycleStateBeforeStop = directTransferLifecycle.getState();
    let lifecycleStopError = null;
    try {
      await directTransferLifecycle.stop();
    } catch (error) {
      lifecycleStopError = error instanceof Error ? error.message : String(error);
    }
    const lifecycleStateAfterStop = directTransferLifecycle.getState();
    report.machineApplication = {
      lifecycleStateBeforeStop,
      lifecycleStateAfterStop,
      lifecycleStopError,
      targetRoot,
    };
    observe(
      'terminalCleanupStopsPreparedTransferOwner',
      lifecycleStopError === null
        && lifecycleStateAfterStop.status === 'stopped'
        && lifecycleStateAfterStop.publishedTransferCount === 0,
      {
        lifecycleStateBeforeStop,
        lifecycleStateAfterStop,
        lifecycleStopError,
      },
    );
    await home.io.close().catch(() => undefined);
    home.server.closeAllConnections?.();
    await new Promise((resolve) => home.server.close(resolve));
    if (admissionServer) await admissionServer.stop().catch(() => undefined);
    if (fixture) await fixture.dispose();
    await rm(fixtureRoot, { recursive: true, force: true });
  }

  const { verdict, reasons } = evaluateBrowserMachineTransferJourney({ observations, failures });
  return { report, observations, failures: reasons, verdict };
}
