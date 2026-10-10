import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';

import {
    buildPluginSearchProviderSections,
    PLUGIN_SEARCH_SECTION_ID_PREFIX,
} from './pluginSearchProviderSections';

const dispatchSemanticCommand = vi.hoisted(() => vi.fn());

vi.mock('@/components/plugins/surfaces/dispatchPluginResolvedSemanticCommand', () => ({
    dispatchPluginResolvedSemanticCommand: dispatchSemanticCommand,
}));

const SCOPED = Object.freeze({
    serverId: 'server-1',
    machineId: 'machine-1',
    interactionEnabled: true,
});

function hostOrigin(pluginId: string, machineId: string, generation: number) {
    return Object.freeze({
        machineId,
        serverId: `server-${machineId}`,
        generation,
        interactionEnabled: true,
        phase: 'current' as const,
        executionOrigin: {
            serverIdentityId: 'srv_test',
            materializationRef: {
                pluginId,
                machineId,
                materializationId: `${machineId}:${pluginId}`,
            },
        },
    });
}

function projection(overrides: Partial<PluginUiProjectionModel> = {}): PluginUiProjectionModel {
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: 7,
        searchProvidersById: Object.freeze({
            'searchProvider:happier.triage:entries': Object.freeze({
                id: 'searchProvider:happier.triage:entries',
                pluginId: 'happier.triage',
                occurrenceId: 'happier-triage-occurrence-7',
                contributionKind: 'searchProvider' as const,
                descriptorId: 'entries',
                identity: Object.freeze({ pluginId: 'happier.triage', localId: 'entries' }),
                action: Object.freeze({ pluginId: 'happier.triage', localId: 'search' }),
            }),
        }),
        actionsById: Object.freeze({
            'happier.triage/search': Object.freeze({
                id: 'search',
                pluginId: 'happier.triage',
                occurrenceId: 'happier-triage-occurrence-7',
                title: 'PRs & Issues',
                icon: 'action',
                scopes: ['global'],
                surfaces: ['ui'],
                execution: { target: 'daemon' },
                dangerLevel: 'safe',
                available: true,
            }),
        }),
        ...overrides,
    }) as PluginUiProjectionModel;
}

function sections(overrides: Record<string, unknown> = {}) {
    return buildPluginSearchProviderSections({
        projection: projection(),
        scopedLaunchFacts: SCOPED,
        rowLimit: 8,
        onCommitActivation: vi.fn(),
        ...overrides,
    } as Parameters<typeof buildPluginSearchProviderSections>[0]);
}

beforeEach(() => {
    dispatchSemanticCommand.mockReset();
});

