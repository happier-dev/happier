import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type {
    ComposerRefV1,
    DaemonPluginUiComposerSurfaceCatalogEntryV1,
    PluginProjectedComposerControlEntryV1,
    PluginProjectedComposerRegionEntryV1,
    PluginProjectionV2,
} from '@happier-dev/protocol';
import type { PluginSurfaceTarget } from '@happier-dev/plugin-sdk/ui';

import { renderHook, renderScreen } from '@/dev/testkit';
import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type {
    PluginContributedActionController,
    PluginContributedActionCurrentSnapshot,
} from '@/components/plugins/actions/pluginContributedActionController';

import type { ComposerScopePluginPresentation } from './useComposerScopePluginPresentation';

const pluginSurfaceHostSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
    });
});

vi.mock('@/components/plugins/surfaces/PluginSurfaceHost', () => ({
    PluginSurfaceHost: (props: Record<string, unknown>) => {
        pluginSurfaceHostSpy(props);
        return React.createElement('PluginSurfaceHost', props);
    },
}));

const region = {
    id: 'acme.compose/summary',
    pluginId: 'acme.compose',
    identity: { pluginId: 'acme.compose', localId: 'summary' },
    immutableGenerationId: 'generation-1',
    definition: {
        id: 'summary',
        placement: 'beforeComposer',
    },
};

const control = {
    id: 'acme.compose/refresh',
    pluginId: 'acme.compose',
    identity: { pluginId: 'acme.compose', localId: 'refresh' },
    immutableGenerationId: 'generation-1',
    definition: {
        id: 'refresh',
        label: 'Refresh',
        icon: 'sparkles',
        interaction: { kind: 'action', action: 'refresh' },
    },
};

function createCatalogEntry(): DaemonPluginUiComposerSurfaceCatalogEntryV1 {
    return {
        contribution: region.identity,
        immutableGenerationId: 'generation-1',
        projectionGeneration: 7,
        role: 'region',
        rendererChain: [{ pluginId: 'acme.compose', localId: 'summary-renderer' }],
        selectedRenderer: {
            identity: { pluginId: 'acme.compose', localId: 'summary-renderer' },
            renderer: {
                kind: 'declarative',
                contributionId: 'summary-renderer',
                model: { visible: true },
            },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        },
        executionOrigin: {
            serverIdentityId: 'server-1',
            materializationRef: {
                machineId: 'machine-1',
                materializationId: 'materialization-1',
                pluginId: 'acme.compose',
            },
        },
        resourceCapability: { readable: true, dynamic: true },
        contributorTargetedContributions: {
            target: { pluginId: 'acme.compose', immutableGenerationId: 'generation-1' },
            points: [],
        },
    } as DaemonPluginUiComposerSurfaceCatalogEntryV1;
}

function createProjection(): PluginProjectionV2 {
    return {
        v: 2,
        generation: 7,
        installedPackagesById: {},
        familiesById: {
            composerControls: {
                entriesById: { [control.id]: control },
            },
            composerRegions: {
                entriesById: { [region.id]: region },
            },
        },
    } as PluginProjectionV2;
}

function createOrderedControl(input: Readonly<{
    localId: string;
    order?: number;
}>): PluginProjectedComposerControlEntryV1 {
    return {
        id: `acme.compose/${input.localId}`,
        pluginId: 'acme.compose',
        identity: { pluginId: 'acme.compose', localId: input.localId },
        immutableGenerationId: 'generation-1',
        definition: {
            id: input.localId,
            label: input.localId,
            icon: 'preview',
            ...(input.order === undefined ? {} : { order: input.order }),
            interaction: { kind: 'action', action: 'refresh' },
        },
    } as PluginProjectedComposerControlEntryV1;
}

