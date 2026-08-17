import { describe, expect, it, vi } from 'vitest';

import type { PluginProjectedActionV2, PluginProjectionV2 } from '@happier-dev/protocol';
import {
    type PluginUiResolvedSemanticCommandV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    EMPTY_PLUGIN_UI_PROJECTION,
    normalizePluginUiProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { PluginSurfaceScopedLaunchFacts } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';

import {
    createPluginSessionHeaderActionDropdownItems,
    createPluginSessionHeaderActionMenuId,
    dispatchPluginSessionHeaderAction,
    resolvePluginSessionHeaderActionPresentations,
} from './pluginHeaderActions';

const HOST_POLICY_CONTEXT = { platform: 'web', channel: 'internal' } as const;

const DEFAULT_HEADER_COMMAND = {
    kind: 'executeAction',
    action: { pluginId: 'acme.plugin', localId: 'roundtrip' },
} satisfies PluginUiResolvedSemanticCommandV1;

function createScopedLaunchFacts(
    overrides: Readonly<Partial<PluginSurfaceScopedLaunchFacts>> = {},
): PluginSurfaceScopedLaunchFacts {
    return {
        serverId: 'server-projection',
        machineId: 'machine-projection',
        generation: 7,
        interactionEnabled: true,
        ...overrides,
    };
}

function createProjectedHeaderAction(params?: Readonly<{
    command?: PluginUiResolvedSemanticCommandV1;
    icon?: 'refresh';
    legacyAction?: string;
    availability?: Readonly<Record<string, unknown>>;
    compatibility?: Readonly<Record<string, unknown>>;
}>): PluginProjectionV2 {
    return {
        v: 2,
        generation: 7,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        // This action entry makes the legacy-action rejection discriminating:
        // the retired UI reader would otherwise reject the raw entry only
        // because its target was absent, rather than because its shape is
        // forbidden.
        actionsById: {
            'acme.plugin/roundtrip': {
                id: 'roundtrip',
                pluginId: 'acme.plugin',
                title: 'Roundtrip',
                scopes: ['session'],
                surfaces: ['ui'],
                placementBindings: ['detailsPanel'],
                dangerLevel: 'safe',
                available: true,
            },
        },
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
                        ...(params?.legacyAction === undefined
                            ? { command: params?.command ?? DEFAULT_HEADER_COMMAND }
                            : { action: params.legacyAction }),
                        ...(params?.icon ? { icon: params.icon } : {}),
                        order: 3,
                        ...(params?.availability ? { availability: params.availability } : {}),
                        ...(params?.compatibility ? { compatibility: params.compatibility } : {}),
                    },
                },
            },
        },
        diagnostics: [],
    } satisfies PluginProjectionV2;
}

