import { renderWithSessionTranscriptSource, createTestSessionTranscriptSource } from '@/dev/testkit';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequestSchema, ApprovalRequestV2Schema, ARTIFACT_PLAIN_DATA_KEY_MARKER, API_TOKEN_FULL_GRANT_V1, StrictJsonValueSchema, buildApprovalRequestArtifactHeaderV1, computeExternalActionRequestEnvelopeDigestV1, encodePlainArtifactStoredContent, signExternalActionApprovalInputV1, type ApprovalRequest, type ApprovalRequestV1, type ApprovalRequestV2 } from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createServerScopedMachineRpcBoundaryMock } from '@/dev/testkit/mocks/serverScopedRpc';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
let homeId: string;
let headerHomeId: string;
let v1HomeId: string;
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;
const daemonRpc = vi.hoisted(() => vi.fn<Parameters<typeof createServerScopedMachineRpcBoundaryMock>[0]>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => createServerScopedMachineRpcBoundaryMock(daemonRpc));
const runtimePermissionDecisionSpy = vi.fn(async () => {});
const routerPushSpy = vi.fn();
function createApprovalTestSource() {
    return createTestSessionTranscriptSource({
        sessionId: 'session-1', navigate: routerPushSpy,
        interaction: { canSendMessages: true, canApprovePermissions: true },
        actions: { respondToPermission: runtimePermissionDecisionSpy, answerUserAction: async () => {}, abort: async () => {}, submitMessage: async () => {} },
    });
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props, null),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props, null),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPushSpy } }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

await loadSyncSingletonForTests();
const { ApprovalPromptCard } = await import('./ApprovalPromptCard');
const { storage } = await import('@/sync/domains/state/storage');
const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const initialState = storage.getState();

async function seedApproval(request: ApprovalRequest, serverId = homeId) {
    const response = await home.artifacts(serverId).handle('/v1/artifacts', {
        method: 'POST', body: JSON.stringify({
            id: 'approval-1', header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }),
    });
    expect(response?.ok).toBe(true);
}

function readApproval(serverId = homeId) {
    return ApprovalRequestSchema.parse(JSON.parse(home.artifacts(serverId).readPlainBody('approval-1') ?? 'null'));
}

async function expectDecision(decision: 'approve' | 'reject', serverId = homeId) {
    await vi.waitFor(() => expect(readApproval(serverId)).toMatchObject({ decision: { kind: decision } }));
    const updates = home.requestsFor('/v1/artifacts/approval-1').filter(request => request.input !== null);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every(request => request.serverId === serverId)).toBe(true);
}

function approvalRequest(): ApprovalRequestV1 {
    return {
        v: 1,
        status: 'open',
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'agent' as const, sessionId: 'session-1' },
        requestedSurface: 'agent',
        actionId: 'session.list',
        actionArgs: {},
        summary: 'List sessions before continuing',
        preview: { summary: 'Agent wants to inspect active sessions' },
    };
}

function invitationApprovalRequest(preview?: ApprovalRequestV2['preview']): ApprovalRequestV2 {
    const request = daemonApprovalRequest();
    return withApiAdmission({
        ...request,
        actionId: 'teams.invitations.accept',
        actionArgs: { v: 1, token: 'a'.repeat(43) },
        summary: 'Accept invitation',
        executionOriginV1: {
            ...request.executionOriginV1,
            actionId: 'teams.invitations.accept',
        },
        ...(preview === undefined ? {} : { preview }),
    });
}

function daemonApprovalRequest(): ApprovalRequestV2 {
    return withApiAdmission({
        v: 2,
        status: 'open',
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'system', sessionId: 'session-1' },
        requestedSurface: 'api',
        executionOriginV1: {
            v: 1,
            authority: 'account_automation',
            surface: 'api',
            caller: { kind: 'host' },
            serverId: 'local-A',
            serverIdentityId: 'srv_stable-home-a',
            accountId: 'account-1',
            principalId: 'principal-1',
            credentialId: 'credential-1',
            sessionId: 'session-1',
            machineId: 'machine-exact',
            target: { kind: 'session', sessionId: 'session-1' },
            actionId: 'session.title.set',
            requestId: 'request-1',
        },
        actionId: 'session.title.set',
        actionArgs: { sessionId: 'session-1', title: 'Current title' },
        summary: 'Set session title',
    });
}

