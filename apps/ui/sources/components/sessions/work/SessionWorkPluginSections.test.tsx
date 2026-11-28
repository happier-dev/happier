import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    normalizePluginUiInlineSurfaceBindingV1,
    PluginUiSurfaceBindingV1Schema,
} from '@happier-dev/protocol/plugins/ui';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { normalizePluginUiProjection, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';

const mountedInlineHosts = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const mockRuntimeListeners = vi.hoisted(() => new Set<() => void>());
const mockRuntime = vi.hoisted(() => ({ current: null as PluginUiProjectionCurrentness | null }));
const mockSessionAddress = vi.hoisted(() => ({ current: { serverId: 'server-1', sessionId: 'session-1' } as { serverId: string; sessionId: string } | null }));

function setMockRuntime(next: PluginUiProjectionCurrentness | null) {
    mockRuntime.current = next;
    for (const listener of mockRuntimeListeners) listener();
}

vi.mock('@/components/plugins/surfaces', () => ({
    PluginInlineSurfaceHost: (props: Record<string, unknown>) => {
        mountedInlineHosts.push(props);
        return React.createElement('PluginInlineSurfaceHostStub', props);
    },
}));

vi.mock('@/components/sessions/plugins/useSessionPluginRuntime', () => ({
    useSessionAddressForSessionId: () => mockSessionAddress.current,
    useSessionPluginRuntime: () => React.useSyncExternalStore(
        (listener) => {
            mockRuntimeListeners.add(listener);
            return () => { mockRuntimeListeners.delete(listener); };
        },
        () => mockRuntime.current,
        () => mockRuntime.current,
    ),
}));

function buildProjection(entries: ReadonlyArray<{
    id: string;
    pluginId: string;
    role: 'sessionWorkSection' | 'scmPullRequest';
    targetKind: 'session' | 'app';
}>): PluginUiProjectionModel {
    const entriesById: Record<string, unknown> = {};
    for (const entry of entries) {
        const inline = normalizePluginUiInlineSurfaceBindingV1({
            pluginId: entry.pluginId,
            surfaceId: entry.id,
            rendererId: `${entry.id}-renderer`,
            role: entry.role,
            target: { kind: entry.targetKind },
        });
        if (!inline) throw new Error(`Expected admitted binding for ${entry.id}`);
        entriesById[entry.id] = {
            id: entry.id,
            pluginId: entry.pluginId,
            occurrenceId: `${entry.pluginId}-occ`,
            contributionKind: 'surfacePlacement',
            descriptorId: entry.id,
            binding: PluginUiSurfaceBindingV1Schema.parse(inline),
            target: inline.target,
            renderer: { kind: 'declarative', contributionId: `${entry.id}-renderer` },
            display: { title: entry.id },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        };
    }
    return normalizePluginUiProjection({
        v: 2,
        generation: 1,
        installedPackagesById: {},
        agentsById: {},
        actionsById: {},
        resourcesById: {},
        settingsById: {},
        diagnostics: [],
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: entriesById as never,
            },
        },
    });
}

function makeRuntime(projection: PluginUiProjectionModel | null): PluginUiProjectionCurrentness {
    return {
        phase: 'current',
        interactionEnabled: true,
        serverId: 'server-1',
        machineId: 'machine-1',
        platform: 'web',
        pluginUiProjection: projection,
    } as unknown as PluginUiProjectionCurrentness;
}

afterEach(() => {
    mountedInlineHosts.length = 0;
    mockRuntime.current = null;
    mockSessionAddress.current = { serverId: 'server-1', sessionId: 'session-1' };
    standardCleanup();
});

describe('SessionWorkPluginSections', () => {
    it('mounts admitted sessionWorkSection placements through PluginInlineSurfaceHost without hardcoding any plugin id', async () => {
        const projection = buildProjection([
            { id: 'work-tasks', pluginId: 'acme.tasks', role: 'sessionWorkSection', targetKind: 'session' },
            { id: 'pr-card', pluginId: 'acme.pr', role: 'scmPullRequest', targetKind: 'session' },
        ]);
        mockRuntime.current = makeRuntime(projection);

        const { SessionWorkPluginSections } = await import('./SessionWorkPluginSections');
        await renderScreen(<SessionWorkPluginSections sessionId="session-1" serverId="server-1" />);

        expect(mountedInlineHosts).toHaveLength(1);
        expect(mountedInlineHosts[0]).toMatchObject({
            sessionId: 'session-1',
            serverId: 'server-1',
            machineId: 'machine-1',
            platform: 'web',
            projectionInteractionEnabled: true,
            inlineMount: { role: 'sessionWorkSection', presentation: 'content' },
        });
        expect((mountedInlineHosts[0]!.placement as { pluginId: string }).pluginId).toBe('acme.tasks');
    });

    it('renders nothing when no sessionWorkSection placements are admitted', async () => {
        mockRuntime.current = makeRuntime(buildProjection([
            { id: 'pr-card', pluginId: 'acme.pr', role: 'scmPullRequest', targetKind: 'session' },
        ]));

        const { SessionWorkPluginSections } = await import('./SessionWorkPluginSections');
        const screen = await renderScreen(<SessionWorkPluginSections sessionId="session-1" serverId="server-1" />);

        expect(mountedInlineHosts).toHaveLength(0);
        expect(screen.tree.toJSON()).toBeNull();
    });

    it('keeps placement selection memoized across unrelated runtime object rebuilds when platform and projection are unchanged', async () => {
        const selectors = await import('@/sync/domains/plugins/ui/surfacePlacementSelectors');
        const selectSpy = vi.spyOn(selectors, 'selectRenderablePluginInlineSurfacePlacementsForRole');
        try {
            const projection = buildProjection([
                { id: 'work-tasks', pluginId: 'acme.tasks', role: 'sessionWorkSection', targetKind: 'session' },
            ]);
            mockRuntime.current = makeRuntime(projection);

            const { SessionWorkPluginSections } = await import('./SessionWorkPluginSections');
            await renderScreen(<SessionWorkPluginSections sessionId="session-1" serverId="server-1" />);
            expect(selectSpy).toHaveBeenCalledTimes(1);

            await React.act(async () => {
                setMockRuntime({
                    ...makeRuntime(projection),
                    interactionEnabled: false,
                } as unknown as PluginUiProjectionCurrentness);
            });
            expect(selectSpy).toHaveBeenCalledTimes(1);
        } finally {
            selectSpy.mockRestore();
        }
    });
});
