import { describe, expect, it } from 'vitest';

import { PluginSourceCustodyV1Schema, PluginWebhookActionResultV1Schema, type PluginWebhookClaimResultV1 } from '@happier-dev/protocol';

import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { createUnavailablePluginServicesFactory } from '@/plugins/runtime/invocation/services/factory';
import { createTargetActionInvocationRegistry } from '@/plugins/runtime/invocation/targetActionRegistry';
import { executeContributedAction, type PluginActionExecutionAttempt } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';

import { processClaimedPluginWebhookDeliveryV1 } from './webhookDeliveryWorker';

function claim(): Extract<PluginWebhookClaimResultV1, { kind: 'delivery' }> {
  const now = Date.now();
  return {
    kind: 'delivery', deliveryId: 'delivery-1', pluginVersion: '1.0.0',
    target: {
      materialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'acme.github' },
      machineInstallationId: 'installation-1',
    },
    endpoint: {
      webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw', revision: 1,
      webhookContribution: { pluginId: 'acme.github', localId: 'github-events' },
      handlerActionLocalId: 'handle-webhook', sourceInstanceId: 'source-1',
    },
    attempt: 1, replay: 0, receivedAtMs: now,
    envelope: { t: 'plain', v: {
      v: 1, receivedAtMs: now, contentType: 'application/json', headers: [],
      rawBodyBytes: 2, rawBodyBase64: 'e30=',
      verified: { verifier: 'github_hmac_sha256_v1', providerDeliveryId: 'provider-1', credentialVersionId: 'credential-1' },
    } },
    lease: { leaseId: 'lease-1', revision: 1, firstClaimAtMs: now, expiresAtMs: now + 120_000, maxClaimUntilMs: now + 600_000 },
  };
}

describe('webhook delivery canonical Action admission', () => {
  it('charges no execution for denied admission, then invokes the available handler as attempt one', async () => {
    let available = false;
    let attempts = 0;
    const effects: number[] = [];
    const executions: PluginActionExecutionAttempt[] = [];
    const occurrenceId = createPluginRuntimeOccurrenceId('acme.github');
    const target = createTargetActionInvocationRegistry({ readMachineLocalDatabaseAgentLevel: async () => undefined,
      actions: [{
        pluginId: 'acme.github', pluginVersion: '1.0.0', occurrenceId, localId: 'handle-webhook',
        sourceCustody: PluginSourceCustodyV1Schema.parse({
          kind: 'managed', immutableGenerationId: 'webhook-handler-generation', installSource: 'archive',
        }),
        definition: { id: 'handle-webhook', dangerLevel: 'safe', scopes: ['global'], surfaces: ['plugin'] },
        handler: async (input) => {
          const delivery = (input as { delivery: { attempt: number } }).delivery;
          effects.push(delivery.attempt);
          return { kind: 'settled', disposition: 'accepted' };
        },
      }],
      resolveAuthorizationFacts: (action) => ({
        generation: { targetGeneration: action.occurrenceId, desiredGeneration: available ? action.occurrenceId : '2', appliedGeneration: action.occurrenceId },
        resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [],
      }),
      resolveHostBinding: createTargetActionHostBindingResolver(),
      createServices: createUnavailablePluginServicesFactory(),
      readCurrentPluginOccurrenceId: (pluginId) => pluginId === 'acme.github' ? occurrenceId : null,
    });
    // Only the catalog fields consumed by this Action corridor are populated;
    // dispatch, preparation, policy and invocation below are the real owners.
    const runtimeRegistry = {
      contributes: { actionsById: new Map([['acme.github/handle-webhook', {
        pluginId: 'acme.github', definition: { id: 'handle-webhook', surfaces: { plugin: true } },
      }]]) },
      targetActionInvocations: target,
      readPluginOccurrenceId: (pluginId: string) => pluginId === 'acme.github' ? occurrenceId : null,
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
    const processDelivery = () => processClaimedPluginWebhookDeliveryV1({
      claim: claim(), credentials: { token: 'token', encryption: null },
      transport: {
        renew: async ({ transition }) => {
          if (transition === 'executionStarted') attempts += 1;
          return { kind: 'renewed', revision: 2, expiresAtMs: Date.now() + 120_000 };
        },
        complete: async () => ({ kind: 'settled', state: 'succeeded' }),
        fail: async () => ({ kind: 'settled', state: 'queued' }),
      },
      execute: async (_actionId, input, options?: Readonly<{ signal?: AbortSignal; beforeHandlerInvocation?: () => Promise<void> }>) => {
        const execution = await executeContributedAction({
          runtimeRegistry, actionId: 'acme.github/handle-webhook', input,
          context: { surface: 'plugin', ...options },
        });
        executions.push(execution);
        return execution.matched && execution.result.ok
          ? PluginWebhookActionResultV1Schema.parse(execution.result.result)
          : { kind: 'retry', code: 'handler_unavailable' };
      },
    });
    try {
      await processDelivery();
      expect({ attempts, effects }).toEqual({ attempts: 0, effects: [] });
      available = true;
      const result = await processDelivery();
      expect(executions.at(-1)).toEqual({
        matched: true,
        result: { ok: true, result: { kind: 'settled', disposition: 'accepted' } },
      });
      expect(result).toEqual({ kind: 'settled', state: 'succeeded' });
      expect({ attempts, effects }).toEqual({ attempts: 1, effects: [1] });
    } finally {
      target.dispose();
    }
  });
});
