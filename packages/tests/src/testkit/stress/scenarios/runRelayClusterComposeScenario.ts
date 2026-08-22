import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import {
  createPeerTcpTunnelRelayAuthorizationSigningInputV2,
  PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
  redactBugReportSensitiveText,
  type PeerTcpTunnelRelayAuthorizationPayloadV2,
  type PeerTcpTunnelRelayEnvelope,
} from '@happier-dev/protocol';
import { io, type Socket } from 'socket.io-client';
import nacl from 'tweetnacl';

import type { TestAuth } from '../../auth';
import { fetchJson } from '../../http';
import type { RunDirs } from '../../runDir';
import { fetchAccountId } from '../../socialFriends';
import { sleep, waitFor } from '../../timing';
import type { StressConfig } from '../config/stressScenarioSchema';
import { renderStressGatewayNginxConf } from '../docker/renderStressGatewayNginxConf';
import { finalizeStressScenario } from '../reporting/finalizeStressScenario';
import type {
  StartedStressTarget,
  StressTargetServiceContainer,
} from '../targets/stressTargetTypes';
import {
  activateGatewayConfig,
  readClusterServiceMetricsByReplicaViaNodeFetch,
  readLabeledMetricValue,
  requireFullComposeAdmin,
  resolveServiceUpstreamTargets,
  waitForRedisServiceHealthy,
  writeScenarioGatewayConfig,
} from './fullComposeScenarioSupport';

const stickyHeaderName = 'X-Happier-Relay-Sticky-Key';
const relayPort = 3000;
const socketPath = '/v1/updates/';
const socketTimeoutMs = 30_000;
const externalPartitionTerminalTimeoutMs = 45_000;

export type RelayClusterComposeDisruption =
  | 'rolling-restart'
  | 'external-redis-partition';

export function assertRelayClusterComposeConfig(config: StressConfig): void {
  if (config.targetMode !== 'full-compose') {
    throw new Error('Relay cluster compose scenario requires full-compose target mode');
  }
  if (config.compose.apiReplicas !== 2) {
    throw new Error('Relay cluster compose scenario requires exactly two configured API replicas');
  }
  if (!config.compose.metricsEnabled) {
    throw new Error('Relay cluster compose scenario requires per-replica metrics');
  }
}

type RelayEnvelopeFactory = Readonly<{
  open: (input: Readonly<{
    tunnelId: string;
    grantId: string;
    relaySocketId: string;
    expiresAt?: number;
  }>) => PeerTcpTunnelRelayEnvelope;
  userData: (input: Readonly<{
    tunnelId: string;
    sequence: number;
    payload: string;
  }>) => PeerTcpTunnelRelayEnvelope;
  machineData: (input: Readonly<{
    tunnelId: string;
    userSocketId: string;
    sequence: number;
    payload: string;
  }>) => PeerTcpTunnelRelayEnvelope;
}>;

export function createRelayClusterEnvelopeFactory(input: Readonly<{
  accountId: string;
  machineId: string;
  signingKeyId: string;
  signingPrivateKeySeedBase64Url: string;
  now?: () => number;
}>): RelayEnvelopeFactory {
  const signingSeed = Buffer.from(input.signingPrivateKeySeedBase64Url, 'base64url');
  if (signingSeed.byteLength !== nacl.sign.seedLength) {
    throw new Error(`Expected a ${nacl.sign.seedLength}-byte relay signing seed`);
  }
  const signingKeyPair = nacl.sign.keyPair.fromSeed(signingSeed);
  const now = input.now ?? Date.now;

  return {
    open: ({ tunnelId, grantId, relaySocketId, expiresAt }) => {
      const issuedAt = now();
      const destination = { host: '127.0.0.1', port: relayPort } as const;
      const payload = {
        v: 2,
        grantId,
        accountId: input.accountId,
        targetMachineId: input.machineId,
        flowKind: 'voice_media',
        applicationKind: 'speech_transcription',
        applicationAttemptId: `attempt_${tunnelId}`,
        applicationAuthorityDigest: `sha256:${'ab'.repeat(32)}`,
        routeKind: 'server_relay',
        tunnelId,
        relaySocketId,
        destination,
        capProfileId: 'interactive',
        maxFrameBytes: 64 * 1024,
        maxIdleMs: 30_000,
        maxDurationMs: 300_000,
        maxTotalBytes: 64 * 1024 * 1024,
        iat: issuedAt,
        exp: expiresAt ?? issuedAt + 300_000,
        aud: 'happier-tcp-tunnel-relay-authorization',
      } satisfies PeerTcpTunnelRelayAuthorizationPayloadV2;

      return {
        v: 1,
        scopeUserId: input.accountId,
        sender: { kind: 'user', socketId: relaySocketId },
        recipient: { kind: 'machine', machineId: input.machineId },
        frame: {
          v: 1,
          kind: 'open',
          open: {
            v: 1,
            kind: 'open',
            tunnelId,
            targetMachineId: input.machineId,
            routeKind: 'server_relay',
            destination,
            relayAuthorization: {
              payload,
              signature: {
                keyId: input.signingKeyId,
                alg: 'Ed25519',
                valueBase64Url: Buffer.from(nacl.sign.detached(
                  new TextEncoder().encode(createPeerTcpTunnelRelayAuthorizationSigningInputV2(payload)),
                  signingKeyPair.secretKey,
                )).toString('base64url'),
              },
            },
          },
        },
      };
    },
    userData: ({ tunnelId, sequence, payload }) => ({
      v: 1,
      scopeUserId: input.accountId,
      sender: { kind: 'user' },
      recipient: { kind: 'machine', machineId: input.machineId },
      frame: {
        v: 1,
        kind: 'data',
        tunnelId,
        direction: 'client_to_daemon',
        sequence,
        payloadBase64: Buffer.from(payload).toString('base64'),
      },
    }),
    machineData: ({ tunnelId, userSocketId, sequence, payload }) => ({
      v: 1,
      scopeUserId: input.accountId,
      sender: { kind: 'machine', machineId: input.machineId },
      recipient: { kind: 'user', socketId: userSocketId },
      frame: {
        v: 1,
        kind: 'data',
        tunnelId,
        direction: 'daemon_to_client',
        sequence,
        payloadBase64: Buffer.from(payload).toString('base64'),
      },
    }),
  };
}

type RawRelayClient = Readonly<{
  socket: Socket;
  frames: PeerTcpTunnelRelayEnvelope[];
  errors: unknown[];
  close: () => void;
}>;

