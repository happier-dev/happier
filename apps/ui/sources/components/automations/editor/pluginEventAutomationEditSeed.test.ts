import {
    AutomationDefinitionDetailSchema,
    AutomationSourceSelectorIdV1Schema,
    AutomationTriggerIdSchema,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createAutomationDefinitionFromDetail } from '@/sync/domains/automations/automationDefinitionProjection';
import {
    pluginEventAutomationEditSeedFromDraftInput,
    readPluginEventAutomationEditSeed,
    readPluginEventAutomationPrivateDetail,
} from './pluginEventAutomationEditSeed';

const triggerId = AutomationTriggerIdSchema.parse('trigger-event-1');

function eventDefinition(
    revision = 4,
    observationKind: 'checkpointedPull' | 'socket' = 'checkpointedPull',
) {
    const eventRef = { pluginId: 'acme.github', localId: 'issue-opened' };
    const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse('11111111-1111-4111-8111-111111111111');
    const triggerDefinitionEnvelope = JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
        mode: 'plain',
        binding: {
            v: 1,
            automationId: 'automation-1',
            triggerId,
            triggerRevision: revision,
            triggerKind: 'pluginEvent',
            eventRef,
            sourceSelectorId,
        },
        definition: {
            v: 1,
            sourceInstanceId: 'repository:42',
            sourceConfig: { repository: 'acme/widgets' },
            displayLabel: 'acme/widgets',
            filter: null,
            maximumObservationAgeMs: null,
        },
    }));
    const detail = AutomationDefinitionDetailSchema.parse({
        id: 'automation-1', name: 'Repository triage', description: null, enabled: true,
        targetType: 'newSession', existingSessionId: null, templateVersion: 7,
        lastRunAt: null, createdAt: 1, updatedAt: 2,
        assignments: [{ machineId: 'machine-1', enabled: true, priority: 100, updatedAt: null }],
        triggers: [{
            id: triggerId, revision, enabled: false, createdAt: 1, updatedAt: 2, kind: 'pluginEvent',
            eventRef, sourceSelectorId, sourceContractVersion: 3,
            observation: {
                kind: observationKind,
                watcher: {
                    machineId: 'machine-1', machineInstallationId: 'installation-1',
                    pluginId: 'acme.github', materializationId: 'github-1',
                },
            },
            sourceStatus: null, sourceCatalogStatus: null, triggerDefinitionEnvelope,
        }],
        executionRecipe: {
            v: 1, templateVersion: 7,
            template: { t: 'plain', v: { v: 1, prompt: 'Review the issue.' } },
            triggerEvidence: null,
            target: {
                kind: 'newSession',
                spawn: {
                    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                    directory: '/workspace',
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                },
            },
        },
    });
    return createAutomationDefinitionFromDetail(detail);
}

describe('pluginEventAutomationEditSeed', () => {
    it('opens and seeds only the explicitly requested trigger identity and revision', () => {
        const definition = eventDefinition();
        const privateDetail = readPluginEventAutomationPrivateDetail(definition, triggerId, { mode: 'plain' });
        const seed = readPluginEventAutomationEditSeed(definition, triggerId, { mode: 'plain' });

        expect(privateDetail?.storedDefinition.displayLabel).toBe('acme/widgets');
        expect(seed).toMatchObject({
            automationId: 'automation-1',
            triggerId: 'trigger-event-1', expectedTriggerRevision: 4, enabled: false,
            eventRef: { pluginId: 'acme.github', localId: 'issue-opened' },
            source: { sourceInstanceId: 'repository:42', sourceContractVersion: 3 },
            observation: {
                kind: 'checkpointedPull',
                watcherMaterializationRef: { machineId: 'machine-1', machineInstallationId: 'installation-1' },
            },
        });
        expect(readPluginEventAutomationEditSeed(definition, 'another-trigger', { mode: 'plain' })).toBeNull();
    });

    it('rejects a summary/detail revision that no longer matches the private binding', () => {
        const definition = eventDefinition();
        const stale = {
            ...definition,
            triggers: definition.triggers.map((trigger) => ({ ...trigger, revision: trigger.revision + 1 })),
        };
        expect(readPluginEventAutomationPrivateDetail(stale, triggerId, { mode: 'plain' })).toBeNull();
    });

    it('rehydrates a socket trigger as a watcher arm without inventing webhook fields', () => {
        const seed = readPluginEventAutomationEditSeed(
            eventDefinition(4, 'socket'),
            triggerId,
            { mode: 'plain' },
        );

        expect(seed?.observation).toEqual({
            kind: 'socket',
            watcherMaterializationRef: {
                machineId: 'machine-1',
                machineInstallationId: 'installation-1',
                pluginId: 'acme.github',
                materializationId: 'github-1',
            },
        });
        expect(seed?.observation).not.toHaveProperty('webhookEndpointId');

        const draft = pluginEventAutomationEditSeedFromDraftInput({
            automationId: 'automation-draft',
            triggerId: 'trigger-draft',
            value: {
                kind: 'pluginEvent',
                enabled: true,
                eventRef: { pluginId: 'acme.github', localId: 'issue-opened' },
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repository: 'acme/widgets' },
                displayLabel: 'acme/widgets',
                observationTransport: {
                    kind: 'socket',
                    watcherMaterializationRef: {
                        machineId: 'machine-1',
                        pluginId: 'acme.github',
                        materializationId: 'github-1',
                    },
                },
                filter: null,
                maximumObservationAgeMs: null,
            },
        });
        expect(draft.observation).toEqual({
            kind: 'socket',
            watcherMaterializationRef: {
                machineId: 'machine-1',
                pluginId: 'acme.github',
                materializationId: 'github-1',
            },
        });
    });
});
