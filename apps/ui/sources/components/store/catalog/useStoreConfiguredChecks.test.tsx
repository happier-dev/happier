import { afterEach, expect, it } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import type { AutomationDefinitionDetail } from '@happier-dev/protocol/automations/automationApiV3';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { createAutomationDefinitionFromDetail, createAutomationDefinitionSummary } from '@/sync/domains/automations/automationDefinitionProjection';
import type { PluginEventAutomationStoredContentAccess } from '@/sync/domains/automations/pluginEventAutomationEditSeed';
import { useStoreConfiguredChecks } from './useStoreConfiguredChecks';

afterEach(standardCleanup);
it('reads configured never-run checks from exact held private detail, and keeps unloaded or mismatched content unknown', async () => {
    const triggerId = '33333333-3333-4333-8333-333333333333';
    const binding = { v: 1 as const, automationId: 'health', triggerId, triggerRevision: 1,
        triggerKind: 'pluginEvent' as const, eventRef: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'health-status' },
        sourceSelectorId: '22222222-2222-4222-8222-222222222222' };
    const sourceConfig = { v: 1, subject: { kind: 'environment', environmentId: 'env-one' }, checks: [{ checkId: 'check-one',
        kind: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'tcp' }, binding: { kind: 'healthCheck' },
        config: { host: 'localhost', port: 80 }, periodMs: 60_000, consecutiveFailuresBeforeAlerting: 2 }] };
    const envelope = sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding,
        definition: { v: 1, sourceInstanceId: 'source-one', sourceConfig, displayLabel: 'Checks', filter: null, maximumObservationAgeMs: null } });
    const detail: AutomationDefinitionDetail = { id: binding.automationId, name: 'Checks', description: null, enabled: true,
        targetType: 'existingSession', existingSessionId: 'session-1', templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
        assignments: [], triggers: [{ id: triggerId, revision: 1, enabled: true, createdAt: 1, updatedAt: 1, kind: 'pluginEvent',
            eventRef: binding.eventRef, sourceSelectorId: binding.sourceSelectorId, sourceContractVersion: 1,
            observation: { kind: 'checkpointedPull', watcher: null }, sourceStatus: null, sourceCatalogStatus: null,
            triggerDefinitionEnvelope: JSON.stringify(envelope) }], executionRecipe: { v: 1, templateVersion: 1,
            template: { t: 'plain', v: { v: 1, prompt: 'Observe' } }, triggerEvidence: null, target: { kind: 'existingSession', sessionId: 'session-1' } } };
    let definition = createAutomationDefinitionFromDetail(detail);
    let access: PluginEventAutomationStoredContentAccess = { mode: 'plain' };
    const hook = await renderHook(() => useStoreConfiguredChecks({ definition, triggerId, access }));
    expect(hook.getCurrent()).toEqual(sourceConfig);
    access = { mode: 'e2ee' };
    await hook.rerender();
    expect(hook.getCurrent()).toBeNull();
    access = { mode: 'plain' };
    const { executionRecipe: _recipe, triggers, ...summary } = detail;
    definition = createAutomationDefinitionSummary({ ...summary, triggers: triggers.map(({ triggerDefinitionEnvelope: _envelope, ...trigger }) => trigger) });
    await hook.rerender();
    expect(hook.getCurrent()).toBeNull();
    definition = createAutomationDefinitionFromDetail(detail);
    definition = { ...definition, templateVersion: 2 };
    await hook.rerender();
    expect(hook.getCurrent()).toBeNull();
    await hook.unmount();
});
