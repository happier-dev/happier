import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { buildServerFeaturesResponse } from './serverFeaturesTestUtils';

installDisconnectedServerSocketBoundary();
// Load the real owner graph after its external boundary, outside the per-case timeout.
const { getStorage } = await import('@/sync/domains/state/storage');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { useAutomationsSupport } = await import('./useAutomationsSupport');
const { loadEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
const homes = createHomeGovernanceHarness();

beforeEach(async () => {
    await homes.reset();
    getStorage().setState({ settings: { ...settingsDefaults }, settingsScope: null });
    getStorage().getState().applySettingsLocal({ experiments: true, featureToggles: { automations: true } });
    // Credential storage is the device boundary; Home selection and policy remain real.
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async serverUrl => {
        const token = homes.findByServerUrl(serverUrl)?.token;
        return token ? { token } : null;
    });
    resetServerFeaturesClientForTests();
});

afterEach(async () => {
    standardCleanup();
    await homes.reset();
    vi.restoreAllMocks();
});

async function addHome(enabled: boolean, suffix = 'active') {
    const serverId = await homes.addHome({ name: suffix,
        serverUrl: `https://automations-${suffix}.example.test`, accountId: 'automations-account' });
    const body = buildServerFeaturesResponse({ automationsEnabled: enabled });
    homes.answer(serverId, '/v1/features', { body });
    homes.answer(serverId, '/v1/features/authenticated', { body });
    return serverId;
}

async function resolveHome(serverId: string) {
    return getServerFeaturesSnapshot({ serverId, force: true });
}

describe('useAutomationsSupport', () => {
    it('reports loading while the feature decision is unresolved', async () => {
        const serverId = await addHome(true);
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        const body = buildServerFeaturesResponse({ automationsEnabled: true });
        homes.answer(serverId, '/v1/features', { body, respondAfter: pending });
        homes.answer(serverId, '/v1/features/authenticated', { body, respondAfter: pending });
        resetServerFeaturesClientForTests();
        const hook = await renderHook(() => useAutomationsSupport({ scopeKind: 'spawn', serverId }));
        try {
            expect(homes.requests.some(request => request.path.startsWith('/v1/features'))).toBe(true);
            expect(hook.getCurrent()).toMatchObject({
                enabled: false,
                loading: true,
                discoverable: true,
                blockedBy: null,
                blockerCode: null,
            });
            await act(async () => { release(); await resolveHome(serverId); });
            await vi.waitFor(() => expect(hook.getCurrent().enabled).toBe(true));
        } finally {
            release();
            await hook.unmount();
        }
    });

    it('keeps automations discoverable when only local policy blocks them', async () => {
        const serverId = await addHome(true);
        await resolveHome(serverId);
        getStorage().getState().applySettingsLocal({ featureToggles: { automations: false } });
        const hook = await renderHook(() => useAutomationsSupport({ scopeKind: 'spawn', serverId }));
        expect(hook.getCurrent()).toMatchObject({
            enabled: false,
            loading: false,
            discoverable: true,
            blockedBy: 'local_policy',
            blockerCode: 'flag_disabled',
        });
    });

    it('returns enabled when the feature decision is enabled', async () => {
        const serverId = await addHome(true);
        expect(await resolveHome(serverId)).toMatchObject({ status: 'ready' });
        const hook = await renderHook(() => useAutomationsSupport({ scopeKind: 'spawn', serverId }));
        expect(hook.getCurrent()).toMatchObject({
            enabled: true,
            loading: false,
            discoverable: true,
            blockedBy: null,
            blockerCode: 'none',
        });
    });

    it('hides automations when the server blocks the feature', async () => {
        const serverId = await addHome(true);
        homes.answer(serverId, '/v1/features', { status: 404, body: {} });
        homes.answer(serverId, '/v1/features/authenticated', { status: 404, body: {} });
        expect(await resolveHome(serverId)).toMatchObject({ status: 'unsupported' });
        const hook = await renderHook(() => useAutomationsSupport({ scopeKind: 'spawn', serverId }));
        expect(hook.getCurrent()).toMatchObject({
            enabled: false,
            loading: false,
            discoverable: false,
            blockedBy: 'server',
            blockerCode: 'endpoint_missing',
        });
    });

    it('fails closed when probing the feature fails', async () => {
        const serverId = await addHome(true);
        homes.answer(serverId, '/v1/features', { dispatchThenFail: true });
        homes.answer(serverId, '/v1/features/authenticated', { dispatchThenFail: true });
        expect(await resolveHome(serverId)).toMatchObject({ status: 'error' });
        expect(homes.requests.some(request => request.path.startsWith('/v1/features'))).toBe(true);
        const hook = await renderHook(() => useAutomationsSupport({ scopeKind: 'spawn', serverId }));
        expect(hook.getCurrent()).toMatchObject({
            enabled: false,
            loading: false,
            discoverable: false,
            blockedBy: 'server',
            blockerCode: 'probe_failed',
        });
    });

    it('passes scope through to useFeatureDecision', async () => {
        const activeId = await addHome(false);
        const spawnId = await addHome(true, 'spawn');
        await homes.selectHomes([activeId]);
        await Promise.all([resolveHome(activeId), resolveHome(spawnId)]);
        const active = await renderHook(() => useAutomationsSupport());
        const spawn = await renderHook(() => useAutomationsSupport({ scopeKind: 'spawn', serverId: spawnId }));
        expect(active.getCurrent()).toMatchObject({ enabled: false, loading: false });
        expect(spawn.getCurrent()).toMatchObject({ enabled: true, loading: false });
        expect(loadEffectiveHomeViewState()?.groups[0]?.serverIds).toEqual([activeId]);
    });
});
