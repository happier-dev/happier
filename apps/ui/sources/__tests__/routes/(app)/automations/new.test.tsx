import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { ExpoRouterParams } from '@/dev/testkit/mocks/router';

const routeState = vi.hoisted(() => ({ params: {} as ExpoRouterParams }));
const setParams = vi.hoisted(() => vi.fn((next: ExpoRouterParams) => {
    Object.assign(routeState.params, next);
}));
const mounted = vi.hoisted(() => vi.fn());
const storeTempDataSpy = vi.hoisted(() => vi.fn(() => 'automation-draft-seed'));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: { setParams },
        params: () => routeState.params,
    }).module;
});
vi.mock('@/app/(app)/new/index', () => ({ default: () => {
    mounted(routeState.params);
    return React.createElement('NewSessionScreen');
} }));
vi.mock('@/components/automations/gating/AutomationsGate', () => ({
    AutomationsGate: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/utils/sessions/tempDataStore', () => ({
    storeTempData: storeTempDataSpy,
}));
vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({ useHydrateSessionForRoute: () => ({ kind: 'ready' }) }));
vi.mock('@/hooks/server/useAutomationsSupport', () => ({ useAutomationsSupport: () => ({ enabled: true }) }));
vi.mock('@/sync/domains/session/sessionRouteHydrationState', () => ({ isSessionRouteHydrationAvailable: () => true }));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: routeState.params.sourceServerId ?? 'server-1' }),
}));
vi.mock('@/sync/domains/automations/sessionAutomationAuthority', () => ({
    captureSessionAutomationAuthority: () => ({
        isCurrent: () => true,
        accountLifetime: { onRetire: () => ({ dispose: () => {} }) },
    }),
}));
vi.mock('@/sync/domains/state/storage', () => ({
    storage: { getState: () => ({ sessions: routeState.params.sourceSessionId ? {
        [routeState.params.sourceSessionId as string]: {
            id: routeState.params.sourceSessionId,
            serverId: routeState.params.sourceServerId,
            latestTurnId: routeState.params.sourceTurnId,
            latestTurnStatus: 'in_progress',
        },
    } : {} }) },
    useSession: () => routeState.params.sourceSessionId ? ({
        id: routeState.params.sourceSessionId,
        serverId: routeState.params.sourceServerId,
        latestTurnId: routeState.params.sourceTurnId,
        latestTurnStatus: 'in_progress',
    }) : null,
}));

describe('/automations/new', () => {
    beforeEach(() => {
        routeState.params = {};
        setParams.mockClear();
        mounted.mockClear();
        storeTempDataSpy.mockClear();
    });

    it('mounts the shared recipe composer directly with a zero-trigger plural draft', async () => {
        const { default: Route } = await import('@/app/(app)/automations/new');
        await renderScreen(<Route />);
        await renderScreen(<Route />);

        expect(setParams).toHaveBeenCalledWith(expect.objectContaining({ automation: '1', dataId: expect.any(String) }));
        expect(mounted).toHaveBeenCalled();
        expect(storeTempDataSpy).toHaveBeenCalledWith({
            automationDraft: {
                enabled: true,
                name: '',
                description: '',
                triggers: [],
            },
        });
    });

    it('preserves exact observed Session and turn identity in the seeded draft path', async () => {
        routeState.params = {
            sourceSessionId: 'source-session',
            sourceTurnId: 'turn-7',
            sourceServerId: 'server-1',
        };
        const { default: Route } = await import('@/app/(app)/automations/new');
        await renderScreen(<Route />);
        await renderScreen(<Route />);

        expect(setParams).toHaveBeenCalledWith(expect.objectContaining({ automation: '1', dataId: expect.any(String) }));
        expect(storeTempDataSpy).toHaveBeenCalledWith({
            automationDraft: {
                enabled: true,
                name: '',
                description: '',
                triggers: [{
                    clientId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
                    definition: {
                        kind: 'sessionLifecycle',
                        enabled: true,
                        event: 'parentTurnCompleted',
                        scope: {
                            kind: 'exactTurn',
                            sourceSessionId: 'source-session',
                            sourceTurnId: 'turn-7',
                        },
                        consumption: 'once',
                    },
                }],
            },
        });
    });

    it('rehydrates an existing plural composer handoff without minting a competing draft', async () => {
        routeState.params = {
            automation: '1',
            dataId: 'existing-plural-seed',
            draftId: 'existing-draft',
        };
        const { default: Route } = await import('@/app/(app)/automations/new');
        await renderScreen(<Route />);

        expect(storeTempDataSpy).not.toHaveBeenCalled();
        expect(setParams).not.toHaveBeenCalled();
        expect(mounted).toHaveBeenCalledWith(expect.objectContaining({
            automation: '1',
            dataId: 'existing-plural-seed',
            draftId: 'existing-draft',
        }));
    });
});