function createOrderedRegion(input: Readonly<{
    localId: string;
    order?: number;
}>): PluginProjectedComposerRegionEntryV1 {
    return {
        id: `acme.compose/${input.localId}`,
        pluginId: 'acme.compose',
        identity: { pluginId: 'acme.compose', localId: input.localId },
        immutableGenerationId: 'generation-1',
        definition: {
            id: input.localId,
            placement: 'beforeComposer',
            ...(input.order === undefined ? {} : { order: input.order }),
        },
    } as PluginProjectedComposerRegionEntryV1;
}

function createPluginProjectionById(): Readonly<Record<string, PluginProjectionEntry>> {
    return {
        'acme.compose': {
            pluginId: 'acme.compose',
            immutableGenerationId: 'generation-1',
            title: 'Acme Compose',
            description: null,
            version: '1.0.0',
            enabled: true,
            generation: 7,
            generationLabel: '7',
            status: null,
            provenance: null,
            diagnostics: [],
            resources: [],
            editableSettingsGroups: [],
            actions: [{
                id: 'review',
                title: 'Review',
                description: null,
                icon: null,
                scopes: ['session'],
                surfaces: ['ui'],
                placementBindings: ['composer.slash'],
                inputSchema: null,
                inputHints: { fields: [] },
                slash: { tokens: ['/review'] },
                priority: null,
                dangerLevel: 'safe',
                confirmation: null,
                available: true,
            }],
        },
    };
}

type ComposerScopeSessionActionAdapterPresentation = ComposerScopePluginPresentation & Readonly<{
    actionController: PluginContributedActionController;
    composerRegions: readonly PluginProjectedComposerRegionEntryV1[];
    getCurrentActionSnapshot: () => PluginContributedActionCurrentSnapshot | null;
    renderComposerRegion: (region: PluginProjectedComposerRegionEntryV1) => React.ReactNode;
    scopeSignal: AbortSignal;
}>;

function asSessionActionAdapterPresentation(
    presentation: ComposerScopePluginPresentation,
): ComposerScopeSessionActionAdapterPresentation {
    return presentation as ComposerScopeSessionActionAdapterPresentation;
}

const scopeCases: readonly Readonly<{
    label: string;
    composer: ComposerRefV1;
    physicalTarget: PluginSurfaceTarget;
    resourceContext: Readonly<{ kind: 'global' }> | Readonly<{ kind: 'session'; sessionId: string }>;
}>[] = [
    {
        label: 'new Session on its truthful app target',
        composer: { kind: 'newSession', instanceId: 'new-session-1' },
        physicalTarget: { kind: 'app' },
        resourceContext: { kind: 'global' },
    },
    {
        label: 'participant authoring on its truthful Session target',
        composer: { kind: 'participantMessage', sessionId: 'session-1', instanceId: 'participant-1' },
        physicalTarget: { kind: 'session', sessionId: 'session-1' },
        resourceContext: { kind: 'session', sessionId: 'session-1' },
    },
    {
        label: 'existing Session on its truthful Session target',
        composer: { kind: 'session', sessionId: 'session-1' },
        physicalTarget: { kind: 'session', sessionId: 'session-1' },
        resourceContext: { kind: 'session', sessionId: 'session-1' },
    },
    {
        label: 'automation authoring on its truthful Session target',
        composer: { kind: 'automationAuthoring', sessionId: 'session-1', instanceId: 'automation-1' },
        physicalTarget: { kind: 'session', sessionId: 'session-1' },
        resourceContext: { kind: 'session', sessionId: 'session-1' },
    },
];

