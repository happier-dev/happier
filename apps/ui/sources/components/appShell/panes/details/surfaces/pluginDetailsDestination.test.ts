import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import {
    createPluginSurfaceLaunchAuthority,
    resolvePluginSurfaceLaunchAuthority,
    resolveSelectedPluginSurfaceLaunchAuthority,
} from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import type { DetailsSurfaceRenderInputV1 } from '@/components/appShell/panes/details/surfaces';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { renderHook, renderScreen } from '@/dev/testkit';
import type { DetailsTabState } from '../workspace/detailsWorkspaceTypes';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import { createPluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';

import {
    createPluginDetailsDestinationResource,
    createPluginDetailsDestinationSurfaceRenderer,
    createPluginDetailsDestinationTab,
    bindPluginDetailsDestinationOpenSurface,
    PluginDetailsDestinationLaunchScope,
    resolvePluginDetailsDestinationPlacement,
    usePluginDetailsDestinationOpenSurfaceHandler,
    usePluginDetailsDestinationLaunchStaging,
} from './pluginDetailsDestination';

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') {
        return flattenStyle(style({ pressed: false, hovered: false, focused: false }));
    }
    if (!Array.isArray(style)) return (style ?? {}) as Record<string, unknown>;
    return style.reduce<Record<string, unknown>>((result, entry) => ({
        ...result,
        ...(entry ?? {}),
    }), {});
}

function createDetailsTabProjection(): Readonly<{
    placement: PluginUiSurfacePlacementProjection;
    projection: PluginUiProjectionModel;
}> {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: 'com.example.viewer',
        destinationId: 'workspace-file',
        rendererId: 'workspace-file-renderer',
        container: 'detailsTab',
        target: { kind: 'session', sessionIdPath: '/session/id' },
        instancePolicy: 'multiple',
    });
    if (!binding) throw new Error('details-tab binding fixture must be admitted');
    const placement = {
        id: 'surfacePlacement:com.example.viewer:workspace-file',
        pluginId: 'com.example.viewer',
        contributionKind: 'surfacePlacement' as const,
        descriptorId: 'workspace-file',
        binding,
        target: binding.target,
        renderer: { kind: 'reactNative', contributionId: 'workspace-file-renderer' },
        display: { developerFallback: 'Workspace file viewer' },
        availability: { state: 'available' as const, reason: 'available', diagnostics: [] },
        // `normalizePluginUiProjection` materializes this required field as an
        // empty readonly list when the daemon placement declares no actions.
        headerActions: [],
        hostOrigin: {
            machineId: 'machine-1',
            serverId: 'server-1',
            generation: 4,
            phase: 'current',
            interactionEnabled: true,
            executionOrigin: {
                serverIdentityId: 'srv_account_one',
                materializationRef: {
                    pluginId: 'com.example.viewer',
                    machineId: 'machine-1',
                    materializationId: 'viewer-install-1',
                },
            },
        },
    } satisfies PluginUiSurfacePlacementProjection;
    return {
        placement,
        projection: {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation: 4,
            surfacePlacementsById: { [placement.id]: placement },
        },
    };
}

function createDetailsPaneProjection(): Readonly<{
    tabPlacement: PluginUiSurfacePlacementProjection;
    panePlacement: PluginUiSurfacePlacementProjection;
    projection: PluginUiProjectionModel;
}> {
    const { placement: tabPlacement, projection } = createDetailsTabProjection();
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: 'com.example.viewer',
        destinationId: 'activity-log',
        rendererId: 'activity-log-renderer',
        container: 'detailsPane',
        target: { kind: 'session', sessionIdPath: '/session/id' },
        instancePolicy: 'multiple',
    });
    if (!binding) throw new Error('details-pane binding fixture must be admitted');
    const panePlacement = {
        ...tabPlacement,
        id: 'surfacePlacement:com.example.viewer:activity-log',
        descriptorId: 'activity-log',
        binding,
        target: binding.target,
        renderer: { kind: 'hostedWeb' as const, contributionId: 'activity-log-renderer' },
        display: { developerFallback: 'Activity log' },
    } satisfies PluginUiSurfacePlacementProjection;
    return {
        tabPlacement,
        panePlacement,
        projection: {
            ...projection,
            surfacePlacementsById: {
                [tabPlacement.id]: tabPlacement,
                [panePlacement.id]: panePlacement,
            },
        },
    };
}

