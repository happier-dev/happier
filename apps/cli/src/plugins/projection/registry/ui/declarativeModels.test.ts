import { describe, expect, it } from 'vitest';
import {
    PluginSettingsContributionV2Schema,
    preparePluginJsonSchema,
} from '@happier-dev/protocol';

import type { ResolvedContributionRegistry, ResolvedSettingsContribution } from '../types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { resolveDeclarativeProjectionModels } from './declarativeModels';
import { listDeclarativeNodesInPreorder } from '@/plugins/runtime/invocation/services/declarativeModel.testkit';

function registry(): ResolvedContributionRegistry {
    return {
        uiRenderersV2: [{
            pluginId: 'acme.forms',
            definition: {
                id: 'preferences',
                kind: 'declarative',
                root: {
                    kind: 'stack',
                    children: [
                        { kind: 'field', label: 'Enabled', control: { kind: 'toggle', settingId: 'enabled' } },
                        { kind: 'action', action: 'save', label: 'Save' },
                    ],
                },
            },
        }],
        settings: [{
            pluginId: 'acme.forms',
            definition: {
                id: 'preferences',
                title: 'Preferences',
                target: { kind: 'plugin' },
                scope: 'daemon',
                fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' }, default: false }],
            },
        }],
        actions: [{
            pluginId: 'acme.forms',
            definition: {
                id: 'save',
                title: 'Save',
                description: 'Save preferences',
                dangerLevel: 'safe',
                execution: { target: 'daemon' },
                scopes: [],
                surfaces: {
                    ui: true,
                    voice: false,
                    agent: false,
                    mcp: false,
                    cli: false,
                    rpc: false,
                    api: false,
                    plugin: false,
                },
            },
        }],
        accountCollections: [{
            pluginId: 'acme.forms',
            definition: {
                pluginId: 'acme.forms',
                collectionId: 'tasks',
                uiQueries: [{
                    collection: { pluginId: 'acme.forms', collectionId: 'tasks' },
                    id: 'open-tasks',
                    indexId: 'by-status',
                    parameters: {
                        status: { kind: 'string', maxUtf8Bytes: 16, enum: ['open'] },
                    },
                    prefix: [{ kind: 'parameter', parameterId: 'status' }],
                    order: 'asc',
                    pageSize: 20,
                    projectedFields: [
                        { field: 'status', kind: 'string' },
                        { field: 'title', kind: 'string' },
                    ],
                }],
            },
        }],
    } as unknown as ResolvedContributionRegistry;
}

type ActionRuntime = NonNullable<ResolvedExecutablePluginRuntimeRegistry['targetActionInvocations']>;

