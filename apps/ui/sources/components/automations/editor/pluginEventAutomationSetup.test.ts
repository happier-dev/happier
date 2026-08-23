import { describe, expect, it, vi } from 'vitest';
import {
    DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema,
    PluginMachineMaterializationV1Schema,
    type DaemonContributionRegistryProjectionAutomationEligibleEventV1,
} from '@happier-dev/protocol';

import type {
    PluginProjectionAction,
    PluginProjectionEntry,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import type { PluginContributedActionDispatch } from '@/components/plugins/actions/pluginContributedActionController';
import type { FreshPluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';

import {
    buildPlainPluginEventAutomationExecutionRecipe,
    buildPluginEventAutomationDefinitionCreateRequest,
} from './pluginEventAutomationDraft';
import { configurePluginEventAutomationSetup } from './pluginEventAutomationSetup';

const PLUGIN_ID = 'acme.github';
const EVENT_LOCAL_ID = 'events/repository';
const SETUP_ACTION_LOCAL_ID = 'setup/choose-a-repository';
const MACHINE_ID = 'watcher-machine';
const SERVER_ID = 'server-a';
const SERVER_IDENTITY_ID = 'srv_account_a';
const MATERIALIZATION_ID = 'github-materialization-a';
const GENERATION = 17;

const ACCOUNT = {
    service: { pluginId: 'com.acme.accounts', localId: 'github' },
    accountId: 'account-a',
} as const;

const ACCOUNT_LIFETIME = Object.freeze({
    scope: Object.freeze({ serverId: SERVER_ID, accountId: 'account-a' }),
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose() {} }),
});

function eligibleEvent(immutableGenerationId = 'github-generation-a'):
DaemonContributionRegistryProjectionAutomationEligibleEventV1 {
    return DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
        event: {
            id: `${PLUGIN_ID}/${EVENT_LOCAL_ID}`,
            identity: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
            immutableGenerationId,
            title: 'Repository updates',
            description: null,
            payloadSchema: {
                type: 'object',
                properties: { eventId: { type: 'string' } },
                required: ['eventId'],
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
                    setupActionRef: { pluginId: PLUGIN_ID, localId: SETUP_ACTION_LOCAL_ID },
                },
            },
        },
        setupAction: {
            id: `${PLUGIN_ID}/${SETUP_ACTION_LOCAL_ID}`,
            identity: { pluginId: PLUGIN_ID, localId: SETUP_ACTION_LOCAL_ID },
            immutableGenerationId,
            title: 'Choose a repository',
            description: null,
            inputSchema: {
                type: 'object',
                properties: {
                    repository: { type: 'string', minLength: 1 },
                    credentialRef: {
                        type: 'object',
                        properties: {
                            service: {
                                type: 'object',
                                properties: {
                                    pluginId: { type: 'string' },
                                    localId: { type: 'string' },
                                },
                                required: ['pluginId', 'localId'],
                                additionalProperties: false,
                            },
                            accountId: { type: 'string' },
                        },
                        required: ['service', 'accountId'],
                        additionalProperties: false,
                    },
                },
                required: ['repository', 'credentialRef'],
                additionalProperties: false,
            },
            inputHints: {
                fields: [
                    { path: 'repository', title: 'Repository', widget: 'text', required: true },
                    {
                        path: 'credentialRef',
                        title: 'Account',
                        widget: 'select',
                        connectedAccountOptions: true,
                        required: true,
                    },
                ],
            },
        },
    });
}

function projectionAction(
    event: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
): PluginProjectionAction {
    return {
        id: event.setupAction.identity.localId,
        title: event.setupAction.title,
        description: event.setupAction.description,
        icon: null,
        scopes: ['settings'],
        surfaces: ['plugin'],
        placementBindings: [],
        inputSchema: event.setupAction.inputSchema,
        inputHints: event.setupAction.inputHints,
        slash: null,
        priority: null,
        dangerLevel: 'safe',
        confirmation: null,
        available: true,
    };
}

