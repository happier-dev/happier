import type {
  ConversationObservationV1,
  ConversationProviderFailureV1,
  ConversationProviderObservationIngestInputV1,
  ConversationTransportFactReportInputV1,
} from '@happier-dev/channels-protocol/v1';
import type { HttpService, PluginWebSocketConnection } from '@happier-dev/plugin-sdk/http';

import type {
  DiscordApplicationMessageContentIntentPermission,
  DiscordApiFailure,
  DiscordBotApi,
  DiscordGatewayBotInfo,
  DiscordGuildMemberRoleEvidence,
} from './discordApi.js';
import {
  DISCORD_DEFAULT_RECONNECT_DELAY_BOUNDS,
  calculateDiscordReconnectDelayMs,
  createDiscordGatewaySession,
  type DiscordGatewayEffect,
  type DiscordGatewayReconnectDelayBounds,
  type DiscordGatewayResumeState,
  type DiscordGatewaySession,
  type DiscordGatewaySessionStartLimit,
} from './discordGateway.js';
import { createDiscordIngressScheduler } from './discordIngressScheduler.js';
import type {
  DiscordIdentifyConcurrency,
  DiscordIdentifyPermit,
} from './discordGatewayIdentifyConcurrency.js';
import { parseDiscordMessageDispatch } from './discordMessage.js';
import { mapDiscordMessageToSocketIngress } from './discordObservation.js';
import { createDiscordChannelEndpointId } from './discordPluginConstants.js';
import { calculateDiscordGatewayIntents } from './discordSetup.js';

/**
 * The only binding-derived fact a Discord socket needs. Channel audience and
 * policy remain in Channels; this is the strict core-derived demand that tells
 * the provider whether it may request Discord's privileged Message Content
 * intent for the aggregate live binding set selected by core.
 */
export type DiscordGatewayRuntimeFacts = Readonly<{
  requiresFullSharedMessageContent: boolean;
}>;

/** The four facts C7 keeps distinct for a live Discord Gateway session. */
export type DiscordGatewayMessageContentIntentState = Readonly<{
  coreDemand: boolean;
  applicationPermission: 'enabled' | 'disabled' | 'unknown';
  gatewayIntentRequested: boolean;
  gatewayIntentActive: boolean;
}>;

export type DiscordGatewayMessageContentIntentRecovery = Readonly<{
  kind: 'messageContentIntentRecoveryRequired';
  source: 'applicationFlags' | 'gateway4014';
  failure: ConversationProviderFailureV1;
} & DiscordGatewayMessageContentIntentState>;

export type DiscordGatewayWorkerConnection = Readonly<{
  connectionId: string;
  authorityEpoch: number;
  applicationId: string;
  botUserId: string;
  token: string;
  runtime: DiscordGatewayRuntimeFacts;
  applicationMessageContentIntentPermission: DiscordApplicationMessageContentIntentPermission;
}>;

export type DiscordGatewayWorkerResult =
  | Readonly<{ kind: 'stopped' }>
  | Extract<ConversationTransportFactReportInputV1['fact'], Readonly<{ kind: 'historyGap' }>>
  | DiscordGatewayMessageContentIntentRecovery
  | Readonly<{
      kind: 'blocked';
      reason: 'identifyLimit' | 'sessionStartLimitRefreshRequired';
      retryAtMs: number;
    }>
  | Readonly<{
      kind: 'terminal';
      reason: 'authenticationFailed' | 'invalidShard' | 'shardingRequired' | 'invalidApiVersion' | 'invalidIntents' | 'disallowedIntents';
    }>
  | Readonly<{
      kind: 'notReady';
      failure: ConversationProviderFailureV1;
      transportFact?: Extract<ConversationTransportFactReportInputV1['fact'], Readonly<{ kind: 'historyGap' }>>;
    }>;

/**
 * Why Discord ended a session for good. `authenticationFailed` is the one
 * reason a person can repair without changing the Channel connection: it means
 * the selected Connected Account's bot token is wrong.
 */