export async function connectRawRelayClient(input: Readonly<{
  baseUrl: string;
  token: string;
  stickyKey: string;
  clientType: 'user-scoped' | 'machine-scoped';
  machineId?: string;
}>): Promise<RawRelayClient> {
  const frames: PeerTcpTunnelRelayEnvelope[] = [];
  const errors: unknown[] = [];
  const socket = io(input.baseUrl, {
    path: socketPath,
    transports: ['websocket'],
    timeout: socketTimeoutMs,
    reconnection: false,
    autoConnect: false,
    forceNew: true,
    extraHeaders: {
      [stickyHeaderName]: input.stickyKey,
    },
    auth: {
      token: input.token,
      clientType: input.clientType,
      ...(input.clientType === 'machine-scoped' ? { machineId: input.machineId } : {}),
    },
  });
  socket.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (value: PeerTcpTunnelRelayEnvelope) => {
    frames.push(value);
  });
  socket.on('error', (value: unknown) => {
    errors.push(value);
  });
  socket.connect();
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out connecting ${input.clientType} relay socket`));
      }, socketTimeoutMs);
      socket.once('connect', () => {
        clearTimeout(timeout);
        resolvePromise();
      });
      socket.once('connect_error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  } catch (error) {
    socket.disconnect();
    throw error;
  }
  return {
    socket,
    frames,
    errors,
    close: () => socket.disconnect(),
  };
}

export async function withRelayClientCleanup<TResult>(
  run: (
    retainClient: <TClient extends Readonly<{ close: () => void }>>(client: TClient) => TClient,
  ) => Promise<TResult>,
): Promise<TResult> {
  const retainedClients: Array<Readonly<{ close: () => void }>> = [];
  const retainClient = <TClient extends Readonly<{ close: () => void }>>(client: TClient): TClient => {
    retainedClients.push(client);
    return client;
  };

  try {
    return await run(retainClient);
  } finally {
    for (const client of retainedClients) {
      client.close();
    }
  }
}

function envelopeTunnelId(envelope: PeerTcpTunnelRelayEnvelope): string | undefined {
  if (envelope.v !== 1) return undefined;
  return envelope.frame.kind === 'open' ? envelope.frame.open.tunnelId : envelope.frame.tunnelId;
}

function framesForTunnel(
  frames: readonly PeerTcpTunnelRelayEnvelope[],
  tunnelId: string,
): PeerTcpTunnelRelayEnvelope[] {
  return frames.filter((frame) => envelopeTunnelId(frame) === tunnelId);
}

function dataPayloads(frames: readonly PeerTcpTunnelRelayEnvelope[], tunnelId: string): string[] {
  return framesForTunnel(frames, tunnelId).flatMap((envelope) => {
    if (envelope.v !== 1 || envelope.frame.kind !== 'data') return [];
    return [Buffer.from(envelope.frame.payloadBase64, 'base64').toString('utf8')];
  });
}

function terminalCount(
  frames: readonly PeerTcpTunnelRelayEnvelope[],
  tunnelId: string,
  reasonCode: string,
): number {
  return framesForTunnel(frames, tunnelId).filter((envelope) =>
    envelope.v === 1
    && (envelope.frame.kind === 'abort' || envelope.frame.kind === 'close')
    && envelope.frame.reasonCode === reasonCode,
  ).length;
}

const externalPartitionForwardPayload = 'must-not-cross-external-partition';
const externalPartitionReversePayload = 'must-not-reverse-cross-external-partition';

export function assertExternalPartitionPayloadsRemainAbsent(input: Readonly<{
  milestone: string;
  tunnelId: string;
  userFrames: readonly PeerTcpTunnelRelayEnvelope[];
  machineFrames: readonly PeerTcpTunnelRelayEnvelope[];
}>): void {
  assert.equal(
    dataPayloads(input.machineFrames, input.tunnelId).includes(externalPartitionForwardPayload),
    false,
    `${input.milestone}: partition-time forward payload crossed the relay`,
  );
  assert.equal(
    dataPayloads(input.userFrames, input.tunnelId).includes(externalPartitionReversePayload),
    false,
    `${input.milestone}: partition-time reverse payload crossed the relay`,
  );
}

export function assertExternalPartitionTerminalWindow(input: Readonly<{
  tunnelId: string;
  userFrames: readonly PeerTcpTunnelRelayEnvelope[];
  machineFrames: readonly PeerTcpTunnelRelayEnvelope[];
}>): Readonly<{ terminalEnvelopeCount: 1; reasonCodes: readonly ['relay_cap_exceeded'] }> {
  const terminals = framesForTunnel(
    [...input.userFrames, ...input.machineFrames],
    input.tunnelId,
  ).filter((envelope) =>
    envelope.v === 1
    && (envelope.frame.kind === 'abort' || envelope.frame.kind === 'close'));
  assert.equal(
    terminals.length,
    1,
    'External Redis partition requires exactly one public terminal envelope in the bounded terminal window',
  );
  const reasonCodes = terminals.map((envelope) =>
    envelope.v === 1 && (envelope.frame.kind === 'abort' || envelope.frame.kind === 'close')
      ? envelope.frame.reasonCode
      : 'unexpected');
  assert.deepEqual(reasonCodes, ['relay_cap_exceeded']);
  return { terminalEnvelopeCount: 1, reasonCodes: ['relay_cap_exceeded'] };
}

const orderedDiagnosticFrameLimit = 12;
const orderedDiagnosticErrorLimit = 4;
const orderedDiagnosticAggregateLimit = 12;
const orderedDiagnosticStringLimit = 256;

type OrderedForwardDiagnosticClient = Readonly<{
  socket: Readonly<{
    id?: string;
    connected: boolean;
  }>;
  frames: readonly PeerTcpTunnelRelayEnvelope[];
  errors: readonly unknown[];
}>;

type OrderedForwardDiagnosticInput = Readonly<{
  orderedTunnelId: string;
  duplicateTunnelIds: Readonly<{
    a: string;
    b: string;
  }>;
  clients: Readonly<{
    userA: OrderedForwardDiagnosticClient;
    userB: OrderedForwardDiagnosticClient;
    machineB: OrderedForwardDiagnosticClient;
  }>;
  placement: Readonly<{
    userAContainerId: string;
    userBContainerId: string;
    machineBContainerId: string;
  }>;
}>;

type OrderedForwardWaitInput = OrderedForwardDiagnosticInput & Readonly<{
  timeoutMs?: number;
  intervalMs?: number;
}>;

type FreshTunnelDiagnosticInput = Readonly<{
  milestone: string;
  tunnelId: string;
  user: OrderedForwardDiagnosticClient;
  machine: OrderedForwardDiagnosticClient;
}>;

type FreshTunnelWaitInput = FreshTunnelDiagnosticInput & Readonly<{
  payload: string;
  timeoutMs?: number;
  intervalMs?: number;
}>;

type RelayAdapterReadinessProbe = Readonly<{
  tunnelId: string;
  grantId: string;
  payload: string;
}>;

const relayAdapterReadinessMaxAttempts = 12;
const relayAdapterReadinessProbeTimeoutMs = 1_000;
const relayAdapterReadinessRetryIntervalMs = 250;

function boundedDiagnosticString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const redacted = redactBugReportSensitiveText(value)
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]');
  return redacted.length <= orderedDiagnosticStringLimit
    ? redacted
    : `${redacted.slice(0, orderedDiagnosticStringLimit)}…`;
}

function summarizeRelaySocketError(value: unknown): Readonly<Record<string, string | boolean>> {
  if (value instanceof Error) {
    const redactedMessage = redactBugReportSensitiveText(value.message)
      .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]');
    return {
      name: boundedDiagnosticString(value.name) ?? 'Error',
      message: boundedDiagnosticString(redactedMessage) ?? '',
      truncated: redactedMessage.length > orderedDiagnosticStringLimit,
    };
  }
  if (typeof value === 'string') {
    const redactedMessage = redactBugReportSensitiveText(value)
      .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]');
    return {
      message: boundedDiagnosticString(redactedMessage) ?? '',
      truncated: redactedMessage.length > orderedDiagnosticStringLimit,
    };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: typeof value };
  }
  const record = value as Record<string, unknown>;
  const fields = ['type', 'name', 'error', 'message', 'reasonCode'] as const;
  return Object.fromEntries(fields.flatMap((field) => {
    const bounded = boundedDiagnosticString(record[field]);
    return bounded === undefined ? [] : [[field, bounded]];
  }));
}

function summarizeRelayFrame(envelope: PeerTcpTunnelRelayEnvelope): Readonly<Record<string, unknown>> {
  if (envelope.v === 2) {
    return {
      v: 2,
      kind: 'binary',
      payloadIdentity: {
        decodedBytes: envelope.frame.byteLength,
        sha256: createHash('sha256').update(envelope.frame).digest('hex'),
      },
    };
  }
  const frame = envelope.frame;
  const tunnelId = frame.kind === 'open' ? frame.open.tunnelId : frame.tunnelId;
  if (frame.kind !== 'data') {
    return {
      v: 1,
      tunnelId,
      kind: frame.kind,
      ...('reasonCode' in frame && typeof frame.reasonCode === 'string'
        ? { reasonCode: boundedDiagnosticString(frame.reasonCode) }
        : {}),
    };
  }
  const payload = Buffer.from(frame.payloadBase64, 'base64');
  return {
    v: 1,
    tunnelId,
    kind: frame.kind,
    sequence: frame.sequence,
    payloadIdentity: {
      decodedBytes: payload.byteLength,
      sha256: createHash('sha256').update(payload).digest('hex'),
    },
  };
}

function summarizeOrderedClient(
  client: OrderedForwardDiagnosticClient,
  orderedTunnelId: string,
): Readonly<Record<string, unknown>> {
  const orderedFrames = framesForTunnel(client.frames, orderedTunnelId);
  return {
    socketId: boundedDiagnosticString(client.socket.id) ?? null,
    connected: client.socket.connected,
    frames: orderedFrames.slice(0, orderedDiagnosticFrameLimit).map(summarizeRelayFrame),
    omittedFrameCount: Math.max(0, orderedFrames.length - orderedDiagnosticFrameLimit),
    errors: client.errors.slice(0, orderedDiagnosticErrorLimit).map(summarizeRelaySocketError),
    omittedErrorCount: Math.max(0, client.errors.length - orderedDiagnosticErrorLimit),
  };
}

export function buildOrderedForwardRelayDiagnostics(
  input: OrderedForwardDiagnosticInput,
): Readonly<Record<string, unknown>> & Readonly<{
  ordered: Readonly<Record<string, unknown>> & Readonly<{ classification: string }>;
}> {
  const orderedMachineFrames = framesForTunnel(input.clients.machineB.frames, input.orderedTunnelId);
  const orderedUserFrames = [
    ...framesForTunnel(input.clients.userA.frames, input.orderedTunnelId),
    ...framesForTunnel(input.clients.userB.frames, input.orderedTunnelId),
  ];
  let openCount = 0;
  let dataCount = 0;
  const dataSequences: number[] = [];
  const seenDataSequences = new Set<number>();
  const seenDuplicateSequences = new Set<number>();
  const duplicateSequences: number[] = [];
  let duplicateSequenceCount = 0;
  for (const envelope of orderedMachineFrames) {
    if (envelope.v !== 1) continue;
    if (envelope.frame.kind === 'open') {
      openCount += 1;
      continue;
    }
    if (envelope.frame.kind !== 'data') continue;
    dataCount += 1;
    if (dataSequences.length < orderedDiagnosticAggregateLimit) {
      dataSequences.push(envelope.frame.sequence);
    }
    if (seenDataSequences.has(envelope.frame.sequence)
      && !seenDuplicateSequences.has(envelope.frame.sequence)) {
      duplicateSequenceCount += 1;
      seenDuplicateSequences.add(envelope.frame.sequence);
      if (duplicateSequences.length < orderedDiagnosticAggregateLimit) {
        duplicateSequences.push(envelope.frame.sequence);
      }
    }
    seenDataSequences.add(envelope.frame.sequence);
  }
  const terminalReasons: string[] = [];
  let terminalReasonCount = 0;
  for (const envelope of [...orderedMachineFrames, ...orderedUserFrames]) {
    if (envelope.v !== 1
      || (envelope.frame.kind !== 'abort' && envelope.frame.kind !== 'close')) {
      continue;
    }
    terminalReasonCount += 1;
    if (terminalReasons.length < orderedDiagnosticAggregateLimit) {
      terminalReasons.push(boundedDiagnosticString(envelope.frame.reasonCode) ?? '');
    }
  }
  const socketErrorCount = Object.values(input.clients).reduce(
    (count, client) => count + client.errors.length,
    0,
  );
  const classification =
    terminalReasonCount > 0 ? 'terminal'
      : socketErrorCount > 0 ? 'socket_error'
        : openCount === 0 ? 'open_absent'
          : dataCount === 0 ? 'open_only'
            : dataCount === 1 ? 'one_data'
              : dataCount === 2 && duplicateSequenceCount === 0 ? 'complete'
                : 'two_plus_or_duplicate_data';
  const duplicateIds = [input.duplicateTunnelIds.a, input.duplicateTunnelIds.b];
  const winnerTunnelIds = duplicateIds.filter((tunnelId) =>
    framesForTunnel(input.clients.machineB.frames, tunnelId).some((envelope) =>
      envelope.v === 1 && envelope.frame.kind === 'open',
    ),
  );
  const rejectedTunnelIds = duplicateIds.filter((tunnelId) =>
    [...input.clients.userA.frames, ...input.clients.userB.frames].some((envelope) =>
      envelopeTunnelId(envelope) === tunnelId
      && envelope.v === 1
      && (envelope.frame.kind === 'abort' || envelope.frame.kind === 'close')
      && envelope.frame.reasonCode === 'relay_authorization_invalid',
    ),
  );

  return {
    milestone: 'ordered_forward_relay_data',
    orderedTunnelId: input.orderedTunnelId,
    ordered: {
      classification,
      openCount,
      dataCount,
      dataSequences,
      omittedDataSequenceCount: Math.max(0, dataCount - dataSequences.length),
      duplicateSequences,
      omittedDuplicateSequenceCount: Math.max(0, duplicateSequenceCount - duplicateSequences.length),
      terminalReasons,
      omittedTerminalReasonCount: Math.max(0, terminalReasonCount - terminalReasons.length),
      socketErrorCount,
    },
    duplicateGrant: {
      tunnelIds: input.duplicateTunnelIds,
      winnerTunnelIds,
      rejectedTunnelIds,
    },
    placement: input.placement,
    clients: {
      userA: summarizeOrderedClient(input.clients.userA, input.orderedTunnelId),
      userB: summarizeOrderedClient(input.clients.userB, input.orderedTunnelId),
      machineB: summarizeOrderedClient(input.clients.machineB, input.orderedTunnelId),
    },
  };
}

function freshTunnelTerminalReasons(input: FreshTunnelDiagnosticInput): string[] {
  return [...input.user.frames, ...input.machine.frames].flatMap((envelope) => {
    if (envelopeTunnelId(envelope) !== input.tunnelId
      || envelope.v !== 1
      || (envelope.frame.kind !== 'abort' && envelope.frame.kind !== 'close')) {
      return [];
    }
    return [envelope.frame.reasonCode];
  });
}

function classifyFreshTunnel(input: FreshTunnelWaitInput):
  | 'ready'
  | 'route_unavailable'
  | 'terminal'
  | 'pending' {
  const terminalReasons = freshTunnelTerminalReasons(input);
  if (terminalReasons.length > 0) {
    return terminalReasons.every((reasonCode) => reasonCode === 'route_unavailable')
      ? 'route_unavailable'
      : 'terminal';
  }
  return dataPayloads(input.machine.frames, input.tunnelId).includes(input.payload)
    ? 'ready'
    : 'pending';
}

export function buildFreshTunnelRelayDiagnostics(
  input: FreshTunnelDiagnosticInput,
): Readonly<Record<string, unknown>> {
  const terminalReasons = freshTunnelTerminalReasons(input);
  return {
    milestone: boundedDiagnosticString(input.milestone) ?? 'fresh_tunnel',
    tunnelId: boundedDiagnosticString(input.tunnelId) ?? null,
    terminalReasons: terminalReasons
      .slice(0, orderedDiagnosticAggregateLimit)
      .map((reasonCode) => boundedDiagnosticString(reasonCode) ?? ''),
    omittedTerminalReasonCount: Math.max(0, terminalReasons.length - orderedDiagnosticAggregateLimit),
    user: summarizeOrderedClient(input.user, input.tunnelId),
    machine: summarizeOrderedClient(input.machine, input.tunnelId),
  };
}

export async function waitForFreshTunnelRelayData(input: FreshTunnelWaitInput): Promise<void> {
  try {
    await waitFor(() => {
      const classification = classifyFreshTunnel(input);
      if (classification === 'route_unavailable' || classification === 'terminal') {
        throw new Error(`Fresh relay tunnel terminated (${freshTunnelTerminalReasons(input).join(',')})`);
      }
      return classification === 'ready';
    }, {
      timeoutMs: input.timeoutMs ?? socketTimeoutMs,
      intervalMs: input.intervalMs,
      failFast: true,
      context: input.milestone,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}; diagnostics=${JSON.stringify(buildFreshTunnelRelayDiagnostics(input))}`, {
      cause: error,
    });
  }
}