function projectionInputs(
    event: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
): DaemonMergedProjectionInputs {
    const plugin: PluginProjectionEntry = {
        pluginId: PLUGIN_ID,
        immutableGenerationId: event.setupAction.immutableGenerationId,
        title: 'Acme GitHub',
        description: null,
        version: '1.0.0',
        enabled: true,
        generation: GENERATION,
        generationLabel: String(GENERATION),
        status: null,
        provenance: null,
        diagnostics: [],
        actions: [projectionAction(event)],
        resources: [],
        editableSettingsGroups: [],
    };
    return {
        mergedProviderProjectionById: {},
        mergedBackendProjectionById: {},
        discoveredBackendIds: [],
        pluginProjectionById: { [PLUGIN_ID]: plugin },
        pluginProjectionV2: {
            v: 2,
            generation: GENERATION,
            installedPackagesById: {},
            agentsById: {},
            backendsById: {},
            actionsById: {
                [`${PLUGIN_ID}/${event.setupAction.identity.localId}`]: {
                    id: event.setupAction.identity.localId,
                    pluginId: PLUGIN_ID,
                    title: event.setupAction.title,
                    scopes: ['settings'],
                    surfaces: ['plugin'],
                    execution: { target: 'daemon' },
                    placementBindings: [],
                    priority: 0,
                    dangerLevel: 'safe',
                    available: true,
                },
            },
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            settingsById: {},
            familiesById: {},
            diagnostics: [],
        },
        automationEligibleEvents: [event],
        registryDiagnostics: [],
    };
}

function executionOrigin(
    materializationId = MATERIALIZATION_ID,
    pluginId = PLUGIN_ID,
): FreshPluginMachineExecutionOriginV1 {
    const materialization = PluginMachineMaterializationV1Schema.parse({
        serverIdentityId: SERVER_IDENTITY_ID,
        machineId: MACHINE_ID,
        materializationId,
        pluginId,
        version: '1.0.0',
        sourceClass: 'registryPackage',
        portableRelease: true,
        uiArtifacts: [],
        enabled: true,
        trustState: 'trusted',
        observedAt: 1_700_000_000_000,
    });
    return {
        origin: {
            serverIdentityId: SERVER_IDENTITY_ID,
            materializationRef: {
                machineId: MACHINE_ID,
                materializationId,
                pluginId,
            },
        },
        materialization,
        machineTarget: {
            kind: 'resolved',
            target: { serverIdentityId: SERVER_IDENTITY_ID, machineId: MACHINE_ID },
            serverId: SERVER_ID,
            profile: {
                id: SERVER_ID,
                name: 'Server A',
                serverUrl: 'https://server-a.invalid',
                serverIdentityId: SERVER_IDENTITY_ID,
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: 1,
            },
            machine: {
                id: MACHINE_ID,
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: null,
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 1,
            },
        },
    };
}

const WEBHOOK_LOCAL_ID = 'github-events';
const WEBHOOK_ENDPOINT_ID = 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA';

/** The same Event, declaring the push arm its webhook contribution serves. */
function durablePushEligibleEvent(): DaemonContributionRegistryProjectionAutomationEligibleEventV1 {
    const base = eligibleEvent();
    return DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
        ...base,
        event: {
            ...base.event,
            automation: {
                ...base.event.automation,
                source: {
                    ...base.event.automation.source,
                    supportedObservationTransports: ['checkpointedPull', 'durablePush'],
                    webhookContributionRef: { pluginId: PLUGIN_ID, localId: WEBHOOK_LOCAL_ID },
                },
            },
        },
    });
}

function durablePushSetupParams(
    event: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
): Omit<Parameters<typeof configurePluginEventAutomationSetup>[0], 'observationTransport'> {
    return {
        eligibleEvent: event,
        filter: null,
        maximumObservationAgeMs: null,
        accountLifetime: ACCOUNT_LIFETIME,
        resolveExecutionOrigin: () => executionOrigin(),
        loadCurrentProjection: async () => projectionInputs(event),
        resolveConnectedAccountOptions: vi.fn(async () => ({
            supported: true as const,
            result: { ok: true as const, options: [{ value: ACCOUNT, label: 'Work GitHub' }] },
        })),
        present: ({ form }) => {
            form.replaceInput({ repository: 'happier-dev/happier', credentialRef: ACCOUNT });
            void form.submit();
        },
        dispatch: vi.fn<PluginContributedActionDispatch>(async () => ({
            ok: true as const,
            result: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
            },
        })),
    };
}

