import { randomUUID } from 'node:crypto';

import {
  decideMachinePluginInstallReviewAsPresentUser,
} from '../../../../../apps/ui/sources/sync/ops/machinePluginInstallPresentUserDecision.mjs';
import {
  HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
} from '@happier-dev/protocol/marketplace/internal';
import { readCliAccessKey, type CliAccessKey } from '../cliAccessKey';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../messageCrypto';
import { type MemoryRpcSchema } from '../memoryRpc';
import {
  createUserScopedSocketCollector,
  type SocketCollector,
  type SocketConnectivityState,
  type SocketConnectivityTransition,
} from '../socketClient';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../syntheticAgent/rpcClient';
import { waitFor } from '../timing';
import { waitForDaemonMachineIdFromCliSettings } from '../uiE2e/daemonMachineId';
export {
  readPluginInstallReviewRequiredEnvelope,
  type PluginInstallationReviewFacts,
} from './pluginInstallReviewRequiredEnvelope.mjs';

export type PluginInstallDecisionOutcome = Readonly<{
  kind: 'committed' | 'failed' | 'conflict' | 'expired' | 'cancelled' | 'unavailable' | 'outcomeUnknown' | 'busy';
  pluginId?: string;
  desiredGeneration?: string | null;
  appliedGeneration?: string | null;
  pendingSurfaces?: readonly string[];
  code?: string;
  message?: string;
}>;

const PluginInstallDecisionOutcomeSchema: MemoryRpcSchema<PluginInstallDecisionOutcome> = {
  safeParse(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { success: false };
    const kind = (value as Readonly<Record<string, unknown>>).kind;
    if (![
      'committed',
      'failed',
      'conflict',
      'expired',
      'cancelled',
      'unavailable',
      'outcomeUnknown',
      'busy',
    ].includes(String(kind))) {
      return { success: false };
    }
    return { success: true, data: value as PluginInstallDecisionOutcome };
  },
};

type ReviewSocket =
  & Pick<SocketCollector, 'connect' | 'close' | 'isConnected' | 'rpcCall'>
  & Partial<Pick<SocketCollector, 'getConnectivityState'>>;

export type AuthenticatedPluginInstallReviewTimeoutDiagnostic = Readonly<{
  pendingChangeId: string;
  machineId: string;
  rpcStartedAtMs: number;
  rpcTimedOutAtMs: number;
  connectedBefore: boolean;
  connectedAfter: boolean;
  transitionCountDuringRpc: number;
  omittedTransitionCountDuringRpc: number;
  transitionsDuringRpc: readonly SocketConnectivityTransition[];
}>;

export class AuthenticatedPluginInstallReviewTimeoutError extends Error {
  readonly code = 'authenticated_plugin_install_review_timeout';

  constructor(
    readonly diagnostic: AuthenticatedPluginInstallReviewTimeoutDiagnostic,
    options?: ErrorOptions,
  ) {
    super(
      `Authenticated plugin install review decision timed out: ${JSON.stringify(diagnostic)}`,
      options,
    );
    this.name = 'AuthenticatedPluginInstallReviewTimeoutError';
  }
}

type PrivateRpcTransportResult =
  | Readonly<{ ok: true; result: unknown | null }>
  | Readonly<{ ok: false; error?: string; errorCode?: string }>;

type AuthenticatedInstallReviewDeps = Readonly<{
  readAccessKey: typeof readCliAccessKey;
  readMachineId: typeof waitForDaemonMachineIdFromCliSettings;
  createUserSocket: (baseUrl: string, token: string) => ReviewSocket;
  waitForConnected: (socket: ReviewSocket) => Promise<void>;
  probeLegacy: (params: Readonly<{
    socket: ReviewSocket;
    machineId: string;
    method: string;
    payload: unknown;
    secret: Uint8Array;
    timeoutMs: number;
  }>) => Promise<PrivateRpcTransportResult>;
  probeDataKey: (params: Readonly<{
    socket: ReviewSocket;
    machineId: string;
    method: string;
    payload: unknown;
    machineKey: Uint8Array;
    timeoutMs: number;
  }>) => Promise<PrivateRpcTransportResult>;
  callLegacy: (params: Readonly<{
    socket: ReviewSocket;
    machineId: string;
    method: string;
    payload: unknown;
    secret: Uint8Array;
    timeoutMs: number;
  }>) => Promise<PluginInstallDecisionOutcome>;
  callDataKey: (params: Readonly<{
    socket: ReviewSocket;
    machineId: string;
    method: string;
    payload: unknown;
    machineKey: Uint8Array;
    timeoutMs: number;
  }>) => Promise<PluginInstallDecisionOutcome>;
  createInteractionId: () => string;
  nowMs: () => number;
  readinessTimeoutMs: number;
  decisionTimeoutMs: number;
}>;

const AUTHENTICATED_INSTALL_DECISION_TIMEOUT_MS = 5 * 60_000;

