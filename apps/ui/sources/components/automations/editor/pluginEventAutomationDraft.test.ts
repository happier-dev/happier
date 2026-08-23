import { describe, expect, it } from 'vitest';
import {
    DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema,
    type DaemonContributionRegistryProjectionAutomationEligibleEventV1,
} from '@happier-dev/protocol';

import {
    buildPlainPluginEventAutomationExecutionRecipe,
    buildPluginEventAutomationDetachedExecutionRunRequest,
    buildPluginEventAutomationDefinitionPatchRequest,
    buildPluginEventAutomationDefinitionCreateRequest,
    createPluginEventAutomationAuthoringDraft,
} from './pluginEventAutomationDraft';

function eligibleEvent(): DaemonContributionRegistryProjectionAutomationEligibleEventV1 {
    return DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
        event: {
            id: 'acme.github/events/repository',
            identity: { pluginId: 'acme.github', localId: 'events/repository' },
            immutableGenerationId: 'github-generation-a',
            title: 'Repository updates',
            description: null,
            payloadSchema: {
                type: 'object',
                properties: {
                    action: { type: 'string' },
                    repository: {
                        type: 'object',
                        properties: { id: { type: 'number' } },
                        required: ['id'],
                        additionalProperties: false,
                    },
                },
                required: ['action', 'repository'],
                additionalProperties: false,
            },
            automation: {
                v: 1,
                eligible: true,
                source: {
                    sourceContractVersion: 3,
                    supportedObservationTransports: ['checkpointedPull'],
                    sourceConfigSchema: {
                        type: 'object',
                        properties: { repositoryId: { type: 'string', minLength: 1 } },
                        required: ['repositoryId'],
                        additionalProperties: false,
                    },
                    setupActionRef: {
                        pluginId: 'acme.github',
                        localId: 'setup/repository-source',
                    },
                },
            },
        },
        setupAction: {
            id: 'acme.github/actions/setup/repository-source',
            identity: { pluginId: 'acme.github', localId: 'setup/repository-source' },
            immutableGenerationId: 'github-generation-a',
            title: 'Configure repository source',
            description: null,
            inputSchema: {
                type: 'object',
                properties: { repository: { type: 'string', minLength: 1 } },
                required: ['repository'],
                additionalProperties: false,
            },
            inputHints: null,
        },
    });
}

