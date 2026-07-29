import { describe, expect, it, vi } from 'vitest';

import type { PluginProjectionV2 } from '@happier-dev/protocol';

import {
    EMPTY_PLUGIN_UI_PROJECTION,
    normalizePluginUiProjection,
} from '@/sync/domains/plugins/ui/projection';

import {
    createPluginSessionHeaderActionExecutor,
    createPluginSessionHeaderActionDropdownItems,
    createPluginSessionHeaderActionMenuId,
    dispatchPluginSessionHeaderAction,
} from './pluginHeaderActions';

function createProjectedHeaderAction(params?: Readonly<{
    includeTargetAction?: boolean;
    actionReference?: string | Readonly<{ pluginId: string; localId: string }>;
    availability?: Readonly<Record<string, unknown>>;
}>): PluginProjectionV2 {
    const includeTargetAction = params?.includeTargetAction ?? true;
    return {
        v: 2,
        generation: 7,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        actionsById: includeTargetAction
            ? {
                'acme.plugin/roundtrip': {
                    id: 'roundtrip',
                    pluginId: 'acme.plugin',
                    title: 'Roundtrip',
                    scopes: ['session'],
                    surfaces: ['ui'],
                    placement: 'detailsPanel',
                    dangerLevel: 'safe',
                    available: true,
                },
            }
            : {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: {
                    'translations:acme.plugin': {
                        id: 'translations:acme.plugin',
                        pluginId: 'acme.plugin',
                        contributionKind: 'translations',
                        locales: ['en'],
                        bundles: {
                            en: {
                                'header.roundtrip': 'Run roundtrip',
                            },
                        },
                    },
                    'sessionHeaderAction:acme.plugin:roundtrip-header': {
                        id: 'sessionHeaderAction:acme.plugin:roundtrip-header',
                        pluginId: 'acme.plugin',
                        contributionKind: 'sessionHeaderAction',
                        descriptorId: 'roundtrip-header',
                        title: {
                            key: 'header.roundtrip',
                            fallback: 'Roundtrip fallback',
                        },
                        action: params?.actionReference ?? 'roundtrip',
                        order: 3,
                        ...(params?.availability ? { availability: params.availability } : {}),
                    },
                },
            },
        },
        diagnostics: [],
    };
}

describe('pluginHeaderActions — contribution-reference resolution', () => {
    it('surfaces a real projected session-header contribution by resolving its action reference', () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction());
        const projectedAction = projection.sessionHeaderActionsById[
            'sessionHeaderAction:acme.plugin:roundtrip-header'
        ];

        const items = createPluginSessionHeaderActionDropdownItems({
            projection,
            iconColor: '#fff',
            locale: 'en',
        });

        expect(projectedAction).toMatchObject({
            descriptorId: 'roundtrip-header',
            action: 'roundtrip',
            qualifiedActionId: 'acme.plugin/roundtrip',
        });
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            id: createPluginSessionHeaderActionMenuId(projectedAction!),
            title: 'Run roundtrip',
        });
    });

    it('dispatches the referenced action through the generation-leased daemon action RPC', async () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction());
        const projectedAction = projection.sessionHeaderActionsById[
            'sessionHeaderAction:acme.plugin:roundtrip-header'
        ]!;
        const execute = vi.fn(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { completed: true } },
        }));
        const executor = createPluginSessionHeaderActionExecutor({
            projection,
            machineId: 'machine-1',
            serverId: 'server-a',
            execute,
        });

        const result = await dispatchPluginSessionHeaderAction({
            projection,
            menuActionId: createPluginSessionHeaderActionMenuId(projectedAction),
            executor,
            context: {
                defaultSessionId: 'sess-1',
                surface: 'ui',
                placement: 'session_action_menu',
            },
        });

        expect(result).toEqual({
            ok: true,
            kind: 'executeAction',
            result: { completed: true },
        });
        expect(execute).toHaveBeenCalledWith('machine-1', {
            serverId: 'server-a',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.plugin/roundtrip',
            input: {},
            sessionId: 'sess-1',
            executionSurface: 'ui',
        });
    });

    it('fails closed before transport when projection generation or action currentness is absent', async () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction());
        const projectedAction = projection.sessionHeaderActionsById[
            'sessionHeaderAction:acme.plugin:roundtrip-header'
        ]!;
        const execute = vi.fn();
        const executor = createPluginSessionHeaderActionExecutor({
            projection: { ...projection, generation: null },
            machineId: 'machine-1',
            execute,
        });

        await expect(dispatchPluginSessionHeaderAction({
            projection,
            menuActionId: createPluginSessionHeaderActionMenuId(projectedAction),
            executor,
            context: { surface: 'ui' },
        })).resolves.toMatchObject({
            ok: false,
            errorCode: 'plugin_ui_action_unavailable',
        });
        expect(execute).not.toHaveBeenCalled();
    });

    it('preserves a daemon stale-generation rejection as an action failure', async () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction());
        const projectedAction = projection.sessionHeaderActionsById[
            'sessionHeaderAction:acme.plugin:roundtrip-header'
        ]!;
        const executor = createPluginSessionHeaderActionExecutor({
            projection,
            machineId: 'machine-1',
            execute: vi.fn(async () => ({
                supported: true as const,
                result: {
                    ok: false as const,
                    code: 'plugin_projection_stale_generation',
                },
            })),
        });

        await expect(dispatchPluginSessionHeaderAction({
            projection,
            menuActionId: createPluginSessionHeaderActionMenuId(projectedAction),
            executor,
            context: { surface: 'ui' },
        })).resolves.toEqual({
            ok: false,
            kind: 'executeAction',
            errorCode: 'plugin_projection_stale_generation',
            error: 'plugin_projection_stale_generation',
        });
    });

    it('fails closed when the referenced action is absent from the same projection generation', () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction({
            includeTargetAction: false,
        }));

        expect(projection.sessionHeaderActionsById).toEqual({});
        expect(createPluginSessionHeaderActionDropdownItems({
            projection,
            iconColor: '#fff',
        })).toEqual([]);
    });

    it('fails closed when an explicit cross-plugin reference does not resolve', () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction({
            actionReference: { pluginId: 'other.plugin', localId: 'roundtrip' },
        }));

        expect(projection.sessionHeaderActionsById).toEqual({});
    });

    it('keeps a policy-disabled header action visible but non-interactive', () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction({
            availability: {
                disabledWhen: {
                    fact: 'host.platform',
                    operator: 'equals',
                    value: 'desktop',
                },
                disabledReason: 'Unavailable on this platform',
            },
        }));

        expect(createPluginSessionHeaderActionDropdownItems({
            projection,
            iconColor: '#fff',
        })).toEqual([
            expect.objectContaining({
                title: 'Run roundtrip',
                disabled: true,
            }),
        ]);
    });

    it('returns null for a non-plugin menu id', async () => {
        await expect(dispatchPluginSessionHeaderAction({
            projection: EMPTY_PLUGIN_UI_PROJECTION,
            menuActionId: 'session.stop',
            host: {},
        })).resolves.toBeNull();
    });
});