describe('useComposerScopePluginPresentation', () => {
    it('projects admitted Composer controls and regions by declaration order, then qualified id', async () => {
        const { useComposerScopePluginPresentation } = await import('./useComposerScopePluginPresentation');
        const controls = [
            createOrderedControl({ localId: 'late', order: 10 }),
            createOrderedControl({ localId: 'z-tie', order: 0 }),
            createOrderedControl({ localId: 'a-tie', order: 0 }),
        ];
        const regions = [
            createOrderedRegion({ localId: 'late-region', order: 10 }),
            createOrderedRegion({ localId: 'z-tie-region', order: 0 }),
            createOrderedRegion({ localId: 'a-tie-region', order: 0 }),
        ];
        const projection = {
            v: 2,
            generation: 7,
            installedPackagesById: {},
            familiesById: {
                composerControls: {
                    entriesById: Object.fromEntries(controls.map((entry) => [entry.id, entry])),
                },
                composerRegions: {
                    entriesById: Object.fromEntries(regions.map((entry) => [entry.id, entry])),
                },
            },
        } as PluginProjectionV2;
        const presentationRef: { current: ComposerScopePluginPresentation | null } = { current: null };
        let tree!: ReturnType<typeof create>;
        function Harness(): null {
            presentationRef.current = useComposerScopePluginPresentation({
                composer: { kind: 'session', sessionId: 'session-1' },
                physicalTarget: { kind: 'session', sessionId: 'session-1' },
                resourceContext: { kind: 'session', sessionId: 'session-1' },
                machineId: 'machine-1',
                serverId: 'server-1',
                projectionPhase: 'ready',
                projectionInputs: {
                    pluginProjectionById: {},
                    pluginProjectionV2: projection,
                    composerSurfaceCatalog: [],
                },
                accountLifetime: null,
                isScopeCurrent: () => true,
                attachmentsEnabled: true,
                includeSessionActions: false,
            });
            return null;
        }

        act(() => {
            tree = create(<Harness />);
        });
        const presentation = presentationRef.current;
        if (presentation === null) throw new Error('expected Composer presentation');

        expect(presentation.extraActionChips.map((chip) => chip.controlId)).toEqual([
            'plugin:acme.compose/a-tie',
            'plugin:acme.compose/z-tie',
            'plugin:acme.compose/late',
        ]);
        expect(presentation.composerRegions.map((entry) => entry.id)).toEqual([
            'acme.compose/a-tie-region',
            'acme.compose/z-tie-region',
            'acme.compose/late-region',
        ]);

        act(() => tree.unmount());
    });

    it.each(scopeCases)('mounts a region for $label through the shared host seam', async (scope) => {
        pluginSurfaceHostSpy.mockClear();
        const { useComposerScopePluginPresentation } = await import('./useComposerScopePluginPresentation');
        const projection = createProjection();
        const hook = await renderHook(() => useComposerScopePluginPresentation({
            composer: scope.composer,
            physicalTarget: scope.physicalTarget,
            resourceContext: scope.resourceContext,
            machineId: 'machine-1',
            serverId: 'server-1',
            projectionPhase: 'ready',
            projectionInputs: {
                pluginProjectionById: {},
                pluginProjectionV2: projection,
                composerSurfaceCatalog: [createCatalogEntry()],
            },
            accountLifetime: null,
            isScopeCurrent: () => true,
            attachmentsEnabled: scope.composer.kind !== 'automationAuthoring',
            includeSessionActions: false,
        }));

        await renderScreen(<>{hook.getCurrent().beforeComposer}</>);

        expect(pluginSurfaceHostSpy).toHaveBeenCalledWith(expect.objectContaining({
            composerMount: expect.objectContaining({
                physicalTarget: scope.physicalTarget,
                mount: expect.objectContaining({
                    kind: 'composer',
                    mount: expect.objectContaining({
                        role: 'region',
                        input: expect.objectContaining({ composer: scope.composer }),
                    }),
                }),
            }),
        }));

        await hook.unmount();
    });

    // A Composer surface is a mounted plugin surface like any other. The scope
    // already resolves the ONE qualified-destination owner for the target it is
    // mounted in and hands it to its declarative control host; a physical
    // Composer surface that never receives it installs no `openSurface`, so an
    // enabled control (Triage's **View details**) refuses every press. This
    // asserts the binding reaches the physical mount, not merely that the
    // scope resolved one.
    it('hands the enclosing scope navigation binding to every physical Composer surface', async () => {
        pluginSurfaceHostSpy.mockClear();
        const { useComposerScopePluginPresentation } = await import('./useComposerScopePluginPresentation');
        const {
            PluginSurfaceDestinationNavigationBindingProvider,
        } = await import('@/components/plugins/surfaces/pluginSurfaceDestinationNavigation');
        const openSurface = vi.fn(async () => ({ ok: true as const }));
        const binding = Object.freeze({
            targetKind: 'session' as const,
            openSurface,
            registerOwner: () => () => {},
        });
        const projection = createProjection();
        const hook = await renderHook(() => useComposerScopePluginPresentation({
            composer: { kind: 'session', sessionId: 'session-1' },
            physicalTarget: { kind: 'session', sessionId: 'session-1' },
            resourceContext: { kind: 'session', sessionId: 'session-1' },
            machineId: 'machine-1',
            serverId: 'server-1',
            projectionPhase: 'ready',
            projectionInputs: {
                pluginProjectionById: {},
                pluginProjectionV2: projection,
                composerSurfaceCatalog: [createCatalogEntry()],
            },
            accountLifetime: null,
            isScopeCurrent: () => true,
            attachmentsEnabled: true,
            includeSessionActions: false,
        }), {
            wrapper: ({ children }) => (
                <PluginSurfaceDestinationNavigationBindingProvider binding={binding}>
                    {children}
                </PluginSurfaceDestinationNavigationBindingProvider>
            ),
        });

        await renderScreen(<>{hook.getCurrent().beforeComposer}</>);

        const hostProps = pluginSurfaceHostSpy.mock.calls.at(-1)?.[0] as Readonly<{
            composerMount?: Readonly<{ binding?: Readonly<{ openSurface?: unknown }> }>;
        }>;
        expect(hostProps.composerMount?.binding?.openSurface).toBe(openSurface);

        await hook.unmount();
    });

    // Factual absence is preserved: a Composer scope with no enclosing
    // destination binding must not advertise a navigation handler the host
    // cannot honour.
    it('installs no openSurface binding when the scope has no enclosing destination owner', async () => {
        pluginSurfaceHostSpy.mockClear();
        const { useComposerScopePluginPresentation } = await import('./useComposerScopePluginPresentation');
        const projection = createProjection();
        const hook = await renderHook(() => useComposerScopePluginPresentation({
            composer: { kind: 'session', sessionId: 'session-1' },
            physicalTarget: { kind: 'session', sessionId: 'session-1' },
            resourceContext: { kind: 'session', sessionId: 'session-1' },
            machineId: 'machine-1',
            serverId: 'server-1',
            projectionPhase: 'ready',
            projectionInputs: {
                pluginProjectionById: {},
                pluginProjectionV2: projection,
                composerSurfaceCatalog: [createCatalogEntry()],
            },
            accountLifetime: null,
            isScopeCurrent: () => true,
            attachmentsEnabled: true,
            includeSessionActions: false,
        }));

        await renderScreen(<>{hook.getCurrent().beforeComposer}</>);

        const hostProps = pluginSurfaceHostSpy.mock.calls.at(-1)?.[0] as Readonly<{
            composerMount?: Readonly<{ binding?: Readonly<{ openSurface?: unknown }> }>;
        }>;
        expect(hostProps.composerMount?.binding).toBeDefined();
        expect(hostProps.composerMount?.binding?.openSurface).toBeUndefined();

        await hook.unmount();
    });

    it('withdraws existing-Session controls and regions when its owner retires the scope', async () => {
        const { useComposerScopePluginPresentation } = await import('./useComposerScopePluginPresentation');
        const projection = createProjection();
        const hook = await renderHook(({ current }: Readonly<{ current: boolean }>) => {
            const isScopeCurrent = React.useCallback(() => current, [current]);
            return useComposerScopePluginPresentation({
                composer: { kind: 'session', sessionId: 'session-1' },
                physicalTarget: { kind: 'session', sessionId: 'session-1' },
                resourceContext: { kind: 'session', sessionId: 'session-1' },
                machineId: 'machine-1',
                serverId: 'server-1',
                projectionPhase: 'ready',
                projectionInputs: {
                    pluginProjectionById: {},
                    pluginProjectionV2: projection,
                    composerSurfaceCatalog: [createCatalogEntry()],
                },
                accountLifetime: null,
                isScopeCurrent,
                attachmentsEnabled: true,
                includeSessionActions: true,
            });
        }, { initialProps: { current: true } });

        expect(hook.getCurrent().extraActionChips).toHaveLength(1);
        expect(hook.getCurrent().beforeComposer).toHaveLength(1);

        await hook.rerender({ current: false });

        expect(hook.getCurrent().extraActionChips).toEqual([]);
        expect(hook.getCurrent().beforeComposer).toEqual([]);

        await hook.unmount();
    });

    it('keeps the shared scope current for reordered equivalent Composer refs', async () => {
        const { useComposerScopePluginPresentation } = await import('./useComposerScopePluginPresentation');
        const projection = createProjection();
        const initialComposer: ComposerRefV1 = {
            kind: 'pendingMessage',
            sessionId: 'session-1',
            localId: 'pending-1',
        };
        const reorderedEquivalentComposer: ComposerRefV1 = {
            localId: 'pending-1',
            kind: 'pendingMessage',
            sessionId: 'session-1',
        };
        const projectionInputs = {
            pluginProjectionById: {},
            pluginProjectionV2: projection,
            composerSurfaceCatalog: [createCatalogEntry()],
        };
        const isScopeCurrent = (): boolean => true;
        const readParentLifetime = (node: React.ReactNode): unknown => (
            React.isValidElement<Readonly<{ parentLifetime: unknown }>>(node)
                ? node.props.parentLifetime
                : null
        );
        const hook = await renderHook(({ composer }: Readonly<{ composer: ComposerRefV1 }>) => (
            useComposerScopePluginPresentation({
                composer,
                physicalTarget: { kind: 'session', sessionId: 'session-1' },
                resourceContext: { kind: 'session', sessionId: 'session-1' },
                machineId: 'machine-1',
                serverId: 'server-1',
                projectionPhase: 'ready',
                projectionInputs,
                accountLifetime: null,
                isScopeCurrent,
                attachmentsEnabled: true,
                includeSessionActions: true,
            })
        ), { initialProps: { composer: initialComposer } });

        const active = asSessionActionAdapterPresentation(hook.getCurrent());
        const activeSignal = active.scopeSignal;
        const activeSnapshot = active.getCurrentActionSnapshot();
        const activeLifetime = readParentLifetime(active.renderComposerRegion(active.composerRegions[0]!));
        expect(activeSnapshot).not.toBeNull();
        expect(activeLifetime).not.toBeNull();
        if (!activeSnapshot) throw new Error('Expected an active Composer scope snapshot.');

        await hook.rerender({ composer: reorderedEquivalentComposer });

        const current = asSessionActionAdapterPresentation(hook.getCurrent());
        expect(activeSignal.aborted).toBe(false);
        expect(current.scopeSignal).toBe(activeSignal);
        expect(activeSnapshot.host.isCurrent?.()).toBe(true);
        expect(current.getCurrentActionSnapshot()).toBe(activeSnapshot);
        expect(readParentLifetime(current.renderComposerRegion(current.composerRegions[0]!))).toBe(activeLifetime);

        await hook.unmount();
    });

    it('keeps the existing-Session action adapter on the shared current scope', async () => {
        const { useComposerScopePluginPresentation } = await import('./useComposerScopePluginPresentation');
        const projection = createProjection();
        const pluginProjectionById = createPluginProjectionById();
        const hook = await renderHook(({ current }: Readonly<{ current: boolean }>) => {
            const isScopeCurrent = React.useCallback(() => current, [current]);
            return useComposerScopePluginPresentation({
                composer: { kind: 'session', sessionId: 'session-1' },
                physicalTarget: { kind: 'session', sessionId: 'session-1' },
                resourceContext: { kind: 'session', sessionId: 'session-1' },
                machineId: 'machine-1',
                serverId: 'server-1',
                projectionPhase: 'ready',
                projectionInputs: {
                    pluginProjectionById,
                    pluginProjectionV2: projection,
                    composerSurfaceCatalog: [createCatalogEntry()],
                },
                accountLifetime: null,
                isScopeCurrent,
                attachmentsEnabled: true,
                includeSessionActions: true,
            });
        }, { initialProps: { current: true } });

        const active = asSessionActionAdapterPresentation(hook.getCurrent());
        const retiredSignal = active.scopeSignal;
        expect(active.getCurrentActionSnapshot()).not.toBeNull();
        expect(active.composerRegions).toEqual([
            expect.objectContaining({ id: region.id }),
        ]);
        expect(active.renderComposerRegion).toEqual(expect.any(Function));
        expect(active.actionController.listSlashCommands()).toEqual([
            expect.objectContaining({
                qualifiedActionId: 'acme.compose/review',
                placement: 'composer.slash',
                scope: 'session',
            }),
        ]);

        await hook.rerender({ current: false });

        const retired = asSessionActionAdapterPresentation(hook.getCurrent());
        expect(retiredSignal.aborted).toBe(true);
        expect(retired.composerRegions).toEqual([]);
        expect(retired.getCurrentActionSnapshot()).toBeNull();
        expect(retired.actionController.listSlashCommands()).toEqual([]);

        await hook.unmount();
    });

    // The host attachment row already renders this instance's label, error
    // feedback and remove control around the mounted custom display. Handing
    // that mount a complete attachment row as its failure fallback rendered a
    // SECOND label and remove control inside the first one. One boundary owns
    // the row; the mounted child owns only body-level failure content.
    it('installs no nested attachment-row fallback on a custom attachment display mount', async () => {
        const { useComposerScopePluginPresentation } = await import('./useComposerScopePluginPresentation');
        const projection = createProjection();
        const hook = await renderHook(() => useComposerScopePluginPresentation({
            composer: { kind: 'session', sessionId: 'session-1' },
            physicalTarget: { kind: 'session', sessionId: 'session-1' },
            resourceContext: { kind: 'session', sessionId: 'session-1' },
            machineId: 'machine-1',
            serverId: 'server-1',
            projectionPhase: 'ready',
            projectionInputs: {
                pluginProjectionById: {},
                pluginProjectionV2: projection,
                composerSurfaceCatalog: [createCatalogEntry()],
            },
            accountLifetime: null,
            isScopeCurrent: () => true,
            attachmentsEnabled: true,
            includeSessionActions: false,
        }));

        const attachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.compose', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { typeLabel: 'Issue', label: 'Issue #42' },
            availability: { status: 'ready' },
        } as const;
        const surface = hook.getCurrent().renderAttachmentSurface({
            attachment,
            catalog: {
                identity: attachment.attachment,
                immutableGenerationId: 'generation-1',
                display: { kind: 'surface', sizing: 'content', renderer: { chain: [] } },
            },
            // Exactly what the row projection offers today: a complete badge
            // carrying this instance's label and its own remove control.
            fallback: {
                kind: 'badge',
                key: 'composer-attachment:issue-42',
                label: 'Issue #42',
                availability: 'ready',
                onRemove: () => undefined,
            },
        } as never);

        const mounted = surface?.renderedContent as React.ReactElement<Record<string, unknown>> | null;
        expect(mounted).not.toBeNull();
        // Positive twin: this is still the exact attachment display mount.
        expect((mounted?.props.request as Readonly<{ role: string }>).role).toBe('attachmentDisplay');
        expect(surface?.sizing).toBe('content');
        // The failure boundary keeps the incumbent body-level unavailable
        // presentation instead of a caller-supplied attachment row.
        expect(mounted?.props).not.toHaveProperty('fallback');

        await hook.unmount();
    });
});