describe('Plugin Event Automation authoring draft', () => {
    it('builds one strict plain Event definition from exact current source and watcher facts', () => {
        const event = eligibleEvent();
        const draft = createPluginEventAutomationAuthoringDraft({
            eligibleEvent: event,
            observation: { kind: 'checkpointedPull' },
            setupResult: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
            },
            watcherOrigin: {
                serverIdentityId: 'srv_account_a',
                materializationRef: {
                    machineId: 'watcher-machine',
                    materializationId: 'github-materialization-a',
                    pluginId: 'acme.github',
                },
            },
            filter: {
                v: 1,
                all: [{ op: 'eq', field: '/action', value: 'opened' }],
            },
            maximumObservationAgeMs: 60_000,
        });
        expect(draft).not.toBeNull();
        if (!draft) return;

        const executionRecipe = buildPlainPluginEventAutomationExecutionRecipe({
            templateVersion: 1,
            prompt: 'Triage {{input}}',
            target: {
                kind: 'newSession',
                spawn: {
                    executionTarget: { serverId: 'server-account-a', machineId: 'executor-machine' },
                    directory: '/workspace/acme',
                    agentTarget: {
                        kind: 'agent',
                        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                    },
                },
            },
        });
        expect(executionRecipe).not.toBeNull();
        if (!executionRecipe) return;

        const request = buildPluginEventAutomationDefinitionCreateRequest({
            name: 'Repository triage',
            description: 'For new repository activity',
            enabled: true,
            eligibleEvents: [event],
            draft,
            watcherOrigin: draft.watcherOrigin,
            executionRecipe,
            assignments: [{ machineId: 'executor-machine', enabled: true, priority: 100 }],
        });

        expect(request).toEqual(expect.objectContaining({
            name: 'Repository triage',
            description: 'For new repository activity',
            enabled: true,
            trigger: expect.objectContaining({
                kind: 'pluginEvent',
                eventRef: { pluginId: 'acme.github', localId: 'events/repository' },
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
                observationTransport: {
                    kind: 'checkpointedPull',
                    watcherMaterializationRef: {
                        machineId: 'watcher-machine',
                        materializationId: 'github-materialization-a',
                        pluginId: 'acme.github',
                    },
                },
                filter: {
                    v: 1,
                    all: [{ op: 'eq', field: '/action', value: 'opened' }],
                },
                maximumObservationAgeMs: 60_000,
            }),
            executionRecipe: expect.objectContaining({
                v: 1,
                templateVersion: 1,
                template: { t: 'plain', v: { v: 1, prompt: 'Triage {{input}}' } },
                triggerEvidence: null,
                target: expect.objectContaining({
                    kind: 'newSession',
                    spawn: expect.objectContaining({
                        executionTarget: { serverId: 'server-account-a', machineId: 'executor-machine' },
                    }),
                }),
            }),
        }));
        expect(request).not.toHaveProperty('sourceSelectorId');
        expect(request).not.toHaveProperty('templateVersion');
    });

    it('fails closed when a same-local-id replacement changes the exact Event or setup Action generation', () => {
        const event = eligibleEvent();
        const draft = createPluginEventAutomationAuthoringDraft({
            eligibleEvent: event,
            observation: { kind: 'checkpointedPull' },
            setupResult: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
            },
            watcherOrigin: {
                serverIdentityId: 'srv_account_a',
                materializationRef: {
                    machineId: 'watcher-machine',
                    materializationId: 'github-materialization-a',
                    pluginId: 'acme.github',
                },
            },
            filter: null,
            maximumObservationAgeMs: null,
        });
        expect(draft).not.toBeNull();
        if (!draft) return;

        const executionRecipe = buildPlainPluginEventAutomationExecutionRecipe({
            templateVersion: 1,
            prompt: 'Triage {{input}}',
            target: {
                kind: 'newSession',
                spawn: {
                    executionTarget: { serverId: 'server-account-a', machineId: 'executor-machine' },
                    directory: '/workspace/acme',
                    agentTarget: {
                        kind: 'agent',
                        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                    },
                },
            },
        });
        expect(executionRecipe).not.toBeNull();
        if (!executionRecipe) return;

        const replaced = DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
            ...event,
            setupAction: {
                ...event.setupAction,
                immutableGenerationId: 'github-generation-b',
            },
        });

        expect(buildPluginEventAutomationDefinitionCreateRequest({
            name: 'Repository triage',
            description: null,
            enabled: true,
            eligibleEvents: [replaced],
            draft,
            watcherOrigin: draft.watcherOrigin,
            executionRecipe,
            assignments: [{ machineId: 'executor-machine', enabled: true, priority: 100 }],
        })).toBeNull();
    });

    it('builds a full Event patch only when the replacement recipe advances the exact direct-detail version', () => {
        const event = eligibleEvent();
        const draft = createPluginEventAutomationAuthoringDraft({
            eligibleEvent: event,
            observation: { kind: 'checkpointedPull' },
            setupResult: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
            },
            watcherOrigin: {
                serverIdentityId: 'srv_account_a',
                materializationRef: {
                    machineId: 'watcher-machine',
                    materializationId: 'github-materialization-a',
                    pluginId: 'acme.github',
                },
            },
            filter: null,
            maximumObservationAgeMs: null,
        });
        expect(draft).not.toBeNull();
        if (!draft) return;

        const executionRecipe = buildPlainPluginEventAutomationExecutionRecipe({
            templateVersion: 4,
            prompt: 'Triage {{input}}',
            target: {
                kind: 'newSession',
                spawn: {
                    executionTarget: { serverId: 'server-account-a', machineId: 'executor-machine' },
                    directory: '/workspace/acme',
                    agentTarget: {
                        kind: 'agent',
                        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                    },
                },
            },
        });
        expect(executionRecipe).not.toBeNull();
        if (!executionRecipe) return;

        const input = {
            name: 'Repository triage',
            description: null,
            enabled: true,
            eligibleEvents: [event],
            draft,
            watcherOrigin: draft.watcherOrigin,
            executionRecipe,
            assignments: [{ machineId: 'executor-machine', enabled: true, priority: 100 }],
        } as const;

        expect(buildPluginEventAutomationDefinitionPatchRequest({
            ...input,
            expectedTemplateVersion: 3,
        })).toEqual(expect.objectContaining({
            expectedTemplateVersion: 3,
            executionRecipe: expect.objectContaining({ templateVersion: 4 }),
        }));
        expect(buildPluginEventAutomationDefinitionPatchRequest({
            ...input,
            expectedTemplateVersion: 4,
        })).toBeNull();
    });

    it('preserves the selected strict existing-session or detached-run target instead of deriving a new session', () => {
        const existingSession = buildPlainPluginEventAutomationExecutionRecipe({
            templateVersion: 1,
            prompt: 'Triage {{input}}',
            target: {
                kind: 'existingSession',
                sessionId: 'session-existing',
            },
        });
        const executionRun = buildPlainPluginEventAutomationExecutionRecipe({
            templateVersion: 1,
            prompt: 'Triage {{input}}',
            target: {
                kind: 'executionRun',
                request: {
                    intent: 'task',
                    backendTarget: { kind: 'backend', backendId: 'codex' },
                    permissionMode: 'read_only',
                    retentionPolicy: 'ephemeral',
                    runClass: 'bounded',
                    ioMode: 'request_response',
                },
            },
        });

        expect(existingSession?.target).toEqual({
            kind: 'existingSession',
            sessionId: 'session-existing',
        });
        expect(executionRun?.target).toEqual(expect.objectContaining({
            kind: 'executionRun',
            request: expect.objectContaining({
                intent: 'task',
                permissionMode: 'read_only',
                retentionPolicy: 'ephemeral',
                runClass: 'bounded',
                ioMode: 'request_response',
            }),
        }));
    });

    it('builds only the detached task configuration and rejects prompt/resume carriers', () => {
        const request = buildPluginEventAutomationDetachedExecutionRunRequest({
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            permissionMode: 'read_only',
            modelSelection: {
                v: 1,
                updatedAt: 1,
                ref: {
                    agentTargetKey: 'backend:codex',
                    providerConnectionId: null,
                    modelId: 'gpt-5.6',
                },
            },
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 1,
                overrides: {
                    effort: { value: 'high', updatedAt: 1 },
                },
            },
            connectedServices: { v: 1, bindingsByServiceId: {} },
        });

        expect(request).toEqual(expect.objectContaining({
            intent: 'task',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
            modelSelection: {
                agentTargetKey: 'backend:codex',
                providerConnectionId: null,
                modelId: 'gpt-5.6',
            },
        }));
        expect(request).not.toHaveProperty('instructions');
        expect(request).not.toHaveProperty('intentInput');
        expect(request).not.toHaveProperty('resumeHandle');
    });
});