function withApiAdmission(request: ApprovalRequestV2): ApprovalRequestV2 {
    // The daemon is the foreign verifier; keep its admitted API input signed by
    // the real protocol owner rather than bypassing UI origin currentness.
    const origin = request.executionOriginV1;
    if (!origin.machineId || !origin.target || !origin.serverIdentityId || !origin.accountId
        || !origin.principalId || !origin.credentialId) throw new Error('API admission fixture is incomplete');
    const authorization = {
        v: 1 as const,
        token: 'approval-invocation-authorization',
        binding: {
            serverIdentityId: origin.serverIdentityId, accountId: origin.accountId,
            principalId: origin.principalId, credentialId: origin.credentialId,
            grant: API_TOKEN_FULL_GRANT_V1, machineId: origin.machineId, actionId: request.actionId,
            requestId: origin.requestId, target: origin.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({
                v: 1, requestId: origin.requestId, target: origin.target, input: StrictJsonValueSchema.parse(request.actionArgs),
            }),
        },
    };
    const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
    return ApprovalRequestV2Schema.parse({ ...request, executionOriginV1: {
        ...origin, externalActionExecutionAuthorization: authorization,
        externalActionInputSignature: signExternalActionApprovalInputV1({
            authorizationToken: authorization.token, actionId: request.actionId, target: origin.target,
            input: request.actionArgs, privateKey: key.secretKey,
        }),
    } });
}

function unplacedApiApprovalRequest(): ApprovalRequestV2 {
    const approval = daemonApprovalRequest();
    const { machineId: _machineId, externalActionExecutionAuthorization: _authorization,
        externalActionInputSignature: _signature, ...executionOriginV1 } = approval.executionOriginV1;
    return { ...approval, executionOriginV1 };
}

function localUiApprovalRequest(serverId = homeId): ApprovalRequestV2 {
    const approval = daemonApprovalRequest();
    return {
        ...approval,
        requestedSurface: 'ui',
        executionOriginV1: {
            v: 1,
            authority: 'present_user',
            surface: 'ui',
            caller: { kind: 'host' },
            serverId,
            sessionId: 'session-1',
            target: { kind: 'session', sessionId: 'session-1' },
            actionId: 'session.title.set',
            requestId: 'request-ui-1',
        },
    };
}

function approvalArtifact(serverId?: string): Pick<DecryptedArtifact, 'id' | 'header'> {
    return {
        id: 'approval-1',
        header: {
            title: null,
            ...(serverId ? { serverId } : {}),
        },
    };
}