describe('Plugin Event Automation setup orchestration', () => {
    it('uses the exact Event setup Action form, restores the selected Account, and dispatches with its immutable generation', async () => {
        const event = eligibleEvent();
        const loadCurrentProjection = vi.fn(async () => projectionInputs(event));
        const dispatch = vi.fn<PluginContributedActionDispatch>(async () => ({
            ok: true as const,
            result: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
            },
        }));
        let formSubmit: Promise<unknown> | null = null;

        let selectedOrigin = executionOrigin();
        const result = await configurePluginEventAutomationSetup({
            eligibleEvent: event,
            observationTransport: 'checkpointedPull',
            filter: null,
            maximumObservationAgeMs: null,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveExecutionOrigin: () => selectedOrigin,
            loadCurrentProjection,
            resolveConnectedAccountOptions: vi.fn(async () => ({
                supported: true as const,
                result: { ok: true as const, options: [{ value: ACCOUNT, label: 'Work GitHub' }] },
            })),
            present: ({ form }) => {
                form.replaceInput({
                    repository: 'happier-dev/happier',
                    credentialRef: ACCOUNT,
                });
                formSubmit = form.submit();
            },
            dispatch,
        });

        await expect(formSubmit).resolves.toMatchObject({
            kind: 'settled',
            outcome: { ok: true },
        });
        expect(result).toMatchObject({
            kind: 'configured',
            draft: {
                draft: {
                    eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                    setupActionRef: { pluginId: PLUGIN_ID, localId: SETUP_ACTION_LOCAL_ID },
                    source: {
                        sourceInstanceId: 'repository:42',
                        sourceConfig: { repositoryId: '42' },
                    },
                },
            },
        });
        expect(loadCurrentProjection).toHaveBeenNthCalledWith(1, {
            machineId: MACHINE_ID,
            serverId: SERVER_ID,
        });
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            action: { pluginId: PLUGIN_ID, localId: SETUP_ACTION_LOCAL_ID },
            input: {
                repository: 'happier-dev/happier',
                credentialRef: ACCOUNT,
            },
            contributedAction: {
                machineId: MACHINE_ID,
                serverId: SERVER_ID,
                expectedGeneration: String(GENERATION),
                expectedImmutableGenerationId: 'github-generation-a',
            },
        }));
        const dispatched = dispatch.mock.calls[0]?.[0];
        expect(dispatched).not.toHaveProperty('targetedOperation');
        expect(dispatched).not.toHaveProperty('callerPluginId');
        expect(dispatched?.resolveContributedAction?.({
            pluginId: PLUGIN_ID,
            localId: SETUP_ACTION_LOCAL_ID,
        })).toMatchObject({ execution: { target: 'daemon' } });

        if (result.kind !== 'configured') throw new Error('expected configured Event setup');
        selectedOrigin = executionOrigin('github-materialization-b');
        const changedWatcherOrigin = result.draft.resolveFreshWatcherOrigin();
        expect(changedWatcherOrigin).not.toBeNull();
        if (!changedWatcherOrigin) throw new Error('expected current watcher origin');
        const executionRecipe = buildPlainPluginEventAutomationExecutionRecipe({
            templateVersion: 0,
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
        expect(buildPluginEventAutomationDefinitionCreateRequest({
            name: 'Repository triage',
            description: null,
            enabled: true,
            eligibleEvents: [event],
            draft: result.draft.draft,
            watcherOrigin: changedWatcherOrigin.origin,
            executionRecipe,
            assignments: [{ machineId: 'executor-machine', enabled: true, priority: 100 }],
        })).toBeNull();
    });

    it('does not dispatch when the exact Event setup form is cancelled', async () => {
        const event = eligibleEvent();
        const dispatch = vi.fn<PluginContributedActionDispatch>();

        await expect(configurePluginEventAutomationSetup({
            eligibleEvent: event,
            observationTransport: 'checkpointedPull',
            filter: null,
            maximumObservationAgeMs: null,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveExecutionOrigin: () => executionOrigin(),
            loadCurrentProjection: async () => projectionInputs(event),
            resolveConnectedAccountOptions: vi.fn(async () => ({
                supported: true as const,
                result: { ok: true as const, options: [{ value: ACCOUNT, label: 'Work GitHub' }] },
            })),
            present: ({ form }) => form.cancel(),
            dispatch,
        })).resolves.toEqual({ kind: 'unavailable' });

        expect(dispatch).not.toHaveBeenCalled();
    });

    it('rejects a fresh origin for another plugin before it opens the Event setup form', async () => {
        const event = eligibleEvent();
        const loadCurrentProjection = vi.fn(async () => projectionInputs(event));
        const dispatch = vi.fn<PluginContributedActionDispatch>(async () => ({
            ok: true as const,
            result: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
            },
        }));
        const present = vi.fn(({ form }: Parameters<NonNullable<Parameters<typeof configurePluginEventAutomationSetup>[0]['present']>>[0]) => {
            form.replaceInput({
                repository: 'happier-dev/happier',
                credentialRef: ACCOUNT,
            });
            void form.submit();
        });

        const result = await configurePluginEventAutomationSetup({
            eligibleEvent: event,
            observationTransport: 'checkpointedPull',
            filter: null,
            maximumObservationAgeMs: null,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveExecutionOrigin: () => executionOrigin('calendar-materialization-a', 'acme.calendar'),
            loadCurrentProjection,
            resolveConnectedAccountOptions: vi.fn(async () => ({
                supported: true as const,
                result: { ok: true as const, options: [{ value: ACCOUNT, label: 'Work GitHub' }] },
            })),
            present,
            dispatch,
        });

        expect(result).toEqual({ kind: 'unavailable' });
        expect(loadCurrentProjection).not.toHaveBeenCalled();
        expect(present).not.toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('fails stale without invoking a replacement Action when the same setup local id changes generation during input selection', async () => {
        const original = eligibleEvent('github-generation-a');
        const replacement = eligibleEvent('github-generation-b');
        const loadCurrentProjection = vi.fn()
            .mockResolvedValueOnce(projectionInputs(original))
            .mockResolvedValueOnce(projectionInputs(replacement));
        const dispatch = vi.fn(async () => ({
            ok: true as const,
            result: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
            },
        }));

        const result = await configurePluginEventAutomationSetup({
            eligibleEvent: original,
            observationTransport: 'checkpointedPull',
            filter: null,
            maximumObservationAgeMs: null,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveExecutionOrigin: () => executionOrigin(),
            loadCurrentProjection,
            resolveConnectedAccountOptions: vi.fn(async () => ({
                supported: true as const,
                result: { ok: true as const, options: [{ value: ACCOUNT, label: 'Work GitHub' }] },
            })),
            present: ({ form }) => {
                form.replaceInput({
                    repository: 'happier-dev/happier',
                    credentialRef: ACCOUNT,
                });
                void form.submit();
            },
            dispatch,
        });

        expect(result).toEqual({ kind: 'stale', reason: 'event_retired' });
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('retires the exact setup form before reloading current Event facts', async () => {
        const event = eligibleEvent();
        let loadCount = 0;
        let postSelectionSubmission: unknown = null;
        let selectionForm: Parameters<NonNullable<Parameters<typeof configurePluginEventAutomationSetup>[0]['present']>>[0]['form'] | null = null;

        const result = await configurePluginEventAutomationSetup({
            eligibleEvent: event,
            observationTransport: 'checkpointedPull',
            filter: null,
            maximumObservationAgeMs: null,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveExecutionOrigin: () => executionOrigin(),
            loadCurrentProjection: async () => {
                loadCount += 1;
                if (loadCount === 2) {
                    if (!selectionForm) throw new Error('expected an open selection form');
                    postSelectionSubmission = await selectionForm.submit();
                }
                return projectionInputs(event);
            },
            resolveConnectedAccountOptions: vi.fn(async () => ({
                supported: true as const,
                result: { ok: true as const, options: [{ value: ACCOUNT, label: 'Work GitHub' }] },
            })),
            present: ({ form }) => {
                selectionForm = form;
                form.replaceInput({
                    repository: 'happier-dev/happier',
                    credentialRef: ACCOUNT,
                });
                void form.submit();
            },
            dispatch: vi.fn(async () => ({
                ok: true as const,
                result: {
                    v: 1,
                    sourceInstanceId: 'repository:42',
                    sourceContractVersion: 3,
                    sourceConfig: { repositoryId: '42' },
                    displayLabel: 'acme/widgets',
                },
            })),
        });

        expect(result).toMatchObject({ kind: 'configured' });
        expect(postSelectionSubmission).toEqual({ kind: 'stale', reason: 'action_retired' });
    });

    it('fails the canonical dispatch preflight when the watcher origin changes after revalidation', async () => {
        const event = eligibleEvent();
        let selectedOrigin = executionOrigin();
        const dispatch = vi.fn(async (input: Parameters<NonNullable<Parameters<typeof configurePluginEventAutomationSetup>[0]['dispatch']>>[0]) => {
            selectedOrigin = executionOrigin('github-materialization-b');
            return input.isCurrent?.()
                ? {
                    ok: true as const,
                    result: {
                        v: 1,
                        sourceInstanceId: 'repository:42',
                        sourceContractVersion: 3,
                        sourceConfig: { repositoryId: '42' },
                        displayLabel: 'acme/widgets',
                    },
                }
                : { ok: false as const, code: 'stale_surface' as const, reason: 'watcher_origin_retired' };
        });

        const result = await configurePluginEventAutomationSetup({
            eligibleEvent: event,
            observationTransport: 'checkpointedPull',
            filter: null,
            maximumObservationAgeMs: null,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveExecutionOrigin: () => selectedOrigin,
            loadCurrentProjection: async () => projectionInputs(event),
            resolveConnectedAccountOptions: vi.fn(async () => ({
                supported: true as const,
                result: { ok: true as const, options: [{ value: ACCOUNT, label: 'Work GitHub' }] },
            })),
            present: ({ form }) => {
                form.replaceInput({
                    repository: 'happier-dev/happier',
                    credentialRef: ACCOUNT,
                });
                void form.submit();
            },
            dispatch,
        });

        expect(result).toEqual({ kind: 'unavailable' });
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('ensures the Account webhook endpoint and writes the durable-push arm the user can complete', async () => {
        const event = durablePushEligibleEvent();
        const ensureWebhookEndpoint = vi.fn(async () => ({
            kind: 'available' as const,
            endpoint: Object.freeze({
                webhookEndpointId: WEBHOOK_ENDPOINT_ID,
                publicUrl: 'https://happier.example/v1/plugins/webhooks/wh_route_abc',
                readiness: 'providerConfirmationRequired' as const,
                oneTimeGeneratedSecret: 'whsec-visible-once',
            }),
        }));
        const result = await configurePluginEventAutomationSetup({
            ...durablePushSetupParams(event),
            observationTransport: 'durablePush',
            ensureWebhookEndpoint,
        });

        expect(result).toMatchObject({
            kind: 'configured',
            webhookEndpoint: {
                publicUrl: 'https://happier.example/v1/plugins/webhooks/wh_route_abc',
                oneTimeGeneratedSecret: 'whsec-visible-once',
            },
        });
        if (result.kind !== 'configured') throw new Error('expected configured Event setup');
        // The endpoint is keyed on the source instance the setup Action just
        // returned, not on anything the composer chose before dispatch.
        expect(ensureWebhookEndpoint).toHaveBeenCalledWith(expect.objectContaining({
            sourceInstanceId: 'repository:42',
        }));

        const watcherOrigin = result.draft.resolveFreshWatcherOrigin();
        if (!watcherOrigin) throw new Error('expected current watcher origin');
        const executionRecipe = buildPlainPluginEventAutomationExecutionRecipe({
            templateVersion: 0,
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
        if (!executionRecipe) throw new Error('expected execution recipe');
        const request = buildPluginEventAutomationDefinitionCreateRequest({
            name: 'Repository triage',
            description: null,
            enabled: true,
            eligibleEvents: [event],
            draft: result.draft.draft,
            watcherOrigin: watcherOrigin.origin,
            executionRecipe,
            assignments: [{ machineId: 'executor-machine', enabled: true, priority: 100 }],
        });
        expect(request?.trigger.observationTransport).toEqual({
            kind: 'durablePush',
            webhookEndpointId: WEBHOOK_ENDPOINT_ID,
            endpointMaterializationRef: {
                machineId: MACHINE_ID,
                materializationId: MATERIALIZATION_ID,
                pluginId: PLUGIN_ID,
            },
            webhookRoutingSourceInstanceId: 'repository:42',
            setup: { kind: 'githubAccountEndpointV1', credential: 'serverGenerated' },
        });
    });

    it('does not author a durable-push trigger when the endpoint could not be ensured', async () => {
        const event = durablePushEligibleEvent();
        const result = await configurePluginEventAutomationSetup({
            ...durablePushSetupParams(event),
            observationTransport: 'durablePush',
            ensureWebhookEndpoint: vi.fn(async () => ({ kind: 'unavailable' as const })),
        });

        expect(result).toEqual({ kind: 'unavailable' });
    });
});