describe('pluginHeaderActions — contribution-reference resolution', () => {
    it('surfaces a compiled qualified session-header command without retaining the legacy action projection', () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction());
        const projectedAction = projection.sessionHeaderActionsById[
            'sessionHeaderAction:acme.plugin:roundtrip-header'
        ];

        const items = createPluginSessionHeaderActionDropdownItems({
            projection,
            iconColor: '#fff',
            locale: 'en',
            policyContext: HOST_POLICY_CONTEXT,
            scopedLaunchFacts: createScopedLaunchFacts(),
        });

        expect(projectedAction).toMatchObject({
            descriptorId: 'roundtrip-header',
            command: DEFAULT_HEADER_COMMAND,
        });
        expect(projectedAction).not.toHaveProperty('action');
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            id: createPluginSessionHeaderActionMenuId(projectedAction!),
            title: 'Run roundtrip',
        });
    });

    it('uses the projected semantic icon instead of the generic plugin fallback', () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction({ icon: 'refresh' }));

        const items = createPluginSessionHeaderActionDropdownItems({
            projection,
            iconColor: '#fff',
            locale: 'en',
            policyContext: HOST_POLICY_CONTEXT,
            scopedLaunchFacts: createScopedLaunchFacts(),
        });

        expect(items).toHaveLength(1);
        expect(items[0]?.icon).toMatchObject({
            props: {
                name: 'arrow-clockwise',
            },
        });
    });

    it('maps omitted executeAction input to the canonical null sentinel only at the generation-leased daemon action RPC', async () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction());
        const projectedAction = projection.sessionHeaderActionsById[
            'sessionHeaderAction:acme.plugin:roundtrip-header'
        ]!;
        const execute = vi.fn(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { completed: true } },
        }));

        const result = await dispatchPluginSessionHeaderAction({
            projection,
            menuActionId: createPluginSessionHeaderActionMenuId(projectedAction),
            scopedLaunchFacts: createScopedLaunchFacts({
                machineId: 'machine-1',
                serverId: 'server-a',
            }),
            sessionId: 'sess-1',
            execute,
        });

        expect(result).toEqual({ ok: true, result: { completed: true } });
        expect(execute).toHaveBeenCalledWith('machine-1', {
            serverId: 'server-a',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.plugin/roundtrip',
            input: null,
            sessionId: 'sess-1',
            executionSurface: 'ui',
        });
    });

    it('dispatches the compiled qualified action target without requalifying it against the declaring plugin', async () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction({
            command: {
                kind: 'executeAction',
                action: { pluginId: 'other.plugin', localId: 'roundtrip' },
                input: { source: 'header' },
            },
        }));
        const projectedAction = projection.sessionHeaderActionsById[
            'sessionHeaderAction:acme.plugin:roundtrip-header'
        ]!;
        const execute = vi.fn(async () => ({
            supported: true as const,
            result: { ok: true as const, result: null },
        }));

        await dispatchPluginSessionHeaderAction({
            projection,
            menuActionId: createPluginSessionHeaderActionMenuId(projectedAction),
            scopedLaunchFacts: createScopedLaunchFacts({ machineId: 'machine-1' }),
            execute,
        });

        expect(execute).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            qualifiedActionId: 'other.plugin/roundtrip',
            input: { source: 'header' },
            executionSurface: 'ui',
        }));
    });

    it('delegates openSurface through the existing host handler without inventing input or action transport', async () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction({
            command: {
                kind: 'openSurface',
                destination: { pluginId: 'acme.plugin', localId: 'details' },
                subPath: 'recent',
                instanceKey: 'current-session',
            },
        }));
        const projectedAction = projection.sessionHeaderActionsById[
            'sessionHeaderAction:acme.plugin:roundtrip-header'
        ]!;
        const execute = vi.fn();
        const openSurface = vi.fn(async () => ({ ok: true as const }));

        await expect(dispatchPluginSessionHeaderAction({
            projection,
            menuActionId: createPluginSessionHeaderActionMenuId(projectedAction),
            // Action dispatch currentness is intentionally not navigation authority.
            scopeIsCurrent: () => false,
            execute,
            openSurface,
        })).resolves.toEqual({ ok: true });

        expect(openSurface).toHaveBeenCalledWith({
            destination: { pluginId: 'acme.plugin', localId: 'details' },
            subPath: 'recent',
            instanceKey: 'current-session',
        });
        expect(execute).not.toHaveBeenCalled();
    });

    it('fails closed before transport when projection generation or scoped machine authority is absent', async () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction());
        const projectedAction = projection.sessionHeaderActionsById[
            'sessionHeaderAction:acme.plugin:roundtrip-header'
        ]!;
        const execute = vi.fn();

        await expect(dispatchPluginSessionHeaderAction({
            projection: { ...projection, generation: null },
            menuActionId: createPluginSessionHeaderActionMenuId(projectedAction),
            scopedLaunchFacts: createScopedLaunchFacts({ machineId: 'machine-1' }),
            execute,
        })).resolves.toMatchObject({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_ui_action_unavailable',
        });

        await expect(dispatchPluginSessionHeaderAction({
            projection,
            menuActionId: createPluginSessionHeaderActionMenuId(projectedAction),
            scopedLaunchFacts: createScopedLaunchFacts({ machineId: '  ' }),
            execute,
        })).resolves.toMatchObject({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_ui_action_unavailable',
        });
        expect(execute).not.toHaveBeenCalled();
    });

    it('preserves a daemon stale-generation rejection as a typed dispatch failure', async () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction());
        const projectedAction = projection.sessionHeaderActionsById[
            'sessionHeaderAction:acme.plugin:roundtrip-header'
        ]!;

        await expect(dispatchPluginSessionHeaderAction({
            projection,
            menuActionId: createPluginSessionHeaderActionMenuId(projectedAction),
            scopedLaunchFacts: createScopedLaunchFacts({ machineId: 'machine-1' }),
            execute: vi.fn(async () => ({
                supported: true as const,
                result: {
                    ok: false as const,
                    code: 'plugin_projection_stale_generation',
                },
            })),
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_projection_stale_generation',
        });
    });

    it('fails closed on a retired raw action entry even when its old target remains available', () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction({
            legacyAction: 'roundtrip',
        }));

        expect(projection.sessionHeaderActionsById).toEqual({});
        expect(createPluginSessionHeaderActionDropdownItems({
            projection,
            iconColor: '#fff',
            policyContext: HOST_POLICY_CONTEXT,
            scopedLaunchFacts: createScopedLaunchFacts(),
        })).toEqual([]);
    });

    it('returns null for a non-plugin menu id', async () => {
        await expect(dispatchPluginSessionHeaderAction({
            projection: EMPTY_PLUGIN_UI_PROJECTION,
            menuActionId: 'session.stop',
        })).resolves.toBeNull();
    });
});

