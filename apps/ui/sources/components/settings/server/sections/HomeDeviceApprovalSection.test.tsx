import * as React from 'react';
import { router } from 'expo-router';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { setAccountServiceEndpoint } from '@/sync/domains/server/serverProfiles';
import { AccountDirectorySession } from '@/sync/domains/accountDirectory/accountDirectorySession';
import { completeAccountServicePostAuth, type AccountPostAuthResult } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';
import { cancelPendingDirectoryHomeEnrollment, getPendingDirectoryHomeEnrollment } from '@/sync/ops/accountDirectory/enrollDirectoryHome';
import { formatEnrollmentExpiry } from '@/auth/pairing/pairingPresentation';

installTokenStorageWebPlatformMocks();
const boundary = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/sync/http/client', () => ({
    createServerFetchAtEndpoint: (options: { endpointUrl: string }) => (path: string, init?: RequestInit) => boundary.request(options.endpointUrl, path, init),
    serverFetch: (path: string, init?: RequestInit) => boundary.request('ambient', path, init),
}));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// No AuthProvider is mounted; an opened Home refreshes auth through this owner.
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: async () => {} }),
}));

import { HomeDeviceApprovalSection } from './HomeDeviceApprovalSection';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { HOME_LOGIN_APPROVALS_HTTP_PATH_V1, buildHomeLoginApprovalDecisionHttpPathV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

type TextNode = Readonly<{ children?: ReadonlyArray<TextNode | string> }>;
function collectText(node: TextNode | string | null | undefined): string {
    if (!node) return '';
    if (typeof node === 'string') return node;
    return (node.children ?? []).map(collectText).join('');
}
/** The section's own polite live-region text (web/Android). */
function liveRegionText(screen: Awaited<ReturnType<typeof renderScreen>>): string {
    return collectText(screen.findByTestId('settings.server.homeApprovals.status') as unknown as TextNode | null);
}

/** Non-secret binding to the Account credential a continuation was created under. */
const ACCOUNT_CREDENTIAL_TOKEN_DIGEST = 'C0jknAf55a-WIBFlxj8xId4cq00hoNQDzcbt4__9tlM';

describe('Home approval visible continuation', () => {
    let fixture: ReturnType<typeof createDirectoryHttpFixture>;
    let restore: () => void;
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    beforeEach(() => { restore = installLocalStorageMock().restore; fixture = createDirectoryHttpFixture(); boundary.request.mockImplementation(fixture.request); });
    afterEach(async () => { await screen?.unmount(); screen = undefined; await cancelPendingDirectoryHomeEnrollment(); restore(); });

    it('discovers pushed approvals and reconciles reconnect and remote decisions without unrelated invalidation reads', async () => {
        const home = await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor, source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: fixture.home.homeServerIdentityId }, { token: fixture.token });
        let pending = false;
        let reads = 0;
        let expiresAtMs = Date.now() + 600_000;
        boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
            if (path !== HOME_LOGIN_APPROVALS_HTTP_PATH_V1) return fixture.request(endpoint, path, init);
            reads += 1;
            return new Response(JSON.stringify(pending ? [{
                approvalId: 'pushed', accountId: 'account-home', flow: 'account_assertion',
                requesterBoxPublicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                issuerServerIdentityId: fixture.service.serverIdentityId, issuerSubjectId: 'account-directory',
                deviceLabel: 'Pushed phone', status: 'pending', expiresAtMs, decidedAtMs: null,
            }] : []));
        });
        screen = await renderScreen(<HomeDeviceApprovalSection homes={[home]} />);
        await vi.waitFor(() => expect(reads).toBe(1));
        pending = true;
        await act(async () => { publishHomeAccountChange(home.id, [HOME_LOGIN_APPROVALS_HTTP_PATH_V1]); });
        expect(screen.findByTestId('settings.server.homeApprovals.pushed.approve')).not.toBeNull();
        expect(reads).toBe(2);
        expiresAtMs -= 300_000;
        await act(async () => { publishHomeAccountChange(home.id, [HOME_LOGIN_APPROVALS_HTTP_PATH_V1]); });
        expect(screen.getTextContent()).toContain(formatEnrollmentExpiry(expiresAtMs));
        expect(reads).toBe(3);
        await act(async () => { publishHomeAccountChange(home.id, ['unrelated'], { changeKinds: ['artifact'] }); });
        expect(reads).toBe(3);
        pending = false;
        await act(async () => { publishHomeAccountChange(home.id, undefined, { source: 'connected' }); });
        expect(screen.findByTestId('settings.server.homeApprovals.pushed.approve')).toBeNull();
        expect(reads).toBe(4);
    });

    it('coalesces committed wakes during an in-flight snapshot into one fresh trailing read', async () => {
        const home = await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor, source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: fixture.home.homeServerIdentityId }, { token: fixture.token });
        const first = createDeferred<Response>();
        let reads = 0;
        boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
            if (path !== HOME_LOGIN_APPROVALS_HTTP_PATH_V1) return fixture.request(endpoint, path, init);
            reads += 1;
            if (reads === 1) return first.promise;
            return new Response(JSON.stringify([{
                approvalId: 'during-read', accountId: 'account-home', flow: 'account_assertion',
                requesterBoxPublicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                issuerServerIdentityId: fixture.service.serverIdentityId, issuerSubjectId: 'account-directory',
                deviceLabel: 'New phone', status: 'pending', expiresAtMs: Date.now() + 600_000, decidedAtMs: null,
            }]));
        });
        screen = await renderScreen(<HomeDeviceApprovalSection homes={[home]} />);
        await vi.waitFor(() => expect(reads).toBe(1));
        await act(async () => {
            publishHomeAccountChange(home.id, [HOME_LOGIN_APPROVALS_HTTP_PATH_V1]);
            publishHomeAccountChange(home.id, [HOME_LOGIN_APPROVALS_HTTP_PATH_V1]);
            first.resolve(new Response('[]'));
        });
        await vi.waitFor(() => expect(screen?.findByTestId('settings.server.homeApprovals.during-read.approve')).not.toBeNull());
        expect(reads).toBe(2);
    });

    it('routes deliberate approval recovery to the original Account Service and enrollment intent', async () => {
        const { service } = fixture;
        await TokenStorage.accountDirectoryAuthCredentials.set({ endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId }, { token: 'directory-token' });
        const intent = { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId };
        await completeAccountServicePostAuth({ service, intent,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId }, { capability: service.capability }),
        });
        screen = await renderScreen(<HomeDeviceApprovalSection homes={[]} />);
        fixture.state.approval = 'expired';
        await screen.pressByTestIdAsync('settings.server.homeEnrollment.pending.retry');
        await vi.waitFor(() => expect(getPendingDirectoryHomeEnrollment()).toBeNull());
        // The live region speaks the same reason the continuation card shows.
        await vi.waitFor(() => expect(liveRegionText(screen!)).toContain('Start the sign-in again.'));
        expect(liveRegionText(screen)).not.toContain('Operation failed');
        fixture.state.directoryStatus = 401;
        await screen.pressByTestIdAsync('account-service-continuation-failure-action');
        await setAccountServiceEndpoint({ url: 'https://unrelated.test', serverIdentityId: 'srv_unrelated', source: 'user' });
        await screen.pressByTestIdAsync('account-service-continuation-failure-action');
        expect(router.push).toHaveBeenLastCalledWith(expect.objectContaining({ params: expect.objectContaining({
            accountServiceEndpoint: service.endpointUrl, accountServiceIdentity: service.serverIdentityId,
            accountIntent: JSON.stringify(intent),
        }) }));
        expect(fixture.state.calls.some(({ endpoint }) => endpoint === 'ambient' || endpoint === 'https://unrelated.test')).toBe(false);
    });

    it('resumes the pending requester on explicit refresh without another Directory assertion', async () => {
        const { service } = fixture;
        await TokenStorage.accountDirectoryAuthCredentials.set({ endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId }, { token: 'directory-token' });
        expect(await completeAccountServicePostAuth({ service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId }, { capability: service.capability }),
            intent: { kind: 'enroll', homeServerIdentityId: fixture.home.homeServerIdentityId },
        })).toMatchObject({ kind: 'approval_required' });
        screen = await renderScreen(<HomeDeviceApprovalSection homes={[]} />);
        fixture.state.approval = 'approved';
        fixture.state.mode = 'e2ee';
        await screen.pressByTestIdAsync('settings.server.homeEnrollment.pending.retry');
        await vi.waitFor(() => expect(getPendingDirectoryHomeEnrollment()).toBeNull());
        expect(screen.findByTestId('settings.server.homeEnrollment.continuation')).not.toBeNull();
        // The live region reads the continuation's own next step, not a separate label.
        await vi.waitFor(() => expect(liveRegionText(screen!)).toContain('Enter the secure key for srv_home_b.'));
        expect(await TokenStorage.getCredentialsForServerUrl(fixture.home.canonicalServerUrl, { serverId: fixture.home.homeServerIdentityId })).toEqual({ token: fixture.token });
        expect(fixture.state.calls.filter(({ path }) => path.includes('login-assertion'))).toHaveLength(1);
    });

    it('presents the requesting device and exact Home before deciding without consulting ambient focus', async () => {
        const home = await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor, source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: fixture.home.homeServerIdentityId }, { token: fixture.token });
        let decided = false;
        const expiresAtMs = Date.now() + 60_000;
        boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
            expect(endpoint).toBe(home.serverUrl);
            if (path === HOME_LOGIN_APPROVALS_HTTP_PATH_V1) return new Response(JSON.stringify(decided ? [] : [{
                approvalId: 'approval-b', accountId: 'account-home', flow: 'account_assertion',
                requesterBoxPublicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                issuerServerIdentityId: fixture.service.serverIdentityId, issuerSubjectId: 'account-directory',
                deviceLabel: 'New phone', status: 'pending', expiresAtMs, decidedAtMs: null,
            }]));
            if (path === buildHomeLoginApprovalDecisionHttpPathV1('approval-b')) {
                expect(JSON.parse(String(init?.body))).toEqual({ decision: 'approve' });
                decided = true;
                return new Response(JSON.stringify({ status: 'approved' }));
            }
            return fixture.request(endpoint, path, init);
        });
        screen = await renderScreen(<HomeDeviceApprovalSection homes={[home]} />);
        await vi.waitFor(() => expect(screen?.findByTestId('settings.server.homeApprovals.approval-b.approve')).not.toBeNull());
        const text = screen.getTextContent();
        expect(text).toContain('Device approvals');
        expect(text).toContain('New phone');
        expect(text).toContain(`Home: ${resolveHomeDisplayLabel(home, home.id)}`);
        expect(text).toContain(`Expires: ${formatEnrollmentExpiry(expiresAtMs)}`);
        expect(text).not.toContain(`Continue on a device already connected to ${home.name}.`);
        expect(text).toContain('Request details');
        expect(text).not.toContain('Request-key fingerprint');
        await screen.pressByTestIdAsync('settings.server.homeApprovals.approval-b.details');
        expect(screen.getTextContent()).toContain('This identifies the request key. It is not a code you need to compare.');
        expect(screen.getTextContent()).toContain('Request-key fingerprint');
        await screen.pressByTestIdAsync('settings.server.homeApprovals.approval-b.approve');
        expect(decided).toBe(true);
        await vi.waitFor(() => expect(screen?.findByTestId('settings.server.homeApprovals.approval-b')).toBeNull());
    });

    it('uses a neutral device fallback and leaves the real decision actions as recovery after a failure', async () => {
        const home = await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor, source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: fixture.home.homeServerIdentityId }, { token: fixture.token });
        let decisionAttempts = 0;
        boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
            expect(endpoint).toBe(home.serverUrl);
            if (path === HOME_LOGIN_APPROVALS_HTTP_PATH_V1) return new Response(JSON.stringify([{
                approvalId: 'approval-unlabeled', accountId: 'account-home', flow: 'account_assertion',
                requesterBoxPublicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                issuerServerIdentityId: fixture.service.serverIdentityId, issuerSubjectId: 'account-directory',
                deviceLabel: '   ', status: 'pending', expiresAtMs: Date.now() + 60_000, decidedAtMs: null,
            }]));
            if (path === buildHomeLoginApprovalDecisionHttpPathV1('approval-unlabeled')) {
                decisionAttempts += 1;
                if (decisionAttempts === 1) return new Response('{}', { status: 503 });
                expect(JSON.parse(String(init?.body))).toEqual({ decision: 'approve' });
                return new Response(JSON.stringify({ status: 'approved' }));
            }
            return fixture.request(endpoint, path, init);
        });

        screen = await renderScreen(<HomeDeviceApprovalSection homes={[home]} />);
        await vi.waitFor(() => expect(screen?.findByTestId('settings.server.homeApprovals.approval-unlabeled.approve')).not.toBeNull());
        expect(screen.getTextContent()).toContain('New device');

        await screen.pressByTestIdAsync('settings.server.homeApprovals.approval-unlabeled.approve');
        await vi.waitFor(() => expect(screen?.findByTestId('settings.server.homeApprovals.approval-unlabeled.error')).not.toBeNull());
        expect(screen.getTextContent()).toContain('Choose Approve or Reject to try again.');
        expect(screen.getTextContent()).not.toContain('Retry');

        await screen.pressByTestIdAsync('settings.server.homeApprovals.approval-unlabeled.approve');
        expect(decisionAttempts).toBe(2);
    });

    it('says which Home did not answer and retries through the same refetch', async () => {
        const home = await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor, source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: fixture.home.homeServerIdentityId }, { token: fixture.token });
        let reachable = false;
        boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
            if (path === HOME_LOGIN_APPROVALS_HTTP_PATH_V1) {
                if (!reachable) throw new TypeError('Failed to fetch');
                return new Response(JSON.stringify([]));
            }
            return fixture.request(endpoint, path, init);
        });
        screen = await renderScreen(<HomeDeviceApprovalSection homes={[home]} />);
        await vi.waitFor(() => expect(screen?.findByTestId('settings.server.homeApprovals.error')).not.toBeNull());
        const text = screen.getTextContent();
        expect(text).toContain("Couldn't load device approvals.");
        expect(text).toContain(`${resolveHomeDisplayLabel(home, home.id)} didn’t answer.`);
        // The next step is a real button, not the row itself.
        expect(screen.findByTestId('settings.server.homeApprovals.error')?.props.onPress).toBeUndefined();
        // Through the shared load-state owner, scoped to the Home that did not answer, so it defers to
        // the page's "can't reach" banner when that Home is the one this device uses.
        const load = screen.root.findAll((node) => node.props?.testID === 'settings.server.homeApprovals.error' && node.props?.state)[0];
        expect(load?.props.state).toMatchObject({ kind: 'failed', homeServerIds: [expect.any(String)] });

        reachable = true;
        await screen.pressByTestIdAsync('settings.server.homeApprovals.error-retry');
        await vi.waitFor(() => expect(screen?.findByTestId('settings.server.homeApprovals.error')).toBeNull());
    });

    it('does not report a signed-out Home as a failed load, since retrying cannot reach its approvals', async () => {
        const home = await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor, source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
        // Signed out: no stored credentials for this Home (earlier cases in this file sign in to it).
        await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: fixture.home.homeServerIdentityId });
        screen = await renderScreen(<HomeDeviceApprovalSection homes={[home]} />);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

        expect(screen.findByTestId('settings.server.homeApprovals.error')).toBeNull();
        expect(screen.getTextContent()).not.toContain("Couldn't load device approvals.");
    });

    it('adds no section while it first checks for approvals, so the page does not jump when there are none', async () => {
        const home = await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor, source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: fixture.home.homeServerIdentityId }, { token: fixture.token });
        boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
            // The first read never settles: the section is still checking.
            if (path === HOME_LOGIN_APPROVALS_HTTP_PATH_V1) return await new Promise<Response>(() => {});
            return fixture.request(endpoint, path, init);
        });
        screen = await renderScreen(<HomeDeviceApprovalSection homes={[home]} />);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

        expect(screen.findByTestId('settings.server.homeApprovals.loading')).toBeNull();
        expect(screen.getTextContent()).not.toContain('Device approvals');
    });
});

