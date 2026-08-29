import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { ExpoRouterParams } from '@/dev/testkit/mocks/router';

const routeState = vi.hoisted(() => ({ params: {} as ExpoRouterParams }));
const setParams = vi.hoisted(() => vi.fn((next: ExpoRouterParams) => {
    Object.assign(routeState.params, next);
}));
const mounted = vi.hoisted(() => vi.fn());
const storeTempDataSpy = vi.hoisted(() => vi.fn(() => 'automation-draft-seed'));
const surfaceStateCardProps = vi.hoisted(() => ({ value: null as any }));
// Lifetime- and scope-sensitive Account state: a same-server Account A→B
// switch retires the A-era authority exactly like the real scope owner.
const accountScopeState = vi.hoisted(() => ({
    value: { serverId: 'server-1', accountId: 'account-1' } as { serverId: string; accountId: string } | null,
}));
const authorityCaptures = vi.hoisted(() => ({ list: [] as Array<{ serverId: string; accountId: string }> }));
// Live source-turn truth, independent of route params, so staleness can be
// simulated while the mounted binding keeps the observed identity.
const liveTurn = vi.hoisted(() => ({ value: 'turn-7' }));
const composerMounts = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const harness = createExpoRouterMock({
        router: { setParams },
        params: () => routeState.params,
    });
    return {
        ...harness.module,
        useRouter: () => ({ ...harness.state.router, setParams }),
    };
});
vi.mock('@/app/(app)/new/index', () => ({ default: () => {
    React.useEffect(() => {
        composerMounts.list.push({ ...routeState.params });
    }, []);
    mounted(routeState.params);
    return React.createElement('NewSessionScreen');
} }));
vi.mock('@/components/automations/gating/AutomationsGate', () => ({
    AutomationsGate: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/ui/surfaces/SurfaceStateCard', () => ({
    SurfaceStateCard: (props: any) => {
        surfaceStateCardProps.value = props;
        return React.createElement('SurfaceStateCard', props);
    },
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
vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => {
        const scope = accountScopeState.value;
        if (!scope) return null;
        return {
            scope,
            isCurrent: () => {
                const current = accountScopeState.value;
                return !!current
                    && current.serverId === scope.serverId
                    && current.accountId === scope.accountId;
            },
            onRetire: () => ({ dispose: () => {} }),
        };
    },
}));
vi.mock('@/sync/domains/automations/sessionAutomationAuthority', () => ({
    captureSessionAutomationAuthority: () => {
        const scope = accountScopeState.value;
        if (!scope) return null;
        authorityCaptures.list.push({ ...scope });
        return {
            serverId: scope.serverId,
            accountLifetime: { onRetire: () => ({ dispose: () => {} }) },
            isCurrent: () => {
                const current = accountScopeState.value;
                return !!current
                    && current.serverId === scope.serverId
                    && current.accountId === scope.accountId;
            },
        };
    },
}));
vi.mock('@/sync/domains/state/storage', () => ({
    storage: { getState: () => ({ sessions: routeState.params.sourceSessionId ? {
        [routeState.params.sourceSessionId as string]: {
            id: routeState.params.sourceSessionId,
            serverId: routeState.params.sourceServerId,
            latestTurnId: liveTurn.value,
            latestTurnStatus: 'in_progress',
        },
    } : {} }) },
    useSession: () => routeState.params.sourceSessionId ? ({
        id: routeState.params.sourceSessionId,
        serverId: routeState.params.sourceServerId,
        latestTurnId: liveTurn.value,
        latestTurnStatus: 'in_progress',
    }) : null,
    useActiveServerAccountScope: () => accountScopeState.value,
}));

