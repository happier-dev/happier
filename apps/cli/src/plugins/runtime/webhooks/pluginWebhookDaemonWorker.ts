import axios from 'axios';

import {
  arePluginMachineMaterializationRefsEqual,
  PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
  PluginWebhookClaimRequestV1Schema,
  PluginWebhookClaimResultV1Schema,
  PluginWebhookCompleteRequestV1Schema,
  PluginWebhookFailRequestV1Schema,
  PluginWebhookRenewRequestV1Schema,
  PluginWebhookRenewResultV1Schema,
  PluginWebhookSettleResultV1Schema,
  type PluginWebhookActionInputV1,
  type PluginWebhookActionResultV1,
  type PluginWebhookClaimRequestV1,
  type PluginWebhookClaimResultV1,
} from '@happier-dev/protocol';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
import { startSingleFlightIntervalLoop, type SingleFlightIntervalLoopHandle } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import type { StoredCredentials } from '@/persistence';
import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import { executeContributedAction } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

import {
  processClaimedPluginWebhookDeliveryV1,
  type PluginWebhookDeliveryWorkerTransportV1,
} from './webhookDeliveryWorker';

type LoggerLike = Readonly<{ debug(message: string, details?: unknown): void }>;
export type PluginWebhookMachineInstallationV1 = PluginWebhookClaimRequestV1['machine'];
export type PluginWebhookDeliveryTargetV1 = Extract<PluginWebhookClaimResultV1, { kind: 'delivery' }>['target'];

export type PluginWebhookDaemonWorkerHandleV1 = Omit<SingleFlightIntervalLoopHandle, 'stop'> & Readonly<{
  stop(): Promise<void>;
}>;