describe('declarative projection models', () => {
    it('binds fields and only enables current committed policy-visible actions', () => {
        const models = resolveDeclarativeProjectionModels({
            registry: registry(),
            generation: 42,
            actionRuntime: {
                has: (pluginId, localId) => pluginId === 'acme.forms' && localId === 'save',
                evaluateCatalogPolicy: () => ({
                    outcome: 'visible',
                    code: 'plugin_action_available',
                    requiresCurrentIntent: false,
                }),
            } satisfies Pick<ActionRuntime, 'has' | 'evaluateCatalogPolicy'>,
        });

        expect(models['acme.forms\0preferences']).toMatchObject({
            identity: {
                pluginId: 'acme.forms',
                localId: 'preferences',
                generation: '42',
            },
            visible: true,
            root: {
                kind: 'stack',
                children: [
                    {
                        kind: 'field',
                        setting: {
                            id: 'enabled',
                            qualifiedId: 'acme.forms/settings/daemon/preferences/fields/enabled',
                        },
                    },
                    {
                        kind: 'action',
                        action: {
                            identity: { pluginId: 'acme.forms', localId: 'save' },
                            qualifiedId: 'acme.forms/save',
                            generation: '42',
                        },
                        enabled: true,
                    },
                ],
            },
        });
    });

    it('normalizes a target renderer only through its exact mounted surface inventory', () => {
        const inputValidation = preparePluginJsonSchema({
            type: 'object',
            properties: { reviewId: { type: 'string' } },
            required: ['reviewId'],
            additionalProperties: false,
        });
        const models = resolveDeclarativeProjectionModels({
            registry: {
                uiRenderersV2: [{
                    pluginId: 'acme.dashboard',
                    definition: {
                        id: 'dashboard',
                        kind: 'declarative',
                        root: {
                            kind: 'targetedSurface',
                            surface: {
                                point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
                                contributor: { pluginId: 'acme.review', contributionId: 'detail' },
                                role: 'detail',
                            },
                            input: { reviewId: 'review-42' },
                            instanceKey: 'review-42',
                        },
                    },
                }],
            } as unknown as ResolvedContributionRegistry,
            generation: 52,
            preparedTargetedSurfacesByPluginId: {
                'acme.dashboard': [{
                    targetPluginId: 'acme.dashboard',
                    handle: {
                        point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
                        contributor: {
                            pluginId: 'acme.review',
                            contributionId: 'detail',
                            immutableGenerationId: 'review-generation-a',
                        },
                        role: 'detail',
                        presentation: 'content',
                    },
                    inputSchema: inputValidation.jsonSchema,
                    inputValidation,
                }],
            },
        });

        expect(models['acme.dashboard\0dashboard']?.root).toMatchObject({
            kind: 'targetedSurface',
            surface: {
                contributor: {
                    pluginId: 'acme.review',
                    contributionId: 'detail',
                    immutableGenerationId: 'review-generation-a',
                },
            },
            input: { reviewId: 'review-42' },
            instanceKey: expect.stringMatching(/^targeted-surface:v1:[a-f0-9]{64}$/u),
        });
    });

    it('keeps a same-plugin settings-page destination available to declarative openSurface commands', () => {
        const source = registry();
        const models = resolveDeclarativeProjectionModels({
            registry: {
                ...source,
                uiRenderersV2: source.uiRenderersV2?.map((renderer) => ({
                    ...renderer,
                    definition: {
                        ...renderer.definition,
                        root: {
                            kind: 'collectionList',
                            source: {
                                collectionId: 'tasks',
                                uiQueryId: 'open-tasks',
                                parameters: { status: 'open' },
                            },
                            projection: { titleField: { field: 'title', kind: 'string' } },
                            secondaryCommands: [{ kind: 'openSurface', destination: 'preferences-settings' }],
                        },
                    },
                })),
                uiSettingsPagesV2: [{
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.forms',
                    identity: { pluginId: 'acme.forms', localId: 'preferences-settings' },
                    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                    definition: {
                        id: 'preferences-settings',
                        group: { kind: 'host', id: 'general' },
                        title: 'Preferences settings',
                        defaultRank: 0,
                        renderer: 'preferences',
                    },
                }],
            } as unknown as ResolvedContributionRegistry,
            generation: 47,
        });

        expect(models['acme.forms\0preferences']).toMatchObject({
            declarativeInventory: {
                destinations: [{
                    identity: { pluginId: 'acme.forms', localId: 'preferences-settings' },
                    qualifiedId: 'acme.forms/preferences-settings',
                    generation: '47',
                }],
            },
            root: {
                kind: 'collectionList',
                secondaryCommands: [{
                    kind: 'openSurface',
                    destination: {
                        identity: { pluginId: 'acme.forms', localId: 'preferences-settings' },
                        qualifiedId: 'acme.forms/preferences-settings',
                        generation: '47',
                    },
                }],
            },
        });
    });

    it('projects a collection list only from Data-normalized query inventory', () => {
        const source = registry();
        const models = resolveDeclarativeProjectionModels({
            registry: {
                ...source,
                uiRenderersV2: source.uiRenderersV2?.map((renderer) => ({
                    ...renderer,
                    definition: {
                        ...renderer.definition,
                        root: {
                            kind: 'collectionList',
                            source: {
                                collectionId: 'tasks',
                                uiQueryId: 'open-tasks',
                                parameters: { status: 'open' },
                            },
                            projection: {
                                titleField: { field: 'title', kind: 'string' },
                                badgeField: { field: 'status', kind: 'string' },
                            },
                        },
                    },
                })),
            },
            generation: 46,
        });

        expect(models['acme.forms\0preferences']).toMatchObject({
            declarativeInventory: {
                uiQueries: [{
                    collection: { pluginId: 'acme.forms', collectionId: 'tasks' },
                    id: 'open-tasks',
                }],
            },
            root: {
                kind: 'collectionList',
                source: {
                    collectionId: 'tasks',
                    uiQueryId: 'open-tasks',
                    parameters: { status: 'open' },
                },
                query: {
                    collection: { pluginId: 'acme.forms', collectionId: 'tasks' },
                    id: 'open-tasks',
                    indexId: 'by-status',
                },
            },
        });
    });

    it('fails closed when no current action runtime exists', () => {
        const model = resolveDeclarativeProjectionModels({
            registry: registry(),
            generation: 43,
        })['acme.forms\0preferences'];

        expect(listDeclarativeNodesInPreorder(model!.root)[2]).toMatchObject({ kind: 'action', enabled: false });
    });

    it('does not lend unrelated plugin action availability to a Session info model', () => {
        const source = registry();
        const unavailable: unknown[] = [];
        const unrelatedAction = {
            ...source.actions[0]!,
            pluginId: 'happier.triage',
            definition: {
                ...source.actions[0]!.definition,
                id: 'actions/administer-v1',
            },
        };
        const models = resolveDeclarativeProjectionModels({
            registry: {
                actions: [unrelatedAction],
                sessionInfoSections: [{
                    pluginId: 'happier.channels',
                    definition: {
                        id: 'external-conversations',
                        resourceId: 'session-info-v1',
                        order: 50,
                        actions: [],
                    },
                }],
            } as unknown as ResolvedContributionRegistry,
            generation: 43,
            onRendererModelUnavailable: ({ error }) => unavailable.push(error),
        });

        expect(unavailable).toEqual([]);
        expect(models['happier.channels\0session-info-external-conversations']).toMatchObject({
            identity: {
                pluginId: 'happier.channels',
                localId: 'session-info-external-conversations',
                generation: '43',
            },
            declarativeInventory: { actions: [] },
        });
    });

    it('keeps a model inert when current action policy evaluation fails', () => {
        const models = resolveDeclarativeProjectionModels({
            registry: registry(),
            generation: 43,
            actionRuntime: {
                has: () => true,
                evaluateCatalogPolicy: () => {
                    throw new Error('policy unavailable');
                },
            },
        });

        expect(listDeclarativeNodesInPreorder(models['acme.forms\0preferences']!.root)[2]).toMatchObject({
            kind: 'action',
            enabled: false,
        });
    });

    it('does not enable an action that is not exposed on the UI surface', () => {
        const source = registry();
        const models = resolveDeclarativeProjectionModels({
            registry: {
                ...source,
                actions: source.actions.map((action) => ({
                    ...action,
                    definition: {
                        ...action.definition,
                        surfaces: { ...action.definition.surfaces, ui: false, cli: true },
                    },
                })),
            },
            generation: 43,
            actionRuntime: {
                has: () => true,
                evaluateCatalogPolicy: () => ({
                    outcome: 'visible',
                    code: 'plugin_action_available',
                    requiresCurrentIntent: false,
                }),
            },
        });

        expect(listDeclarativeNodesInPreorder(models['acme.forms\0preferences']!.root)[2]).toMatchObject({
            kind: 'action',
            enabled: false,
        });
    });

    it('omits an invalid model instead of projecting an inferred renderer', () => {
        const invalid = registry();
        const models = resolveDeclarativeProjectionModels({
            registry: {
                ...invalid,
                settings: [],
            },
            generation: 44,
        });

        expect(models).toEqual({});
    });

    it('projects Account fields through the stable settings owner while keeping actions inert without runtime policy', () => {
        const account = registry();
        const models = resolveDeclarativeProjectionModels({
            registry: {
                ...account,
                settings: account.settings?.map((setting) => ({
                    ...setting,
                    definition: { ...setting.definition, scope: 'account' as const },
                })),
            },
            generation: 45,
        });

        expect(models['acme.forms\0preferences']).toMatchObject({
            identity: {
                pluginId: 'acme.forms',
                localId: 'preferences',
                generation: '45',
            },
            root: {
                children: [
                    {
                        kind: 'field',
                        setting: {
                            qualifiedId: 'acme.forms/settings/account/preferences/fields/enabled',
                            descriptor: { scope: 'account' },
                        },
                    },
                    {
                        kind: 'action',
                        enabled: false,
                    },
                ],
            },
        });
    });

    it('projects Account and daemon fields as separate Settings models instead of flattening their records', () => {
        const source = registry();
        const accountSettings = (source.settings ?? []).map((setting) => ({
            ...setting,
            definition: PluginSettingsContributionV2Schema.parse({
                ...setting.definition,
                scope: 'account',
            }),
        }));
        const daemonSettings = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.forms',
            manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
            definition: PluginSettingsContributionV2Schema.parse({
                id: 'daemon-preferences',
                title: 'Daemon preferences',
                target: { kind: 'plugin' },
                scope: 'daemon',
                fields: [{ id: 'daemon-enabled', title: 'Daemon enabled', schema: { type: 'boolean' }, default: false }],
            }),
        } satisfies ResolvedSettingsContribution;
        const models = resolveDeclarativeProjectionModels({
            registry: {
                ...source,
                uiRenderersV2: source.uiRenderersV2?.map((renderer) => ({
                    ...renderer,
                    definition: {
                        ...renderer.definition,
                        root: {
                            kind: 'stack' as const,
                            children: [
                                { kind: 'field' as const, label: 'Account enabled', control: { kind: 'toggle' as const, settingId: 'enabled' } },
                                { kind: 'field' as const, label: 'Daemon enabled', control: { kind: 'toggle' as const, settingId: 'daemon-enabled' } },
                            ],
                        },
                    },
                })),
                settings: [...accountSettings, daemonSettings],
            },
            generation: 46,
        });

        expect(models['acme.forms\0preferences']?.root).toMatchObject({
            kind: 'stack',
            children: [
                { kind: 'field', setting: { descriptor: { scope: 'account' } } },
                { kind: 'field', setting: { descriptor: { scope: 'daemon' } } },
            ],
        });
    });
});
