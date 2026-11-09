import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ComposerSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/composer';

import type {
    ComposerRefV1} from '@happier-dev/protocol/plugins/ui/composerRef';
import type {
    DaemonPluginUiComposerSurfaceCatalogEntryV1,
    PluginProjectedComposerControlEntryV1,
    PluginProjectedComposerRegionEntryV1,
    PluginProjectionV2,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
    DaemonPluginUiComposerSurfaceCatalogEntryV1Schema,
    PluginProjectedComposerControlEntryV1Schema,
    PluginProjectedComposerRegionEntryV1Schema,
    PluginProjectionV2Schema,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginSurfaceTarget } from '@happier-dev/plugin-sdk/ui';

import { renderHook, renderScreen } from '@/dev/testkit';
import { Modal, ModalProvider } from '@/modal';
import type { PluginSurfaceOpenHandler, PluginSurfaceOpenOutcome } from '@/components/plugins/surfaces/openPluginSurface';
import { createPluginUiTranslationRuntime, PluginUiTranslationRuntimeProvider } from '@/sync/domains/plugins/ui/i18n';
import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { publishDaemonMergedProjectionInputs } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type {
    PluginContributedActionController,
    PluginContributedActionCurrentSnapshot,
} from '@/components/plugins/actions/pluginContributedActionController';

// Imported statically, like every other owner under test here. A dynamic
// `await import(...)` inside a test body bills this hook's whole module graph
// to the FIRST test's timeout instead of to collection, which is why the
// projection case alone accounted for 33s of a 33.4s file.
import {
    useComposerScopePluginPresentation,
    type ComposerScopePluginPresentation,
} from './useComposerScopePluginPresentation';
import { registerComposerPresentationTarget, registerSessionComposerPresentationTarget } from './sessionComposerPresentationTargets';

const accountScope = { serverId: 'server-1', accountId: 'composer-account' };
const accountLifetime = { scope: accountScope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };

function registerMountedComposer(ref: ComposerRefV1): void {
    const snapshot = ComposerSnapshotV1Schema.parse({
        revision: 1, ref, text: '', references: [], attachments: [], layout: 'wrap',
        capabilities: { text: true, references: true, attachments: true, submit: true },
        state: { focused: false, editable: true, submittable: true, submitting: false, running: false },
    });
    const target = { readScope: () => accountScope, readSnapshot: () => snapshot, readRevision: () => 1, replace: () => 1 };
    onTestFinished(ref.kind === 'session'
        ? registerSessionComposerPresentationTarget({ serverId: accountScope.serverId, sessionId: ref.sessionId }, target)
        : registerComposerPresentationTarget(ref, target));
}

const pluginSurfaceHostSpy = vi.hoisted(() => vi.fn());

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ renderCustomModals: true }).module;
});

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
    occurrenceId: 'generation-1',
    definition: {
        id: 'summary',
        placement: 'beforeComposer',
        renderer: { renderer: 'summary-renderer' },
    },
};

const control = {
    id: 'acme.compose/refresh',
    pluginId: 'acme.compose',
    identity: { pluginId: 'acme.compose', localId: 'refresh' },
    occurrenceId: 'generation-1',
    definition: {
        id: 'refresh',
        label: 'Refresh',
        icon: 'preview',
        interaction: { kind: 'action', action: 'refresh' },
    },
};

function createCatalogEntry(): DaemonPluginUiComposerSurfaceCatalogEntryV1 {
    return DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.parse({
        contribution: region.identity,
        occurrenceId: 'generation-1',
        projectionGeneration: 7,
        role: 'region',
        rendererChain: [{ pluginId: 'acme.compose', localId: 'summary-renderer' }],
        selectedRenderer: {
            identity: { pluginId: 'acme.compose', localId: 'summary-renderer' },
            renderer: {
                kind: 'declarative',
                contributionId: 'summary-renderer',
            },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        },
        executionOrigin: {
            serverIdentityId: 'srv_server-1',
            materializationRef: {
                machineId: 'machine-1',
                materializationId: 'materialization-1',
                pluginId: 'acme.compose',
            },
        },
        resourceCapability: { readable: true, dynamic: true },
        contributorTargetedContributions: {
            target: {
                pluginId: 'acme.compose',
                occurrenceId: 'generation-1',
                sourceCustody: { kind: 'development', registeredRootId: 'compose-root' },
            },
            points: [],
        },
    });
}