function normalizeLegacyPrivateRpcResult(
  raw: unknown,
  secret: Uint8Array,
): PrivateRpcTransportResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'invalid-rpc-response' };
  }
  const envelope = raw as Readonly<Record<string, unknown>>;
  if (envelope.ok === true) {
    if (typeof envelope.result !== 'string') {
      return { ok: false, error: 'invalid-rpc-result' };
    }
    return {
      ok: true,
      result: decryptLegacyBase64(envelope.result, secret),
    };
  }
  return {
    ok: false,
    error: typeof envelope.error === 'string'
      ? envelope.error
      : 'rpc-failed',
    ...(typeof envelope.errorCode === 'string'
      ? { errorCode: envelope.errorCode }
      : {}),
  };
}

async function callLegacyPrivateRpcOnce(params: Readonly<{
  socket: ReviewSocket;
  machineId: string;
  method: string;
  payload: unknown;
  secret: Uint8Array;
  timeoutMs: number;
}>): Promise<PrivateRpcTransportResult> {
  return normalizeLegacyPrivateRpcResult(
    await params.socket.rpcCall(
      `${params.machineId}:${params.method}`,
      encryptLegacyBase64(params.payload, params.secret),
      params.timeoutMs,
    ),
    params.secret,
  );
}

function isExactInvalidRequestProbeResult(
  result: PrivateRpcTransportResult,
): boolean {
  if (result.ok !== true) return false;
  const value = result.result;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    Object.keys(record).sort().join(',')
      === 'error,errorCode,ok'
    && record.ok === false
    && record.errorCode === 'invalid_request'
    && record.error === 'invalid_request'
  );
}

// The private decision handler validates its strict schema before calling the
// daemon decision owner. An empty request therefore proves the exact route is
// registered while remaining incapable of carrying a decision or actor evidence.
async function waitForPrivateInstallDecisionRpcReady(params: Readonly<{
  probe: () => Promise<PrivateRpcTransportResult>;
  timeoutMs: number;
}>): Promise<void> {
  await waitFor(async () => {
    const result = await params.probe();
    if (
      result.ok === false
      && result.errorCode === 'RPC_METHOD_NOT_AVAILABLE'
    ) {
      return false;
    }
    if (isExactInvalidRequestProbeResult(result)) return true;
    if (result.ok === false) {
      throw new Error(
        `Authenticated plugin install-review readiness probe failed: ${result.errorCode ?? result.error ?? 'unknown-error'}`,
      );
    }
    throw new Error(
      'Authenticated plugin install-review readiness probe returned an invalid handler response',
    );
  }, {
    timeoutMs: params.timeoutMs,
    intervalMs: 50,
    failFast: true,
    context: 'authenticated plugin install-review private RPC readiness',
  });
}

const defaultDeps: AuthenticatedInstallReviewDeps = {
  readAccessKey: readCliAccessKey,
  readMachineId: waitForDaemonMachineIdFromCliSettings,
  createUserSocket: (baseUrl, token) => createUserScopedSocketCollector(baseUrl, token, {
    captureEvents: false,
  }),
  waitForConnected: async (socket) => {
    socket.connect();
    await waitFor(() => socket.isConnected(), {
      timeoutMs: 20_000,
      context: 'authenticated plugin install-review socket',
    });
  },
  probeLegacy: callLegacyPrivateRpcOnce,
  probeDataKey: async ({
    socket,
    machineId,
    method,
    payload,
    machineKey,
    timeoutMs,
  }) => await createDataKeyRpcClient(socket, machineKey).call(
    `${machineId}:${method}`,
    payload,
    timeoutMs,
  ),
  callLegacy: async ({ socket, machineId, method, payload, secret, timeoutMs }) => {
    const raw = await callLegacyPrivateRpcOnce({
      socket,
      machineId,
      method,
      payload,
      secret,
      timeoutMs,
    });
    if (raw.ok !== true) {
      if (raw.error === 'operation has timed out') {
        throw new Error(raw.error);
      }
      throw new Error(
        `Authenticated plugin install review failed: ${raw.errorCode ?? raw.error ?? 'unknown-error'}`,
      );
    }
    const parsed = PluginInstallDecisionOutcomeSchema.safeParse(raw.result);
    if (!parsed.success) {
      throw new Error(
        'Authenticated plugin install review returned an invalid outcome',
      );
    }
    return parsed.data;
  },
  callDataKey: async ({ socket, machineId, method, payload, machineKey, timeoutMs }) => {
    const raw = unwrapDataKeyRpcResult(
      await createDataKeyRpcClient(socket, machineKey).call(
        `${machineId}:${method}`,
        payload,
        timeoutMs,
      ),
      method,
    );
    const parsed = PluginInstallDecisionOutcomeSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Authenticated plugin install review returned an invalid outcome');
    return parsed.data;
  },
  createInteractionId: randomUUID,
  nowMs: Date.now,
  readinessTimeoutMs: 20_000,
  decisionTimeoutMs: AUTHENTICATED_INSTALL_DECISION_TIMEOUT_MS,
};

