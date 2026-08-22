import axios from 'axios';

import {
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
} from '@happier-dev/protocol';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
import { startSingleFlightIntervalLoop, type SingleFlightIntervalLoopHandle } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import type { StoredCredentials } from '@/persistence';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
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
type TargetV1 = Readonly<{
  materialization: Readonly<{ machineId: string; materializationId: string; pluginId: string }>;
  machineInstallationId: string;
}>;

export type PluginWebhookDaemonWorkerHandleV1 = Omit<SingleFlightIntervalLoopHandle, 'stop'> & Readonly<{
  stop(): Promise<void>;
}>;

export function createPluginWebhookDaemonHttpTransportV1(credentials: StoredCredentials): PluginWebhookDeliveryWorkerTransportV1 & Readonly<{
  claim(target: TargetV1, signal?: AbortSignal): Promise<ReturnType<typeof PluginWebhookClaimResultV1Schema.parse>>;
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
    async claim(target, signal) {
      const body = PluginWebhookClaimRequestV1Schema.parse({ v: 1, policyVersion: 1, target });
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

async function executeWebhookHandlerV1(
  actionId: string,
  input: PluginWebhookActionInputV1,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<PluginWebhookActionResultV1> {
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
  try {
    const execution = await executeContributedAction({
      runtimeRegistry: lease.registry,
      actionId,
      input,
      context: {
        surface: 'plugin',
        invocationSurface: 'background',
        ...(options?.signal ? { signal: options.signal } : {}),
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

/** One daemon-owned polling loop over exact current materialization epochs. */
export function startPluginWebhookDaemonWorkerV1(params: Readonly<{
  credentials: StoredCredentials;
  machineId: () => string;
  machineInstallationId: string;
  enabled: () => boolean;
  logger: LoggerLike;
  intervalMs?: number;
}>): PluginWebhookDaemonWorkerHandleV1 {
  const transport = createPluginWebhookDaemonHttpTransportV1(params.credentials);
  const stateStore = createPluginRegistryStateStore({ happyHomeDir: configuration.happyHomeDir });
  const shutdownController = new AbortController();
  let activeTask: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  const loop = startSingleFlightIntervalLoop({
    intervalMs: params.intervalMs ?? 2_000,
    failureBackoffMs: 2_000,
    maxFailureBackoffMs: 60_000,
    unref: true,
    task: async () => {
      const task = (async () => {
        if (shutdownController.signal.aborted || !params.enabled()) return;
        const inventory = await stateStore.readAvailabilityInventory();
        if (shutdownController.signal.aborted) return;
        const targets: TargetV1[] = inventory.materializations
          .filter((row) => row.enabled && row.trustState === 'trusted')
          .map((row) => ({
            materialization: {
              machineId: params.machineId(),
              materializationId: row.materializationId,
              pluginId: row.pluginId,
            },
            machineInstallationId: params.machineInstallationId,
          }));
        for (const target of targets) {
          if (shutdownController.signal.aborted) return;
          const claim = await transport.claim(target, shutdownController.signal);
          if (shutdownController.signal.aborted || claim.kind !== 'delivery') continue;
          await processClaimedPluginWebhookDeliveryV1({
            claim,
            target,
            credentials: params.credentials,
            transport,
            execute: executeWebhookHandlerV1,
            signal: shutdownController.signal,
          });
        }
      })();
      const settledTask = task.catch((error) => {
        if (!shutdownController.signal.aborted) throw error;
      });
      activeTask = settledTask;
      try {
        await settledTask;
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