describe('buildPluginSearchProviderSections', () => {
    it('builds one qualified dynamic section per admitted provider', () => {
        const built = sections();
        expect(built).toHaveLength(1);
        expect(built[0]!.id).toBe(`${PLUGIN_SEARCH_SECTION_ID_PREFIX}happier.triage:entries`);
        expect(built[0]!.title).toBe('PRs & Issues');
        expect(built[0]!.resultFiltering).toBe('provider');
    });

    it('makes no provider request on an empty query', () => {
        const built = sections();
        expect(built[0]!.visibleWhen?.('')).toBe(false);
        expect(built[0]!.visibleWhen?.('   ')).toBe(false);
        expect(built[0]!.visibleWhen?.('pr')).toBe(true);
    });

    it('keeps the resolver across peer projection changes and rebinds for occurrence, machine, or server changes', () => {
        const first = sections()[0]!.resolverKey;
        const peerProjectionChange = sections({
            projection: projection({ generation: 8 }),
        })[0]!.resolverKey;
        const current = projection();
        const nextOccurrence = sections({
            projection: projection({
                searchProvidersById: Object.freeze({
                    'searchProvider:happier.triage:entries': Object.freeze({
                        ...current.searchProvidersById['searchProvider:happier.triage:entries'],
                        occurrenceId: 'happier-triage-occurrence-8',
                    }),
                }),
                actionsById: Object.freeze({
                    'happier.triage/search': Object.freeze({
                        ...current.actionsById['happier.triage/search']!,
                        occurrenceId: 'happier-triage-occurrence-8',
                    }),
                }),
            }),
        })[0]!.resolverKey;
        const otherMachine = sections({ scopedLaunchFacts: { ...SCOPED, machineId: 'machine-2' } })[0]!.resolverKey;
        const otherServer = sections({ scopedLaunchFacts: { ...SCOPED, serverId: 'server-2' } })[0]!.resolverKey;
        expect(peerProjectionChange).toBe(first);
        expect(new Set([first, nextOccurrence, otherMachine, otherServer]).size).toBe(4);
    });

    it('admits exact source-backed providers and rebinds when their source custody changes', () => {
        const current = projection();
        const sourceOrigin = (registeredRootId: string) => ({
            ...hostOrigin('happier.triage', 'machine-1', 7),
            executionOrigin: {
                serverIdentityId: 'srv_test',
                sourceRef: {
                    pluginId: 'happier.triage',
                    machineId: 'machine-1',
                    sourceCustody: { kind: 'development' as const, registeredRootId },
                },
            },
        });
        const withSource = (providerRoot: string, actionRoot = providerRoot, generation = 7) => projection({
            generation,
            searchProvidersById: {
                'searchProvider:happier.triage:entries': {
                    ...current.searchProvidersById['searchProvider:happier.triage:entries']!,
                    hostOrigin: sourceOrigin(providerRoot),
                },
            },
            actionsById: {
                'happier.triage/search': {
                    ...current.actionsById['happier.triage/search']!,
                    hostOrigin: sourceOrigin(actionRoot),
                },
            },
        });
        const scopedLaunchFacts = { ...SCOPED, serverId: 'server-machine-1' };
        const first = sections({ projection: withSource('root-a'), scopedLaunchFacts });
        expect(first).toHaveLength(1);
        const peerUpdate = sections({ projection: withSource('root-a', 'root-a', 8), scopedLaunchFacts });
        expect(peerUpdate[0]!.resolverKey).toBe(first[0]!.resolverKey);
        const replacement = sections({ projection: withSource('root-b'), scopedLaunchFacts });
        expect(replacement[0]!.resolverKey).not.toBe(first[0]!.resolverKey);
        expect(sections({ projection: withSource('root-a', 'root-b'), scopedLaunchFacts })).toHaveLength(0);
    });

    it('omits a provider whose query Action is unavailable or retired', () => {
        const unavailable = projection({
            actionsById: Object.freeze({
                'happier.triage/search': Object.freeze({
                    id: 'search',
                    pluginId: 'happier.triage',
                    occurrenceId: 'happier-triage-occurrence-7',
                    title: 'PRs & Issues',
                    scopes: ['global'],
                    surfaces: ['ui'],
                    execution: { target: 'daemon' },
                    dangerLevel: 'safe',
                    available: false,
                }),
            }),
        } as Partial<PluginUiProjectionModel>);
        expect(sections({ projection: unavailable })).toHaveLength(0);
        // Uninstalled: the descriptor is gone with the projection it came from.
        expect(sections({
            projection: projection({ searchProvidersById: Object.freeze({}) }),
        })).toHaveLength(0);
        expect(sections({ scopedLaunchFacts: { ...SCOPED, interactionEnabled: false } })).toHaveLength(0);
    });

    it('omits an ambient provider projected for another Home when Search scope changes', () => {
        const scopedProvider = {
            ...SCOPED,
            serverId: 'server-2',
            machineId: 'machine-2',
        };
        const providerWithOrigin = projection({
            searchProvidersById: Object.freeze({
                'searchProvider:happier.triage:entries': Object.freeze({
                    ...projection().searchProvidersById['searchProvider:happier.triage:entries'],
                    hostOrigin: hostOrigin('happier.triage', 'machine-1', 7),
                }),
            }),
        });
        expect(sections({ projection: providerWithOrigin, scopedLaunchFacts: scopedProvider })).toHaveLength(0);
    });

    it('treats null scope coordinates as unconstrained while preserving exact constraints', () => {
        const providerWithOrigin = projection({
            searchProvidersById: Object.freeze({
                'searchProvider:happier.triage:entries': Object.freeze({
                    ...projection().searchProvidersById['searchProvider:happier.triage:entries'],
                    hostOrigin: hostOrigin('happier.triage', 'machine-1', 7),
                }),
            }),
            actionsById: Object.freeze({
                'happier.triage/search': Object.freeze({
                    ...projection().actionsById['happier.triage/search'],
                    hostOrigin: hostOrigin('happier.triage', 'machine-1', 7),
                }),
            }),
        });

        // An exact Home with a coarse machine union still admits the provider.
        expect(sections({
            projection: providerWithOrigin,
            scopedLaunchFacts: { ...SCOPED, serverId: 'server-machine-1', machineId: null },
        })).toHaveLength(1);

        // A coarse Home union with an exact machine constrains only that machine.
        expect(sections({
            projection: providerWithOrigin,
            scopedLaunchFacts: { ...SCOPED, serverId: null, machineId: 'machine-1' },
        })).toHaveLength(1);
        expect(sections({
            projection: providerWithOrigin,
            scopedLaunchFacts: { ...SCOPED, serverId: null, machineId: 'machine-2' },
        })).toHaveLength(0);
    });

    it('queries the declared Action through the one dispatcher and renders its rows', async () => {
        dispatchSemanticCommand.mockResolvedValue({
            ok: true,
            result: {
                items: [{
                    id: 'entry-1',
                    title: 'Fix the crash',
                    subtitle: 'happier/happier',
                    command: { kind: 'openSurface', destination: 'triage', subPath: '' },
                }],
                truncated: true,
            },
        });
        const controller = new AbortController();
        const resolved = await sections()[0]!.resolve('  pr  ', controller.signal);
        expect(dispatchSemanticCommand).toHaveBeenCalledTimes(1);
        const call = dispatchSemanticCommand.mock.calls[0]![0];
        expect(call.callerPluginId).toBe('happier.triage');
        expect(call.command).toEqual({
            kind: 'executeAction',
            action: { pluginId: 'happier.triage', localId: 'search' },
            input: { query: 'pr', limit: 8 },
        });
        expect(call.signal).toBe(controller.signal);
        expect(call.scopedLaunchFacts).toEqual(SCOPED);
        expect(resolved.options).toHaveLength(1);
        expect(resolved.options[0]!.id).toBe(
            `${PLUGIN_SEARCH_SECTION_ID_PREFIX}happier.triage:entries::entry-1`,
        );
        expect(resolved.options[0]!.label).toBe('Fix the crash');
        expect(resolved.options[0]!.subtitle).toBe('happier/happier');
        expect(resolved.emptyHint).toBeUndefined();
        expect(resolved.resultHint).toBe('More results are available. Refine your search.');
    });

    it('uses each provider exact origin in a two-machine union even when coarse union coordinates are null', async () => {
        const firstOrigin = hostOrigin('acme.first', 'machine-a', 11);
        const secondOrigin = hostOrigin('acme.second', 'machine-b', 22);
        const union = projection({
            generation: 999,
            searchProvidersById: Object.freeze({
                'searchProvider:acme.first:entries': Object.freeze({
                    id: 'searchProvider:acme.first:entries',
                    pluginId: 'acme.first',
                    occurrenceId: 'acme-first-occurrence-11',
                    contributionKind: 'searchProvider' as const,
                    descriptorId: 'entries',
                    identity: Object.freeze({ pluginId: 'acme.first', localId: 'entries' }),
                    action: Object.freeze({ pluginId: 'acme.first', localId: 'search' }),
                    hostOrigin: firstOrigin,
                }),
                'searchProvider:acme.second:entries': Object.freeze({
                    id: 'searchProvider:acme.second:entries',
                    pluginId: 'acme.second',
                    occurrenceId: 'acme-second-occurrence-22',
                    contributionKind: 'searchProvider' as const,
                    descriptorId: 'entries',
                    identity: Object.freeze({ pluginId: 'acme.second', localId: 'entries' }),
                    action: Object.freeze({ pluginId: 'acme.second', localId: 'search' }),
                    hostOrigin: secondOrigin,
                }),
            }),
            actionsById: Object.freeze({
                'acme.first/search': Object.freeze({
                    id: 'search', pluginId: 'acme.first', occurrenceId: 'acme-first-occurrence-11', title: 'First', scopes: ['global'], surfaces: ['ui'],
                    execution: { target: 'daemon' }, dangerLevel: 'safe', available: true, hostOrigin: firstOrigin,
                }),
                'acme.second/search': Object.freeze({
                    id: 'search', pluginId: 'acme.second', occurrenceId: 'acme-second-occurrence-22', title: 'Second', scopes: ['global'], surfaces: ['ui'],
                    execution: { target: 'daemon' }, dangerLevel: 'safe', available: true, hostOrigin: secondOrigin,
                }),
            }),
        } as Partial<PluginUiProjectionModel>);
        dispatchSemanticCommand.mockImplementation(async ({ callerPluginId, command }) => ({
            ok: true,
            result: command.kind === 'executeAction' && command.input
                ? {
                    items: [{
                        id: `${callerPluginId}-entry`,
                        title: `${callerPluginId} entry`,
                        command: { kind: 'executeAction', action: 'search' },
                    }],
                    truncated: false,
                }
                : undefined,
        }));

        const onCommitActivation = vi.fn();
        const built = buildPluginSearchProviderSections({
            projection: union,
            scopedLaunchFacts: {
                serverId: null,
                machineId: null,
                interactionEnabled: true,
            },
            onCommitActivation,
        });
        expect(built).toHaveLength(2);
        const resolved = await Promise.all(
            built.map((section) => section.resolve('entry', new AbortController().signal)),
        );

        expect(dispatchSemanticCommand.mock.calls.map(([call]) => call.scopedLaunchFacts)).toEqual([
            { serverId: 'server-machine-a', machineId: 'machine-a', interactionEnabled: true },
            { serverId: 'server-machine-b', machineId: 'machine-b', interactionEnabled: true },
        ]);

        resolved[1]!.options[0]!.onSelect?.();
        await onCommitActivation.mock.calls[0]![0]();
        const activation = dispatchSemanticCommand.mock.calls[2]![0];
        expect(activation.scopedLaunchFacts).toEqual({
            serverId: 'server-machine-b',
            machineId: 'machine-b',
            interactionEnabled: true,
        });
        expect(activation.command).toEqual({
            kind: 'executeAction',
            action: { pluginId: 'acme.second', localId: 'search' },
        });
        expect(activation.projection.actionsById['acme.second/search']?.hostOrigin).toEqual(secondOrigin);
    });

    it('fails the section locally on malformed provider output', async () => {
        dispatchSemanticCommand.mockResolvedValue({
            ok: true,
            result: { items: [{ id: 'entry-1', title: 'Fix', command: { kind: 'openLink', url: 'https://x' } }], truncated: false },
        });
        await expect(sections()[0]!.resolve('pr', new AbortController().signal)).rejects.toThrow(
            /plugin_search_result_invalid/,
        );
    });

    it('fails only the duplicate-id provider while a healthy sibling provider still resolves', async () => {
        const siblingProjection = projection({
            searchProvidersById: Object.freeze({
                ...projection().searchProvidersById,
                'searchProvider:acme.healthy:entries': Object.freeze({
                    id: 'searchProvider:acme.healthy:entries',
                    pluginId: 'acme.healthy',
                    occurrenceId: 'acme-healthy-occurrence-7',
                    contributionKind: 'searchProvider' as const,
                    descriptorId: 'entries',
                    identity: Object.freeze({ pluginId: 'acme.healthy', localId: 'entries' }),
                    action: Object.freeze({ pluginId: 'acme.healthy', localId: 'search' }),
                }),
            }),
            actionsById: Object.freeze({
                ...projection().actionsById,
                'acme.healthy/search': Object.freeze({
                    id: 'search', pluginId: 'acme.healthy', occurrenceId: 'acme-healthy-occurrence-7', title: 'Healthy', scopes: ['global'], surfaces: ['ui'],
                    execution: { target: 'daemon' }, dangerLevel: 'safe', available: true,
                }),
            }),
        } as Partial<PluginUiProjectionModel>);
        dispatchSemanticCommand.mockImplementation(async ({ callerPluginId }) => callerPluginId === 'happier.triage'
            ? {
                ok: true,
                result: {
                    items: [
                        { id: 'same', title: 'One', command: { kind: 'executeAction', action: 'open' } },
                        { id: 'same', title: 'Two', command: { kind: 'executeAction', action: 'open' } },
                    ],
                    truncated: false,
                },
            }
            : {
                ok: true,
                result: {
                    items: [{ id: 'healthy', title: 'Healthy', command: { kind: 'executeAction', action: 'open' } }],
                    truncated: false,
                },
            });
        const built = sections({ projection: siblingProjection });
        const duplicate = built.find((section) => section.id.includes('happier.triage'))!;
        const healthy = built.find((section) => section.id.includes('acme.healthy'))!;

        await expect(duplicate.resolve('entry', new AbortController().signal)).rejects.toThrow(
            /plugin_search_result_duplicate_id/,
        );
        await expect(healthy.resolve('entry', new AbortController().signal)).resolves.toMatchObject({
            options: [expect.objectContaining({ label: 'Healthy' })],
        });
    });

    it('fails only an overbound plugin provider before dispatch while a built-in sibling remains usable', async () => {
        const overbound = 'x'.repeat(257);
        const composed = [
            ...sections(),
            {
                id: 'transcript',
                title: 'Transcript',
                resolverKey: 'healthy-transcript',
                resultFiltering: 'provider' as const,
                resolve: async () => ({
                    options: [{ id: 'transcript::healthy', label: 'Healthy built-in result' }],
                }),
            },
        ];
        const plugin = composed.find((section) => section.id.startsWith(PLUGIN_SEARCH_SECTION_ID_PREFIX))!;
        const transcript = composed.find((section) => section.id === 'transcript')!;

        await expect(plugin.resolve(overbound, new AbortController().signal)).rejects.toThrow(
            /plugin_search_query_invalid/,
        );
        expect(dispatchSemanticCommand).not.toHaveBeenCalled();
        await expect(transcript.resolve(overbound, new AbortController().signal)).resolves.toMatchObject({
            options: [expect.objectContaining({ label: 'Healthy built-in result' })],
        });
    });

    it('reports host-side row truncation even when the provider forgot to mark it', async () => {
        dispatchSemanticCommand.mockResolvedValue({
            ok: true,
            result: {
                items: [
                    { id: 'entry-1', title: 'One', command: { kind: 'openSurface', destination: 'triage' } },
                    { id: 'entry-2', title: 'Two', command: { kind: 'openSurface', destination: 'triage' } },
                ],
                truncated: false,
            },
        });
        const resolved = await sections({ rowLimit: 1 })[0]!.resolve(
            'pr',
            new AbortController().signal,
        );
        expect(resolved.options).toHaveLength(1);
        expect(resolved.resultHint).toBe('More results are available. Refine your search.');
    });

    it('fails the section locally on a typed dispatch failure', async () => {
        dispatchSemanticCommand.mockResolvedValue({ ok: false, code: 'unavailable', reason: 'plugin_ui_action_unavailable' });
        await expect(sections()[0]!.resolve('pr', new AbortController().signal)).rejects.toThrow(
            /plugin_ui_action_unavailable/,
        );
    });

    it('stops before dispatching when the query is already cancelled', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(sections()[0]!.resolve('pr', controller.signal)).rejects.toThrow();
        expect(dispatchSemanticCommand).not.toHaveBeenCalled();
    });

    it('does not publish query rows after the captured Account lifetime retires', async () => {
        let resolveQuery!: (value: unknown) => void;
        dispatchSemanticCommand.mockImplementationOnce(() => new Promise((resolve) => {
            resolveQuery = resolve;
        }));
        let current = true;
        const accountLifetime = {
            scope: { serverId: 'server-a', accountId: 'account-a' },
            isCurrent: () => current,
            onRetire: () => ({ dispose: () => undefined }),
        };
        const section = sections({ accountLifetime, accountLifetimeRevision: 1 })[0]!;
        const pending = section.resolve('private', new AbortController().signal);
        await vi.waitFor(() => expect(dispatchSemanticCommand).toHaveBeenCalledTimes(1));

        current = false;
        resolveQuery({
            ok: true,
            result: {
                items: [{
                    id: 'private-entry',
                    title: 'Private entry',
                    command: { kind: 'executeAction', action: 'open-entry' },
                }],
                truncated: false,
            },
        });

        await expect(pending).resolves.toEqual({ options: [] });
    });

    it('commits without dispatching, then activates through the incumbent semantic-command owner', async () => {
        dispatchSemanticCommand.mockResolvedValueOnce({
            ok: true,
            result: {
                items: [{
                    id: 'entry-1',
                    title: 'Fix the crash',
                    command: { kind: 'openSurface', destination: 'triage', input: { v: 1 }, subPath: '' },
                }],
                truncated: false,
            },
        }).mockResolvedValueOnce({ ok: true });
        const onCommitActivation = vi.fn();
        const built = buildPluginSearchProviderSections({
            projection: projection(),
            scopedLaunchFacts: SCOPED,
            rowLimit: 8,
            onCommitActivation,
        } as Parameters<typeof buildPluginSearchProviderSections>[0]);
        const resolved = await built[0]!.resolve('pr', new AbortController().signal);
        resolved.options[0]!.onSelect?.();
        expect(dispatchSemanticCommand).toHaveBeenCalledTimes(1);
        expect(onCommitActivation).toHaveBeenCalledTimes(1);
        const outcome = await onCommitActivation.mock.calls[0]![0]();
        expect(dispatchSemanticCommand).toHaveBeenCalledTimes(2);
        expect(dispatchSemanticCommand.mock.calls[1]![0]).toMatchObject({
            callerPluginId: 'happier.triage',
            command: {
                kind: 'openSurface',
                destination: { pluginId: 'happier.triage', localId: 'triage' },
                input: { v: 1 },
                subPath: '',
            },
        });
        expect(outcome).toEqual({ ok: true });
    });

    it('refuses activation once the admitting generation is gone', async () => {
        dispatchSemanticCommand.mockResolvedValue({
            ok: true,
            result: {
                items: [{ id: 'entry-1', title: 'Fix', command: { kind: 'executeAction', action: 'open-entry' } }],
                truncated: false,
            },
        });
        const onCommitActivation = vi.fn();
        let current = true;
        const accountLifetime = {
            scope: { serverId: 'server-a', accountId: 'account-a' },
            isCurrent: () => current,
            onRetire: () => ({ dispose: () => undefined }),
        };
        const built = buildPluginSearchProviderSections({
            projection: projection(),
            scopedLaunchFacts: SCOPED,
            rowLimit: 8,
            accountLifetime,
            accountLifetimeRevision: 1,
            onCommitActivation,
        } as Parameters<typeof buildPluginSearchProviderSections>[0]);
        const resolved = await built[0]!.resolve('pr', new AbortController().signal);
        current = false;
        resolved.options[0]!.onSelect?.();
        expect(dispatchSemanticCommand).toHaveBeenCalledTimes(1);
        const outcome = await onCommitActivation.mock.calls[0]![0]();
        expect(outcome).toEqual({
            ok: false,
            code: 'stale_surface',
            reason: 'plugin_ui_generation_retired',
        });
        expect(dispatchSemanticCommand).toHaveBeenCalledTimes(1);
    });

    it('does not accept a replacement Account lifetime merely because its scope strings are identical', async () => {
        dispatchSemanticCommand.mockResolvedValueOnce({
            ok: true,
            result: {
                items: [{ id: 'entry-1', title: 'Private result', command: { kind: 'executeAction', action: 'open-entry' } }],
                truncated: false,
            },
        });
        const onCommitActivation = vi.fn();
        let admittingLifetimeCurrent = true;
        const admittingLifetime = {
            scope: { serverId: 'server-a', accountId: 'account-a' },
            isCurrent: () => admittingLifetimeCurrent,
            onRetire: () => ({ dispose: () => undefined }),
        };
        const built = buildPluginSearchProviderSections({
            projection: projection(),
            scopedLaunchFacts: SCOPED,
            accountLifetime: admittingLifetime,
            accountLifetimeRevision: 4,
            onCommitActivation,
        } as Parameters<typeof buildPluginSearchProviderSections>[0]);
        const resolved = await built[0]!.resolve('private', new AbortController().signal);

        admittingLifetimeCurrent = false;
        const replacementLifetime = {
            scope: { ...admittingLifetime.scope },
            isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }),
        };
        expect(replacementLifetime.scope).toEqual(admittingLifetime.scope);
        resolved.options[0]!.onSelect?.();

        await expect(onCommitActivation.mock.calls[0]![0]()).resolves.toEqual({
            ok: false,
            code: 'stale_surface',
            reason: 'plugin_ui_generation_retired',
        });
        expect(dispatchSemanticCommand).toHaveBeenCalledTimes(1);
    });

    it('replaces and removes provider sections across update, disable, and uninstall lifecycle changes', () => {
        const original = sections()[0]!;
        const current = projection();
        const updated = sections({ projection: projection({
            generation: 8,
            searchProvidersById: Object.freeze({
                'searchProvider:happier.triage:entries': Object.freeze({
                    ...current.searchProvidersById['searchProvider:happier.triage:entries'],
                    occurrenceId: 'happier-triage-occurrence-8',
                }),
            }),
            actionsById: Object.freeze({
                'happier.triage/search': Object.freeze({
                    ...current.actionsById['happier.triage/search']!,
                    occurrenceId: 'happier-triage-occurrence-8',
                }),
            }),
        }) })[0]!;
        expect(updated.id).toBe(original.id);
        expect(updated.resolverKey).not.toBe(original.resolverKey);
        expect(sections({ scopedLaunchFacts: { ...SCOPED, interactionEnabled: false } })).toEqual([]);
        expect(sections({ projection: projection({ searchProvidersById: Object.freeze({}) }) })).toEqual([]);
    });
});
