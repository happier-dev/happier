import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import {
  createProviderSettingsAccountHarness,
  createProviderSettingsHarness,
  installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storage');
const { MonitoringScreen } = await import('./MonitoringScreen');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { InboxArtifactSourceBoundary } = await import('@/hooks/inbox/useInboxArtifactSource');

afterEach(async () => {
  standardCleanup();
  await account.reset();
  rpc.reset();
});

// Monitoring is the one home for saved Checks (owner 11-28); these moved here with Deployments' retired Checks view.

const { createAutomationDefinitionSummary } = await import('@/sync/domains/automations/automationDefinitionProjection');
const { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1 } = await import('@happier-dev/protocol/deployments/healthCheckV1');
const healthCheckSummary = (id: string) => createAutomationDefinitionSummary({ id, name: `Check ${id}`, description: null, enabled: true,
  targetType: 'existingSession', existingSessionId: 'session-1', templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [],
  triggers: [{ id: `33333333-3333-4333-8333-33333333333${id}`, revision: 1, enabled: true, createdAt: 1, updatedAt: 1, kind: 'pluginEvent',
    eventRef: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'health-status' }, sourceSelectorId: '22222222-2222-4222-8222-222222222222',
    sourceContractVersion: 1, observation: { kind: 'checkpointedPull', watcher: null }, sourceStatus: null, sourceCatalogStatus: null }] } as never);

const checkRowId = (id: string) => `services.checks.row.${id}.${healthCheckSummary(id).triggers[0]!.id}`;

/** The saved Check's private definition as the Home answers it (managedOperationalInventory.test's fixture shape). */
async function healthCheckDetail(id: string) {
  const { sealAutomationTriggerDefinitionStoredEnvelopeV1 } = await import('@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent');
  const { AutomationDefinitionDetailSchema } = await import('@happier-dev/protocol/automations/automationApiV3');
  const { AutomationSourceSelectorIdV1Schema } = await import('@happier-dev/protocol/automations/automationEventDeclarationV1');
  const summary = healthCheckSummary(id);
  const { detail: _privateDetail, linkedExistingSessionId: _linkedSession, ...summaryInput } = summary;
  const trigger = summary.triggers[0]!;
  if (trigger.kind !== 'pluginEvent') throw new Error('Expected health Event fixture');
  return AutomationDefinitionDetailSchema.parse({ ...summaryInput, targetType: null, existingSessionId: null,
    observationOnly: { kind: 'observationOnly', templateVersion: summary.templateVersion },
    triggers: [{ ...trigger, triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
      mode: 'plain' as const,
      binding: { v: 1, automationId: summary.id, triggerId: trigger.id, triggerRevision: trigger.revision,
        triggerKind: 'pluginEvent', eventRef: trigger.eventRef, sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(trigger.sourceSelectorId) },
      definition: { v: 1, sourceInstanceId: `health:shop:${id}`, displayLabel: `Check ${id}`,
        sourceConfig: { v: 1, subject: { kind: 'environment', environmentId: 'shop' }, checks: [{ checkId: 'readiness',
          kind: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'http' }, binding: { kind: 'healthCheck' },
          config: { endpoint: 'https://shop.example/ready', expectStatus: 204 }, periodMs: 300_000, consecutiveFailuresBeforeAlerting: 1 }] },
        filter: null, maximumObservationAgeMs: null },
    })) }] });
}

// Partly read results (a Check's health history) are facts of listed rows, not missing rows: no "haven't loaded" line.
it('lists saved Checks without a "haven\'t loaded" line while only their results are partly read', async () => {
  await account.restore({ serverIdentityId: 'srv_monitoring_checks_results', machines: [], httpAnswers: {
    'POST /v3/automations/query': { body: { automations: await Promise.all(['1', '2'].map(healthCheckDetail)), nextCursor: null } } } });
  await act(async () => { storage.setState({ automations: { '1': healthCheckSummary('1'), '2': healthCheckSummary('2') }, isDataReady: true, automationDefinitionNextCursor: null }); });
  const screen = await renderScreen(<InboxArtifactSourceBoundary>
    <AppPaneProvider><MonitoringScreen /></AppPaneProvider>
  </InboxArtifactSourceBoundary>);
  await vi.waitFor(() => expect(screen.findHostByTestId(checkRowId('2')), screen.getTextContent()).not.toBeNull());
  expect(screen.findHostByTestId('monitoring.checks.coverage.partial')).toBeNull();
});

it('shows saved Checks from the next Automation page without requiring Show more', async () => {
  const [first, second] = await Promise.all(['1', '2'].map(healthCheckDetail));
  const nextPage = Promise.withResolvers<void>();
  await account.restore({ serverIdentityId: 'srv_monitoring_checks_paged', machines: [], httpAnswers: {
    'POST /v3/automations/query': { select: input => {
      const next = typeof input === 'object' && input !== null && 'cursor' in input && input.cursor === 'cursor-2';
      return next
        ? { body: { automations: [second], nextCursor: null }, respondAfter: nextPage.promise }
        : { body: { automations: [first], nextCursor: 'cursor-2' } };
    } },
  } });
  await act(async () => { storage.setState({ automations: { '1': healthCheckSummary('1') }, isDataReady: true, automationDefinitionNextCursor: 'cursor-2' }); });
  const screen = await renderScreen(<InboxArtifactSourceBoundary>
    <AppPaneProvider><MonitoringScreen /></AppPaneProvider>
  </InboxArtifactSourceBoundary>);
  try {
    // The first page lists, then the Automation read continues by itself: no Show more to press.
    await vi.waitFor(() => expect(screen.findHostByTestId(checkRowId('1'))).not.toBeNull());
  } finally {
    nextPage.resolve();
  }
  await vi.waitFor(() => expect(screen.findHostByTestId(checkRowId('2'))).not.toBeNull());
  expect(screen.findHostByTestId(checkRowId('1'))).not.toBeNull();
  expect(screen.findHostByTestId('monitoring.checks.paging.more')).toBeNull();
});
