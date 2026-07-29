import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routeParamsState = vi.hoisted(() => ({
    value: {
        machineId: 'machine-1',
        serverId: 'server-1',
        agentId: 'acme-agent',
        agentPluginId: 'acme.external',
        agentLocalId: 'reviewer',
    } as Record<string, string>,
}));
const daemonProjectionState = vi.hoisted(() => ({
    phase: 'ready' as 'loading' | 'ready' | 'error',
}));
const routerBackSpy = vi.hoisted(() => vi.fn());

const browseScreenPropsRef = {
    current: null as Readonly<Record<string, unknown>> | null,
};

const projection = {
    v: 2,
    generation: 9,
    installedPackagesById: {
        'acme.external': {
            id: 'acme.external',
            displayName: 'Acme External',
            enabled: true,
            source: { kind: 'path', locator: '/plugins/acme-external' },
        },
    },
    agentsById: {
        'acme-agent': {
            id: 'acme-agent',
            title: 'Acme Reviewer',
            externalSessions: {
                agent: { pluginId: 'acme.external', localId: 'reviewer' },
                generation: 9,
                operations: {
                    listCandidates: true,
                    resolveLinkIdentity: true,
                    pageTranscript: true,
                    readAfterTranscript: true,
                },
                sources: [{
                    sourceKind: 'acmeHistory',
                    schema: {
                        passthrough: true,
                        fields: [
                            { name: 'kind', kind: 'literal', value: 'acmeHistory' },
                            { name: 'scope', kind: 'literal', value: 'default' },
                        ],
                    },
                    key: {
                        segments: [
                            { kind: 'literal', value: 'acmeHistory' },
                            { kind: 'field', field: 'scope' },
                        ],
                    },
                    instances: [{ kind: 'default', constants: { scope: 'default' } }],
                }],
            },
        },
    },
    backendsById: {},
    actionsById: {},
    toolsById: {},
    commandsById: {},
    resourcesById: {},
    settingsById: {},
    familiesById: {},
    diagnostics: [],
};

vi.mock('expo-router', () => createExpoRouterMock({
    params: () => routeParamsState.value,
    router: { back: routerBackSpy },
}).module);

vi.mock('@/sync/domains/state/storage', () => ({
    useSettings: () => ({
        backendEnabledByTargetKey: {},
        acpCatalogSettingsV1: { v: 2, backends: [] },
        connectedServicesProfileLabelByKey: {},
    }),
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useProfile: () => ({ connectedServicesV2: [] }),
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({
        phase: daemonProjectionState.phase,
        inputs: daemonProjectionState.phase === 'ready'
            ? { pluginProjectionV2: projection }
            : null,
    }),
}));

vi.mock('@/components/ui/surfaces/SurfaceStateCard', () => ({
    SurfaceStateCard: (props: Readonly<Record<string, unknown>>) =>
        React.createElement('SurfaceStateCard', props),
}));

vi.mock('@/components/sessions/external/browse/ExternalSessionsBrowseScreen', () => ({
    ExternalSessionsBrowseScreen: (props: Readonly<Record<string, unknown>>) => {
        browseScreenPropsRef.current = props;
        return null;
    },
}));

describe('ExternalSessionsBrowseRoute locked Agent scope', () => {
    beforeEach(() => {
        routeParamsState.value = {
            machineId: 'machine-1',
            serverId: 'server-1',
            agentId: 'acme-agent',
            agentPluginId: 'acme.external',
            agentLocalId: 'reviewer',
        };
        daemonProjectionState.phase = 'ready';
        routerBackSpy.mockReset();
        browseScreenPropsRef.current = null;
    });

    afterEach(() => {
        standardCleanup();
    });

    it('resolves a projected third-party source and locks browse to the qualified Agent', async () => {
        const Route = (await import('@/app/(app)/external/browse')).default;

        await renderScreen(<Route />);

        expect(browseScreenPropsRef.current?.lockScope).toEqual({
            machineId: 'machine-1',
            serverId: 'server-1',
            providerId: 'acme-agent',
            source: {
                kind: 'acmeHistory',
                scope: 'default',
            },
        });
    });

    it('fails closed instead of opening an unlocked browse when qualified Agent identity is stale', async () => {
        routeParamsState.value = {
            ...routeParamsState.value,
            agentPluginId: 'replaced.external',
        };
        const Route = (await import('@/app/(app)/external/browse')).default;

        await renderScreen(<Route />);

        expect(browseScreenPropsRef.current).toBeNull();
    });

    it('shows a closable loading surface while the locked Agent projection resolves', async () => {
        daemonProjectionState.phase = 'loading';
        const Route = (await import('@/app/(app)/external/browse')).default;

        const screen = await renderScreen(<Route />);

        const state = screen.findByTestId('external-sessions-browse-route-loading');
        expect(state?.props.kind).toBe('loading');
        expect(state?.props.secondaryAction?.label).toBe('Close');
        state?.props.secondaryAction?.onPress();
        expect(routerBackSpy).toHaveBeenCalledOnce();
        expect(browseScreenPropsRef.current).toBeNull();
    });

    it('shows a closable unavailable surface when the locked Agent is no longer projected', async () => {
        routeParamsState.value = {
            ...routeParamsState.value,
            agentPluginId: 'replaced.external',
        };
        const Route = (await import('@/app/(app)/external/browse')).default;

        const screen = await renderScreen(<Route />);

        const state = screen.findByTestId('external-sessions-browse-route-unavailable');
        expect(state?.props.kind).toBe('unavailable');
        expect(state?.props.action?.label).toBe('Close');
        state?.props.action?.onPress();
        expect(routerBackSpy).toHaveBeenCalledOnce();
        expect(browseScreenPropsRef.current).toBeNull();
    });

    it('preserves the ordinary unscoped browse entry point', async () => {
        routeParamsState.value = {};
        const Route = (await import('@/app/(app)/external/browse')).default;

        await renderScreen(<Route />);

        expect(browseScreenPropsRef.current?.lockScope).toBeNull();
    });
});