function createProjection(): PluginProjectionV2 {
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation: 7,
        familiesById: {
            composerControls: {
                family: 'composerControls',
                entriesById: { [control.id]: control },
            },
            composerRegions: {
                family: 'composerRegions',
                entriesById: { [region.id]: region },
            },
        },
    });
}

function createOrderedControl(input: Readonly<{
    localId: string;
    order?: number;
}>): PluginProjectedComposerControlEntryV1 {
    return PluginProjectedComposerControlEntryV1Schema.parse({
        id: `acme.compose/${input.localId}`,
        pluginId: 'acme.compose',
        identity: { pluginId: 'acme.compose', localId: input.localId },
        occurrenceId: 'generation-1',
        definition: {
            id: input.localId,
            label: input.localId,
            icon: 'preview',
            ...(input.order === undefined ? {} : { order: input.order }),
            interaction: { kind: 'action', action: 'refresh' },
        },
    });
}

function createOrderedRegion(input: Readonly<{
    localId: string;
    order?: number;
}>): PluginProjectedComposerRegionEntryV1 {
    return PluginProjectedComposerRegionEntryV1Schema.parse({
        id: `acme.compose/${input.localId}`,
        pluginId: 'acme.compose',
        identity: { pluginId: 'acme.compose', localId: input.localId },
        occurrenceId: 'generation-1',
        definition: {
            id: input.localId,
            placement: 'beforeComposer',
            renderer: { renderer: `${input.localId}-renderer` },
            ...(input.order === undefined ? {} : { order: input.order }),
        },
    });
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
                occurrenceId: 'generation-1',
                title: 'Review',
                description: null,
                icon: null,
                scopes: ['session'],
                surfaces: ['ui'],
                placementBindings: ['composer.slash'],
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
        label: 'independent Discussion on its truthful app target',
        composer: { kind: 'discussion', discussionId: 'discussion-1' },
        physicalTarget: { kind: 'app' },
        resourceContext: { kind: 'global' },
    },
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
    it('refreshes visible copy without retiring the current Action snapshot', async () => {
        const base = publishDaemonMergedProjectionInputs({ projection: createProjection() });
        const projectionInputs = { ...base, pluginUiProjection: { ...base.pluginUiProjection, translationsByPluginId: {
            'acme.compose': { id: 'translations:acme.compose', pluginId: 'acme.compose', contributionKind: 'translations' as const,
                locales: ['en'], resourceIdsByLocale: { en: 'copy.en' } },
        } } };
        let finishRead!: (bytes: Uint8Array) => void;
        const runtime = createPluginUiTranslationRuntime({ projection: projectionInputs.pluginUiProjection,
            readResourceBytes: () => new Promise<Uint8Array>((resolve) => { finishRead = resolve; }) });
        const isScopeCurrent = () => true;
        const hook = await renderHook(() => {
            const presentation = useComposerScopePluginPresentation({
                composer: { kind: 'discussion', discussionId: 'discussion-1' }, physicalTarget: { kind: 'app' },
                resourceContext: { kind: 'global' }, machineId: 'machine-1', serverId: 'server-1', projectionPhase: 'ready',
                projectionInputs, accountLifetime: null, isScopeCurrent, attachmentsEnabled: false, includeSessionActions: false,
            });
            return { presentation, label: presentation.localizePluginText('acme.compose', { key: 'compose.label', fallback: 'Author label' }) };
        }, { wrapper: ({ children }) => React.createElement(PluginUiTranslationRuntimeProvider, { runtime }, children) });
        const snapshot = hook.getCurrent().presentation.getCurrentActionSnapshot();
        expect(snapshot?.host.isCurrent?.()).toBe(true);
        expect(hook.getCurrent().label).toBe('Author label');
        await act(async () => { finishRead(new TextEncoder().encode(JSON.stringify({ 'compose.label': 'Loaded label' }))); });
        expect(hook.getCurrent().label).toBe('Loaded label');
        expect(hook.getCurrent().presentation.getCurrentActionSnapshot()).toBe(snapshot);
        expect(snapshot?.host.isCurrent?.()).toBe(true);
        await hook.unmount();
        runtime.dispose();
    });

    it('keeps control Actions usable when the optional physical surface catalog is omitted', async () => {
        const projectionInputs = publishDaemonMergedProjectionInputs({ projection: createProjection() });
        const open = vi.fn();
        const isScopeCurrent = () => true;
        const hook = await renderHook(() => useComposerScopePluginPresentation({
            composer: { kind: 'session', sessionId: 'session-1' }, physicalTarget: { kind: 'session', sessionId: 'session-1' },
            resourceContext: { kind: 'session', sessionId: 'session-1' }, machineId: 'machine-1', serverId: 'server-1',
            projectionPhase: 'ready', projectionInputs, accountLifetime: null, isScopeCurrent,
            attachmentsEnabled: true, includeSessionActions: false, onOpenControlAction: open,
        }));
        try {
            const menu = hook.getCurrent().extraActionChips[0]?.collapsedAction?.({
                tint: 'test-tint', dismiss() {}, blurInput() {}, openCollapsedPopover() {},
            });
            if (!menu || !('onPress' in menu)) throw new Error('Expected the current control Action');
            expect(menu.disabled).toBe(false);
            menu.onPress?.();
            expect(open).toHaveBeenCalledWith(expect.objectContaining({ action: control.identity }));
        } finally { await hook.unmount(); }
    });

    it('retains its presentation across a host re-render with unchanged inputs and an omitted catalog', async () => {
        const projectionInputs = publishDaemonMergedProjectionInputs({ projection: createProjection() });
        const open = vi.fn();
        const isScopeCurrent = () => true;
        const composer = { kind: 'session', sessionId: 'session-1' } as const;
        const hook = await renderHook(() => useComposerScopePluginPresentation({
            composer, physicalTarget: composer, resourceContext: composer, machineId: 'machine-1', serverId: 'server-1',
            projectionPhase: 'ready', projectionInputs, accountLifetime: null, isScopeCurrent,
            attachmentsEnabled: true, includeSessionActions: false, onOpenControlAction: open,
        }));
        try {
            const first = hook.getCurrent();
            await hook.rerender();
            // The Session composer re-renders its whole input chrome when these change identity.
            expect(hook.getCurrent().statusRegions).toBe(first.statusRegions);
            expect(hook.getCurrent().renderComposerRegion).toBe(first.renderComposerRegion);
            expect(hook.getCurrent()).toBe(first);
        } finally { await hook.unmount(); }
    });

    it('follows current scope readiness without waiting for a catalog or callback replacement', async () => {
        let current = false;
        const isScopeCurrent = () => current;
        const projectionInputs = publishDaemonMergedProjectionInputs({ projection: createProjection(), composerSurfaceCatalog: [] });
        const hook = await renderHook(() => useComposerScopePluginPresentation({
            composer: { kind: 'discussion', discussionId: 'discussion-1' },
            contributorPluginId: 'acme.compose', physicalTarget: { kind: 'app' }, resourceContext: { kind: 'global' },
            machineId: 'machine-1', serverId: 'server-1', projectionPhase: 'ready', projectionInputs,
            accountLifetime: null, isScopeCurrent, attachmentsEnabled: false, includeSessionActions: false,
        }));
        try {
            expect(hook.getCurrent().composerRegions).toEqual([]);
            current = true;
            await hook.rerender();
            expect(hook.getCurrent().composerRegions.map(entry => entry.id)).toEqual([region.id]);
            const admittedSignal = hook.getCurrent().scopeSignal;
            current = false;
            await hook.rerender();
            expect(hook.getCurrent().composerRegions).toEqual([]);
            expect(hook.getCurrent().getCurrentActionSnapshot()).toBeNull();
            expect(admittedSignal.aborted).toBe(true);
        } finally { await hook.unmount(); }
    });

    it('projects only the selected contributor into an independent Discussion composer', async () => {
        const projection = PluginProjectionV2Schema.parse({
            v: 2, generation: 7,
            familiesById: {
                composerControls: { family: 'composerControls', entriesById: {
                    [control.id]: control,
                    'other.compose/refresh': { ...control, id: 'other.compose/refresh', pluginId: 'other.compose',
                        identity: { pluginId: 'other.compose', localId: 'refresh' } },
                } },
                composerRegions: { family: 'composerRegions', entriesById: {
                    [region.id]: region,
                    'other.compose/summary': { ...region, id: 'other.compose/summary', pluginId: 'other.compose',
                        identity: { pluginId: 'other.compose', localId: 'summary' } },
                } },
            },
        });
        const projectionInputs = publishDaemonMergedProjectionInputs({ projection, composerSurfaceCatalog: [] });
        const hook = await renderHook(() => useComposerScopePluginPresentation({
            composer: { kind: 'discussion', discussionId: 'discussion-1' },
            contributorPluginId: 'acme.compose', physicalTarget: { kind: 'app' }, resourceContext: { kind: 'global' },
            machineId: 'machine-1', serverId: 'server-1', projectionPhase: 'ready',
            projectionInputs,
            accountLifetime: null, isScopeCurrent: () => true, attachmentsEnabled: false, includeSessionActions: false,
        }));
        expect(hook.getCurrent().extraActionChips.map(chip => chip.controlId)).toEqual(['plugin:control:acme.compose/refresh']);
        expect(hook.getCurrent().composerRegions.map(entry => entry.id)).toEqual(['acme.compose/summary']);
        await hook.unmount();
    });

    it('shares normalized UI facts across composers consuming one published projection snapshot', async () => {
        let projectionInputs = publishDaemonMergedProjectionInputs({ projection: createProjection(), composerSurfaceCatalog: [] });
        function usePresentation(instanceId: string) {
            return useComposerScopePluginPresentation({
                composer: { kind: 'newSession', instanceId }, physicalTarget: { kind: 'app' }, resourceContext: { kind: 'global' },
                machineId: 'machine-1', serverId: 'server-1', projectionPhase: 'ready', projectionInputs,
                accountLifetime: null, isScopeCurrent: () => true, attachmentsEnabled: false,
            });
        }
        const hook = await renderHook(() => [usePresentation('first'), usePresentation('second')] as const);
        try {
            const first = hook.getCurrent()[0].getCurrentActionSnapshot()!.pluginUiProjection;
            if (!first) throw new Error('Expected a ready Composer projection');
            expect(first.composerControlsById[control.id]).toBeDefined();
            expect(hook.getCurrent()[1].getCurrentActionSnapshot()!.pluginUiProjection).toBe(first);
            // Same-generation snapshots from another read are still new inputs;
            // neither generation nor a machine id is sufficient as a cache key.
            projectionInputs = publishDaemonMergedProjectionInputs({ projection: createProjection(), composerSurfaceCatalog: [] });
            await hook.rerender();
            const replacement = hook.getCurrent()[0].getCurrentActionSnapshot()!.pluginUiProjection;
            expect(replacement).not.toBe(first);
            expect(hook.getCurrent()[1].getCurrentActionSnapshot()!.pluginUiProjection).toBe(replacement);
        } finally { await hook.unmount(); }
    });

    it('projects admitted Composer controls and regions by declaration order, then qualified id', async () => {
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
        const projection = PluginProjectionV2Schema.parse({
            v: 2,
            generation: 7,
            familiesById: {
                composerControls: {
                    family: 'composerControls',
                    entriesById: Object.fromEntries(controls.map((entry) => [entry.id, entry])),
                },
                composerRegions: {
                    family: 'composerRegions',
                    entriesById: Object.fromEntries(regions.map((entry) => [entry.id, entry])),
                },
            },
        });
        const { pluginUiProjection, composerSurfaceCatalog, composerSurfaceActionInputSelectionFacts } = publishDaemonMergedProjectionInputs({ projection, composerSurfaceCatalog: [] });
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
                    pluginUiProjection,
                    composerSurfaceCatalog,
                    composerSurfaceActionInputSelectionFacts,
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
            'plugin:control:acme.compose/a-tie',
            'plugin:control:acme.compose/z-tie',
            'plugin:control:acme.compose/late',
        ]);
        expect(presentation.composerRegions.map((entry) => entry.id)).toEqual([
            'acme.compose/a-tie-region',
            'acme.compose/z-tie-region',
            'acme.compose/late-region',
        ]);

        act(() => tree.unmount());
    });

    it.each(scopeCases)('mounts a region for $label through the shared host seam', async (scope) => {
        registerMountedComposer(scope.composer);
        pluginSurfaceHostSpy.mockClear();
        const projection = createProjection();
        const { pluginUiProjection, composerSurfaceCatalog, composerSurfaceActionInputSelectionFacts } = publishDaemonMergedProjectionInputs({ projection, composerSurfaceCatalog: [createCatalogEntry()] });
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
                pluginUiProjection,
                composerSurfaceCatalog,
                composerSurfaceActionInputSelectionFacts,
            },
            accountLifetime,
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
        registerMountedComposer({ kind: 'session', sessionId: 'session-1' });
        pluginSurfaceHostSpy.mockClear();
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
        const { pluginUiProjection, composerSurfaceCatalog, composerSurfaceActionInputSelectionFacts } = publishDaemonMergedProjectionInputs({ projection, composerSurfaceCatalog: [createCatalogEntry()] });
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
                pluginUiProjection,
                composerSurfaceCatalog,
                composerSurfaceActionInputSelectionFacts,
            },
            accountLifetime,
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

    it.each(scopeCases.filter((scope) => scope.composer.kind === 'newSession' || scope.composer.kind === 'session'))(
        'dismisses only an opened destination from the $label picker dialog', async (scope) => {
            onTestFinished(() => Modal.hideAll());
            registerMountedComposer(scope.composer);
            pluginSurfaceHostSpy.mockClear();
            const { PluginSurfaceDestinationNavigationBindingProvider } = await import('@/components/plugins/surfaces/pluginSurfaceDestinationNavigation');
            // Incumbent route navigation is the boundary: keep the real Composer
            // owner, mounted surface and custom modal content beneath it.
            let finishOpen!: (outcome: PluginSurfaceOpenOutcome) => void;
            const openSurface = vi.fn<PluginSurfaceOpenHandler>()
                .mockResolvedValueOnce({ ok: false, code: 'unsupported_method', reason: 'destination unavailable' })
                .mockImplementationOnce(() => new Promise((resolve) => { finishOpen = resolve; }));
            const binding = Object.freeze({ targetKind: scope.physicalTarget.kind, openSurface, registerOwner: () => () => {} });
            const projection = createProjection();
            const inputs = publishDaemonMergedProjectionInputs({
                projection,
                composerSurfaceCatalog: [{ ...createCatalogEntry(), role: 'attachmentPicker' }],
            });
            const hook = await renderHook(() => useComposerScopePluginPresentation({
                composer: scope.composer,
                physicalTarget: scope.physicalTarget,
                resourceContext: scope.resourceContext,
                machineId: 'machine-1', serverId: 'server-1', projectionPhase: 'ready',
                projectionInputs: { ...inputs, pluginProjectionById: {}, pluginProjectionV2: projection },
                accountLifetime, isScopeCurrent: () => true, attachmentsEnabled: true, includeSessionActions: false,
            }), { wrapper: ({ children }) => (
                <PluginSurfaceDestinationNavigationBindingProvider binding={binding}>{children}</PluginSurfaceDestinationNavigationBindingProvider>
            ) });
            const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
            const interaction = hook.getCurrent().resolveAttachmentInteraction({
                attachment: {
                    v: 1, instanceId: 'entry-42', attachment: region.identity, key: '42', value: { entryId: '42' },
                    presentation: { typeLabel: 'Entry', label: 'Entry 42' }, availability: { status: 'ready' },
                },
                catalog: { identity: region.identity, occurrenceId: 'generation-1', picker: { renderer: 'summary-renderer' } },
            });
            expect(interaction?.onPress).toBeDefined();
            await act(async () => { interaction?.onPress?.(); });
            expect(screen.findAllByType('PluginSurfaceHost')).toHaveLength(1);
            const hostProps = pluginSurfaceHostSpy.mock.calls.at(-1)?.[0] as Readonly<{
                composerMount: Readonly<{ binding: Readonly<{ openSurface: PluginSurfaceOpenHandler }> }>;
            }>;
            const request = { destination: region.identity, input: { originComposer: scope.composer, entryId: '42' } };
            await act(async () => { expect(await hostProps.composerMount.binding.openSurface(request)).toMatchObject({ ok: false }); });
            expect(screen.findAllByType('PluginSurfaceHost')).toHaveLength(1);
            let opened!: ReturnType<PluginSurfaceOpenHandler>;
            await act(async () => { opened = hostProps.composerMount.binding.openSurface(request); });
            expect(screen.findAllByType('PluginSurfaceHost')).toHaveLength(1);
            await act(async () => { finishOpen({ ok: true }); expect(await opened).toEqual({ ok: true }); });
            expect(openSurface.mock.calls.at(-1)?.[0]).toEqual(request);
            expect(screen.findAllByType('PluginSurfaceHost')).toHaveLength(0);
            await hook.unmount();
        },
    );

    // Factual absence is preserved: a Composer scope with no enclosing
    // destination binding must not advertise a navigation handler the host
    // cannot honour.
    it('installs no openSurface binding when the scope has no enclosing destination owner', async () => {
        registerMountedComposer({ kind: 'session', sessionId: 'session-1' });
        pluginSurfaceHostSpy.mockClear();
        const projection = createProjection();
        const { pluginUiProjection, composerSurfaceCatalog, composerSurfaceActionInputSelectionFacts } = publishDaemonMergedProjectionInputs({ projection, composerSurfaceCatalog: [createCatalogEntry()] });
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
                pluginUiProjection,
                composerSurfaceCatalog,
                composerSurfaceActionInputSelectionFacts,
            },
            accountLifetime,
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
        const projection = createProjection();
        const { pluginUiProjection, composerSurfaceCatalog, composerSurfaceActionInputSelectionFacts } = publishDaemonMergedProjectionInputs({ projection, composerSurfaceCatalog: [createCatalogEntry()] });
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
                    pluginUiProjection,
                    composerSurfaceCatalog,
                    composerSurfaceActionInputSelectionFacts,
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
        const projectionInputs = publishDaemonMergedProjectionInputs({ projection, composerSurfaceCatalog: [createCatalogEntry()] });
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

    it.each(['attachment', 'custody'] as const)('keeps Composer presentation ownership only for an unchanged physical catalog (%s)', async updateKind => {
        const projection = createProjection();
        const initialInputs = publishDaemonMergedProjectionInputs({ projection, composerSurfaceCatalog: [createCatalogEntry()] });
        const updatedProjection = PluginProjectionV2Schema.parse({ ...projection,
            familiesById: { ...projection.familiesById, composerAttachments: { family: 'composerAttachments', entriesById: {
                'acme.compose/issue': { id: 'acme.compose/issue', pluginId: 'acme.compose',
                    identity: { pluginId: 'acme.compose', localId: 'issue' }, occurrenceId: 'generation-1',
                    definition: { id: 'issue', title: 'Issue', icon: 'file', cardinality: 'many', valueSchema: { type: 'object' } } },
            } } },
        });
        const catalogEntry = createCatalogEntry();
        const updatedCatalogEntry = updateKind === 'custody' ? DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.parse({
            ...catalogEntry, contributorTargetedContributions: { ...catalogEntry.contributorTargetedContributions,
                target: { ...catalogEntry.contributorTargetedContributions.target,
                    sourceCustody: { kind: 'development', registeredRootId: 'replacement-compose-root' } },
            },
        }) : catalogEntry;
        const updatedInputs = publishDaemonMergedProjectionInputs({ projection: updatedProjection,
            composerSurfaceCatalog: [updatedCatalogEntry] }, initialInputs);
        let scopeCurrent = true;
        const isScopeCurrent = () => scopeCurrent;
        const hook = await renderHook((projectionInputs: typeof initialInputs) => useComposerScopePluginPresentation({
            composer: { kind: 'session', sessionId: 'session-1' }, physicalTarget: { kind: 'session', sessionId: 'session-1' },
            resourceContext: { kind: 'session', sessionId: 'session-1' }, machineId: 'machine-1', serverId: 'server-1',
            projectionPhase: 'ready', projectionInputs, accountLifetime: null, isScopeCurrent,
            attachmentsEnabled: true, includeSessionActions: true,
        }), { initialProps: initialInputs });
        const readMount = (presentation: ComposerScopePluginPresentation) => {
            const node = presentation.renderComposerRegion(presentation.composerRegions[0]!);
            if (!React.isValidElement<React.ComponentProps<typeof import('./ComposerPluginSurface').ComposerPluginSurface>>(node)) {
                throw new Error('Expected real Composer surface entry');
            }
            return node.props;
        };
        try {
            const initialSignal = asSessionActionAdapterPresentation(hook.getCurrent()).scopeSignal;
            const initialAction = asSessionActionAdapterPresentation(hook.getCurrent()).getCurrentActionSnapshot();
            const before = readMount(hook.getCurrent());
            const current = await hook.rerender(updatedInputs);
            const after = readMount(current);
            expect(asSessionActionAdapterPresentation(current).scopeSignal).toBe(initialSignal);
            expect(initialAction?.host.isCurrent?.()).toBe(false);
            expect(before.parentLifetime.isCurrent()).toBe(updateKind === 'attachment');
            if (updateKind === 'attachment') expect(after.parentLifetime).toBe(before.parentLifetime);
            else expect(after.parentLifetime).not.toBe(before.parentLifetime);
            expect(after.transactionApplier).toBe(before.transactionApplier);
            expect(after.transactionApplier.resolveAttachmentIdentity({ attachmentLocalId: 'issue',
                admittedContributor: { identity: control.identity, occurrenceId: 'generation-1' } })).toEqual({
                pluginId: 'acme.compose', localId: 'issue',
            });
            scopeCurrent = false;
            await hook.rerender(updatedInputs);
            expect(after.parentLifetime.isCurrent()).toBe(false);
        } finally { await hook.unmount(); }
    });

    // A parent that rebuilds an equal Session target object on every render must not retire the
    // Composer scope: a new parent lifetime replaces every physical Composer surface controller, whose
    // committed publication re-renders the parent, and the imported-Session view looped until React
    // stopped it ("Maximum update depth exceeded").
    it('keeps the existing-Session scope current when the parent passes an equal new Session target', async () => {
        const projection = createProjection();
        const projectionInputs = publishDaemonMergedProjectionInputs({ projection, composerSurfaceCatalog: [createCatalogEntry()] });
        const isScopeCurrent = (): boolean => true;
        const readParentLifetime = (node: React.ReactNode): unknown => (
            React.isValidElement<Readonly<{ parentLifetime: unknown }>>(node)
                ? node.props.parentLifetime
                : null
        );
        // The render callback builds fresh, structurally equal objects each time, as the Session view does.
        const hook = await renderHook((_props: Readonly<{ revision: number }>) => (
            useComposerScopePluginPresentation({
                composer: { kind: 'session', sessionId: 'session-1' },
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
        ), { initialProps: { revision: 0 } });

        const active = asSessionActionAdapterPresentation(hook.getCurrent());
        const activeSnapshot = active.getCurrentActionSnapshot();
        const activeLifetime = readParentLifetime(active.renderComposerRegion(active.composerRegions[0]!));
        expect(activeSnapshot).not.toBeNull();
        expect(activeLifetime).not.toBeNull();

        await hook.rerender({ revision: 1 });

        const current = asSessionActionAdapterPresentation(hook.getCurrent());
        expect(current.getCurrentActionSnapshot()).toBe(activeSnapshot);
        expect(readParentLifetime(current.renderComposerRegion(current.composerRegions[0]!))).toBe(activeLifetime);

        await hook.unmount();
    });

    it('keeps the existing-Session action adapter on the shared current scope', async () => {
        const projection = createProjection();
        const pluginProjectionById = createPluginProjectionById();
        const { pluginUiProjection, composerSurfaceCatalog, composerSurfaceActionInputSelectionFacts } = publishDaemonMergedProjectionInputs({ projection, composerSurfaceCatalog: [createCatalogEntry()] });
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
                    pluginUiProjection,
                    composerSurfaceCatalog,
                    composerSurfaceActionInputSelectionFacts,
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
        const projection = createProjection();
        const { pluginUiProjection, composerSurfaceCatalog, composerSurfaceActionInputSelectionFacts } = publishDaemonMergedProjectionInputs({ projection, composerSurfaceCatalog: [createCatalogEntry()] });
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
                pluginUiProjection,
                composerSurfaceCatalog,
                composerSurfaceActionInputSelectionFacts,
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
                occurrenceId: 'occurrence-1',
                display: { kind: 'surface', sizing: 'content', renderer: { renderer: 'issue-display' } },
            },
        });

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
