import { afterEach, expect, it } from 'vitest';
import { AutomationSourceSelectorIdV1Schema } from '@happier-dev/protocol/automations/automationEventDeclarationV1';
import { standardCleanup } from '@/dev/testkit';
import {
  createProviderSettingsAccountHarness,
  createProviderSettingsHarness,
  installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { createKeyFlowFixture } from '@/dev/testkit/fixtures/serviceCheckRowFixtures';

// The real sync owner, store and stored-content opening under the canonical Account HTTP boundary.
const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storage');
const { listSavedServiceCheckOptions } = await import('./savedCheckOptions');
const { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1 } =
  await import('@happier-dev/protocol/deployments/healthCheckV1');
const { TELEMETRY_KEY_FLOW_HEALTH_KIND_V1 } =
  await import('@happier-dev/database-protocol');
const { readAutomationDefinitionDetailsDemand } =
  await import('@/sync/domains/automations/automationReadDemand');
const { captureActiveServerAccountScopeLifetime } =
  await import('@/sync/domains/scope/activeServerAccountScope');

afterEach(async () => {
  standardCleanup();
  await account.reset();
  rpc.reset();
});

/** One saved Check as the server holds it: the Automation summary and its sealed private trigger definition. */
async function savedCheck(
  id: string,
  name: string,
  check: Readonly<{
    kind: { pluginId: string; localId: string };
    config: unknown;
  }>,
) {
  const { sealAutomationTriggerDefinitionStoredEnvelopeV1 } =
    await import('@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent');
  const { AutomationDefinitionDetailSchema } =
    await import('@happier-dev/protocol/automations/automationApiV3');
  const trigger = {
    id: `33333333-3333-4333-8333-33333333333${id}`,
    revision: 1,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    kind: 'pluginEvent' as const,
    eventRef: {
      pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1,
      localId: 'health-status',
    },
    sourceSelectorId: '22222222-2222-4222-8222-222222222222',
    sourceContractVersion: 1,
    observation: { kind: 'checkpointedPull', watcher: null },
    sourceStatus: null,
    sourceCatalogStatus: null,
  };
  return AutomationDefinitionDetailSchema.parse({
    id: `automation-${id}`,
    name,
    description: null,
    enabled: true,
    targetType: null,
    existingSessionId: null,
    templateVersion: 1,
    lastRunAt: null,
    createdAt: 1,
    updatedAt: 1,
    assignments: [],
    observationOnly: { kind: 'observationOnly', templateVersion: 1 },
    triggers: [
      {
        ...trigger,
        id: trigger.id,
        triggerDefinitionEnvelope: JSON.stringify(
          sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: 'plain',
            binding: {
              v: 1,
              automationId: `automation-${id}`,
              triggerId: trigger.id,
              triggerRevision: 1,
              triggerKind: 'pluginEvent',
              eventRef: trigger.eventRef,
              sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(
                trigger.sourceSelectorId,
              ),
            },
            definition: {
              v: 1,
              sourceInstanceId: `health:billing:${id}`,
              displayLabel: name,
              sourceConfig: {
                v: 1,
                subject: {
                  kind: 'environment',
                  environmentId: 'env-billing-prod',
                },
                checks: [
                  {
                    checkId: 'c',
                    kind: check.kind,
                    binding: { kind: 'healthCheck' },
                    config: check.config,
                    periodMs: 60_000,
                    consecutiveFailuresBeforeAlerting: 1,
                  },
                ],
              },
              filter: null,
              maximumObservationAgeMs: null,
            },
          }),
        ),
      },
    ],
  });
}

it('names each saved Check as the Checks list does, from its private definition, and releases the definition demand', async () => {
  const checkout = createKeyFlowFixture('Checkout', {
    limitMs: 800,
    routes: ['GET /api/cart', 'POST /checkout'],
  });
  const automations = await Promise.all([
    savedCheck('1', 'Checkout key flow', {
      kind: {
        pluginId: TELEMETRY_KEY_FLOW_HEALTH_KIND_V1.pluginId,
        localId: TELEMETRY_KEY_FLOW_HEALTH_KIND_V1.localId,
      },
      config: checkout,
    }),
    savedCheck('2', 'Billing availability', {
      kind: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'http' },
      config: {
        endpoint: 'https://billing.acme.dev/health',
        expectStatus: 200,
      },
    }),
  ]);
  const page = { body: { automations, nextCursor: null } };
  await account.restore({
    serverIdentityId: 'srv_saved_check_options',
    machines: [],
    httpAnswers: {
      'POST /v3/automations/query': page,
      'GET /v3/automations': page,
    },
  });
  const scope = storage.getState().settingsScope!;
  const listed = await listSavedServiceCheckOptions(
    { serverId: scope.serverId },
    undefined,
  );
  expect(listed).toEqual({
    items: [
      {
        automationId: 'automation-2',
        triggerId: automations[1]!.triggers[0]!.id,
        label: 'billing.acme.dev/health',
        description: 'Billing availability',
      },
      {
        automationId: 'automation-1',
        triggerId: automations[0]!.triggers[0]!.id,
        label: 'Checkout',
        description: 'GET /api/cart, POST /checkout',
      },
    ],
  });
  expect(
    readAutomationDefinitionDetailsDemand(
      captureActiveServerAccountScopeLifetime(),
    ),
  ).toBe(false);
});

it('lists nothing for another Home', async () => {
  await account.restore({
    serverIdentityId: 'srv_saved_check_other',
    machines: [],
  });
  expect(
    await listSavedServiceCheckOptions(
      { serverId: 'some-other-home' },
      undefined,
    ),
  ).toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
});