export type DiscordGatewayTerminalReason = Extract<
  DiscordGatewayWorkerResult,
  Readonly<{ kind: 'terminal' }>
>['reason'];

export type DiscordGatewayWorkerClock = Readonly<{
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}>;

export type DiscordGatewayWorkerInput = Readonly<{
  connection: DiscordGatewayWorkerConnection;
  api: Pick<DiscordBotApi, 'getGatewayBot' | 'getChannel' | 'getGuildMember'>;
  webSockets: Pick<HttpService, 'openWebSocket'>;
  admitObservation(
    input: ConversationProviderObservationIngestInputV1,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<void>;
  /** Supervisor-owned queueing hook; it never persists provider state locally. */
  reportReadiness?(): void;
  signal: AbortSignal;
  clock?: DiscordGatewayWorkerClock;
  ingressLimits?: Readonly<{
    maxConcurrent: number;
    maxQueuedPerKey: number;
    maxQueuedTotal: number;
  }>;
  identifyConcurrency?: DiscordIdentifyConcurrency;
}>;

export type DiscordGatewayWorker = Readonly<{
  result: Promise<DiscordGatewayWorkerResult>;
  stop(): void;
}>;

const DEFAULT_INGRESS_LIMITS = Object.freeze({
  maxConcurrent: 8,
  maxQueuedPerKey: 64,
  maxQueuedTotal: 512,
});

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Discord Gateway worker was cancelled.'));
      return;
    }
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      reject(signal.reason ?? new Error('Discord Gateway worker was cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const DEFAULT_CLOCK: DiscordGatewayWorkerClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  sleep: defaultSleep,
});