function createPrivateBinding(): BoundPluginSurfaceBinding {
    return Object.freeze({
        openableContent: Object.freeze({
            ref: Object.freeze({ kind: 'workspaceFile' as const, handle: 'viewer-ref-1' }),
            stat: async () => ({
                status: 'ready' as const,
                mimeType: 'text/plain',
                contentClass: 'text' as const,
                extension: '.txt',
                sizeBytes: 22,
                revision: 'revision-1',
            }),
            read: async () => ({
                status: 'ready' as const,
                content: { kind: 'utf8' as const, text: 'private file data' },
                revision: 'revision-1',
            }),
        }),
    });
}

function createDetailsRenderInput(): DetailsSurfaceRenderInputV1 {
    const tab: DetailsTabState = {
        ...createPluginDetailsDestinationTab({
            destination: { pluginId: 'com.example.viewer', localId: 'workspace-file' },
            instanceKey: 'file-instance-1',
            title: 'Workspace file viewer',
        }),
        isPinned: true,
        isPreview: false,
    };
    return {
        tab,
        descriptor: {
            surfaceId: 'session:session-1:details:plugin-file',
            resourceKey: 'pluginDetailsDestination:plugin-file',
            scope: { kind: 'session', sessionId: 'session-1', serverId: 'server-1', machineId: 'machine-1' },
            region: 'details',
            status: 'available',
        },
        scope: { kind: 'session', sessionId: 'session-1', serverId: 'server-1', machineId: 'machine-1' },
        region: 'details',
        active: true,
        callbacks: {},
    };
}