export async function waitForRelayAdapterReadiness(input: Readonly<{
  milestone: string;
  user: OrderedForwardDiagnosticClient;
  machine: OrderedForwardDiagnosticClient;
  sendProbe: (probe: RelayAdapterReadinessProbe) => void;
  maxAttempts?: number;
  probeTimeoutMs?: number;
  intervalMs?: number;
  retryIntervalMs?: number;
}>): Promise<Readonly<{ attempts: number }>> {
  const maxAttempts = input.maxAttempts ?? relayAdapterReadinessMaxAttempts;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('Relay adapter readiness requires at least one bounded probe attempt');
  }
  let lastDiagnostics: Readonly<Record<string, unknown>> | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const identity = randomUUID();
    const probe: RelayAdapterReadinessProbe = {
      tunnelId: `adapter-readiness-${identity}`,
      grantId: `adapter-readiness-grant-${randomUUID()}`,
      payload: `adapter-readiness-payload-${identity}`,
    };
    input.sendProbe(probe);
    const waitInput: FreshTunnelWaitInput = {
      milestone: input.milestone,
      tunnelId: probe.tunnelId,
      payload: probe.payload,
      user: input.user,
      machine: input.machine,
      timeoutMs: input.probeTimeoutMs ?? relayAdapterReadinessProbeTimeoutMs,
      intervalMs: input.intervalMs,
    };

    try {
      await waitFor(() => {
        const classification = classifyFreshTunnel(waitInput);
        return classification !== 'pending';
      }, {
        timeoutMs: waitInput.timeoutMs,
        intervalMs: waitInput.intervalMs,
        context: `${input.milestone} probe ${attempt}`,
      });
    } catch {
      // A no-response probe is transient readiness evidence until the bounded series is exhausted.
    }

    lastDiagnostics = buildFreshTunnelRelayDiagnostics(waitInput);
    const classification = classifyFreshTunnel(waitInput);
    if (classification === 'ready') {
      return { attempts: attempt };
    }
    // The relay also emits a generic socket error for route_unavailable. The
    // tunnel-scoped reason is the authoritative retry decision for that case.
    // DATA sent immediately after a transiently unavailable OPEN can add the
    // dependent tunnel_not_open terminal; that pair remains retryable only
    // when route_unavailable is the originating reason.
    const terminalReasons = freshTunnelTerminalReasons(waitInput);
    const isTransientRouteUnavailability = terminalReasons.includes('route_unavailable')
      && terminalReasons.every((reasonCode) =>
        reasonCode === 'route_unavailable' || reasonCode === 'tunnel_not_open');
    if (classification === 'terminal' && !isTransientRouteUnavailability) {
      throw new Error(
        `Relay adapter readiness failed on probe ${attempt}; diagnostics=${JSON.stringify(lastDiagnostics)}`,
      );
    }
    if (attempt < maxAttempts) {
      await sleep(input.retryIntervalMs ?? relayAdapterReadinessRetryIntervalMs);
    }
  }

  throw new Error(
    `Relay adapter readiness remained unavailable after ${maxAttempts} unique probes; diagnostics=${JSON.stringify(lastDiagnostics)}`,
  );
}