function isDiscordApiFailure(value: DiscordGatewayBotInfo | ConversationProviderFailureV1): value is ConversationProviderFailureV1 {
  return 'kind' in value && value.kind === 'notReady';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function copyResume(value: DiscordGatewayResumeState | null): DiscordGatewayResumeState | undefined {
  return value === null ? undefined : { ...value };
}

function sessionStartLimit(gateway: DiscordGatewayBotInfo, nowMs: number): DiscordGatewaySessionStartLimit {
  return { ...gateway.sessionStartLimit, observedAtMs: nowMs };
}

function toGatewayFrame(message: Readonly<{ kind: 'text'; text: string }> | Readonly<{ kind: 'binary'; data: Uint8Array }>): unknown | null {
  if (message.kind !== 'text') return null;
  try {
    return JSON.parse(message.text);
  } catch {
    return null;
  }
}

function extractionChannelId(payload: unknown): string | null {
  return isRecord(payload) ? nonEmptyString(payload.channel_id) : null;
}

function isMessageDispatchEvent(event: string): event is 'MESSAGE_CREATE' | 'MESSAGE_UPDATE' {
  return event === 'MESSAGE_CREATE' || event === 'MESSAGE_UPDATE';
}

function guildId(payload: unknown): string | null {
  return isRecord(payload) ? nonEmptyString(payload.guild_id) : null;
}

function hasRoleMention(payload: unknown): boolean {
  return isRecord(payload)
    && Array.isArray(payload.mention_roles)
    && payload.mention_roles.some((roleId) => typeof roleId === 'string' && roleId.trim().length > 0);
}

function hasGuildMemberRoleEvidence(
  value: DiscordGuildMemberRoleEvidence | DiscordApiFailure | null,
): value is DiscordGuildMemberRoleEvidence {
  return value !== null && !('kind' in value);
}

class DiscordGatewayRoleLookupFailure extends Error {
  readonly failure: DiscordApiFailure;

  constructor(failure: DiscordApiFailure) {
    super('Discord Gateway could not obtain current bot role evidence.');
    this.name = 'DiscordGatewayRoleLookupFailure';
    this.failure = failure;
  }
}

function isDiscordGatewayRoleLookupFailure(value: unknown): value is DiscordGatewayRoleLookupFailure {
  return value instanceof DiscordGatewayRoleLookupFailure;
}

function workerFailure(reason: ConversationProviderFailureV1['reason'], diagnostic: string): DiscordGatewayWorkerResult {
  return { kind: 'notReady', failure: { kind: 'notReady', reason, diagnostic } };
}

function applicationPermission(
  permission: DiscordApplicationMessageContentIntentPermission,
): DiscordGatewayMessageContentIntentState['applicationPermission'] {
  return permission.kind;
}

function messageContentIntentRecovery(input: Readonly<{
  source: DiscordGatewayMessageContentIntentRecovery['source'];
  state: DiscordGatewayMessageContentIntentState;
  failure: ConversationProviderFailureV1;
}>): DiscordGatewayMessageContentIntentRecovery {
  return { kind: 'messageContentIntentRecoveryRequired', ...input.state, source: input.source, failure: input.failure };
}

function preflightMessageContentIntent(input: Readonly<{
  state: DiscordGatewayMessageContentIntentState;
}>): DiscordGatewayMessageContentIntentRecovery | null {
  if (!input.state.coreDemand || input.state.applicationPermission === 'enabled') return null;
  if (input.state.applicationPermission === 'disabled') {
    return messageContentIntentRecovery({
      source: 'applicationFlags',
      state: input.state,
      failure: {
        kind: 'notReady',
        reason: 'permissionMissing',
        diagnostic: 'Discord Message Content must be enabled for this application in the Developer Portal.',
      },
    });
  }
  return messageContentIntentRecovery({
    source: 'applicationFlags',
    state: input.state,
    failure: {
      kind: 'notReady',
      reason: 'invalidConfiguration',
      diagnostic: 'Discord did not return usable application flags/flags_new needed to verify the Message Content intent.',
    },
  });
}

async function disposeSocket(socket: PluginWebSocketConnection): Promise<void> {
  await socket.dispose();
}

export function startDiscordGatewayWorker(input: DiscordGatewayWorkerInput): DiscordGatewayWorker {
  const controller = new AbortController();
  let activeSocket: PluginWebSocketConnection | null = null;
  const abortFromParent = (): void => controller.abort(input.signal.reason);
  if (input.signal.aborted) abortFromParent();
  else input.signal.addEventListener('abort', abortFromParent, { once: true });

  const result = (async (): Promise<DiscordGatewayWorkerResult> => {
    const signal = controller.signal;
    if (signal.aborted) return { kind: 'stopped' };
    const clock = input.clock ?? DEFAULT_CLOCK;
    const scheduler = createDiscordIngressScheduler(input.ingressLimits ?? DEFAULT_INGRESS_LIMITS);
    const pendingAdmissions = new Set<Promise<void>>();
    const admissionsAtCancellation = new Set<Promise<void>>();
    const captureAdmissionsAtCancellation = (): void => {
      for (const admission of pendingAdmissions) admissionsAtCancellation.add(admission);
    };
    const messageContentIntent: {
      coreDemand: boolean;
      applicationPermission: DiscordGatewayMessageContentIntentState['applicationPermission'];
      gatewayIntentRequested: boolean;
      gatewayIntentActive: boolean;
    } = {
      coreDemand: input.connection.runtime.requiresFullSharedMessageContent,
      applicationPermission: applicationPermission(input.connection.applicationMessageContentIntentPermission),
      gatewayIntentRequested: false,
      gatewayIntentActive: false,
    };
    const preflightFailure = preflightMessageContentIntent({ state: messageContentIntent });
    if (preflightFailure) return preflightFailure;
    signal.addEventListener('abort', captureAdmissionsAtCancellation, { once: true });
    let resume: DiscordGatewayResumeState | undefined;
    let lastStartLimit: DiscordGatewaySessionStartLimit | undefined;
    let reconnectAttempt = 0;
    let admissionLost = false;
    let providerFailure: ConversationProviderFailureV1 | null = null;
    let mustDrainIncumbentAdmissions = false;

    const closeForAdmissionLoss = (failure?: ConversationProviderFailureV1): void => {
      if (signal.aborted || admissionLost) return;
      admissionLost = true;
      if (failure !== undefined) providerFailure = failure;
      activeSocket?.close({ code: 4_000, reason: 'Channels admission unavailable' });
    };

    const drainIncumbentAdmissionsBeforeProductAdmission = async (): Promise<boolean> => {
      if (signal.aborted || admissionLost || providerFailure !== null) return false;
      if (!mustDrainIncumbentAdmissions) return true;
      mustDrainIncumbentAdmissions = false;
      const incumbentAdmissions = [...pendingAdmissions];
      if (incumbentAdmissions.length === 0) return true;
      const settled = await Promise.allSettled(incumbentAdmissions);
      if (signal.aborted || admissionLost || providerFailure !== null) return false;
      if (settled.some((admission) => admission.status === 'rejected')) {
        closeForAdmissionLoss();
        return false;
      }
      return true;
    };

    const admitDispatch = async (effect: Extract<DiscordGatewayEffect, { kind: 'dispatch' }>): Promise<void> => {
      const event = effect.event;
      if (!isMessageDispatchEvent(event)) return;
      const channelId = extractionChannelId(effect.payload);
      if (!channelId) return;
      if (!await drainIncumbentAdmissionsBeforeProductAdmission()) return;
      if (signal.aborted || admissionLost || providerFailure !== null) return;
      // The dispatch's content visibility belongs to the session that received
      // it. A later reconnect must not retroactively reinterpret queued work.
      const messageContentIntentEnabled = messageContentIntent.gatewayIntentActive;
      const task = scheduler.schedule({
        connectionId: input.connection.connectionId,
        endpointId: createDiscordChannelEndpointId(channelId),
        signal,
        async run(taskSignal) {
          const admissionSignal = taskSignal ?? signal;
          const channel = await input.api.getChannel({ channelId }, { signal: admissionSignal });
          if (channel === null) throw new Error('Discord Gateway message channel is no longer available.');
          if (channel.kind === 'notReady') throw new Error(`Discord Gateway message channel lookup failed: ${channel.reason}.`);
          if (channel.kind !== 'direct' && channel.kind !== 'shared' && channel.kind !== 'thread') {
            throw new Error(`Discord Gateway message channel kind '${channel.kind}' is unsupported.`);
          }
          const messageGuildId = guildId(effect.payload);
          const roleMentionGuildId = messageGuildId && hasRoleMention(effect.payload)
            ? messageGuildId
            : null;
          const member = roleMentionGuildId !== null
            ? await input.api.getGuildMember({
              guildId: roleMentionGuildId,
              userId: input.connection.botUserId,
            }, { signal: admissionSignal })
            : null;
          if (member === null && roleMentionGuildId !== null) {
            throw new DiscordGatewayRoleLookupFailure({
              kind: 'notReady',
              reason: 'permissionMissing',
              diagnostic: 'Discord did not confirm the current bot as a member of the guild for role mention evidence.',
            });
          }
          if (member !== null && !hasGuildMemberRoleEvidence(member)) {
            throw new DiscordGatewayRoleLookupFailure(member);
          }
          // `GUILD_MEMBER_UPDATE` requires Discord's separate privileged
          // GUILD_MEMBERS intent. A single-member REST read is the current
          // authenticated role proof for a role mention, so an old Gateway
          // snapshot cannot turn a changed role into integration evidence.
          const botRoleIds = hasGuildMemberRoleEvidence(member)
            ? member.roleIds
            : [];
          const parsed = parseDiscordMessageDispatch({
            event,
            payload: effect.payload,
            channel: {
              channelId: channel.channelId,
              kind: channel.kind,
              ...(channel.parentChannelId === undefined ? {} : { parentChannelId: channel.parentChannelId }),
            },
            context: {
              applicationId: input.connection.applicationId,
              botUserId: input.connection.botUserId,
              botRoleIds,
              messageContentIntentEnabled,
            },
          });
          const observation = mapDiscordMessageToSocketIngress({ parsed });
          if (!observation) return;
          await input.admitObservation({
            connectionId: input.connection.connectionId,
            observation,
          }, { signal: admissionSignal });
        },
      });
      const tracked = task.then(
        () => undefined,
        (error: unknown) => {
          if (isDiscordGatewayRoleLookupFailure(error)) {
            closeForAdmissionLoss(error.failure);
            return;
          }
          if (!signal.aborted) closeForAdmissionLoss();
          throw error;
        },
      );
      pendingAdmissions.add(tracked);
      void tracked.catch(() => undefined).finally(() => pendingAdmissions.delete(tracked));
    };

    let rejectedAdmissionAtTeardown = false;
    let completedResult: DiscordGatewayWorkerResult | null = null;
    try {
      while (!signal.aborted) {
        let gateway: DiscordGatewayBotInfo | undefined;
        if (!resume) {
          messageContentIntent.gatewayIntentRequested = false;
          messageContentIntent.gatewayIntentActive = false;
          const gatewayResult = await input.api.getGatewayBot({ signal });
          if (isDiscordApiFailure(gatewayResult)) {
            completedResult = { kind: 'notReady', failure: gatewayResult };
            break;
          }
          gateway = gatewayResult;
          lastStartLimit = sessionStartLimit(gateway, clock.now());
        }
        if (!lastStartLimit) {
          completedResult = workerFailure('invalidConfiguration', 'Discord Gateway session start facts are unavailable.');
          break;
        }
        const socketUrl = resume?.resumeGatewayUrl ?? gateway?.gatewayUrl;
        if (!socketUrl) {
          completedResult = workerFailure('invalidConfiguration', 'Discord Gateway URL is unavailable.');
          break;
        }

        let socket: PluginWebSocketConnection;
        try {
          socket = await input.webSockets.openWebSocket({ url: socketUrl }, { signal });
        } catch (error) {
          if (signal.aborted) break;
          completedResult = workerFailure('network', 'Discord Gateway could not be opened.');
          break;
        }
        activeSocket = socket;
        let heartbeatHandle: unknown | null = null;
        let identifyPermit: DiscordIdentifyPermit | null = null;
        const releaseUnsentIdentify = (): void => {
          const permit = identifyPermit;
          identifyPermit = null;
          permit?.release();
        };
        let reconnectRequested = false;
        let reconnectDelayBounds: DiscordGatewayReconnectDelayBounds = DISCORD_DEFAULT_RECONNECT_DELAY_BOUNDS;
        let controlResult: DiscordGatewayWorkerResult | null = null;
        let session: DiscordGatewaySession;
        try {
          session = createDiscordGatewaySession({
            token: input.connection.token,
            intents: calculateDiscordGatewayIntents(messageContentIntent.coreDemand),
            sessionStartLimit: lastStartLimit,
            ...(resume === undefined ? {} : { resume }),
          });
        } catch {
          await disposeSocket(socket);
          activeSocket = null;
          completedResult = workerFailure('invalidConfiguration', 'Discord Gateway session configuration is invalid.');
          break;
        }

        const clearHeartbeat = (): void => {
          if (heartbeatHandle === null) return;
          clock.clearTimeout(heartbeatHandle);
          heartbeatHandle = null;
        };
        const requestReconnect = (): void => {
          reconnectRequested = true;
          socket.close({ code: 4_000, reason: 'Discord Gateway reconnect requested' });
        };
        const processEffects = async (effects: readonly DiscordGatewayEffect[]): Promise<void> => {
          for (const effect of effects) {
            if (controlResult) return;
            switch (effect.kind) {
              case 'send': {
                const isIdentify = effect.payload.op === 2;
                if (isIdentify && identifyPermit === null && input.identifyConcurrency) {
                  identifyPermit = await input.identifyConcurrency.acquire({
                    applicationId: input.connection.applicationId,
                    maxConcurrency: session.snapshot().sessionStartLimit.maxConcurrency,
                    signal,
                  });
                }
                if (isIdentify) {
                  if (signal.aborted) {
                    releaseUnsentIdentify();
                    throw signal.reason ?? new Error('Discord Gateway worker was cancelled before Identify send.');
                  }
                  // The SDK WebSocket contract cannot prove that a rejected
                  // send had no effect. Consume the Discord window at the
                  // attempted-send boundary, before invoking the host socket.
                  identifyPermit?.commit();
                  identifyPermit = null;
                }
                await socket.send({ kind: 'text', text: JSON.stringify(effect.payload) }, { signal });
                if (isIdentify) {
                  messageContentIntent.gatewayIntentRequested = messageContentIntent.coreDemand;
                  messageContentIntent.gatewayIntentActive = false;
                }
                break;
              }
              case 'dispatch':
                if (effect.event === 'READY' || effect.event === 'RESUMED') {
                  // Discord accepted this session. The next disconnect starts a
                  // fresh backoff ramp instead of inheriting the ramp that
                  // preceded it, so a long-lived socket that Discord recycles
                  // does not accumulate a permanent maximum-delay outage.
                  reconnectAttempt = 0;
                }
                if (
                  (effect.event === 'READY' || effect.event === 'RESUMED')
                  && messageContentIntent.coreDemand
                  && messageContentIntent.gatewayIntentRequested
                ) {
                  messageContentIntent.gatewayIntentActive = true;
                }
                // A readiness clear is valid only after the current Gateway
                // session proves the demanded intent active. When core has no
                // such demand, READY/RESUMED still clears stale remote
                // attention from an earlier strict-demand session.
                if (
                  (effect.event === 'READY' || effect.event === 'RESUMED')
                  && (!messageContentIntent.coreDemand || messageContentIntent.gatewayIntentActive)
                ) {
                  input.reportReadiness?.();
                }
                await admitDispatch(effect);
                break;
              case 'scheduleHeartbeat':
                clearHeartbeat();
                heartbeatHandle = clock.setTimeout(() => {
                  if (signal.aborted || controlResult || reconnectRequested) return;
                  void processEffects(session.onHeartbeatTimer()).catch(() => requestReconnect());
                }, effect.afterMs);
                break;
              case 'disconnect':
                socket.close({ code: 4_000, reason: effect.reason });
                break;
              case 'historyGap':
                controlResult = { kind: 'historyGap', reason: effect.reason };
                socket.close({ code: 4_000, reason: effect.reason });
                break;
              case 'reconnect':
                reconnectRequested = true;
                reconnectDelayBounds = { minDelayMs: effect.minDelayMs, maxDelayMs: effect.maxDelayMs };
                break;
              case 'blocked':
                controlResult = { kind: 'blocked', reason: effect.reason, retryAtMs: effect.retryAtMs };
                socket.close({ code: 4_000, reason: effect.reason });
                break;
              case 'terminal':
                if (effect.reason === 'disallowedIntents' && messageContentIntent.coreDemand) {
                  messageContentIntent.gatewayIntentActive = false;
                  controlResult = messageContentIntentRecovery({
                    source: 'gateway4014',
                    state: messageContentIntent,
                    failure: {
                      kind: 'notReady',
                      reason: 'permissionMissing',
                      diagnostic: 'Discord refused the requested Message Content intent (Gateway close 4014).',
                    },
                  });
                } else {
                  controlResult = { kind: 'terminal', reason: effect.reason };
                }
                socket.close({ code: 4_000, reason: effect.reason });
                break;
            }
          }
        };

        try {
          while (!signal.aborted && !controlResult) {
            if (providerFailure !== null) {
              controlResult = { kind: 'notReady', failure: providerFailure };
              break;
            }
            if (admissionLost) {
              controlResult = { kind: 'historyGap', reason: 'applicationAdmissionLost' };
              break;
            }
            let received: Awaited<ReturnType<PluginWebSocketConnection['receive']>>;
            try {
              received = await socket.receive({ signal });
            } catch {
              if (signal.aborted) break;
              requestReconnect();
              break;
            }
            if (providerFailure !== null) {
              controlResult = { kind: 'notReady', failure: providerFailure };
              break;
            }
            if (admissionLost) {
              controlResult = { kind: 'historyGap', reason: 'applicationAdmissionLost' };
              break;
            }
            if (received.kind === 'closed') {
              if (!reconnectRequested) {
                await processEffects(session.onClose({ code: received.close.code ?? 1_006 }));
              }
              break;
            }
            const frame = toGatewayFrame(received);
            if (frame === null) {
              requestReconnect();
              break;
            }
            try {
              await processEffects(session.onFrame(frame, clock.now()));
            } catch {
              requestReconnect();
              break;
            }
            if (providerFailure !== null) {
              controlResult = { kind: 'notReady', failure: providerFailure };
              break;
            }
            if (admissionLost) {
              controlResult = { kind: 'historyGap', reason: 'applicationAdmissionLost' };
              break;
            }
            if (reconnectRequested) break;
          }
        } finally {
          clearHeartbeat();
          releaseUnsentIdentify();
          resume = copyResume(session.snapshot().resume);
          if (resume === undefined) messageContentIntent.gatewayIntentActive = false;
          if (pendingAdmissions.size > 0) mustDrainIncumbentAdmissions = true;
          await disposeSocket(socket);
          if (activeSocket === socket) activeSocket = null;
        }

        if (signal.aborted) break;
        if (providerFailure !== null) {
          completedResult = { kind: 'notReady', failure: providerFailure };
          break;
        }
        if (admissionLost) {
          completedResult = { kind: 'historyGap', reason: 'applicationAdmissionLost' };
          break;
        }
        if (controlResult) {
          completedResult = controlResult;
          break;
        }
        if (!reconnectRequested) reconnectRequested = true;
        if (reconnectRequested) {
          const delayMs = calculateDiscordReconnectDelayMs(reconnectAttempt, reconnectDelayBounds);
          reconnectAttempt += 1;
          try {
            await clock.sleep(delayMs, signal);
          } catch {
            if (signal.aborted) break;
            completedResult = workerFailure('network', 'Discord Gateway reconnect delay failed.');
            break;
          }
        }
      }
    } finally {
      // The Gateway loop owns its own teardown. Await every unresolved
      // admission before publishing any outcome: a rejection is the canonical
      // application-loss fact, including after a terminal Gateway result.
      signal.removeEventListener('abort', captureAdmissionsAtCancellation);
      activeSocket?.close({ code: 1_000, reason: 'Discord Gateway worker stopped' });
      const settledAdmissions = await Promise.allSettled([
        ...admissionsAtCancellation,
        ...pendingAdmissions,
      ]);
      rejectedAdmissionAtTeardown = settledAdmissions.some((result) => result.status === 'rejected');
    }
    if (admissionLost || rejectedAdmissionAtTeardown) {
      const transportFact = { kind: 'historyGap', reason: 'applicationAdmissionLost' } as const;
      return providerFailure === null
        ? transportFact
        : { kind: 'notReady', failure: providerFailure, transportFact };
    }
    if (providerFailure !== null) return { kind: 'notReady', failure: providerFailure };
    return completedResult ?? { kind: 'stopped' };
  })().finally(() => input.signal.removeEventListener('abort', abortFromParent));

  return Object.freeze({
    result,
    stop() {
      if (!controller.signal.aborted) controller.abort(new Error('Discord Gateway worker was stopped.'));
      activeSocket?.close({ code: 1_000, reason: 'Discord Gateway worker stopped' });
    },
  });
}