describe('pluginDetailsDestination', () => {
    it('creates one durable tab resource from a qualified destination and optional instance identity', async () => {
        const module = await import('./pluginDetailsDestination');
        const createTab = Reflect.get(module, 'createPluginDetailsDestinationTab');

        expect(typeof createTab).toBe('function');
        if (typeof createTab !== 'function') return;

        const tab = Reflect.apply(createTab, undefined, [Object.freeze({
            destination: {
                pluginId: 'com.example.viewer',
                localId: 'workspace-file',
            },
            instanceKey: 'file-instance-1',
            title: 'Workspace file viewer',
            subtitle: 'Plugin viewer',
            // Deliberately hostile extra fields: the factory is the owner of
            // durable tab identity, not a transport for current mount facts.
            launchInput: { opaqueFileRef: 'viewer-ref-1' },
            executionOrigin: { materializationId: 'materialization-1' },
        })]);

        expect(tab).toEqual({
            key: 'plugin-details:com.example.viewer:workspace-file:instance-file-instance-1',
            kind: 'pluginDetailsDestination',
            title: 'Workspace file viewer',
            subtitle: 'Plugin viewer',
            resource: {
                kind: 'pluginDetailsDestination',
                destination: {
                    pluginId: 'com.example.viewer',
                    localId: 'workspace-file',
                },
                instanceKey: 'file-instance-1',
            },
        });
    });

    it('adapts an exact current details-tab placement through the canonical details mount', async () => {
        const module = await import('./pluginDetailsDestination');
        const createRenderer = Reflect.get(module, 'createPluginDetailsDestinationSurfaceRenderer');

        expect(typeof createRenderer).toBe('function');
        if (typeof createRenderer !== 'function') return;

        const { placement, projection } = createDetailsTabProjection();
        const renderInput = createDetailsRenderInput();
        const renderer = createRenderer({
            targetKind: 'session',
            projection,
            mount: {
                machineId: 'machine-1',
                serverId: 'server-1',
                sessionId: 'session-1',
                platform: 'web',
                projectionPhase: 'current',
                projectionInteractionEnabled: true,
            },
        });

        expect(renderer.canRender(renderInput)).toBe(true);
        const rendered = renderer.render(renderInput);
        expect(React.isValidElement(rendered)).toBe(true);
        if (!React.isValidElement(rendered)) return;
        // The renderer returns the host-owned Details mount, which resolves a
        // private handoff from the AppPane-scope store only after it is mounted.
        // It must not smuggle launch input through this durable render adapter.
        expect(rendered.props).not.toHaveProperty('launchInput');
        expect(rendered.props).not.toHaveProperty('binding');
        expect(placement.binding.container).toBe('detailsTab');
    });

    it('routes a Project Details mount through its target binding to the existing right-pane owner', async () => {
        const binding = normalizePluginUiDestinationBindingV1({
            pluginId: 'com.example.viewer',
            destinationId: 'project-companion',
            rendererId: 'project-companion-renderer',
            container: 'rightPane',
            target: { kind: 'project' },
        });
        if (!binding) throw new Error('project right-pane binding fixture must be admitted');
        const rightPlacement = {
            id: 'surfacePlacement:com.example.viewer:project-companion',
            pluginId: 'com.example.viewer',
            contributionKind: 'surfacePlacement' as const,
            descriptorId: 'project-companion',
            binding,
            target: binding.target,
            renderer: { kind: 'hostedWeb' as const, contributionId: 'project-companion-renderer' },
            display: { developerFallback: 'Project companion' },
            availability: { state: 'available' as const, reason: 'available', diagnostics: [] },
            headerActions: [],
            hostOrigin: {
                machineId: 'machine-1',
                serverId: 'server-1',
                generation: 4,
                phase: 'current',
                interactionEnabled: true,
                executionOrigin: {
                    serverIdentityId: 'srv_account_one',
                    materializationRef: {
                        pluginId: 'com.example.viewer',
                        machineId: 'machine-1',
                        materializationId: 'viewer-install-1',
                    },
                },
            },
        } satisfies PluginUiSurfacePlacementProjection;
        const openRight = vi.fn(async () => ({ ok: true as const }));
        const targetBinding = createPluginSurfaceDestinationNavigationBinding({
            placements: [rightPlacement],
            targetKind: 'project',
            runtimeAdmission: { platform: 'web', formFactor: 'tablet' },
        });
        targetBinding.registerOwner({ container: 'rightPane', handler: openRight });

        const detailsBinding = bindPluginDetailsDestinationOpenSurface({
            openSurface: targetBinding.openSurface,
        });
        expect(detailsBinding?.openSurface).toBeTypeOf('function');
        await expect(detailsBinding?.openSurface?.({
            destination: binding.destination,
            input: { source: 'project-details' },
        })).resolves.toEqual({ ok: true });
        expect(openRight).toHaveBeenCalledTimes(1);
    });

    it('keeps a desktop/tablet details tab as a phone tombstone while admitting it on tablet', () => {
        const { placement, projection } = createDetailsTabProjection();
        const resource = createPluginDetailsDestinationResource({
            destination: placement.binding.destination,
            instanceKey: 'file-instance-1',
        });

        expect(resolvePluginDetailsDestinationPlacement({
            resource,
            targetKind: 'session',
            projection,
            projectionPhase: 'current',
            runtimeAdmission: { platform: 'ios', formFactor: 'phone' },
        })).toEqual({
            kind: 'unavailable',
            resource,
            reason: 'details_destination_platform_unavailable',
        });

        expect(resolvePluginDetailsDestinationPlacement({
            resource,
            targetKind: 'session',
            projection,
            projectionPhase: 'current',
            runtimeAdmission: { platform: 'ios', formFactor: 'tablet' },
        })).toMatchObject({
            kind: 'available',
            resource,
            placement,
        });
    });

    it('refreshes direct Details openSurface admission when the mounted form factor changes', async () => {
        const { placement, projection } = createDetailsTabProjection();
        const openTab = vi.fn();
        const hook = await renderHook(
            ({ formFactor }: Readonly<{ formFactor: 'phone' | 'tablet' }>) => (
                usePluginDetailsDestinationOpenSurfaceHandler({
                    targetKind: 'session',
                    projection,
                    mount: {
                        sessionId: 'session-1',
                        machineId: 'machine-1',
                        serverId: 'server-1',
                        platform: 'ios',
                        formFactor,
                        projectionPhase: 'current',
                        projectionInteractionEnabled: true,
                    },
                    openTab,
                })
            ),
            {
                initialProps: { formFactor: 'tablet' },
                wrapper: ({ children }) => React.createElement(
                    PluginDetailsDestinationLaunchScope,
                    null,
                    children ?? null,
                ),
            },
        );

        const tabletHandler = hook.getCurrent();
        if (!tabletHandler) throw new Error('expected mounted Details openSurface handler');
        await expect(tabletHandler({
            destination: placement.binding.destination,
            instanceKey: 'file-instance-1',
        })).resolves.toEqual({ ok: true });
        expect(openTab).toHaveBeenCalledTimes(1);

        await hook.rerender({ formFactor: 'phone' });
        const phoneHandler = hook.getCurrent();
        if (!phoneHandler) throw new Error('expected updated Details openSurface handler');
        await expect(phoneHandler({
            destination: placement.binding.destination,
            instanceKey: 'file-instance-2',
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_surface_open_destination_platform_unavailable',
        });
        expect(openTab).toHaveBeenCalledTimes(1);

        await hook.unmount();
    });

    it('keeps a restored Details destination pending until first describe and unavailable after a current miss', () => {
        const { placement, projection } = createDetailsTabProjection();
        const resource = createPluginDetailsDestinationResource({
            destination: placement.binding.destination,
        });

        expect(resolvePluginDetailsDestinationPlacement({
            resource,
            targetKind: 'session',
            projection,
            projectionPhase: 'establishing',
        })).toEqual({ kind: 'unresolved', resource });
        expect(resolvePluginDetailsDestinationPlacement({
            resource,
            targetKind: 'session',
            projection,
            projectionPhase: 'unavailable',
        })).toEqual({
            kind: 'unavailable',
            resource,
            reason: 'details_destination_projection_unavailable',
        });
    });

    it('offers the current details owner a typed fallback without selecting a different plugin', async () => {
        const module = await import('./pluginDetailsDestination');
        const createRenderer = Reflect.get(module, 'createPluginDetailsDestinationSurfaceRenderer');
        const LaunchScope = Reflect.get(module, 'PluginDetailsDestinationLaunchScope');

        expect(typeof createRenderer).toBe('function');
        expect(typeof LaunchScope).toBe('function');
        if (typeof createRenderer !== 'function' || typeof LaunchScope !== 'function') return;

        const fallbacks: unknown[] = [];
        const renderer = createRenderer({
            targetKind: 'session',
            projection: null,
            mount: { projectionPhase: 'establishing' },
            renderFallback: (fallback: unknown) => {
                fallbacks.push(fallback);
                return 'builtin-file-details-fallback';
            },
        });

        await renderScreen(React.createElement(
            LaunchScope,
            null,
            renderer.render(createDetailsRenderInput()),
        ));
        expect(fallbacks).toEqual([
            expect.objectContaining({
                kind: 'unresolved',
                resource: {
                    kind: 'pluginDetailsDestination',
                    destination: { pluginId: 'com.example.viewer', localId: 'workspace-file' },
                    instanceKey: 'file-instance-1',
                },
            }),
        ]);
    });

    it('rejects a same-destination placement outside the canonical details-tab slot', async () => {
        const module = await import('./pluginDetailsDestination');
        const createRenderer = Reflect.get(module, 'createPluginDetailsDestinationSurfaceRenderer');
        const LaunchScope = Reflect.get(module, 'PluginDetailsDestinationLaunchScope');

        expect(typeof createRenderer).toBe('function');
        expect(typeof LaunchScope).toBe('function');
        if (typeof createRenderer !== 'function' || typeof LaunchScope !== 'function') return;

        const { placement } = createDetailsTabProjection();
        const wrongBinding = normalizePluginUiDestinationBindingV1({
            pluginId: 'com.example.viewer',
            destinationId: 'workspace-file',
            rendererId: 'workspace-file-renderer',
            container: 'rightPane',
            target: { kind: 'session', sessionIdPath: '/session/id' },
        });
        if (!wrongBinding) throw new Error('wrong-slot fixture must still be an admitted binding');
        const wrongPlacement = {
            ...placement,
            id: 'surfacePlacement:com.example.viewer:workspace-file:right-pane',
            binding: wrongBinding,
            target: wrongBinding.target,
        } satisfies PluginUiSurfacePlacementProjection;
        const fallbacks: unknown[] = [];
        const renderer = createRenderer({
            targetKind: 'session',
            projection: {
                ...EMPTY_PLUGIN_UI_PROJECTION,
                generation: 4,
                surfacePlacementsById: { [wrongPlacement.id]: wrongPlacement },
            },
            mount: { projectionPhase: 'current' },
            renderFallback: (fallback: unknown) => {
                fallbacks.push(fallback);
                return 'wrong-slot-fallback';
            },
        });

        await renderScreen(React.createElement(
            LaunchScope,
            null,
            renderer.render(createDetailsRenderInput()),
        ));
        expect(fallbacks).toEqual([
            expect.objectContaining({ kind: 'unavailable' }),
        ]);
    });

    it('does not expose a legacy callback launch path outside the AppPane handoff owner', async () => {
        const module = await import('./pluginDetailsDestination');
        const createRenderer = Reflect.get(module, 'createPluginDetailsDestinationSurfaceRenderer');

        expect(typeof createRenderer).toBe('function');
        if (typeof createRenderer !== 'function') return;

        const { projection } = createDetailsTabProjection();
        const renderInput = createDetailsRenderInput();
        const renderer = createRenderer({
            targetKind: 'session',
            projection,
            mount: { projectionPhase: 'current' },
        });

        const rendered = renderer.render(renderInput);
        expect(React.isValidElement(rendered)).toBe(true);
        if (!React.isValidElement(rendered)) return;
        expect(rendered.props).not.toHaveProperty('resolveLaunch');
    });

    it('stages a private details binding only for its exact current destination, target, and instance, then releases it on retirement', async () => {
        const module = await import('./pluginDetailsDestination');
        const createStore = Reflect.get(module, 'createPluginDetailsDestinationLaunchStore');
        const stage = Reflect.get(module, 'stagePluginDetailsDestinationLaunch');
        const resolve = Reflect.get(module, 'resolvePluginDetailsDestinationLaunch');

        expect(typeof createStore).toBe('function');
        expect(typeof stage).toBe('function');
        expect(typeof resolve).toBe('function');
        if (typeof createStore !== 'function' || typeof stage !== 'function' || typeof resolve !== 'function') return;

        const { placement } = createDetailsTabProjection();
        const authority = resolveSelectedPluginSurfaceLaunchAuthority({
            placement,
            accountLifetime: null,
        });
        expect(authority).not.toBeNull();
        if (!authority) return;

        const store = createStore();
        const privateBinding = createPrivateBinding();
        const viewerChoice = vi.fn(() => ({
            candidates: [{ id: 'builtin', label: 'Built-in', selected: true }],
            selectCandidate: async () => {},
        }));
        const receipt = stage({
            store,
            accountLifetime: null,
            placement,
            targetKind: 'session',
            instanceKey: 'file-instance-1',
            input: { opaqueFileRef: 'viewer-ref-1' },
            binding: privateBinding,
            viewerChoice,
        });

        expect(receipt).toEqual({
            resource: {
                kind: 'pluginDetailsDestination',
                destination: { pluginId: 'com.example.viewer', localId: 'workspace-file' },
                instanceKey: 'file-instance-1',
            },
            tabKey: 'plugin-details:com.example.viewer:workspace-file:instance-file-instance-1',
        });
        if (!receipt) throw new Error('current details launch must stage');

        const launch = resolve({
            store,
            authority,
            targetKind: 'session',
            resource: receipt.resource,
            tabKey: receipt.tabKey,
        });
        expect(launch?.input).toEqual({ opaqueFileRef: 'viewer-ref-1' });
        expect(launch?.binding).toBe(privateBinding);
        expect(launch?.viewerChoice).toBe(viewerChoice);

        expect(resolve({
            store,
            authority,
            targetKind: 'session',
            resource: { ...receipt.resource, instanceKey: 'other-file' },
            tabKey: receipt.tabKey,
        })).toBeNull();
        expect(resolve({
            store,
            authority: createPluginSurfaceLaunchAuthority({
                serverId: 'server-1',
                machineId: 'machine-1',
                generation: 5,
            }),
            targetKind: 'session',
            resource: receipt.resource,
            tabKey: receipt.tabKey,
        })).toBeNull();

        store.retire();
        expect(resolve({
            store,
            authority,
            targetKind: 'session',
            resource: receipt.resource,
            tabKey: receipt.tabKey,
        })).toBeNull();
    });

    it('accepts a direct Session/Project scope only when its current scoped facts and producer materialization agree', async () => {
        const module = await import('./pluginDetailsDestination');
        const createStore = Reflect.get(module, 'createPluginDetailsDestinationLaunchStore');
        const stage = Reflect.get(module, 'stagePluginDetailsDestinationLaunch');

        expect(typeof createStore).toBe('function');
        expect(typeof stage).toBe('function');
        if (typeof createStore !== 'function' || typeof stage !== 'function') return;

        const { placement } = createDetailsTabProjection();
        const { hostOrigin: _hostOrigin, ...directPlacement } = placement;
        const direct = {
            ...directPlacement,
            serverIdentityId: 'srv_account_one',
            materializationRef: {
                pluginId: 'com.example.viewer',
                machineId: 'machine-1',
                materializationId: 'viewer-install-1',
            },
        } satisfies PluginUiSurfacePlacementProjection;
        const scopedLaunchFacts = {
            serverId: 'server-1',
            machineId: 'machine-1',
            generation: 4,
            interactionEnabled: true,
        } as const;
        const authority = resolvePluginSurfaceLaunchAuthority({
            placement: direct,
            accountLifetime: null,
            scoped: scopedLaunchFacts,
        });
        expect(authority).toMatchObject({
            serverId: 'server-1',
            machineId: 'machine-1',
            generation: 4,
            executionOrigin: {
                materializationRef: {
                    pluginId: 'com.example.viewer',
                    machineId: 'machine-1',
                    materializationId: 'viewer-install-1',
                },
            },
        });

        expect(stage({
            store: createStore(),
            accountLifetime: null,
            placement: direct,
            targetKind: 'session',
            scopedLaunchFacts: { ...scopedLaunchFacts, machineId: 'machine-2' },
            instanceKey: 'file-instance-1',
            input: { opaqueFileRef: 'must-not-stage' },
        })).toBeNull();
    });

    it('opens an exact qualified details destination through the canonical tab or overlay owner without leaking input into selection', async () => {
        const module = await import('./pluginDetailsDestination');
        const createStore = Reflect.get(module, 'createPluginDetailsDestinationLaunchStore');
        const createHandler = Reflect.get(module, 'createPluginDetailsDestinationOpenSurfaceHandler');
        const resolveTabLaunch = Reflect.get(module, 'resolvePluginDetailsDestinationLaunch');
        const resolvePaneLaunch = Reflect.get(module, 'resolvePluginDetailsPaneLaunch');

        expect(typeof createStore).toBe('function');
        expect(typeof createHandler).toBe('function');
        expect(typeof resolveTabLaunch).toBe('function');
        expect(typeof resolvePaneLaunch).toBe('function');
        if (
            typeof createStore !== 'function'
            || typeof createHandler !== 'function'
            || typeof resolveTabLaunch !== 'function'
            || typeof resolvePaneLaunch !== 'function'
        ) return;

        const { tabPlacement, panePlacement, projection } = createDetailsPaneProjection();
        const openTab = vi.fn();
        const openOverlay = vi.fn();
        const store = createStore();
        const handler = createHandler({
            store,
            accountLifetime: null,
            targetKind: 'session',
            projection,
            mount: {
                sessionId: 'session-1',
                machineId: 'machine-1',
                serverId: 'server-1',
                platform: 'web',
                projectionPhase: 'current',
                projectionInteractionEnabled: true,
            },
            openTab,
            openOverlay,
        }) as (request: Readonly<{
            destination: { pluginId: string; localId: string };
            input?: unknown;
            instanceKey?: string;
            subPath?: string;
        }>) => Promise<unknown> | unknown;

        await expect(Promise.resolve(handler({
            destination: panePlacement.binding.destination,
            instanceKey: 'activity:run-1',
            input: { opaqueActivityRef: 'activity-ref-1' },
        }))).resolves.toEqual({ ok: true });
        expect(openTab).not.toHaveBeenCalled();
        expect(openOverlay).toHaveBeenCalledWith({
            destination: panePlacement.binding.destination,
            instanceKey: 'activity:run-1',
        });

        const paneAuthority = resolveSelectedPluginSurfaceLaunchAuthority({
            placement: panePlacement,
            accountLifetime: null,
        });
        expect(resolvePaneLaunch({
            store,
            authority: paneAuthority,
            targetKind: 'session',
            destination: panePlacement.binding.destination,
            instanceKey: 'activity:run-1',
        })).toMatchObject({
            input: { opaqueActivityRef: 'activity-ref-1' },
            destination: panePlacement.binding.destination,
            instanceKey: 'activity:run-1',
        });

        await expect(Promise.resolve(handler({
            destination: tabPlacement.binding.destination,
            instanceKey: 'file-instance-1',
            input: { opaqueFileRef: 'viewer-ref-1' },
        }))).resolves.toEqual({ ok: true });
        expect(openTab).toHaveBeenCalledWith(expect.objectContaining({
            resource: {
                kind: 'pluginDetailsDestination',
                destination: tabPlacement.binding.destination,
                instanceKey: 'file-instance-1',
            },
        }));
        expect(openOverlay).toHaveBeenCalledTimes(1);

        const tabAuthority = resolveSelectedPluginSurfaceLaunchAuthority({
            placement: tabPlacement,
            accountLifetime: null,
        });
        const tab = openTab.mock.calls[0]?.[0];
        expect(resolveTabLaunch({
            store,
            authority: tabAuthority,
            targetKind: 'session',
            resource: tab.resource,
            tabKey: tab.key,
        })).toMatchObject({ input: { opaqueFileRef: 'viewer-ref-1' } });

        await expect(Promise.resolve(handler({
            destination: panePlacement.binding.destination,
            instanceKey: 'activity:run-2',
            subPath: 'must-not-become-a-details-route',
        }))).resolves.toEqual({
            ok: false,
            code: 'invalid_payload',
            reason: 'plugin_surface_open_sub_path_unsupported',
        });
        expect(openOverlay).toHaveBeenCalledTimes(1);
    });

    it('returns a delivered opaque launch to its original host fallback when its placement disappears', async () => {
        const { placement, projection } = createDetailsTabProjection();
        const originalFallback = vi.fn();
        const genericFallback = vi.fn(() => null);
        const privateBinding = createPrivateBinding();
        let removePlacement: (() => void) | null = null;

        function Harness(): React.ReactElement | null {
            const stageLaunch = usePluginDetailsDestinationLaunchStaging();
            const [showDetails, setShowDetails] = React.useState(false);
            const [placementAvailable, setPlacementAvailable] = React.useState(true);
            removePlacement = () => { setPlacementAvailable(false); };

            React.useEffect(() => {
                const receipt = stageLaunch({
                    placement,
                    targetKind: 'session',
                    instanceKey: 'file-instance-1',
                    input: { opaqueFileRef: 'viewer-ref-1' },
                    binding: privateBinding,
                    unavailableFallback: originalFallback,
                });
                setShowDetails(receipt !== null);
            }, [stageLaunch]);

            if (!showDetails) return null;
            const renderer = createPluginDetailsDestinationSurfaceRenderer({
                targetKind: 'session',
                projection: placementAvailable ? projection : null,
                mount: {
                    machineId: 'machine-1',
                    serverId: 'server-1',
                    sessionId: 'session-1',
                    platform: 'web',
                    projectionPhase: 'current',
                    projectionInteractionEnabled: true,
                },
                renderFallback: genericFallback,
            });
            return renderer.render(createDetailsRenderInput()) as React.ReactElement | null;
        }

        await renderScreen(React.createElement(
            PluginDetailsDestinationLaunchScope,
            null,
            React.createElement(Harness),
        ));
        await act(async () => {});

        expect(originalFallback).not.toHaveBeenCalled();
        expect(removePlacement).not.toBeNull();
        await act(async () => { removePlacement?.(); });

        expect(originalFallback).toHaveBeenCalledTimes(1);
        expect(originalFallback).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'unavailable',
            reason: 'details_destination_projection_unavailable',
            resource: {
                kind: 'pluginDetailsDestination',
                destination: { pluginId: 'com.example.viewer', localId: 'workspace-file' },
                instanceKey: 'file-instance-1',
            },
        }));
        expect(genericFallback).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'unavailable',
            reason: 'details_destination_projection_unavailable',
        }));
    });

    it('keeps the host-owned viewer selector reachable and serializes an async viewer change', async () => {
        const module = await import('./pluginDetailsDestination');
        const ViewerChoiceChrome = Reflect.get(module, 'PluginDetailsViewerChoiceChrome');

        expect(typeof ViewerChoiceChrome).toBe('function');
        if (typeof ViewerChoiceChrome !== 'function') return;

        let settleSelection: (() => void) | undefined;
        const selection = new Promise<void>((resolve) => {
            settleSelection = resolve;
        });
        const selectCandidate = vi.fn(() => selection);
        const screen = await renderScreen(React.createElement(ViewerChoiceChrome, {
            model: {
                candidates: [
                    { id: 'builtin', label: 'Built-in', selected: true },
                    {
                        id: 'openableContentViewer:com.example.viewer:markdown',
                        label: 'Markdown viewer',
                        selected: false,
                    },
                    {
                        id: 'openableContentViewer:com.example.viewer:unavailable',
                        label: 'Unavailable viewer',
                        selected: false,
                        disabled: true,
                    },
                ],
                selectCandidate,
            },
        }));

        const builtin = screen.findByTestId('plugin-details-viewer-choice:builtin');
        const markdown = screen.findByTestId('plugin-details-viewer-choice:openableContentViewer:com.example.viewer:markdown');
        const unavailable = screen.findByTestId('plugin-details-viewer-choice:openableContentViewer:com.example.viewer:unavailable');
        expect(builtin?.props.accessibilityState).toEqual({ selected: true, disabled: false });
        expect(markdown?.props.accessibilityState).toEqual({ selected: false, disabled: false });
        expect(unavailable?.props.accessibilityState).toEqual({ selected: false, disabled: true });
        expect(markdown?.props.style({ pressed: false, focused: false })).toEqual(expect.arrayContaining([
            expect.objectContaining({ minHeight: 44 }),
        ]));

        await act(async () => {
            markdown?.props.onPress();
        });

        expect(selectCandidate).toHaveBeenCalledTimes(1);
        expect(selectCandidate).toHaveBeenCalledWith('openableContentViewer:com.example.viewer:markdown');
        expect(builtin?.props.accessibilityState).toEqual({ selected: true, disabled: true });
        expect(markdown?.props.accessibilityState).toEqual({ selected: false, disabled: true });

        await act(async () => {
            settleSelection?.();
            await selection;
        });

        expect(builtin?.props.accessibilityState).toEqual({ selected: true, disabled: false });
        expect(markdown?.props.accessibilityState).toEqual({ selected: false, disabled: false });
    });

    it('uses the canonical interactive target for every chooser choice platform', async () => {
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        try {
            const module = await import('./pluginDetailsDestination');
            const ViewerChoiceChrome = Reflect.get(module, 'PluginDetailsViewerChoiceChrome');

            expect(typeof ViewerChoiceChrome).toBe('function');
            if (typeof ViewerChoiceChrome !== 'function') return;
            expect(resolveMinimumInteractiveTargetSize('android')).toBe(48);
            expect(resolveMinimumInteractiveTargetSize('ios')).toBe(44);
            expect(resolveMinimumInteractiveTargetSize('web')).toBe(44);

            for (const platform of ['android', 'ios', 'web'] as const) {
                (Platform as { OS: string }).OS = platform;
                const screen = await renderScreen(React.createElement(ViewerChoiceChrome, {
                    model: {
                        candidates: [{ id: 'builtin', label: 'Built-in', selected: true }],
                        selectCandidate: async () => undefined,
                    },
                }));
                try {
                    const choice = screen.findByTestId('plugin-details-viewer-choice:builtin');
                    const targetSize = resolveMinimumInteractiveTargetSize(platform);
                    const style = flattenStyle(choice?.props.style);
                    expect(style.minHeight).toBe(targetSize);
                    expect(style.minWidth).toBe(targetSize);
                } finally {
                    await screen.unmount();
                }
            }
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });

    it('keeps plugin attribution and unavailable state legible while supporting tab keyboard selection', async () => {
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        (Platform as { OS: string }).OS = 'web';
        try {
            const module = await import('./pluginDetailsDestination');
            const ViewerChoiceChrome = Reflect.get(module, 'PluginDetailsViewerChoiceChrome');

            expect(typeof ViewerChoiceChrome).toBe('function');
            if (typeof ViewerChoiceChrome !== 'function') return;

            const selectCandidate = vi.fn(async () => undefined);
            const screen = await renderScreen(React.createElement(ViewerChoiceChrome, {
                model: {
                    candidates: [
                        { id: 'builtin', label: 'Built-in', selected: true },
                        {
                            id: 'openableContentViewer:com.example.viewer:markdown',
                            label: 'Markdown viewer',
                            detail: 'com.example.viewer',
                            selected: false,
                        },
                        {
                            id: 'openableContentViewer:com.example.viewer:unavailable',
                            label: 'Retired viewer',
                            detail: 'Unavailable',
                            selected: false,
                            disabled: true,
                        },
                    ],
                    selectCandidate,
                },
            }));

            const builtin = screen.findByTestId('plugin-details-viewer-choice:builtin');
            const markdown = screen.findByTestId('plugin-details-viewer-choice:openableContentViewer:com.example.viewer:markdown');
            const unavailable = screen.findByTestId('plugin-details-viewer-choice:openableContentViewer:com.example.viewer:unavailable');
            expect(builtin?.props.tabIndex).toBe(0);
            expect(markdown?.props.tabIndex).toBe(-1);
            expect(markdown?.props.accessibilityLabel).toBe('Markdown viewer · com.example.viewer');
            expect(unavailable?.props.accessibilityLabel).toBe('Retired viewer · Unavailable');
            expect(screen.findByTestId('plugin-details-viewer-choice-detail:openableContentViewer:com.example.viewer:markdown')?.props.children)
                .toBe('com.example.viewer');
            expect(screen.findByTestId('plugin-details-viewer-choice-detail:openableContentViewer:com.example.viewer:unavailable')?.props.children)
                .toBe('Unavailable');

            const preventDefault = vi.fn();
            await act(async () => {
                builtin?.props.onKeyDown({ nativeEvent: { key: 'ArrowRight' }, preventDefault });
            });

            expect(preventDefault).toHaveBeenCalledTimes(1);
            expect(selectCandidate).toHaveBeenCalledWith('openableContentViewer:com.example.viewer:markdown');
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });
});