describe('pluginHeaderActions — scoped projection authority', () => {
    it('keeps a retained header descriptor visible but unavailable when its scoped projection loses interaction authority', () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction());
        const presentationInput = {
            projection,
            locale: 'en',
            policyContext: HOST_POLICY_CONTEXT,
            scopedLaunchFacts: createScopedLaunchFacts({ interactionEnabled: false }),
        };

        const presentations = resolvePluginSessionHeaderActionPresentations(presentationInput);
        const dropdownItems = createPluginSessionHeaderActionDropdownItems({
            ...presentationInput,
            iconColor: '#fff',
        });

        expect(presentations).toEqual([
            expect.objectContaining({
                title: 'Run roundtrip',
                enabled: false,
            }),
        ]);
        expect(dropdownItems).toEqual([
            expect.objectContaining({
                title: 'Run roundtrip',
                disabled: true,
            }),
        ]);
    });

    it('re-enables the retained descriptor only after the same scoped projection regains interaction authority', () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction());
        const disabledPresentationInput = {
            projection,
            policyContext: HOST_POLICY_CONTEXT,
            scopedLaunchFacts: createScopedLaunchFacts({ interactionEnabled: false }),
        };
        const reconnectedPresentationInput = {
            projection,
            policyContext: HOST_POLICY_CONTEXT,
            scopedLaunchFacts: createScopedLaunchFacts(),
        };
        const disabledPresentations = resolvePluginSessionHeaderActionPresentations(disabledPresentationInput);
        const reconnectedPresentations = resolvePluginSessionHeaderActionPresentations(reconnectedPresentationInput);

        expect(disabledPresentations[0]?.enabled).toBe(false);
        expect(reconnectedPresentations[0]?.enabled).toBe(true);
    });

    it('uses the exact scoped machine, server, and generation rather than a header-local handoff target', async () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction());
        const projectedAction = projection.sessionHeaderActionsById[
            'sessionHeaderAction:acme.plugin:roundtrip-header'
        ]!;
        const execute = vi.fn(async () => ({
            supported: true as const,
            result: { ok: true as const, result: null },
        }));
        const dispatchInput = {
            projection,
            menuActionId: createPluginSessionHeaderActionMenuId(projectedAction),
            sessionId: 'sess-1',
            execute,
            scopedLaunchFacts: createScopedLaunchFacts(),
        };

        await expect(dispatchPluginSessionHeaderAction(dispatchInput)).resolves.toEqual({
            ok: true,
            result: null,
        });

        expect(execute).toHaveBeenCalledWith('machine-projection', {
            serverId: 'server-projection',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.plugin/roundtrip',
            input: null,
            sessionId: 'sess-1',
            executionSurface: 'ui',
        });
    });

    it('fails closed before transport when a retained descriptor no longer matches the scoped projection generation', async () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction());
        const projectedAction = projection.sessionHeaderActionsById[
            'sessionHeaderAction:acme.plugin:roundtrip-header'
        ]!;
        const execute = vi.fn(async () => ({
            supported: true as const,
            result: { ok: true as const, result: null },
        }));
        const dispatchInput = {
            projection,
            menuActionId: createPluginSessionHeaderActionMenuId(projectedAction),
            execute,
            scopedLaunchFacts: createScopedLaunchFacts({
                generation: 8,
                machineId: 'machine-replacement',
                serverId: 'server-replacement',
            }),
        };

        await expect(dispatchPluginSessionHeaderAction(dispatchInput)).resolves.toMatchObject({
            ok: false,
            code: 'unavailable',
        });
        expect(execute).not.toHaveBeenCalled();
    });
});