export async function waitForOrderedForwardRelayData(input: OrderedForwardWaitInput): Promise<void> {
  try {
    await waitFor(() =>
      dataPayloads(input.clients.machineB.frames, input.orderedTunnelId).length === 2,
    {
      timeoutMs: input.timeoutMs ?? socketTimeoutMs,
      intervalMs: input.intervalMs,
      context: 'ordered forward relay DATA',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}; diagnostics=${JSON.stringify(buildOrderedForwardRelayDiagnostics(input))}`);
  }
}

async function readReplicaConnectionCounts(
  target: StartedStressTarget,
  clientType: 'user-scoped' | 'machine-scoped',
): Promise<Map<string, number>> {
  const replicas = await readClusterServiceMetricsByReplicaViaNodeFetch(target, 'api');
  return new Map(replicas.map((replica) => [
    replica.containerId,
    readLabeledMetricValue({
      metricsText: replica.metricsText,
      metricName: 'websocket_connections_active',
      labels: { role: 'api', type: clientType },
    }),
  ]));
}

async function resolveConnectedReplica(input: Readonly<{
  target: StartedStressTarget;
  baseline: ReadonlyMap<string, number>;
  clientType: 'user-scoped' | 'machine-scoped';
}>): Promise<string | null> {
  const current = await readReplicaConnectionCounts(input.target, input.clientType);
  const increased = [...current.entries()].filter(([containerId, value]) =>
    value === (input.baseline.get(containerId) ?? 0) + 1,
  );
  return increased.length === 1 ? increased[0]?.[0] ?? null : null;
}

async function discoverDistinctStickyKeys(input: Readonly<{
  target: StartedStressTarget;
  token: string;
}>): Promise<Readonly<{
  first: { stickyKey: string; containerId: string };
  second: { stickyKey: string; containerId: string };
}>> {
  const baseline = await readReplicaConnectionCounts(input.target, 'user-scoped');
  const discovered = new Map<string, string>();
  for (let index = 0; index < 64 && discovered.size < 2; index += 1) {
    const stickyKey = `relay-cluster-placement-${index}`;
    const probe = await connectRawRelayClient({
      baseUrl: input.target.baseUrl,
      token: input.token,
      stickyKey,
      clientType: 'user-scoped',
    });
    try {
      let containerId: string | null = null;
      await waitFor(async () => {
        containerId = await resolveConnectedReplica({
          target: input.target,
          baseline,
          clientType: 'user-scoped',
        });
        return containerId !== null;
      }, {
        timeoutMs: socketTimeoutMs,
        intervalMs: 250,
        context: `sticky placement for ${stickyKey}`,
      });
      discovered.set(containerId!, stickyKey);
    } finally {
      probe.close();
      await waitFor(async () => {
        const current = await readReplicaConnectionCounts(input.target, 'user-scoped');
        return [...baseline.entries()].every(([id, value]) => current.get(id) === value);
      }, {
        timeoutMs: socketTimeoutMs,
        intervalMs: 250,
        context: `sticky probe cleanup for ${stickyKey}`,
      });
    }
  }
  const entries = [...discovered.entries()];
  if (entries.length !== 2 || !entries[0] || !entries[1]) {
    throw new Error(`Could not discover sticky keys for two distinct API replicas (found=${entries.length})`);
  }
  return {
    first: { containerId: entries[0][0], stickyKey: entries[0][1] },
    second: { containerId: entries[1][0], stickyKey: entries[1][1] },
  };
}

async function provisionMachine(baseUrl: string, token: string, machineId: string): Promise<void> {
  const response = await fetchJson(`${baseUrl}/v1/machines`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: machineId,
      metadata: 'relay-cluster-compose-test-machine',
    }),
    timeoutMs: socketTimeoutMs,
  });
  if (response.status !== 200) {
    throw new Error(`Failed to provision relay cluster machine (status=${response.status})`);
  }
}

async function waitForExactContainerHealthy(
  target: StartedStressTarget,
  containerId: string,
): Promise<StressTargetServiceContainer> {
  let matched: StressTargetServiceContainer | undefined;
  await waitFor(async () => {
    matched = (await target.admin?.listServiceContainers('api'))?.find((entry) =>
      entry.id === containerId && entry.state === 'running' && entry.health === 'healthy',
    );
    return matched !== undefined;
  }, {
    timeoutMs: 60_000,
    intervalMs: 500,
    context: `API container ${containerId} healthy`,
  });
  return matched!;
}

async function assertClientPlacement(input: Readonly<{
  target: StartedStressTarget;
  clientType: 'user-scoped' | 'machine-scoped';
  expectedContainerId: string;
  baseline: ReadonlyMap<string, number>;
}>): Promise<void> {
  await waitFor(async () =>
    await resolveConnectedReplica({
      target: input.target,
      baseline: input.baseline,
      clientType: input.clientType,
    }) === input.expectedContainerId,
  {
    timeoutMs: socketTimeoutMs,
    intervalMs: 250,
    context: `${input.clientType} placed on ${input.expectedContainerId}`,
  });
}

function emit(socket: Socket, envelope: PeerTcpTunnelRelayEnvelope): void {
  socket.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, envelope);
}

async function waitForTunnelOpen(frames: readonly PeerTcpTunnelRelayEnvelope[], tunnelId: string): Promise<void> {
  await waitFor(() => framesForTunnel(frames, tunnelId).some((envelope) =>
    envelope.v === 1 && envelope.frame.kind === 'open',
  ), {
    timeoutMs: socketTimeoutMs,
    context: `relay OPEN ${tunnelId}`,
  });
}

async function executeRelayClusterComposeScenario(params: Readonly<{
  run: RunDirs;
  target: StartedStressTarget;
  config: StressConfig;
  auth: TestAuth;
}>): Promise<void> {
  void params.run;
  assertRelayClusterComposeConfig(params.config);
  const admin = requireFullComposeAdmin(params.target);
  if (!admin || params.target.topology.resolvedApiReplicas !== 2) {
    throw new Error('Relay cluster compose scenario requires exactly two full-compose API replicas');
  }
  const startContainer = admin.startContainer;
  if (!startContainer) {
    throw new Error('Relay cluster compose scenario requires exact-container restart support');
  }
  const peerMediation = params.target.testRuntime?.peerMediation;
  if (!peerMediation || !peerMediation.allowedPorts.includes(relayPort)) {
    throw new Error(`Relay cluster compose topology must expose test-only signing metadata and port ${relayPort}`);
  }

  const upstreamTargets = await resolveServiceUpstreamTargets(params.target, 'api', 53288);
  const gatewayConfig = await writeScenarioGatewayConfig({
    target: params.target,
    fileName: 'nginx.relay-cluster.conf',
    contents: renderStressGatewayNginxConf({
      upstreamApiTargets: upstreamTargets,
      affinity: 'header-hash',
      stickyHeaderName,
      workerConnections: params.config.compose.gatewayWorkerConnections,
      workerRlimitNoFile: params.config.compose.gatewayWorkerRlimitNoFile,
    }),
  });
  await activateGatewayConfig(params.target, gatewayConfig);

  const accountId = await fetchAccountId(params.target.baseUrl, params.auth.token);
  const machineId = `relay-cluster-machine-${randomUUID()}`;
  await provisionMachine(params.target.baseUrl, params.auth.token, machineId);
  const placement = await discoverDistinctStickyKeys({
    target: params.target,
    token: params.auth.token,
  });
  const envelopeFactory = createRelayClusterEnvelopeFactory({
    accountId,
    machineId,
    signingKeyId: peerMediation.routeGrantSigning.keyId,
    signingPrivateKeySeedBase64Url: peerMediation.routeGrantSigning.privateKeySeedBase64Url,
  });

  await withRelayClientCleanup(async (retainClient) => {
    const connect = async (
      clientType: 'user-scoped' | 'machine-scoped',
      stickyKey: string,
    ): Promise<RawRelayClient> => {
      return retainClient(await connectRawRelayClient({
        baseUrl: params.target.baseUrl,
        token: params.auth.token,
        stickyKey,
        clientType,
        machineId,
      }));
    };
    const reconnectMachineAfterCrash = async (stickyKey: string): Promise<RawRelayClient> => {
      const deadline = Date.now() + socketTimeoutMs;
      let lastConflict: unknown;
      while (Date.now() < deadline) {
        try {
          return await connect('machine-scoped', stickyKey);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'machine-owner-conflict') {
            throw error;
          }
          lastConflict = error;
          await sleep(500);
        }
      }
      throw lastConflict ?? new Error('Timed out waiting for crashed machine ownership lease recovery');
    };

    const initialUserCounts = await readReplicaConnectionCounts(params.target, 'user-scoped');
    const initialMachineCounts = await readReplicaConnectionCounts(params.target, 'machine-scoped');
    let userA = await connect('user-scoped', placement.first.stickyKey);
    let userB = await connect('user-scoped', placement.second.stickyKey);
    let machineB = await connect('machine-scoped', placement.second.stickyKey);

    const userBaseline = new Map(initialUserCounts);
    userBaseline.set(
      placement.second.containerId,
      (userBaseline.get(placement.second.containerId) ?? 0) + 1,
    );
    await assertClientPlacement({
      target: params.target,
      clientType: 'user-scoped',
      expectedContainerId: placement.first.containerId,
      baseline: userBaseline,
    });
    await assertClientPlacement({
      target: params.target,
      clientType: 'machine-scoped',
      expectedContainerId: placement.second.containerId,
      baseline: initialMachineCounts,
    });
    assert.ok(userA.socket.id);
    assert.ok(userB.socket.id);
    assert.ok(machineB.socket.id);

    const duplicateGrantId = `duplicate-${randomUUID()}`;
    const duplicateA = `duplicate-a-${randomUUID()}`;
    const duplicateB = `duplicate-b-${randomUUID()}`;
    emit(userA.socket, envelopeFactory.open({
      tunnelId: duplicateA,
      grantId: duplicateGrantId,
      relaySocketId: userA.socket.id,
    }));
    emit(userB.socket, envelopeFactory.open({
      tunnelId: duplicateB,
      grantId: duplicateGrantId,
      relaySocketId: userB.socket.id,
    }));
    await waitFor(() => {
      const opens = [duplicateA, duplicateB].filter((id) =>
        framesForTunnel(machineB.frames, id).some((frame) => frame.v === 1 && frame.frame.kind === 'open'),
      ).length;
      const rejected = [duplicateA, duplicateB].filter((id) =>
        terminalCount([...userA.frames, ...userB.frames], id, 'relay_authorization_invalid') === 1,
      ).length;
      return opens === 1 && rejected === 1;
    }, {
      timeoutMs: socketTimeoutMs,
      context: 'one global relay grant winner',
    });

    const orderedTunnelId = `ordered-${randomUUID()}`;
    emit(userA.socket, envelopeFactory.open({
      tunnelId: orderedTunnelId,
      grantId: `grant-${randomUUID()}`,
      relaySocketId: userA.socket.id,
    }));
    emit(userA.socket, envelopeFactory.userData({
      tunnelId: orderedTunnelId,
      sequence: 0,
      payload: 'forward-0',
    }));
    emit(userA.socket, envelopeFactory.userData({
      tunnelId: orderedTunnelId,
      sequence: 1,
      payload: 'forward-1',
    }));
    await waitForOrderedForwardRelayData({
      orderedTunnelId,
      duplicateTunnelIds: {
        a: duplicateA,
        b: duplicateB,
      },
      clients: {
        userA,
        userB,
        machineB,
      },
      placement: {
        userAContainerId: placement.first.containerId,
        userBContainerId: placement.second.containerId,
        machineBContainerId: placement.second.containerId,
      },
    });
    assert.deepEqual(dataPayloads(machineB.frames, orderedTunnelId), ['forward-0', 'forward-1']);
    const orderedKinds = framesForTunnel(machineB.frames, orderedTunnelId).flatMap((envelope) =>
      envelope.v === 1 ? [envelope.frame.kind] : [],
    );
    assert.deepEqual(orderedKinds.slice(0, 3), ['open', 'data', 'data']);

    emit(machineB.socket, envelopeFactory.machineData({
      tunnelId: orderedTunnelId,
      userSocketId: userA.socket.id,
      sequence: 0,
      payload: 'reverse-0',
    }));
    emit(machineB.socket, envelopeFactory.machineData({
      tunnelId: orderedTunnelId,
      userSocketId: userA.socket.id,
      sequence: 1,
      payload: 'reverse-1',
    }));
    await waitFor(() => dataPayloads(userA.frames, orderedTunnelId).length === 2, {
      timeoutMs: socketTimeoutMs,
      context: 'ordered reverse relay DATA',
    });
    assert.deepEqual(dataPayloads(userA.frames, orderedTunnelId), ['reverse-0', 'reverse-1']);

    const preFrameDisconnectTunnelId = `pre-frame-disconnect-${randomUUID()}`;
    emit(userA.socket, envelopeFactory.open({
      tunnelId: preFrameDisconnectTunnelId,
      grantId: `grant-${randomUUID()}`,
      relaySocketId: userA.socket.id,
    }));
    await waitForTunnelOpen(machineB.frames, preFrameDisconnectTunnelId);
    machineB.close();
    await waitFor(() =>
      terminalCount(userA.frames, preFrameDisconnectTunnelId, 'relay_socket_disconnected') === 1,
    {
      timeoutMs: socketTimeoutMs,
      context: 'recipient disconnect terminal',
    });
    await sleep(250);
    assert.equal(
      terminalCount(userA.frames, preFrameDisconnectTunnelId, 'relay_socket_disconnected'),
      1,
    );
    machineB = await connect('machine-scoped', placement.second.stickyKey);

    const expiredTunnelId = `expired-after-redis-${randomUUID()}`;
    const expiresAt = Date.now() + 500;
    const expiredEnvelope = envelopeFactory.open({
      tunnelId: expiredTunnelId,
      grantId: `grant-${randomUUID()}`,
      relaySocketId: userA.socket.id,
      expiresAt,
    });
    await admin.stopService('redis');
    await sleep(1_000);
    await admin.startService('redis');
    await waitForRedisServiceHealthy(params.target, 45_000);
    await waitFor(() => userA.socket.connected && machineB.socket.connected, {
      timeoutMs: 45_000,
      intervalMs: 500,
      context: 'relay sockets after Redis recovery',
    });
    emit(userA.socket, expiredEnvelope);
    await waitFor(() => terminalCount(userA.frames, expiredTunnelId, 'relay_authorization_invalid') === 1, {
      timeoutMs: socketTimeoutMs,
      context: 'expired grant rejected after Redis recovery',
    });
    const postRedisTunnelId = `post-redis-${randomUUID()}`;
    emit(userA.socket, envelopeFactory.open({
      tunnelId: postRedisTunnelId,
      grantId: `grant-${randomUUID()}`,
      relaySocketId: userA.socket.id,
    }));
    await waitForTunnelOpen(machineB.frames, postRedisTunnelId);

    const beforeBKillTunnelId = `before-b-kill-${randomUUID()}`;
    emit(userA.socket, envelopeFactory.open({
      tunnelId: beforeBKillTunnelId,
      grantId: `grant-${randomUUID()}`,
      relaySocketId: userA.socket.id,
    }));
    await waitForTunnelOpen(machineB.frames, beforeBKillTunnelId);
    await admin.killContainer(placement.second.containerId);
    await waitFor(() => !machineB.socket.connected, {
      timeoutMs: socketTimeoutMs,
      context: 'replica B crash disconnect',
    });
    await startContainer(placement.second.containerId);
    await waitForExactContainerHealthy(params.target, placement.second.containerId);
    userB = await connect('user-scoped', placement.second.stickyKey);
    machineB = await reconnectMachineAfterCrash(placement.second.stickyKey);
    emit(userA.socket, envelopeFactory.userData({
      tunnelId: beforeBKillTunnelId,
      sequence: 0,
      payload: 'must-not-fail-over-after-b-kill',
    }));
    await sleep(500);
    assert.deepEqual(dataPayloads(machineB.frames, beforeBKillTunnelId), []);

    const afterBRestartTunnelId = `after-b-restart-${randomUUID()}`;
    emit(userA.socket, envelopeFactory.open({
      tunnelId: afterBRestartTunnelId,
      grantId: `grant-${randomUUID()}`,
      relaySocketId: userA.socket.id,
    }));
    emit(userA.socket, envelopeFactory.userData({
      tunnelId: afterBRestartTunnelId,
      sequence: 0,
      payload: 'fresh-after-b-restart',
    }));
    await waitFor(() =>
      dataPayloads(machineB.frames, afterBRestartTunnelId).includes('fresh-after-b-restart'),
    {
      timeoutMs: socketTimeoutMs,
      context: 'fresh tunnel after B restart',
    });

    const beforeAKillTunnelId = `before-a-kill-${randomUUID()}`;
    const oldUserASocketId = userA.socket.id;
    assert.ok(oldUserASocketId);
    emit(userA.socket, envelopeFactory.open({
      tunnelId: beforeAKillTunnelId,
      grantId: `grant-${randomUUID()}`,
      relaySocketId: oldUserASocketId,
    }));
    await waitForTunnelOpen(machineB.frames, beforeAKillTunnelId);
    await admin.killContainer(placement.first.containerId);
    await waitFor(() => !userA.socket.connected, {
      timeoutMs: socketTimeoutMs,
      context: 'replica A crash disconnect',
    });

    const survivingReplicaTunnelId = `surviving-b-${randomUUID()}`;
    emit(userB.socket, envelopeFactory.open({
      tunnelId: survivingReplicaTunnelId,
      grantId: `grant-${randomUUID()}`,
      relaySocketId: userB.socket.id!,
    }));
    emit(userB.socket, envelopeFactory.userData({
      tunnelId: survivingReplicaTunnelId,
      sequence: 0,
      payload: 'fresh-while-a-down',
    }));
    try {
      await waitFor(() =>
        dataPayloads(machineB.frames, survivingReplicaTunnelId).includes('fresh-while-a-down'),
      {
        timeoutMs: socketTimeoutMs,
        context: 'fresh tunnel while replica A is down',
      });
    } catch (error) {
      const diagnostics = {
        userConnected: userB.socket.connected,
        machineConnected: machineB.socket.connected,
        userFrames: framesForTunnel(userB.frames, survivingReplicaTunnelId),
        machineFrames: framesForTunnel(machineB.frames, survivingReplicaTunnelId),
        userErrors: userB.errors,
        machineErrors: machineB.errors,
      };
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; diagnostics=${JSON.stringify(diagnostics)}`,
        { cause: error },
      );
    }

    await startContainer(placement.first.containerId);
    await waitForExactContainerHealthy(params.target, placement.first.containerId);
    userA = await connect('user-scoped', placement.first.stickyKey);
    assert.ok(userA.socket.id);
    emit(machineB.socket, envelopeFactory.machineData({
      tunnelId: beforeAKillTunnelId,
      userSocketId: oldUserASocketId,
      sequence: 0,
      payload: 'must-not-fail-over-after-a-kill',
    }));
    await sleep(500);
    assert.deepEqual(dataPayloads(userA.frames, beforeAKillTunnelId), []);

    await waitForRelayAdapterReadiness({
      milestone: 'API A distributed relay adapter readiness after restart',
      user: userA,
      machine: machineB,
      sendProbe: ({ tunnelId, grantId, payload }) => {
        emit(userA.socket, envelopeFactory.open({
          tunnelId,
          grantId,
          relaySocketId: userA.socket.id!,
        }));
        emit(userA.socket, envelopeFactory.userData({
          tunnelId,
          sequence: 0,
          payload,
        }));
      },
    });

    const afterARestartTunnelId = `after-a-restart-${randomUUID()}`;
    const afterARestartPayload = 'fresh-after-a-restart';
    emit(userA.socket, envelopeFactory.open({
      tunnelId: afterARestartTunnelId,
      grantId: `grant-${randomUUID()}`,
      relaySocketId: userA.socket.id,
    }));
    emit(userA.socket, envelopeFactory.userData({
      tunnelId: afterARestartTunnelId,
      sequence: 0,
      payload: afterARestartPayload,
    }));
    await waitForFreshTunnelRelayData({
      milestone: 'fresh_after_api_restart',
      tunnelId: afterARestartTunnelId,
      payload: afterARestartPayload,
      user: userA,
      machine: machineB,
    });
  });
}