describe('ApprovalPromptCard', () => {
    beforeEach(async () => {
        webLocks = installWebLockManagerMock();
        await home.reset();
        homeId = await home.addHome({ name: 'Home A', serverUrl: 'https://approval-home-a.example',
            serverIdentityId: 'srv_stable-home-a', accountId: 'account-1' });
        headerHomeId = await home.addHome({ name: 'Header Home', serverUrl: 'https://approval-header.example',
            serverIdentityId: 'srv_stable-home-b', accountId: 'account-1', active: false });
        v1HomeId = await home.addHome({ name: 'V1 Home', serverUrl: 'https://approval-v1.example',
            accountId: 'account-1', active: false });
        storage.setState({ sessions: { 'session-1': createSessionFixture({ id: 'session-1', serverId: homeId }) } });
        daemonRpc.mockReset();
        daemonRpc.mockResolvedValue({ ok: true, result: { status: 'executed' } });
        runtimePermissionDecisionSpy.mockClear();
        routerPushSpy.mockClear();
    });
    afterEach(async () => {
        standardCleanup();
        await home.reset();
        storage.setState(initialState, true);
        webLocks?.restore();
        webLocks = undefined;
    });

    async function renderCard(approval: ApprovalRequest, options: Readonly<{
        serverId?: string; header?: boolean; chrome?: 'inline'; location?: { kind: 'top'; messageId: string; seq: number };
    }> = {}) {
        const serverId = options.serverId ?? homeId;
        await seedApproval(approval, serverId);
        return renderWithSessionTranscriptSource(<ApprovalPromptCard
            artifact={approvalArtifact(options.header === false ? undefined : serverId)}
            approval={approval} sessionId="session-1" canApprove chrome={options.chrome} location={options.location}
        />, createApprovalTestSource());
    }

    it('denies decisions when the source withholds actions even if interaction props permit approval', async () => {
        const approval = localUiApprovalRequest();
        await seedApproval(approval);
        const screen = await renderWithSessionTranscriptSource(<ApprovalPromptCard
            artifact={approvalArtifact(homeId)} approval={approval} sessionId="session-1" canApprove
        />, createTestSessionTranscriptSource({ interaction: { canSendMessages: true, canApprovePermissions: true } }));
        expect(screen.findByTestId('approval-prompt-approve')).toBeNull();
        expect(screen.findByTestId('approval-prompt-reject')).toBeNull();
        expect(screen.getTextContent()).toContain('session.sharing.permissionApprovalsDisabledTitle');
        expect(readApproval().status).toBe('open');
        expect(home.requestsFor('/v1/artifacts/approval-1').filter(request => request.input !== null)).toEqual([]);
        expect(daemonRpc).not.toHaveBeenCalled();
    });

    it('renders the action approval summary in inline chrome', async () => {
        const screen = await renderCard(approvalRequest(), { chrome: 'inline' });
        expect(screen.findByTestId('approval-prompt-card')).toBeTruthy();
        expect(screen.getTextContent()).toContain('List sessions before continuing');
        expect(screen.getTextContent()).toContain('Agent wants to inspect active sessions');
    });

    it('withholds approve for a released V1 request while preserving rejection', async () => {
        const screen = await renderCard(approvalRequest());
        expect(screen.findByTestId('approval-prompt-approve')?.props).toMatchObject({
            disabled: true, accessibilityHint: 'approvals.approveUnavailableHint',
        });
        expect(screen.findByTestId('approval-prompt-reject')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('approval-prompt-approve');
        expect(readApproval().status).toBe('open');
        await screen.pressByTestIdAsync('approval-prompt-reject');
        await expectDecision('reject');
        expect(readApproval().status).toBe('rejected');
        expect(daemonRpc).not.toHaveBeenCalled();
    });

    it('renders canonical invitation context without revealing its bearer', async () => {
        const bearer = 'a'.repeat(43);
        const screen = await renderCard(invitationApprovalRequest({
            actionId: 'teams.invitations.accept', actionArgs: {
                homeServerId: 'srv-home-acme', continuation: { teamId: 'team-acme' },
                teamName: 'Acme Platform', role: 'member', historyAccess: 'from_membership',
                state: 'active', expiresAt: 1234, recipientEmailMask: 'a•••@example.com',
            },
        }));
        expect(screen.getTextContent()).toContain('Acme Platform');
        expect(screen.getTextContent()).toContain('a•••@example.com');
        expect(screen.getTextContent()).not.toContain(bearer);
        expect(screen.findByTestId('approval-prompt-approve')?.props.disabled).toBe(false);
    });

    it('withholds approval when required invitation context is unavailable while preserving rejection', async () => {
        const screen = await renderCard(invitationApprovalRequest());
        expect(screen.findByTestId('approvals.unrepresentable-details')).not.toBeNull();
        expect(screen.getTextContent()).toContain('approvals.unsafeDetailsTitle');
        expect(screen.getTextContent()).not.toContain('a'.repeat(43));
        expect(screen.findByTestId('approval-prompt-approve')?.props.disabled).toBe(true);
        expect(screen.findByTestId('approval-prompt-reject')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('approval-prompt-approve');
        expect(readApproval().status).toBe('open');
        await screen.pressByTestIdAsync('approval-prompt-reject');
        await expectDecision('reject');
        expect(readApproval().status).toBe('rejected');
        expect(daemonRpc).not.toHaveBeenCalled();
    });

    it('opens the originating transcript tool when a location is available', async () => {
        const screen = await renderCard(approvalRequest(), {
            location: { kind: 'top', messageId: 'tool:tool-1', seq: 10 },
        });
        await screen.pressByTestIdAsync('approval-prompt-view-tool');
        expect(routerPushSpy).toHaveBeenCalledWith('/session/session-1?jumpSeq=10');
    });

    it('places the primary approve action before the reject action', async () => {
        const screen = await renderCard(approvalRequest());
        const order = collectRenderedTestIds(screen.tree.toJSON());
        expect(order.indexOf('approval-prompt-approve')).toBeGreaterThanOrEqual(0);
        expect(order.indexOf('approval-prompt-reject')).toBeGreaterThanOrEqual(0);
        expect(order.indexOf('approval-prompt-approve')).toBeLessThan(order.indexOf('approval-prompt-reject'));
    });

    it('approves through the real Action front door and Artifact decision owner', async () => {
        const screen = await renderCard(localUiApprovalRequest());
        await screen.pressByTestIdAsync('approval-prompt-approve');
        await expectDecision('approve');
        expect(runtimePermissionDecisionSpy).not.toHaveBeenCalled();
        expect(daemonRpc).not.toHaveBeenCalled();
    });

    it('rejects on the real Session Home when the artifact header does not name a route', async () => {
        const screen = await renderCard(approvalRequest(), { header: false });
        await screen.pressByTestIdAsync('approval-prompt-reject');
        await expectDecision('reject');
        expect(readApproval().status).toBe('rejected');
        expect(runtimePermissionDecisionSpy).not.toHaveBeenCalled();
    });

    it('routes a V2 durable approval through this device profile for the same stable Home', async () => {
        const screen = await renderCard(daemonApprovalRequest());
        await screen.pressByTestIdAsync('approval-prompt-approve');
        await vi.waitFor(() => expect(daemonRpc).toHaveBeenCalledTimes(1));
        expect(daemonRpc).toHaveBeenCalledWith(expect.objectContaining({
            serverId: homeId, machineId: 'machine-exact', method: RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED,
            payload: { artifactId: 'approval-1' },
        }));
        expect(readApproval()).toMatchObject({ status: 'approved', decision: { kind: 'approve' } });
        expect(home.artifacts(headerHomeId).list()).toEqual([]);
    });

    it('does not locally replay a V2 approval when the exact daemon reports approval_stale', async () => {
        daemonRpc.mockResolvedValue({ ok: false, errorCode: 'approval_stale', error: 'approval_stale' });
        const screen = await renderCard(daemonApprovalRequest());
        await screen.pressByTestIdAsync('approval-prompt-approve');
        await vi.waitFor(() => expect(daemonRpc).toHaveBeenCalledTimes(1));
        expect(daemonRpc).toHaveBeenCalledWith(expect.objectContaining({
            serverId: homeId, machineId: 'machine-exact', payload: { artifactId: 'approval-1' },
        }));
        expect(home.requests.filter(request => request.path.includes('/sessions/'))).toEqual([]);
    });

    it('fails closed instead of locally replaying an API approval whose daemon placement is missing', async () => {
        const screen = await renderCard(unplacedApiApprovalRequest());
        await screen.pressByTestIdAsync('approval-prompt-approve');
        expect(daemonRpc).not.toHaveBeenCalled();
        expect(readApproval().status).toBe('open');
    });

    it('fails closed when the immutable Home identity is unavailable even with a saved different Home', async () => {
        const approval = daemonApprovalRequest();
        approval.executionOriginV1.serverIdentityId = 'srv_missing-home';
        const screen = await renderCard(withApiAdmission(approval), { serverId: headerHomeId });
        await screen.pressByTestIdAsync('approval-prompt-approve');
        expect(daemonRpc).not.toHaveBeenCalled();
        expect(readApproval(headerHomeId).status).toBe('open');
        expect(screen.findByTestId('approval-prompt-approve')?.props.disabled).toBe(true);
        expect(screen.findByTestId('approval-prompt-reject')?.props.disabled).toBe(true);
        expect(screen.getTextContent()).toContain('actionConfirmations.homeUnavailable');
    });

    it('retains exact-route decisions for a V2 approval stamped by the UI/Home owner', async () => {
        const screen = await renderCard(localUiApprovalRequest(headerHomeId), { serverId: headerHomeId });
        await screen.pressByTestIdAsync('approval-prompt-approve');
        await expectDecision('approve', headerHomeId);
        expect(home.artifacts(homeId).list()).toEqual([]);
        expect(daemonRpc).not.toHaveBeenCalled();
    });

    it('keeps V1 on its explicitly scoped route without attempting cross-device replay', async () => {
        const screen = await renderCard(approvalRequest(), { serverId: v1HomeId });
        await screen.pressByTestIdAsync('approval-prompt-reject');
        await expectDecision('reject', v1HomeId);
        expect(readApproval(v1HomeId).status).toBe('rejected');
        expect(home.artifacts(homeId).list()).toEqual([]);
        expect(daemonRpc).not.toHaveBeenCalled();
    });
});