function accessKeyIdentity(accessKey: CliAccessKey): string {
  return 'secret' in accessKey
    ? `legacy:${accessKey.token}:${accessKey.secret}`
    : `dataKey:${accessKey.token}:${accessKey.encryption.publicKey}:${accessKey.encryption.machineKey}`;
}

function readSocketConnectivityState(socket: ReviewSocket): SocketConnectivityState {
  return socket.getConnectivityState?.() ?? {
    connected: socket.isConnected(),
    totalTransitionCount: 0,
    transitions: [],
  };
}

function isSocketAcknowledgementTimeout(error: unknown): error is Error {
  return error instanceof Error && error.message === 'operation has timed out';
}

export async function decideAuthenticatedPluginInstallReview(input: Readonly<{
  cliHomeDir: string;
  serverUrl: string;
  pendingChangeId: string;
  optionalSelections: readonly Readonly<{ accessId: string; selected: boolean }>[];
  confirmPresentUser: () => Promise<boolean>;
  deps?: Partial<AuthenticatedInstallReviewDeps>;
}>): Promise<PluginInstallDecisionOutcome> {
  const deps = { ...defaultDeps, ...(input.deps ?? {}) };
  const [machineId, accessKey] = await Promise.all([
    deps.readMachineId({ cliHomeDir: input.cliHomeDir }),
    deps.readAccessKey(input.cliHomeDir),
  ]);
  if (!accessKey) {
    throw new Error('Authenticated CLI credentials were unavailable for plugin install review');
  }
  const socket = deps.createUserSocket(input.serverUrl, accessKey.token);
  try {
    await deps.waitForConnected(socket);
    await waitForPrivateInstallDecisionRpcReady({
      timeoutMs: deps.readinessTimeoutMs,
      probe: async () => {
        const common = {
          socket,
          machineId,
          method: HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
          payload: {},
          timeoutMs: deps.readinessTimeoutMs,
        };
        if ('secret' in accessKey) {
          return await deps.probeLegacy({
            ...common,
            secret: Uint8Array.from(
              Buffer.from(accessKey.secret, 'base64'),
            ),
          });
        }
        return await deps.probeDataKey({
          ...common,
          machineKey: Uint8Array.from(
            Buffer.from(accessKey.encryption.machineKey, 'base64'),
          ),
        });
      },
    });
    return await decideMachinePluginInstallReviewAsPresentUser({
      pendingChangeId: input.pendingChangeId,
      confirmPresentUser: async () => (
        await input.confirmPresentUser()
          ? [...input.optionalSelections]
          : null
      ),
      isAuthorityCurrent: async () => {
        const [currentMachineId, currentAccessKey] = await Promise.all([
          deps.readMachineId({ cliHomeDir: input.cliHomeDir }),
          deps.readAccessKey(input.cliHomeDir),
        ]);
        return (
          currentMachineId === machineId
          && currentAccessKey !== null
          && accessKeyIdentity(currentAccessKey) === accessKeyIdentity(accessKey)
          && socket.isConnected()
        );
      },
      callAuthenticatedPrivateRpc: async (method, payload) => {
        const before = readSocketConnectivityState(socket);
        const rpcStartedAtMs = deps.nowMs();
        try {
          if ('secret' in accessKey) {
            return await deps.callLegacy({
              socket,
              machineId,
              method,
              payload,
              secret: Uint8Array.from(Buffer.from(accessKey.secret, 'base64')),
              timeoutMs: deps.decisionTimeoutMs,
            });
          }
          return await deps.callDataKey({
            socket,
            machineId,
            method,
            payload,
            machineKey: Uint8Array.from(Buffer.from(accessKey.encryption.machineKey, 'base64')),
            timeoutMs: deps.decisionTimeoutMs,
          });
        } catch (error) {
          if (!isSocketAcknowledgementTimeout(error)) throw error;
          const rpcTimedOutAtMs = deps.nowMs();
          const after = readSocketConnectivityState(socket);
          const transitionCountDuringRpc = Math.max(
            0,
            after.totalTransitionCount - before.totalTransitionCount,
          );
          const transitionsDuringRpc = after.transitions.filter(
            (transition) => transition.sequence > before.totalTransitionCount,
          );
          throw new AuthenticatedPluginInstallReviewTimeoutError({
            pendingChangeId: input.pendingChangeId,
            machineId,
            rpcStartedAtMs,
            rpcTimedOutAtMs,
            connectedBefore: before.connected,
            connectedAfter: after.connected,
            transitionCountDuringRpc,
            omittedTransitionCountDuringRpc: Math.max(
              0,
              transitionCountDuringRpc - transitionsDuringRpc.length,
            ),
            transitionsDuringRpc,
          }, { cause: error });
        }
      },
      createInteractionId: deps.createInteractionId,
      nowMs: deps.nowMs,
    });
  } finally {
    socket.close();
  }
}