function requireExternalRedisPartitionAdmin(target: StartedStressTarget): Readonly<{
  disconnectContainerFromNetwork: NonNullable<
    NonNullable<StartedStressTarget['admin']>['disconnectContainerFromNetwork']
  >;
  connectContainerToNetwork: NonNullable<
    NonNullable<StartedStressTarget['admin']>['connectContainerToNetwork']
  >;
}> {
  const admin = requireFullComposeAdmin(target);
  if (!admin?.disconnectContainerFromNetwork || !admin.connectContainerToNetwork) {
    throw new Error(
      'Relay cluster compose scenario requires canonical external Redis network partition support',
    );
  }
  return {
    disconnectContainerFromNetwork: admin.disconnectContainerFromNetwork,
    connectContainerToNetwork: admin.connectContainerToNetwork,
  };
}

function withForgedRelaySignature(envelope: PeerTcpTunnelRelayEnvelope): PeerTcpTunnelRelayEnvelope {
  if (envelope.v !== 1 || envelope.frame.kind !== 'open') {
    throw new Error('Expected a V1 relay OPEN envelope to forge');
  }
  const authorization = envelope.frame.open.relayAuthorization;
  if (!authorization) {
    throw new Error('Expected signed relay authorization to forge');
  }
  return {
    ...envelope,
    frame: {
      ...envelope.frame,
      open: {
        ...envelope.frame.open,
        relayAuthorization: {
          ...authorization,
          signature: {
            ...authorization.signature,
            valueBase64Url: Buffer.from(new Uint8Array(nacl.sign.signatureLength).fill(7))
              .toString('base64url'),
          },
        },
      },
    },
  };
}

