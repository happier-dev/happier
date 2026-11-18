import { homeDeviceApprovalRequestFixture } from '@/dev/testkit/fixtures/accountDirectoryFixtures';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createConcurrentCacheNetworkHarness } from '@/dev/testkit/harness/concurrentCacheNetworkHarness';
import { HOME_LOGIN_APPROVALS_HTTP_PATH_V1, type HomeDeviceApprovalRequestV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { formatEnrollmentExpiry } from '@/auth/pairing/pairingPresentation';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const { AuthProvider } = await import('@/auth/context/AuthContext');

const h = await createConcurrentCacheNetworkHarness('approval-push');
const { HomeDeviceApprovalSection } = await import('./HomeDeviceApprovalSection');
let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
let homes: Awaited<ReturnType<typeof h.profiles.adoptHomeProfile>>[];
const pending = new Map<string, HomeDeviceApprovalRequestV1[]>();
const approvalReads = () => h.httpRequests.filter(({ url }) => url.pathname === HOME_LOGIN_APPROVALS_HTTP_PATH_V1);
const card = (id: string) => screen?.findByTestId(`settings.server.homeApprovals.${id}`);
const view = (visible = true) => <PluginSurfaceFocusEligibilityProvider active={visible} presentationActive={visible}>
    <AuthProvider initialCredentials={null}><HomeDeviceApprovalSection homes={homes} /></AuthProvider>
</PluginSurfaceFocusEligibilityProvider>;

beforeEach(async () => {
    await h.reset();
    homes = await Promise.all([h.homeB, h.homeC].map(home => h.profiles.adoptHomeProfile({
        descriptor: { v: 1, homeServerIdentityId: `srv_approval_${home.accountId}`, canonicalServerUrl: home.serverUrl,
            revision: 1, endpoints: [{ kind: 'https', url: home.serverUrl }] },
        source: 'manual', descriptorAuthority: 'current_connection_observation',
    })));
    await h.select([h.homeA.id, h.profiles.resolveServerProfileScopeId(homes[0])]);
    pending.clear();
    h.setResponder(async input => {
        const url = new URL(String(input));
        if (url.pathname !== HOME_LOGIN_APPROVALS_HTTP_PATH_V1) return null;
        return Response.json((pending.get(url.origin) ?? []).filter(item => item.expiresAtMs > Date.now()));
    });
    // Install before mounting either owner: otherwise a real discovery timer evades the count.
    vi.useFakeTimers();
});
afterEach(async () => {
    await screen?.unmount(); screen = undefined;
    await h.cleanup();
    vi.useRealTimers();
});
afterAll(() => h.dispose());

function request(id: string, expiresAtMs = Date.now() + 600_000): HomeDeviceApprovalRequestV1 {
    return homeDeviceApprovalRequestFixture({ approvalId: id, accountId: 'account-b', deviceLabel: id, expiresAtMs });
}
async function start() {
    await h.start();
    await vi.waitFor(() => expect(h.storage.getState().concurrentSessionListCacheByServerId[
        h.profiles.resolveServerProfileScopeId(homes[0])]?.listObservation?.phase).toBe('ready'));
    screen = await renderScreen(view());
    await vi.waitFor(() => expect(h.network.socketBoundaries.some(socket => socket.serverUrl === h.homeC.serverUrl)).toBe(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
}
async function wake(home: typeof h.homeB) {
    await act(async () => {
        h.socket(home).trigger('update', { id: 'approval-wake', seq: 1, createdAt: Date.now(), body: {
            t: 'account-change', cursor: 1, entityIds: [HOME_LOGIN_APPROVALS_HTTP_PATH_V1], changeKinds: ['account'], sessionSystemRecords: [],
        } });
    });
}

describe('Home approval composed push', () => {
    it('delivers creation, remote decision and reconnect through selected and unselected Home sockets', async () => {
        await start();
        for (const home of [h.homeB, h.homeC]) {
            const id = `approval-${home.accountId}`;
            pending.set(home.serverUrl, [request(id)]);
            await wake(home);
            await vi.waitFor(() => expect(card(id)).not.toBeNull());
            pending.set(home.serverUrl, []);
            await wake(home);
            await vi.waitFor(() => expect(card(id)).toBeNull());
            pending.set(home.serverUrl, [request(id)]);
            await act(async () => { h.socket(home).trigger('connect'); });
            await vi.waitFor(() => expect(card(id)).not.toBeNull());
        }
    });

    it('does zero idle discovery reads for 300s and observes a shortened real expiry without polling', async () => {
        await start();
        const initialReads = approvalReads().length;
        await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
        expect(approvalReads()).toHaveLength(initialReads);
        pending.set(h.homeC.serverUrl, [request('expiring')]);
        await wake(h.homeC);
        await vi.waitFor(() => expect(card('expiring')).not.toBeNull());
        const shortenedExpiry = Date.now() + 1_000;
        pending.set(h.homeC.serverUrl, [request('expiring', shortenedExpiry)]);
        await wake(h.homeC);
        await vi.waitFor(() => expect(screen!.getTextContent()).toContain(formatEnrollmentExpiry(shortenedExpiry)));
        const beforeExpiry = approvalReads().length;
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        await vi.waitFor(() => expect(card('expiring')).toBeNull());
        expect(approvalReads()).toHaveLength(beforeExpiry + homes.length);
        const socket = h.socket(h.homeC);
        await screen!.update(view(false));
        await vi.waitFor(() => expect(socket.socket.connected).toBe(false));
        const hiddenReads = approvalReads().length;
        pending.set(h.homeC.serverUrl, [request('while-hidden')]);
        await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
        expect(approvalReads()).toHaveLength(hiddenReads);
        await screen!.update(view());
        await vi.waitFor(() => expect(card('while-hidden')).not.toBeNull());
    });
});