export function createPluginWebhookDaemonHttpTransportV1(credentials: StoredCredentials): PluginWebhookDeliveryWorkerTransportV1 & Readonly<{
  claim(machine: PluginWebhookMachineInstallationV1, signal?: AbortSignal): Promise<ReturnType<typeof PluginWebhookClaimResultV1Schema.parse>>;
}> {
  const post = async (path: string, body: unknown, signal?: AbortSignal) => {
    const publisherHeader = await createDefaultPluginInstallationPublisherHeader({
      method: 'POST',
      path,
      body,
    });
    if (!publisherHeader) {
      throw new Error('plugin_webhook_machine_proof_unavailable');
    }
    const response = await axios.post(`${resolveServerHttpBaseUrl()}${path}`, body, {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${credentials.token}`,
        [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader,
      },
      timeout: configuration.sessionControlHttpTimeoutMs,
      validateStatus: (status) => status >= 200 && status < 300,
      ...(signal ? { signal } : {}),
    });
    return response.data;
  };
  return Object.freeze({
    async claim(machine, signal) {
      const body = PluginWebhookClaimRequestV1Schema.parse({ v: 1, policyVersion: 1, machine });
      return PluginWebhookClaimResultV1Schema.parse(await post('/v1/daemon/plugins/webhooks/claim', body, signal));
    },
    async renew(input) {
      const body = PluginWebhookRenewRequestV1Schema.parse({
        v: 1,
        target: input.target,
        lease: input.lease,
        transition: input.transition,
      });
      return PluginWebhookRenewResultV1Schema.parse(await post(
        `/v1/daemon/plugins/webhooks/${encodeURIComponent(input.deliveryId)}/renew`,
        body,
        input.signal,
      ));
    },
    async complete(input) {
      const body = PluginWebhookCompleteRequestV1Schema.parse({
        v: 1,
        target: input.target,
        lease: input.lease,
        result: input.result,
      });
      return PluginWebhookSettleResultV1Schema.parse(await post(
        `/v1/daemon/plugins/webhooks/${encodeURIComponent(input.deliveryId)}/complete`,
        body,
        input.signal,
      ));
    },
    async fail(input) {
      const body = PluginWebhookFailRequestV1Schema.parse({
        v: 1,
        target: input.target,
        lease: input.lease,
        result: input.result,
        ...(input.automationAdmissionUnresolved
          ? { automationAdmissionUnresolved: input.automationAdmissionUnresolved }
          : {}),
      });
      return PluginWebhookSettleResultV1Schema.parse(await post(
        `/v1/daemon/plugins/webhooks/${encodeURIComponent(input.deliveryId)}/fail`,
        body,
        input.signal,
      ));
    },
  });
}

export async function executeWebhookHandlerV1(
  actionId: string,
  input: PluginWebhookActionInputV1,
  options: Readonly<{
    target: PluginWebhookDeliveryTargetV1;
    signal?: AbortSignal;
  }>,
): Promise<PluginWebhookActionResultV1> {
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
  try {
    const currentTarget = lease.resolveCurrentPluginMaterializationRef?.(
      options.target.materialization.pluginId,
    ) ?? null;
    if (
      currentTarget === null
      || !arePluginMachineMaterializationRefsEqual(
        currentTarget,
        options.target.materialization,
      )
    ) {
      return { kind: 'retry', code: 'handler_unavailable' };
    }
    const execution = await executeContributedAction({
      runtimeRegistry: lease.registry,
      actionId,
      input,
      context: {
        surface: 'plugin',
        invocationSurface: 'background',
        ...(options.signal ? { signal: options.signal } : {}),
        caller: {
          kind: 'host',
          domain: 'ingress',
          originSurface: 'webhook',
          contribution: {
            id: input.endpoint.webhookContribution.localId,
            qualifiedId: `${input.endpoint.webhookContribution.pluginId}/${input.endpoint.webhookContribution.localId}`,
          },
        },
      },
    });
    if (!execution.matched || !execution.result.ok) {
      return { kind: 'retry', code: 'handler_unavailable' };
    }
    return execution.result.result as PluginWebhookActionResultV1;
  } finally {
    await lease.release();
  }
}

/**
 * Typed internal reason for the intentional cancellation of one parked claim
 * HTTP request when a wake arrives. The worker suppresses exactly this abort;
 * every other claim failure keeps the existing handling.
 */
const PLUGIN_WEBHOOK_WAKE_CLAIM_ABORT_REASON_V1 = Object.freeze({
  kind: 'pluginWebhookClaimWakeAbortV1',
} as const);

/**
 * One daemon-owned claim loop per Account/machine installation. Each wake
 * issues exactly one authenticated claim; the server selects the one currently
 * eligible exact materialization target, and the daemon dispatches exactly the
 * returned target/endpoint authority. The server may park an empty claim
 * response for its fixed window, so every claim runs on a per-claim abort
 * controller composed with shutdown only while the claim request is in
 * flight: a wake trigger aborts the parked request with the typed wake reason
 * and the single-flight loop coalesces exactly one forced rerun once that
 * iteration settles. Daemon-generation currentness stays with the canonical
 * Action invocation lifecycle; the server claim response never carries daemon
 * immutable generation. Renew/complete/fail stay exact-target. Eligibility
 * (enabled, trust, release correspondence) is server-owned; this loop keeps
 * no local inventory copy and no second queue.
 */
export function startPluginWebhookDaemonWorkerV1(params: Readonly<{
  credentials: StoredCredentials;
  machineId: () => string;
  machineInstallationId: string;
  enabled: () => boolean;
  logger: LoggerLike;
  intervalMs?: number;
}>): PluginWebhookDaemonWorkerHandleV1 {
  const transport = createPluginWebhookDaemonHttpTransportV1(params.credentials);
  const shutdownController = new AbortController();
  let activeClaimAbort: AbortController | null = null;
  let activeTask: Promise<void | { nextAutomaticRunAfterMs: number }> | null = null;
  let stopping: Promise<void> | null = null;
  const loop = startSingleFlightIntervalLoop({
    intervalMs: params.intervalMs ?? 2_000,
    failureBackoffMs: 2_000,
    maxFailureBackoffMs: 60_000,
    unref: true,
    task: async () => {
      let claimAbort: AbortController | null = null;
      const task = (async () => {
        if (shutdownController.signal.aborted || !params.enabled()) return;
        const machine = {
          machineId: params.machineId(),
          machineInstallationId: params.machineInstallationId,
        } as const;
        claimAbort = new AbortController();
        activeClaimAbort = claimAbort;
        const claim = await transport.claim(
          machine,
          // Shutdown composition spans only the parked claim request; the
          // per-claim controller is cleared the moment the claim settles.
          AbortSignal.any([shutdownController.signal, claimAbort.signal]),
        ).finally(() => {
          if (activeClaimAbort === claimAbort) activeClaimAbort = null;
        });
        if (shutdownController.signal.aborted) return;
        if (claim.kind !== 'delivery') return { nextAutomaticRunAfterMs: claim.retryAfterMs };
        await processClaimedPluginWebhookDeliveryV1({
          claim,
          credentials: params.credentials,
          transport,
          execute: (actionId, input, options) => executeWebhookHandlerV1(
            actionId,
            input,
            {
              target: claim.target,
              ...(options?.signal ? { signal: options.signal } : {}),
            },
          ),
          signal: shutdownController.signal,
        });
        return undefined;
      })();
      const settledTask = task.catch((error) => {
        if (shutdownController.signal.aborted) return;
        // Only the exact intentional wake cancellation of the parked claim
        // request is suppressed: the wake trigger's coalesced forced rerun
        // supersedes it. Every other failure keeps the existing handling.
        if (claimAbort?.signal.reason === PLUGIN_WEBHOOK_WAKE_CLAIM_ABORT_REASON_V1) return;
        throw error;
      });
      activeTask = settledTask;
      try {
        return await settledTask;
      } finally {
        if (activeTask === settledTask) activeTask = null;
      }
    },
    onError: (error) => {
      params.logger.debug('[PLUGIN WEBHOOK] Delivery worker iteration failed', {
        error: projectPluginFailureText(error),
      });
    },
  });
  loop.trigger();
  return Object.freeze({
    ...loop,
    trigger: () => {
      // Abort the currently parked claim HTTP request, then coalesce exactly
      // one forced rerun once the cancelled iteration settles. When no claim
      // is parked (idle or mid-delivery), this is only the loop trigger.
      activeClaimAbort?.abort(PLUGIN_WEBHOOK_WAKE_CLAIM_ABORT_REASON_V1);
      loop.trigger();
    },
    stop: () => {
      if (stopping) return stopping;
      stopping = (async () => {
        shutdownController.abort(new Error('plugin_webhook_daemon_stopped'));
        loop.stop();
        await Promise.resolve();
        await activeTask;
      })();
      return stopping;
    },
  });
}