async function executeRelayClusterExternalPartitionScenario(params: Readonly<{
  run: RunDirs;
  target: StartedStressTarget;
  config: StressConfig;
  auth: TestAuth;
}>): Promise<void> {
  void params.run;
  assertRelayClusterComposeConfig(params.config);
  if (params.target.topology.resolvedApiReplicas !== 2) {
    throw new Error('Relay cluster compose scenario requires exactly two full-compose API replicas');
  }
  const partitionAdmin = requireExternalRedisPartitionAdmin(params.target);
  const peerMediation = params.target.testRuntime?.peerMediation;
  if (!peerMediation || !peerMediation.allowedPorts.includes(relayPort)) {
    throw new Error(`Relay cluster compose topology must expose test-only signing metadata and port ${relayPort}`);
  }

  const composeProjectName = params.target.topology.composeProjectName;
  if (!composeProjectName) {
    throw new Error('Relay cluster external Redis partition requires an owned Compose project');
  }
  const composeNetworkName = `${composeProjectName}_default`;
  const redisContainers = await params.target.admin?.listServiceContainers('redis') ?? [];
  const redis = redisContainers[0];
  const redisAttachment = redis?.networkAttachments?.[composeNetworkName];
  if (!redis || redisContainers.length !== 1 || !redisAttachment?.ipv4Address) {
    throw new Error(
      `Relay cluster external Redis partition requires one Redis container attached to ${composeNetworkName}`,
    );
  }

  const upstreamTargets = await resolveServiceUpstreamTargets(params.target, 'api', 53288);
  const gatewayConfig = await writeScenarioGatewayConfig({
    target: params.target,
    fileName: 'nginx.relay-cluster-external-partition.conf',
    contents: renderStressGatewayNginxConf({
      upstreamApiTargets: upstreamTargets,
      affinity: 'header-hash',
      stickyHeaderName,
      workerConnections: params.config.compose.gatewayWorkerConnections,
      workerRlimitNoFile: params.config.compose.gatewayWorkerRlimitNoFile,
    }),
  });
  await activateGatewayConfig(params.target, gatewayConfig);

  const accountId = await fetchAccountId(params.target.baseUrl, params.auth.token);
  const machineId = `relay-cluster-partition-machine-${randomUUID()}`;
  await provisionMachine(params.target.baseUrl, params.auth.token, machineId);
  const placement = await discoverDistinctStickyKeys({
    target: params.target,
    token: params.auth.token,
  });
  const envelopeFactory = createRelayClusterEnvelopeFactory({
    accountId,
    machineId,
    signingKeyId: peerMediation.routeGrantSigning.keyId,
    signingPrivateKeySeedBase64Url: peerMediation.routeGrantSigning.privateKeySeedBase64Url,
  });

  let redisPartitioned = false;
  try {
    await withRelayClientCleanup(async (retainClient) => {
      const initialUserCounts = await readReplicaConnectionCounts(params.target, 'user-scoped');
      const initialMachineCounts = await readReplicaConnectionCounts(params.target, 'machine-scoped');
      const user = retainClient(await connectRawRelayClient({
        baseUrl: params.target.baseUrl,
        token: params.auth.token,
        stickyKey: placement.first.stickyKey,
        clientType: 'user-scoped',
        machineId,
      }));
      const machine = retainClient(await connectRawRelayClient({
        baseUrl: params.target.baseUrl,
        token: params.auth.token,
        stickyKey: placement.second.stickyKey,
        clientType: 'machine-scoped',
        machineId,
      }));
      await assertClientPlacement({
        target: params.target,
        clientType: 'user-scoped',
        expectedContainerId: placement.first.containerId,
        baseline: initialUserCounts,
      });
      await assertClientPlacement({
        target: params.target,
        clientType: 'machine-scoped',
        expectedContainerId: placement.second.containerId,
        baseline: initialMachineCounts,
      });
      assert.notEqual(placement.first.containerId, placement.second.containerId);
      assert.ok(user.socket.id);
      assert.ok(machine.socket.id);

      const tunnelId = `external-partition-${randomUUID()}`;
      emit(user.socket, envelopeFactory.open({
        tunnelId,
        grantId: `grant-${randomUUID()}`,
        relaySocketId: user.socket.id,
      }));
      emit(user.socket, envelopeFactory.userData({
        tunnelId,
        sequence: 0,
        payload: 'before-external-partition-forward',
      }));
      await waitFor(() =>
        dataPayloads(machine.frames, tunnelId).includes('before-external-partition-forward'),
      {
        timeoutMs: socketTimeoutMs,
        context: 'forward relay traffic before external Redis partition',
      });
      emit(machine.socket, envelopeFactory.machineData({
        tunnelId,
        userSocketId: user.socket.id,
        sequence: 0,
        payload: 'before-external-partition-reverse',
      }));
      await waitFor(() =>
        dataPayloads(user.frames, tunnelId).includes('before-external-partition-reverse'),
      {
        timeoutMs: socketTimeoutMs,
        context: 'reverse relay traffic before external Redis partition',
      });

      await partitionAdmin.disconnectContainerFromNetwork(redis.id, composeNetworkName);
      redisPartitioned = true;
      assert.equal(user.socket.connected, true);
      assert.equal(machine.socket.connected, true);
      emit(user.socket, envelopeFactory.userData({
        tunnelId,
        sequence: 1,
        payload: externalPartitionForwardPayload,
      }));
      emit(machine.socket, envelopeFactory.machineData({
        tunnelId,
        userSocketId: user.socket.id,
        sequence: 1,
        payload: externalPartitionReversePayload,
      }));
      await sleep(1_500);
      assertExternalPartitionPayloadsRemainAbsent({
        milestone: 'during external Redis partition',
        tunnelId,
        userFrames: user.frames,
        machineFrames: machine.frames,
      });

      await waitFor(() => terminalCount(user.frames, tunnelId, 'relay_cap_exceeded') === 1, {
        timeoutMs: externalPartitionTerminalTimeoutMs,
        intervalMs: 100,
        context: 'bounded relay terminal during external Redis partition',
      });
      await sleep(500);
      const partitionTerminalWindow = assertExternalPartitionTerminalWindow({
        tunnelId,
        userFrames: user.frames,
        machineFrames: machine.frames,
      });
      assert.equal(user.socket.connected, true);
      assert.equal(machine.socket.connected, true);

      await partitionAdmin.connectContainerToNetwork(redis.id, composeNetworkName, {
        aliases: redisAttachment.aliases,
        ipv4Address: redisAttachment.ipv4Address,
      });
      redisPartitioned = false;
      await waitForRedisServiceHealthy(params.target, 45_000);
      await waitFor(() => user.socket.connected && machine.socket.connected, {
        timeoutMs: 45_000,
        intervalMs: 250,
        context: 'relay clients remain connected after external Redis partition heal',
      });
      await waitForRelayAdapterReadiness({
        milestone: 'distributed relay adapter readiness after external Redis partition heal',
        user,
        machine,
        sendProbe: ({ tunnelId: probeTunnelId, grantId, payload }) => {
          emit(user.socket, envelopeFactory.open({
            tunnelId: probeTunnelId,
            grantId,
            relaySocketId: user.socket.id!,
          }));
          emit(user.socket, envelopeFactory.userData({
            tunnelId: probeTunnelId,
            sequence: 0,
            payload,
          }));
        },
      });
      assertExternalPartitionPayloadsRemainAbsent({
        milestone: 'after external Redis partition adapter readiness',
        tunnelId,
        userFrames: user.frames,
        machineFrames: machine.frames,
      });

      emit(user.socket, envelopeFactory.userData({
        tunnelId,
        sequence: 2,
        payload: 'must-not-resurrect-forward-after-heal',
      }));
      emit(machine.socket, envelopeFactory.machineData({
        tunnelId,
        userSocketId: user.socket.id,
        sequence: 2,
        payload: 'must-not-resurrect-reverse-after-heal',
      }));
      await sleep(1_000);
      assert.equal(
        dataPayloads(machine.frames, tunnelId).includes('must-not-resurrect-forward-after-heal'),
        false,
      );
      assert.equal(
        dataPayloads(user.frames, tunnelId).includes('must-not-resurrect-reverse-after-heal'),
        false,
      );
      assertExternalPartitionPayloadsRemainAbsent({
        milestone: 'after bounded external Redis partition heal settle',
        tunnelId,
        userFrames: user.frames,
        machineFrames: machine.frames,
      });
      assert.deepEqual(assertExternalPartitionTerminalWindow({
        tunnelId,
        userFrames: user.frames,
        machineFrames: machine.frames,
      }), partitionTerminalWindow);

      const forgedTunnelId = `forged-after-partition-${randomUUID()}`;
      emit(user.socket, withForgedRelaySignature(envelopeFactory.open({
        tunnelId: forgedTunnelId,
        grantId: `grant-${randomUUID()}`,
        relaySocketId: user.socket.id,
      })));
      await waitFor(() =>
        terminalCount(user.frames, forgedTunnelId, 'relay_authorization_invalid') === 1,
      {
        timeoutMs: socketTimeoutMs,
        context: 'forged relay grant rejected after external Redis partition heal',
      });
      assert.equal(
        framesForTunnel(machine.frames, forgedTunnelId).some((envelope) =>
          envelope.v === 1 && envelope.frame.kind === 'open',
        ),
        false,
      );

      const expiredTunnelId = `expired-after-partition-${randomUUID()}`;
      const expiredEnvelope = envelopeFactory.open({
        tunnelId: expiredTunnelId,
        grantId: `grant-${randomUUID()}`,
        relaySocketId: user.socket.id,
        expiresAt: Date.now() + 250,
      });
      await sleep(500);
      emit(user.socket, expiredEnvelope);
      await waitFor(() =>
        terminalCount(user.frames, expiredTunnelId, 'relay_authorization_invalid') === 1,
      {
        timeoutMs: socketTimeoutMs,
        context: 'expired relay grant rejected after external Redis partition heal',
      });
      assert.equal(
        framesForTunnel(machine.frames, expiredTunnelId).some((envelope) =>
          envelope.v === 1 && envelope.frame.kind === 'open',
        ),
        false,
      );

      const recoveredTunnelId = `fresh-after-partition-${randomUUID()}`;
      emit(user.socket, envelopeFactory.open({
        tunnelId: recoveredTunnelId,
        grantId: `grant-${randomUUID()}`,
        relaySocketId: user.socket.id,
      }));
      emit(user.socket, envelopeFactory.userData({
        tunnelId: recoveredTunnelId,
        sequence: 0,
        payload: 'fresh-forward-after-external-partition',
      }));
      await waitForFreshTunnelRelayData({
        milestone: 'fresh_forward_after_external_partition',
        tunnelId: recoveredTunnelId,
        payload: 'fresh-forward-after-external-partition',
        user,
        machine,
      });
      emit(machine.socket, envelopeFactory.machineData({
        tunnelId: recoveredTunnelId,
        userSocketId: user.socket.id,
        sequence: 0,
        payload: 'fresh-reverse-after-external-partition',
      }));
      await waitFor(() =>
        dataPayloads(user.frames, recoveredTunnelId).includes('fresh-reverse-after-external-partition'),
      {
        timeoutMs: socketTimeoutMs,
        context: 'fresh reverse relay traffic after external Redis partition',
      });

      process.stdout.write(`${JSON.stringify({
        relayExternalPartition: {
          apiReplicas: 2,
          workerReplicas: params.target.topology.resolvedWorkerReplicas,
          clientsStayedConnected: true,
          prePartitionBidirectional: true,
          noTrafficCrossedPartition: true,
          boundedPartitionTerminalEnvelopes: partitionTerminalWindow.terminalEnvelopeCount,
          boundedPartitionTerminalReason: partitionTerminalWindow.reasonCodes[0],
          noResurrectionAfterHeal: true,
          forgedGrantRejected: true,
          expiredGrantRejected: true,
          freshBidirectionalRecovery: true,
        },
      })}\n`);
    });
  } finally {
    if (redisPartitioned) {
      await partitionAdmin.connectContainerToNetwork(redis.id, composeNetworkName, {
        aliases: redisAttachment.aliases,
        ipv4Address: redisAttachment.ipv4Address,
      }).catch(() => undefined);
    }
  }
}

export async function runRelayClusterComposeScenario(params: Readonly<{
  run: RunDirs;
  target: StartedStressTarget;
  config: StressConfig;
  auth: TestAuth;
  disruption?: RelayClusterComposeDisruption;
}>): Promise<void> {
  const disruption = params.disruption ?? 'rolling-restart';
  const testDir = params.run.testDir(
    disruption === 'external-redis-partition'
      ? 'relay-cluster-external-partition-compose'
      : 'relay-cluster-compose',
  );
  const startedAt = new Date().toISOString();
  let failure: unknown;

  try {
    if (disruption === 'external-redis-partition') {
      await executeRelayClusterExternalPartitionScenario(params);
    } else {
      await executeRelayClusterComposeScenario(params);
    }
  } catch (error) {
    failure = error;
  } finally {
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: disruption === 'external-redis-partition'
        ? 'relay.clusterExternalPartitionCompose'
        : 'relay.clusterCompose',
      target: params.target,
      config: params.config,
      startedAt,
      seed: params.config.seed,
      status: failure ? 'failed' : 'passed',
      error: failure,
      counts: {
        apiReplicas: params.target.topology.resolvedApiReplicas,
        scenarioRuns: 1,
      },
    });
  }

  if (failure) {
    throw failure;
  }
}
