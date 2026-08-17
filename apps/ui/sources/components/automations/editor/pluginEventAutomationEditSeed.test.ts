import {
    AutomationSourceSelectorIdV1Schema,
    AutomationV3DefinitionDetailSchema,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import type {
    AutomationDefinition,
    AutomationDefinitionAvailable,
} from '@/sync/domains/automations/automationTypes';
import { createAutomationDefinitionFromDetail } from '@/sync/domains/automations/automationDefinitionProjection';

import {
    readPluginEventAutomationEditSeed,
    readPluginEventAutomationPrivateDetail,
} from './pluginEventAutomationEditSeed';

function isAvailablePluginEventDefinition(
    definition: AutomationDefinition,
): definition is AutomationDefinitionAvailable<'pluginEvent'> {
    return definition.trigger.kind === 'pluginEvent' && definition.detail.kind === 'available';
}

function eventDefinition(params: Readonly<{
    envelopeSourceSelectorId?: string;
    filter?: { v: 1; all: Array<{ op: 'eq'; field: string; value: string }> } | null;
    target?:
        | Readonly<{
            kind: 'existingSession';
            sessionId: string;
        }>
        | Readonly<{
            kind: 'newSession';
            spawn: Readonly<{
                executionTarget: Readonly<{ serverId: string; machineId: string }>;
                directory: string;
                agentTarget: Readonly<{
                    kind: 'agent';
                    identity: Readonly<{ pluginId: string; localId: string }>;
                }>;
            }>;
        }>
        | Readonly<{
            kind: 'executionRun';
            request: Readonly<{
                intent: 'task';
                backendTarget: Readonly<{ kind: 'builtInAgent'; agentId: string }>;
                permissionMode: 'no_tools' | 'read_only';
                retentionPolicy: 'ephemeral';
                runClass: 'bounded';
                ioMode: 'request_response';
            }>;
        }>;
}> = {}): AutomationDefinitionAvailable<'pluginEvent'> {
    const templateVersion = 7;
    const target = params.target ?? {
        kind: 'newSession' as const,
        spawn: {
            executionTarget: { serverId: 'server-1', machineId: 'executor-machine' },
            directory: '/workspace/acme',
            agentTarget: {
                kind: 'agent' as const,
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
        },
    };
    const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse('11111111-1111-4111-8111-111111111111');
    const envelopeSourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(
        params.envelopeSourceSelectorId ?? sourceSelectorId,
    );
    const detail = AutomationV3DefinitionDetailSchema.parse({
        id: 'automation-event-1',
        name: 'Repository triage',
        description: 'Review repository updates',
        enabled: true,
        trigger: {
            kind: 'pluginEvent',
            eventRef: { pluginId: 'acme.github', localId: 'repository-updated' },
            sourceSelectorId,
            sourceContractVersion: 3,
            observation: {
                kind: 'checkpointedPull',
                watcher: {
                    machineId: 'watcher-machine',
                    machineInstallationId: 'watcher-installation',
                    pluginId: 'acme.github',
                    materializationId: 'github-materialization',
                },
            },
        },
        targetType: target.kind,
        templateVersion,
        nextRunAt: null,
        lastRunAt: null,
        createdAt: 1,
        updatedAt: 2,
        assignments: [{ machineId: 'executor-machine', enabled: true, priority: 100, updatedAt: null }],
        triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: 'plain',
            binding: {
                v: 1,
                automationId: 'automation-event-1',
                templateVersion,
                triggerKind: 'pluginEvent',
                eventRef: { pluginId: 'acme.github', localId: 'repository-updated' },
                sourceSelectorId: envelopeSourceSelectorId,
            },
            definition: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceConfig: { repository: 'acme/widgets' },
                displayLabel: 'acme/widgets',
                filter: params.filter === undefined
                    ? { v: 1, all: [{ op: 'eq', field: '/action', value: 'opened' }] }
                    : params.filter,
                maximumObservationAgeMs: 60_000,
            },
        })),
        executionRecipe: {
            v: 1,
            templateVersion,
            template: {
                t: 'plain',
                v: { v: 1, prompt: 'Review {{input}}' },
            },
            triggerEvidence: null,
            target,
        },
    });
    const definition = createAutomationDefinitionFromDetail(detail);
    if (
        !isAvailablePluginEventDefinition(definition)
        || definition.targetType !== target.kind
    ) {
        throw new Error('Expected Plugin Event Automation detail fixture');
    }
    return definition;
}

describe('readPluginEventAutomationEditSeed', () => {
    it('reads a private Event detail only for a current available direct definition and preserves an absent optional filter', () => {
        const available = eventDefinition({ filter: null });
        const unavailable: AutomationDefinition = {
            ...available,
            detail: {
                kind: 'unavailable',
                templateVersion: available.templateVersion,
                code: 'automation_stored_content_unavailable',
            },
        };
        const stale: AutomationDefinition = {
            ...available,
            detail: {
                kind: 'available',
                templateVersion: available.templateVersion + 1,
                value: available.detail.value,
            },
        };

        expect(readPluginEventAutomationPrivateDetail(available)?.storedDefinition.filter).toBeNull();
        expect(readPluginEventAutomationPrivateDetail(unavailable)).toBeNull();
        expect(readPluginEventAutomationPrivateDetail(stale)).toBeNull();
    });

    it('hydrates a transient Event edit seed only from the matching plain direct detail', () => {
        const seed = readPluginEventAutomationEditSeed(eventDefinition());

        expect(seed).toMatchObject({
            automationId: 'automation-event-1',
            expectedTemplateVersion: 7,
            eventRef: { pluginId: 'acme.github', localId: 'repository-updated' },
            source: {
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repository: 'acme/widgets' },
                displayLabel: 'acme/widgets',
            },
            watcherMaterializationRef: {
                machineId: 'watcher-machine',
                pluginId: 'acme.github',
                materializationId: 'github-materialization',
            },
            filter: { v: 1, all: [{ op: 'eq', field: '/action', value: 'opened' }] },
            maximumObservationAgeMs: 60_000,
            prompt: 'Review {{input}}',
            target: {
                kind: 'newSession',
                spawn: {
                executionTarget: { serverId: 'server-1', machineId: 'executor-machine' },
                directory: '/workspace/acme',
                },
            },
        });
    });

    it('hydrates existing-session and detached execution-run target arms without reinterpreting either as a spawn', () => {
        const existingSession = readPluginEventAutomationEditSeed(eventDefinition({
            target: { kind: 'existingSession', sessionId: 'session-existing' },
        }));
        const executionRun = readPluginEventAutomationEditSeed(eventDefinition({
            target: {
                kind: 'executionRun',
                request: {
                    intent: 'task',
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                    permissionMode: 'no_tools',
                    retentionPolicy: 'ephemeral',
                    runClass: 'bounded',
                    ioMode: 'request_response',
                },
            },
        }));

        expect(existingSession?.target).toEqual({
            kind: 'existingSession',
            sessionId: 'session-existing',
        });
        expect(executionRun?.target).toEqual(expect.objectContaining({
            kind: 'executionRun',
            request: expect.objectContaining({
                intent: 'task',
                permissionMode: 'no_tools',
            }),
        }));
    });

    it('fails closed when the private envelope is bound to a different source selector', () => {
        expect(readPluginEventAutomationEditSeed(eventDefinition({
            envelopeSourceSelectorId: '22222222-2222-4222-8222-222222222222',
        }))).toBeNull();
    });
});
