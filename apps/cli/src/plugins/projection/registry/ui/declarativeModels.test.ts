import { describe, expect, it } from 'vitest';

import type { ResolvedContributionRegistry } from '../types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { resolveDeclarativeProjectionModels } from './declarativeModels';

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
                scope: 'local',
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
                scopes: [],
                surfaces: {
                    ui: true,
                    voice: false,
                    agent: false,
                    mcp: false,
                    cli: false,
                    rpc: false,
                    sdk: false,
                },
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
                            qualifiedId: 'acme.forms/settings/preferences/fields/enabled',
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

    it('fails closed when no current action runtime exists', () => {
        const model = resolveDeclarativeProjectionModels({
            registry: registry(),
            generation: 43,
        })['acme.forms\0preferences'];

        expect(model?.nodes[2]).toMatchObject({ kind: 'action', enabled: false });
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

        expect(models['acme.forms\0preferences']?.nodes[2]).toMatchObject({
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

        expect(models['acme.forms\0preferences']?.nodes[2]).toMatchObject({
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

    it('projects synced fields through the stable settings owner while keeping actions inert without runtime policy', () => {
        const synced = registry();
        const models = resolveDeclarativeProjectionModels({
            registry: {
                ...synced,
                settings: synced.settings?.map((setting) => ({
                    ...setting,
                    definition: { ...setting.definition, scope: 'synced' as const },
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
                            qualifiedId: 'acme.forms/settings/preferences/fields/enabled',
                            descriptor: { scope: 'synced' },
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
});
