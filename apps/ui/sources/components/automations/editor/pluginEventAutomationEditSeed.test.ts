import {
    AutomationDefinitionDetailSchema} from '@happier-dev/protocol/automations/automationApiV3';
import {
    AutomationSourceSelectorIdV1Schema} from '@happier-dev/protocol/automations/automationEventJsonBoundsV1';
import {
    AutomationTriggerIdSchema} from '@happier-dev/protocol/automations/automationTriggerIdentity';
import {
    sealAutomationTriggerDefinitionStoredEnvelopeV1} from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import {
    type PluginJsonValueV2,
} from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { describe, expect, it, vi } from 'vitest';

import { createAutomationDefinitionFromDetail } from '@/sync/domains/automations/automationDefinitionProjection';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import {
    pluginEventAutomationEditSeedFromDraftInput,
    readPluginEventAutomationEditSeed,
    readPluginEventAutomationPrivateDetail,
} from '@/sync/domains/automations/pluginEventAutomationEditSeed';

const triggerId = AutomationTriggerIdSchema.parse('trigger-event-1');
await loadSyncSingletonForTests();

function eventDefinition(
    revision = 4,
    observationKind: 'checkpointedPull' | 'socket' = 'checkpointedPull',
    storedFields: Readonly<Record<string, PluginJsonValueV2>> = {},
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
            ...storedFields,
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
                    directory: { kind: 'path', path: '/workspace' },
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                },
            },
        },
    });
    return createAutomationDefinitionFromDetail(detail);
}

describe('pluginEventAutomationEditSeed', () => {
    it('retains observation-only intent when reopening a definition without an execution recipe', () => {
        const definition = eventDefinition();
        if (definition.detail.kind !== 'available') throw new Error('Expected private detail');
        const { executionRecipe: _recipe, ...detail } = definition.detail.value;
        const observation = createAutomationDefinitionFromDetail(AutomationDefinitionDetailSchema.parse({ ...detail,
            targetType: null, assignments: [], observationOnly: { kind: 'observationOnly', templateVersion: detail.templateVersion } }));
        expect(readPluginEventAutomationEditSeed(observation, triggerId, { mode: 'plain' })?.source.observationOnly)
            .toEqual({ kind: 'observationOnly' });
    });
    it('opens retained event definitions without discarding opaque source config', () => {
        const sourceConfig = { repository: 'acme/widgets', retired: { nativeField: 'opaque-source-value' } };
        const definition = eventDefinition(4, 'checkpointedPull', { sourceConfig, retired: { enabled: true } });
        const privateDetail = readPluginEventAutomationPrivateDetail(definition, triggerId, { mode: 'plain' });
        expect(privateDetail?.storedDefinition).toEqual({
            v: 1, sourceInstanceId: 'repository:42', sourceConfig, displayLabel: 'acme/widgets', filter: null, maximumObservationAgeMs: null,
        });
        expect(readPluginEventAutomationEditSeed(definition, triggerId, { mode: 'plain' })?.source.sourceConfig).toEqual(sourceConfig);
    });
    it.each(['available', 'unloaded'] as const)('opens a saved event through Sync currentness, acquiring private content only when needed (%s)', async detailKind => {
        const { sync } = await import('@/sync/sync');
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        const { storage } = await import('@/sync/domains/state/storage');
        const owner = sync as unknown as {
            credentials: import('@/auth/storage/tokenStorage').AuthCredentials | undefined;
            appliedServerTarget: { serverId: string; serverUrl: string; generation: number } | null;
            getAutomationPluginEventEditSeed(automationId: string, triggerId: string): Promise<unknown>;
        };
        const previousCredentials = owner.credentials;
        const previousTarget = owner.appliedServerTarget;
        const previousAutomations = storage.getState().automations;
        const definition = eventDefinition();
        if (definition.detail.kind !== 'available') throw new Error('Expected private detail');
        storage.setState({ automations: { [definition.id]: detailKind === 'available' ? definition
            : { ...definition, detail: { kind: 'unloaded', templateVersion: definition.templateVersion } } } });
        // apiSocket's prepared request is the network boundary; API parsing, currentness and opening stay real.
        const paths: string[] = [];
        const transport = vi.spyOn(apiSocket, 'createRequestForPreparedTarget').mockReturnValue(async (path: string) => {
            paths.push(path);
            return new Response(JSON.stringify(path === '/v1/account/encryption/currentness'
                ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
                : definition.detail.kind === 'available' ? definition.detail.value : null), { status: 200 });
        });
        owner.credentials = { token: 'event-authoring-token' };
        owner.appliedServerTarget = { serverId: 'event-authoring-home', serverUrl: 'https://event-authoring.test', generation: 0 };
        try {
            await expect(owner.getAutomationPluginEventEditSeed('automation-1', triggerId)).resolves.toMatchObject({
                triggerId, expectedTriggerRevision: 4, source: { sourceInstanceId: 'repository:42', sourceConfig: { repository: 'acme/widgets' } },
            });
            expect(paths.filter(path => path === '/v3/automations/automation-1')).toHaveLength(detailKind === 'available' ? 0 : 1);
            expect(paths.filter(path => path === '/v1/account/encryption/currentness')).toHaveLength(1);
        } finally {
            transport.mockRestore();
            owner.credentials = previousCredentials;
            owner.appliedServerTarget = previousTarget;
            storage.setState({ automations: previousAutomations });
        }
    });
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
