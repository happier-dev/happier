import { PluginManifestV2LoadSchema } from '@happier-dev/protocol/plugins/manifest';
import { readIndexedBundledDeclarationManifest } from '../../../../../cli/src/plugins/projection/registry/builtIn/declarationAssetFormat.mjs';
import { afterEach, expect, it, onTestFinished } from 'vitest';
import { AutomationSourceSelectorIdV1Schema } from '@happier-dev/protocol/automations/automationEventDeclarationV1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol/v1';
import { standardCleanup } from '@/dev/testkit';
import {
  createProviderSettingsAccountHarness,
  createProviderSettingsHarness,
  installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { createKeyFlowFixture } from '@/dev/testkit/fixtures/serviceCheckRowFixtures';
import { installBundledPluginUiDeclarationsForTests } from '@/dev/testkit/mocks/bundledPluginUiAssets';

import { projectBundledPluginUiDeclaration, projectBundledPluginUiFirstPaintDeclaration } from '../../../../../cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs';

const bundledMachineServices = PluginManifestV2LoadSchema.parse(readIndexedBundledDeclarationManifest(new URL('../../../../../cli/assets/bundled-plugin-manifests/machine-services.json', import.meta.url)));

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
  const declaration = await projectBundledPluginUiDeclaration({
    packageName: '@happier-dev/plugins-machine-services', packageVersion: bundledMachineServices.version,
    manifest: bundledMachineServices, artifactGraphs: [],
  });
  if (!declaration) throw new Error('Expected the bundled Machine services declaration');
  onTestFinished(installBundledPluginUiDeclarationsForTests([await projectBundledPluginUiFirstPaintDeclaration(declaration)]));
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
  const localHttp = await savedCheck('3', 'Billing local', {
    kind: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'http' },
    config: { endpoint: 'http://127.0.0.1:8080/health', expectStatus: 200 },
  });
  const page = { body: { automations: [...automations, localHttp], nextCursor: null } };
  const serverIdentityId = 'srv_saved_check_options';
  const environment = createDeploymentEnvironmentHeaderV1({
    id: 'env-billing-prod', serverId: serverIdentityId, contentArtifactId: 'artifact-billing-production',
  });
  await account.restore({
    serverIdentityId,
    machines: [],
    httpAnswers: {
      'POST /v3/automations/query': page,
      'GET /v3/automations': page,
      'GET /v1/deployments/environments': { body: { ok: true, items: [environment], nextCursor: null } },
    },
  });
  const scope = storage.getState().settingsScope!;
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const writer = await captureLazyActionAccountContext(scope.serverId);
  try {
    const { content } = createDeploymentEnvironmentDetailV1({ environment });
    await writer.createArtifactDocument({ artifactId: environment.contentArtifactId,
      header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Billing production' },
      body: JSON.stringify({ ...content, name: 'Billing production' }),
    });
  } finally { writer.dispose(); }
  const listed = await listSavedServiceCheckOptions(
    { serverId: scope.serverId },
    undefined,
  );
  expect(listed).toEqual({
    items: [
      {
        automationId: 'automation-1',
        triggerId: automations[0]!.triggers[0]!.id,
        sourceInstanceId: 'health:billing:1',
        label: 'Checkout',
        description: 'GET /api/cart, POST /checkout',
      },
      {
        automationId: 'automation-3',
        triggerId: localHttp.triggers[0]!.id,
        sourceInstanceId: 'health:billing:3',
        label: 'HTTP · Billing production',
        description: '127.0.0.1:8080/health',
      },
      {
        automationId: 'automation-2',
        triggerId: automations[1]!.triggers[0]!.id,
        sourceInstanceId: 'health:billing:2',
        label: 'HTTP · billing.acme.dev',
        description: 'billing.acme.dev/health',
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
