import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createHomeGovernanceHarness } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { buildServerFeaturesResponse, stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';
import { renderHookAndCollectValues } from './serverFeatureHookHarness.testHelpers';
import { resetServerFeaturesClientForTests, getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { getStorage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import type { FeatureDecisionScopeParams } from './useFeatureDecision';

installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);


const homes = createHomeGovernanceHarness();
beforeEach(async () => {
    await homes.reset();
    const { getStorage } = await import('@/sync/domains/state/storage');
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    getStorage().setState({ settings: { ...settingsDefaults }, settingsScope: null });
    // Device credential reads are the OS boundary; selection and usable-Home policy stay real.
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (serverUrl) => {
        const token = homes.findByServerUrl(serverUrl)?.token;
        return token ? { token } : null;
    });
    const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
    await updateEffectiveHomeViewState(() => ({
        version: 1, groups: [], activeTargetKind: null, activeTargetId: null,
    }), { scope: 'device' });
});


beforeEach(() => {
    resetServerFeaturesClientForTests();
});

afterEach(() => {
    standardCleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('useFeatureDecision', () => {
    it('fails closed for main selection when servers disagree (mixed scope support)', async () => {
        const serverAId = await homes.addHome({ serverUrl: 'https://a.example', name: 'A', accountId: 'account-a' });
        const serverBId = await homes.addHome({ serverUrl: 'https://b.example', name: 'B', accountId: 'account-b', active: false });
        await homes.selectHomes([serverAId, serverBId]);

        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { automations: true },
        });

        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: RequestInfo | URL) => {
                const href = url instanceof Request ? url.url : String(url);
                if (href.includes('a.example')) {
                    return Response.json(buildServerFeaturesResponse({ automationsEnabled: true }));
                }
                if (href.includes('b.example')) {
                    return Response.json(buildServerFeaturesResponse({ automationsEnabled: false }));
                }
                return Response.json(buildServerFeaturesResponse({ automationsEnabled: true }));
            }),
        );

        await getServerFeaturesSnapshot({ serverId: serverAId, force: true });
        await getServerFeaturesSnapshot({ serverId: serverBId, force: true });

        const { useFeatureDecision } = await import('./useFeatureDecision');
        const seen = await renderHookAndCollectValues(() => useFeatureDecision('automations'));

        expect(seen.at(-1)?.state).toBe('unsupported');
        expect(seen.at(-1)?.blockedBy).toBe('scope');
        expect(seen.at(-1)?.blockerCode).toBe('mixed_scope_support');
        expect(seen.at(-1)?.scope.scopeKind).toBe('main_selection');
    }, 30_000);

    it('returns enabled decision when the feature is available', async () => {
        await stubServerFeaturesFetch({ voiceEnabled: true });

        getStorage().getState().applySettingsLocal({ experiments: true, featureToggles: { voice: true } });

        await getServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, force: true });

        const { useFeatureDecision } = await import('./useFeatureDecision');
        const seen = await renderHookAndCollectValues(() => useFeatureDecision('voice'));

        expect(seen.at(-1)?.state).toBe('enabled');
        expect(seen.at(-1)?.blockedBy).toBeNull();
    }, 30_000);

    it('keeps hook order stable when the scope changes between renders', async () => {
        const { useFeatureDecision } = await import('./useFeatureDecision');

        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'execution.runs': true },
        });

        const initialProps: Readonly<{ scope?: FeatureDecisionScopeParams }> = { scope: undefined };

        const hook = await renderHook(
            ({ scope }: Readonly<{ scope?: FeatureDecisionScopeParams }>) => useFeatureDecision('execution.runs', scope),
            {
                // Start at the default (main selection) scope, then change scopes across rerenders.
                // This would have crashed with the audit-reported conditional-hook implementation.
                initialProps,
            },
        );

        expect(hook.getCurrent()?.state).toBe('enabled');

        await expect(hook.rerender({ scope: { scopeKind: 'runtime' } })).resolves.toMatchObject({
            state: 'enabled',
        });

        await expect(hook.rerender({ scope: { scopeKind: 'spawn', serverId: 'test-spawn-server' } })).resolves.toMatchObject({
            state: 'enabled',
        });

        await expect(hook.rerender({ scope: { scopeKind: 'main_selection' } })).resolves.toMatchObject({
            state: 'enabled',
        });

        await expect(hook.rerender({ scope: { scopeKind: 'runtime' } })).resolves.toMatchObject({
            state: 'enabled',
        });
    });

    it('does not rerender local-only decisions for unrelated account settings', async () => {
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'zen.navigation': true },
            analyticsOptOut: false,
        });

        const { useFeatureDecision } = await import('./useFeatureDecision');
        let renderCount = 0;
        const hook = await renderHook(() => {
            renderCount += 1;
            return useFeatureDecision('zen.navigation');
        });

        expect(hook.getCurrent()?.state).toBe('enabled');
        const rendersAfterMount = renderCount;

        await act(async () => {
            getStorage().getState().applySettingsLocal({ analyticsOptOut: true });
        });

        expect(renderCount).toBe(rendersAfterMount);

        await act(async () => {
            getStorage().getState().applySettingsLocal({
                featureToggles: { 'zen.navigation': false },
            });
        });

        expect(renderCount).toBeGreaterThan(rendersAfterMount);
        expect(hook.getCurrent()?.state).toBe('disabled');

        await hook.unmount();
    });

    it('returns unsupported when the features endpoint is missing', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => Response.json({}, { status: 404 })),
        );

        getStorage().getState().applySettingsLocal({ experiments: true, featureToggles: { voice: true } });

        await getServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, force: true });

        const { useFeatureDecision } = await import('./useFeatureDecision');
        const seen = await renderHookAndCollectValues(() => useFeatureDecision('voice'));

        expect(seen.at(-1)?.state).toBe('unsupported');
        expect(seen.at(-1)?.blockerCode).toBe('endpoint_missing');
    }, 30_000);

    it('returns unknown when probing features fails', async () => {
        await stubServerFeaturesFetchFailure();

        getStorage().getState().applySettingsLocal({ experiments: true, featureToggles: { voice: true } });

        await getServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, force: true });

        const { useFeatureDecision } = await import('./useFeatureDecision');
        const seen = await renderHookAndCollectValues(() => useFeatureDecision('voice'));

        expect(seen.at(-1)?.state).toBe('unknown');
        expect(seen.at(-1)?.blockerCode).toBe('probe_failed');
    }, 30_000);
});