describe('/automations/new', () => {
    beforeEach(() => {
        routeState.params = {};
        setParams.mockClear();
        mounted.mockClear();
        storeTempDataSpy.mockClear();
        surfaceStateCardProps.value = null;
        accountScopeState.value = { serverId: 'server-1', accountId: 'account-1' };
        authorityCaptures.list.length = 0;
        liveTurn.value = 'turn-7';
        composerMounts.list.length = 0;
    });

    it('fails a partial exact-turn tuple closed instead of composing generically', async () => {
        routeState.params = {
            sourceSessionId: 'source-session',
            sourceServerId: 'server-1',
        };
        const { default: Route } = await import('@/app/(app)/automations/new');
        await renderScreen(<Route />);

        expect(surfaceStateCardProps.value).toMatchObject({
            testID: 'new-automation-exact-turn-invalid',
        });
        expect(mounted).not.toHaveBeenCalled();
        expect(storeTempDataSpy).not.toHaveBeenCalled();
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

    it('rebinds the exact-turn authority under the new Account instead of staying retired', async () => {
        routeState.params = {
            sourceSessionId: 'source-session',
            sourceTurnId: 'turn-7',
            sourceServerId: 'server-1',
        };
        const { default: Route } = await import('@/app/(app)/automations/new');
        const screen = await renderScreen(<Route />);
        // The first render creates the canonical composer handoff; the next
        // render consumes that same handoff and mounts the shared composer.
        await screen.update(<Route />);
        await act(async () => {});

        expect(composerMounts.list).toHaveLength(1);
        expect(surfaceStateCardProps.value).toBeNull();

        // Same server, Account B mounts: the A-era authority retires; the
        // route must rebind under B instead of rendering a permanent error.
        accountScopeState.value = { serverId: 'server-1', accountId: 'account-2' };
        await screen.update(<Route />);
        await act(async () => {});

        expect(authorityCaptures.list.at(-1)).toMatchObject({ serverId: 'server-1', accountId: 'account-2' });
        expect(surfaceStateCardProps.value).toBeNull();
        expect(composerMounts.list).toHaveLength(1);
        expect(mounted).toHaveBeenLastCalledWith(expect.objectContaining({ automation: '1' }));
    });

    it('keeps the composer draft identity when explicitly adopting the current turn', async () => {
        routeState.params = {
            sourceSessionId: 'source-session',
            sourceTurnId: 'turn-7',
            sourceServerId: 'server-1',
        };
        const { default: Route } = await import('@/app/(app)/automations/new');
        const screen = await renderScreen(<Route />);

        const seededDraftId = routeState.params.draftId;
        const seededDataId = routeState.params.dataId;
        expect(seededDraftId).toEqual(expect.any(String));
        expect(storeTempDataSpy).toHaveBeenCalledTimes(1);

        // The source turn advances while composing: typed stale truth is
        // offered instead of silently retargeting.
        liveTurn.value = 'turn-8';
        await screen.update(<Route />);
        await act(async () => {});

        const stale = screen.findByProps({ testID: 'new-automation-exact-turn-stale' });
        expect(stale.props.kind).toBe('warning');
        expect(stale.props.action.label).toBe('Use current turn');

        await act(async () => stale.props.action.onPress());
        await act(async () => {});

        // Explicit adoption updates URL truth and re-mounts the composer on
        // the SAME draft identity: no second minted draft, continuity stays
        // with the incumbent draft owner, and the stale card clears.
        expect(setParams).toHaveBeenCalledWith(expect.objectContaining({ sourceTurnId: 'turn-8' }));
        expect(routeState.params.draftId).toBe(seededDraftId);
        expect(routeState.params.dataId).toBe(seededDataId);
        expect(storeTempDataSpy).toHaveBeenCalledTimes(1);
        expect(composerMounts.list.at(-1)).toMatchObject({ draftId: seededDraftId, dataId: seededDataId });
        expect(screen.findAllByProps({ testID: 'new-automation-exact-turn-stale' })).toHaveLength(0);
        expect(mounted).toHaveBeenLastCalledWith(expect.objectContaining({ automation: '1' }));
    });
});