function createOrderedHeaderActions(): PluginProjectionV2 {
    const action = (localId: string): PluginProjectedActionV2 => ({
        id: localId,
        pluginId: 'acme.plugin',
        title: localId,
        scopes: ['session'],
        surfaces: ['ui'],
        placementBindings: ['detailsPanel'],
        dangerLevel: 'safe',
        available: true,
    });
    const entry = (descriptorId: string, order?: number) => ({
        id: `sessionHeaderAction:acme.plugin:${descriptorId}`,
        pluginId: 'acme.plugin',
        contributionKind: 'sessionHeaderAction',
        descriptorId,
        title: descriptorId,
        command: {
            kind: 'executeAction' as const,
            action: { pluginId: 'acme.plugin', localId: descriptorId },
        },
        ...(order === undefined ? {} : { order }),
    });
    return {
        v: 2,
        generation: 7,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        actionsById: {
            'acme.plugin/aaa-unordered': action('aaa-unordered'),
            'acme.plugin/zzz-first': action('zzz-first'),
            'acme.plugin/mmm-second': action('mmm-second'),
        },
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: {
                    'sessionHeaderAction:acme.plugin:aaa-unordered': entry('aaa-unordered'),
                    'sessionHeaderAction:acme.plugin:zzz-first': entry('zzz-first', 0),
                    'sessionHeaderAction:acme.plugin:mmm-second': entry('mmm-second', 5),
                },
            },
        },
        diagnostics: [],
    } satisfies PluginProjectionV2;
}

describe('pluginHeaderActions — applicability against the exact host facts', () => {
    const webPolicyContext = { platform: 'web', channel: 'internal' } as const;

    it('keeps a header action declaring this platform visible', () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction({
            compatibility: { platforms: ['web'] },
        }));

        expect(createPluginSessionHeaderActionDropdownItems({
            projection,
            iconColor: '#fff',
            locale: 'en',
            policyContext: webPolicyContext,
            scopedLaunchFacts: createScopedLaunchFacts(),
        })).toEqual([
            expect.objectContaining({ title: 'Run roundtrip' }),
        ]);
    });

    it('hides a header action declaring only other platforms', () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction({
            compatibility: { platforms: ['ios'] },
        }));

        expect(createPluginSessionHeaderActionDropdownItems({
            projection,
            iconColor: '#fff',
            locale: 'en',
            policyContext: webPolicyContext,
            scopedLaunchFacts: createScopedLaunchFacts(),
        })).toEqual([]);
    });

    it('leaves a header action enabled when its disabledWhen fact does not hold here', () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction({
            availability: {
                disabledWhen: { fact: 'host.platform', operator: 'equals', value: 'desktop' },
            },
        }));

        const items = createPluginSessionHeaderActionDropdownItems({
            projection,
            iconColor: '#fff',
            locale: 'en',
            policyContext: webPolicyContext,
            scopedLaunchFacts: createScopedLaunchFacts(),
        });

        expect(items).toHaveLength(1);
        expect(items[0]).not.toHaveProperty('disabled');
    });

    it('disables a header action when its disabledWhen fact does hold here', () => {
        const projection = normalizePluginUiProjection(createProjectedHeaderAction({
            availability: {
                disabledWhen: { fact: 'host.platform', operator: 'equals', value: 'web' },
            },
        }));

        expect(createPluginSessionHeaderActionDropdownItems({
            projection,
            iconColor: '#fff',
            locale: 'en',
            policyContext: webPolicyContext,
            scopedLaunchFacts: createScopedLaunchFacts(),
        })).toEqual([
            expect.objectContaining({ title: 'Run roundtrip', disabled: true }),
        ]);
    });

    it('orders declared contributions before undeclared ones, as the surface-placement owner does', () => {
        const projection = normalizePluginUiProjection(createOrderedHeaderActions());

        expect(createPluginSessionHeaderActionDropdownItems({
            projection,
            iconColor: '#fff',
            policyContext: webPolicyContext,
            scopedLaunchFacts: createScopedLaunchFacts(),
        }).map((item) => item.title)).toEqual([
            'zzz-first',
            'mmm-second',
            'aaa-unordered',
        ]);
    });
});
