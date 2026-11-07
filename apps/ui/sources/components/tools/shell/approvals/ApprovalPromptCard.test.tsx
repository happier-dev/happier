import { renderWithSessionTranscriptSource, createTestSessionTranscriptSource, createActionExecutorBoundaryFixture } from '@/dev/testkit';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequestSchema, ApprovalRequestV2Schema, type ApprovalRequest, type ApprovalRequestV1, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import { API_TOKEN_FULL_GRANT_V1} from '@happier-dev/protocol/auth/apiTokenGrant';
import { StrictJsonValueSchema} from '@happier-dev/protocol/json/strictJsonValue';
import { buildApprovalRequestArtifactHeaderV1} from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1} from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import tweetnacl from 'tweetnacl';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createServerScopedMachineRpcBoundaryMock } from '@/dev/testkit/mocks/serverScopedRpc';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';

import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { deriveTranscriptInteraction, deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { deriveReadOnlyTranscriptInteraction } from '@/components/sessions/transcript/forkContext/deriveReadOnlyTranscriptInteraction';
import { TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS } from './transcriptSettledApprovalPresentations';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { buildDiscussionRequesterApprovalArtifact } from '@/sync/domains/artifacts/approvalArtifacts.discussionRequester.testkit';
import { createSessionSurfaceNoteDocumentV1 } from '@happier-dev/protocol/sessions/board';
import { createActionExecutor } from '@happier-dev/protocol/actions';

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

async function invitationApprovalRequest(includePreview = true): Promise<ApprovalRequestV2> {
    let prepared: ApprovalRequest | null = null;
    const bearer = 'a'.repeat(43);
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        // The authenticated Home owns exchanging the bearer for deferred custody.
        homeDomainAction: async ({ actionId, input }) => {
            expect(actionId).toBe('teams.invitations.accept.prepareApproval');
            expect(input).toEqual({ v: 1, token: bearer });
            return {
                outcome: 'ok', continuation: {
                    v: 1, kind: 'post_auth_invitation', reference: 'prepared-invitation-reference', teamId: 'team-acme',
                },
                preview: {
                    home: { serverId: 'srv-home-acme', displayName: 'Acme Home', storageMode: 'encrypted' },
                    team: { teamId: 'team-acme', name: 'Acme Platform', logo: null, accentSeed: 'team-acme' },
                    role: 'member', historyAccess: 'from_membership', state: 'active',
                    expiresAt: 1234, recipientEmailMask: 'a•••@example.com',
                },
            };
        },
        approvalsCreate: async ({ request }) => {
            prepared = request;
            return { artifactId: 'approval-1' };
        },
    }));
    expect(await executor.execute('approval.request.create', {
        actionId: 'teams.invitations.accept', actionArgs: { v: 1, token: bearer },
        summary: 'Accept invitation', createdBy: { surface: 'system' },
    }, { surface: 'mcp', authority: 'present_user', serverId: homeId,
        runtimeAccountId: 'account-1', actionRequestId: 'request-invitation-1', actionCaller: { kind: 'host' },
    })).toMatchObject({ ok: true, result: { artifactId: 'approval-1' } });
    const invitation = ApprovalRequestV2Schema.parse(prepared);
    expect(JSON.stringify(invitation)).not.toContain(bearer);
    const request = daemonApprovalRequest();
    return withApiAdmission({
        ...request,
        actionId: 'teams.invitations.accept',
        // Missing stored presentation models an incomplete bearer-only request.
        actionArgs: includePreview ? invitation.actionArgs : { v: 1, token: bearer },
        summary: 'Accept invitation',
        executionOriginV1: {
            ...request.executionOriginV1,
            actionId: 'teams.invitations.accept',
        },
        ...(includePreview ? { preview: invitation.preview } : {}),
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
            actionId: 'session.archive',
            requestId: 'request-1',
        },
        // Title writes are Account-placed; this fixture exercises Session-daemon replay.
        actionId: 'session.archive',
        actionArgs: { sessionId: 'session-1' },
        summary: 'Archive session',
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
            // This foreign admission selected a same-Account daemon installation.
            custodianAccountId: origin.accountId, installationId: 'installation-exact',
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
        actionId: 'session.title.set',
        actionArgs: { sessionId: 'session-1', title: 'Current title' },
        summary: 'Set session title',
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
            serverIdentityId: 'srv_stable-home-a', accountId: 'account-1', currentAccount: true });
        // Replay first admits the exact daemon's custody from its Home's genuine machine census.
        const machineRow = { ...createPlainMachineRowFixture({ id: 'machine-exact', accountId: 'account-1' }),
            installationId: 'installation-exact' };
        home.answer(homeId, 'GET /v1/machines', { body: [machineRow] });
        // The external Action transport reads its exact Machine by id (read-batch over this row).
        home.answer(homeId, 'GET /v1/machines/machine-exact', { body: { machine: machineRow } });
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
        toolOutput?: string;
    }> = {}) {
        const serverId = options.serverId ?? homeId;
        await seedApproval(approval, serverId);
        return renderWithSessionTranscriptSource(<ApprovalPromptCard
            artifact={approvalArtifact(options.header === false ? undefined : serverId)}
            approval={approval} sessionId="session-1" canApprove chrome={options.chrome} location={options.location}
            toolOutput={options.toolOutput}
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

    describe('an Agent visual at Ask', () => {
        const visualArgs = {
            sessionId: 'session-1', itemId: 'visual-1', expectedItemRevision: null, destination: 'transcript' as const,
            item: { v: 1 as const, title: 'Release checklist', frame: 'frameless' as const,
                height: { mode: 'auto' as const, fallback: 'regular' as const },
                source: { kind: 'declarative' as const, document: createSessionSurfaceNoteDocumentV1('- ship it') } },
        };
        function visualApproval(overrides: Record<string, unknown> = {}): ApprovalRequest {
            return ApprovalRequestV2Schema.parse({
                v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
                createdBy: { surface: 'agent', sessionId: 'session-1' }, requestedSurface: 'agent',
                origin: { kind: 'transcript_tool_call', sessionId: 'session-1', messageId: 'message-1', toolCallId: 'tool-1',
                    toolName: 'session_board_item_upsert', toolInput: visualArgs },
                executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
                    caller: { kind: 'session', sessionId: 'session-1', starterDepth: 0, turnDepth: 0 },
                    serverId: homeId, sessionId: 'session-1', machineId: 'machine-1',
                    actionId: 'session.board.item.upsert', requestId: 'request-1' },
                actionId: 'session.board.item.upsert', actionArgs: visualArgs, summary: 'Show Release checklist?',
                ...overrides,
            });
        }

        it('becomes the visual itself once approved: the live occurrence at the request, not a card around it', async () => {
            const approved = visualApproval({ status: 'executed', updatedAtMs: 3, decision: { kind: 'approve', decidedAtMs: 2 },
                execution: { executedAtMs: 3, effectAttempted: true, ok: true, result: {
                    v: 1, serverId: homeId, sessionId: 'session-1', itemDestination: 'transcript', destination: null,
                    result: { operation: 'upsert_item', itemId: 'visual-1', outcome: 'created', itemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
                } } });
            const screen = await renderCard(approved, { chrome: 'inline' });
            const ids = collectRenderedTestIds(screen.tree.toJSON());
            expect(ids).toContain('transcript-board-item-visual-1');
            expect(ids).not.toContain('approval-prompt-card');
        });

        it('keeps the request at its call while it waits, with its decision', async () => {
            const screen = await renderCard(visualApproval(), { chrome: 'inline' });
            const ids = collectRenderedTestIds(screen.tree.toJSON());
            expect(ids).toContain('approval-prompt-card');
            expect(ids).toContain('approval-prompt-approve');
            expect(ids).not.toContain('transcript-board-item-visual-1');
        });
    });

    describe('a first Computer click at Ask (lab computer CS)', () => {
        function computerClickApproval(captureMedia: boolean): ApprovalRequest {
            return {
                ...approvalRequest(),
                actionId: 'computer.input',
                actionArgs: { machineId: 'machine-exact', captureId: 'capture-1', operation: { kind: 'click', x: 412, y: 318 } },
                summary: 'Click Sign in',
                preview: { computerApprovalDisplay: {
                    machineDisplayName: 'MacBook Pro', requiresTargetSelection: false, appName: 'Safari',
                    target: { kind: 'window', title: 'Sign in to Lumen' },
                    ...(captureMedia ? { captureMedia: { mediaId: 'media-1', mediaKind: 'image', width: 1280, height: 800, sizeBytes: 48_213,
                        file: { sessionId: 'session-1', storage: 'session', path: '.happier/media/sign-in.png',
                            sha256: 'a'.repeat(64), mimeType: 'image/png' } } } : {}),
                } },
            };
        }

        it('shows the shared window as the owner last captured it, in the chat card itself', async () => {
            const screen = await renderCard(computerClickApproval(true), { chrome: 'inline' });
            const ids = collectRenderedTestIds(screen.tree.toJSON());
            expect(ids).toContain('approval-prompt-computer-action');
            expect(ids.some((id) => id.startsWith('approval-prompt-computer-action-capture'))).toBe(true);
        });

        it('reads a daemon-stored capture from the Machine the Home lists under its stable identity', async () => {
            const approval = computerClickApproval(true);
            const display = (approval.preview as { computerApprovalDisplay: { captureMedia: { file: { storage: string } } } }).computerApprovalDisplay;
            display.captureMedia.file.storage = 'daemon';
            // Machine inventories may be keyed by the Home's portable identity rather than this device's profile id.
            const machine = createMachineFixture({ id: 'machine-exact' });
            storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { 'srv_stable-home-a': [machine] } });
            const screen = await renderCard(approval, { chrome: 'inline' });
            const ids = collectRenderedTestIds(screen.tree.toJSON());
            expect(ids.some((id) => id.startsWith('approval-prompt-computer-action-capture'))).toBe(true);
        });

        it('leaves the picture out when the owner has no capture yet', async () => {
            const screen = await renderCard(computerClickApproval(false), { chrome: 'inline' });
            const ids = collectRenderedTestIds(screen.tree.toJSON());
            expect(ids).toContain('approval-prompt-computer-action');
            expect(ids.some((id) => id.startsWith('approval-prompt-computer-action-capture'))).toBe(false);
        });
    });

    it('renders the action approval summary in inline chrome', async () => {
        const screen = await renderCard(approvalRequest(), { chrome: 'inline' });
        expect(screen.findByTestId('approval-prompt-card')).toBeTruthy();
        expect(screen.getTextContent()).toContain('List sessions before continuing');
        expect(screen.getTextContent()).toContain('Agent wants to inspect active sessions');
    });

    it('withholds requester-bound decisions from the Bot Session owner', async () => {
        const artifact = buildDiscussionRequesterApprovalArtifact({
            id: 'approval-1', serverId: homeId, serverIdentityId: 'srv_stable-home-a',
            botSessionId: 'session-1', executionAccountId: 'account-1', requesterAccountId: 'account-2',
            summary: 'Update document',
        });
        if (typeof artifact.body !== 'string') throw new Error('Expected requester approval body');
        const approval = ApprovalRequestV2Schema.parse(JSON.parse(artifact.body));
        await seedApproval(approval);

        const screen = await renderWithSessionTranscriptSource(<ApprovalPromptCard
            artifact={approvalArtifact(homeId)} approval={approval} sessionId="session-1" canApprove chrome="inline"
        />, createApprovalTestSource());

        expect(screen.findByTestId('approval-prompt-approve')).toBeNull();
        expect(screen.findByTestId('approval-prompt-reject')).toBeNull();
        expect(screen.findByTestId('approval-prompt-requester-waiting')).toBeTruthy();
        expect(screen.getTextContent()).toContain('detailPages.approval.requester.thread.waiting');
        expect(readApproval().status).toBe('open');
        expect(home.requestsFor('/v1/artifacts/approval-1').filter(request => request.input !== null)).toEqual([]);
    });

    it('offers requester-bound decisions after the requester restores the Home under another local profile id', async () => {
        const artifact = buildDiscussionRequesterApprovalArtifact({
            id: 'approval-1', serverId: 'creator-local-home-profile', serverIdentityId: 'srv_stable-home-a',
            botSessionId: 'session-1', executionAccountId: 'bot-owner', requesterAccountId: 'account-1',
            summary: 'Update document',
        });
        if (typeof artifact.body !== 'string') throw new Error('Expected requester approval body');
        const approval = ApprovalRequestV2Schema.parse(JSON.parse(artifact.body));
        await seedApproval(approval);

        const screen = await renderWithSessionTranscriptSource(<ApprovalPromptCard
            artifact={approvalArtifact(homeId)} approval={approval} sessionId="session-1" canApprove chrome="inline"
        />, createApprovalTestSource());

        await waitForHomeGovernance(() => {
            expect(screen.findByTestId('approval-prompt-approve')).toBeTruthy();
            expect(screen.findByTestId('approval-prompt-reject')).toBeTruthy();
            expect(screen.findByTestId('approval-prompt-requester-waiting')).toBeNull();
        });
    });

    it('renders a contributed Action approval with its canonical decision controls', async () => {
        const approval = TargetActionApprovalRequestV1Schema.parse({
            v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'session-1' }, requestedSurface: 'agent',
            qualifiedActionId: 'dev.leads-fixture/actions/update-stage', input: { leadId: 'verdant', stage: 'qualified' },
            sourceCustody: { kind: 'managed', immutableGenerationId: 'fixture-generation', installSource: 'npm' },
            policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), approvalInputCustody: 'live_only',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
                caller: { kind: 'session', sessionId: 'session-1', starterDepth: 0, turnDepth: 0 },
                serverId: homeId, sessionId: 'session-1', actionId: 'action.invoke', requestId: 'request-1' },
            summary: 'Update this lead’s stage?',
        });
        const screen = await renderWithSessionTranscriptSource(<ApprovalPromptCard
            artifact={{ id: 'target-approval', header: { title: approval.summary, kind: 'target_action_approval.v1',
                approvalStatus: 'open', sessionId: 'session-1', serverId: homeId } }}
            approval={approval} sessionId="session-1" canApprove chrome="inline"
        />, createApprovalTestSource());
        expect(screen.findByTestId('approval-prompt-card')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Update this lead’s stage?');
        expect(screen.findByTestId('approval-prompt-approve')).toBeTruthy();
        expect(screen.findByTestId('approval-prompt-reject')).toBeTruthy();
    });

    function declinedSignIn(status: 'rejected' | 'canceled'): ApprovalRequest {
        return ApprovalRequestSchema.parse({
            v: 1, status, createdAtMs: 1, updatedAtMs: 2,
            createdBy: { surface: 'agent', sessionId: 'session-1' }, requestedSurface: 'agent',
            actionId: 'mcp.servers.signIn.start',
            actionArgs: { serverId: 'server-1', client: { clientId: 'design-reference-public' } },
            summary: 'Sign in to MCP server.', preview: { summary: 'Sign in to MCP server.' },
            ...(status === 'rejected' ? { decision: { kind: 'reject', decidedAtMs: 2 } } : {}),
        });
    }

    it.each(['rejected', 'canceled'] as const)('reads a %s request as what was asked and that it was declined, with no decision to make', async (status) => {
        const approval = declinedSignIn(status);
        expect(TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS.some(presents => presents(approval.origin ? approval : { ...approval, origin: { kind: 'transcript_tool_call', sessionId: 'session-1', toolCallId: 'call-1', toolName: 'x' } } as ApprovalRequest))).toBe(true);
        const screen = await renderCard(approval, { chrome: 'inline' });
        expect(screen.findByTestId('approval-prompt-approve')).toBeNull();
        expect(screen.findByTestId('approval-prompt-reject')).toBeNull();
        expect(screen.findByTestId('approval-prompt-declined')).toBeTruthy();
        const text = screen.getTextContent();
        // Its real disposition, and the request's own review fields.
        expect(text).toContain(`approvals.status.${status}`);
        expect(text).toContain('design-reference-public');
        // The title says the action once; the preview that only repeats it is not a second line.
        expect(text.match(/Sign in to MCP server/g)).toHaveLength(1);
    });

    it('keeps a declined call\'s raw output reachable behind Technical details, never beside the review', async () => {
        const output = '{"status":"failed","code":"approval_rejected"}';
        const screen = await renderCard(declinedSignIn('rejected'), { chrome: 'inline', toolOutput: output });
        expect(screen.getTextContent()).not.toContain('approval_rejected');
        const node = screen.findAllByTestId('approvals.technical-details').find(candidate => typeof candidate.props.onExpandedChange === 'function');
        await act(async () => { node?.props.onExpandedChange(true); });
        expect(screen.getTextContent()).toContain('approval_rejected');
        // An open request has no declined output to keep.
        const open = await renderCard({ ...declinedSignIn('rejected'), status: 'open', decision: undefined } as ApprovalRequest, { chrome: 'inline', toolOutput: output });
        expect(open.getTextContent()).not.toContain('approval_rejected');
    });

    function failedWriteFile(): ApprovalRequest {
        return ApprovalRequestSchema.parse({
            v: 1,
            status: 'executed',
            createdAtMs: 1,
            updatedAtMs: 2,
            createdBy: { surface: 'agent', sessionId: 'session-1' },
            requestedSurface: 'agent',
            actionId: 'daemon.filesystem.writeFile',
            actionArgs: { rootPath: '/home/happier/mqa2-c14-clone', path: '.', content: 'C24_FAIL' },
            summary: 'Write . in mqa2-c14-clone.',
            preview: { summary: 'Write . in mqa2-c14-clone.' },
            decision: { kind: 'approve', decidedAtMs: 2 },
            execution: {
                executedAtMs: 3,
                ok: true,
                result: { success: false, error: "EISDIR: illegal operation on a directory, open '/home/happier/mqa2-c14-clone'" },
            },
        });
    }

    it('reads a persisted filesystem effect refusal as a plain outcome with the raw error behind Details', async () => {
        const approval = failedWriteFile();
        expect(TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS.some(presents => presents(approval))).toBe(false);
        const screen = await renderCard(approval, { chrome: 'inline' });
        expect(screen.findByTestId('approval-prompt-approve')).toBeNull();
        const text = screen.getTextContent();
        expect(text).toContain('approvals.failureFileWrite');
        // The effect summary reads once, as the subtitle.
        expect(text.match(/Write \. in mqa2-c14-clone\./g)).toHaveLength(1);
        // The executor's own words and its code wait in Details, collapsed.
        expect(text).not.toContain('EISDIR');
        expect(text).not.toContain('filesystem_operation_failed');
        const expand = async (testID: string) => {
            const node = screen.findAllByTestId(testID).find(candidate => typeof candidate.props.onExpandedChange === 'function');
            await act(async () => { node?.props.onExpandedChange(true); });
        };
        await expand('approvals.details-disclosure');
        await expand('approvals.technical-details');
        expect(screen.getTextContent()).toContain('EISDIR: illegal operation on a directory');
        expect(screen.getTextContent()).toContain('filesystem_operation_failed');
    });

    function executedConfidentialFill(result: unknown, submit?: Readonly<{ label: string; consequence: string }>): ApprovalRequest {
        const submitControl = submit ? { controlId: 'control-submit', locator: '#submit', ...submit } : undefined;
        return ApprovalRequestSchema.parse({ v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 3,
            createdBy: { surface: 'agent', sessionId: 'session-1' }, requestedSurface: 'ui',
            actionId: 'browser.automation.secret.fill', summary: 'Sign in to App Store Connect',
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
                serverId: homeId, serverIdentityId: 'srv_stable-home-a', sessionId: 'session-1', machineId: 'machine-exact',
                target: { kind: 'session', sessionId: 'session-1' }, actionId: 'browser.automation.secret.fill', requestId: 'fill-1' },
            actionArgs: { serverId: homeId, sessionId: 'session-1', machineId: 'machine-exact', purpose: 'Sign in',
                browserSessionId: 'browser-1', viewId: 'view-1', tabId: 'tab-1', frameId: 'frame-1',
                documentId: 'document-1', navigationGeneration: 1, origin: 'https://appstoreconnect.apple.com',
                field: { fieldId: 'password', focusId: 'focus-1', locator: '#password' }, ...(submitControl ? { submit: submitControl } : {}) },
            decision: { kind: 'approve', decidedAtMs: 2 },
            execution: { executedAtMs: 3, ok: true, result },
        });
    }

    it('reads a settled confidential fill as what was entered and what is still held for the person (lab b-secret F)', async () => {
        const held = await renderCard(executedConfidentialFill({ status: 'filled', code: 'filled' },
            { label: 'Continue', consequence: 'submits' }), { chrome: 'inline' });
        expect(held.findByTestId('approval-prompt-approve')).toBeNull();
        const outcome = held.findByTestId('approval-prompt-confidential-outcome');
        expect(outcome).toBeTruthy();
        const text = held.getTextContent();
        expect(text).toContain('approvals.confidential.filled');
        expect(text).toContain('approvals.confidential.submitHeld');
    });

    it('reads a refused confidential fill as nothing entered, with no held submit', async () => {
        const refused = await renderCard(executedConfidentialFill({ status: 'refused', code: 'target_changed' }), { chrome: 'inline' });
        const refusedText = refused.getTextContent();
        expect(refusedText).toContain('approvals.confidential.targetChanged');
        expect(refusedText).toContain('approvals.confidential.nothingEntered');
        expect(refusedText).not.toContain('approvals.confidential.submitHeld');
    });

    it('says why a Service start failed and offers the same output disclosure as the Service row', async () => {
        const { DaemonLocalServiceLauncherStartResponseV1Schema } = await import('@happier-dev/protocol/local/services/launcher/v1');
        const result = DaemonLocalServiceLauncherStartResponseV1Schema.parse({
            protocolVersion: 1, machineId: 'machine', targetId: 'declared:lumen', status: 'failed',
            reasonCode: 'plugin_managed_service_establishment_failed',
            establishmentFailure: { cause: 'process_exited', exitCode: 1, lastStderrLine: 'Unable to bind listener' },
            snapshot: { v: 1, machineId: 'machine', updatedAt: 10, targets: [{
                id: 'declared:lumen', source: 'managed_service', machineId: 'machine', title: 'Lumen web',
                confidence: 'high', state: 'available', serviceState: 'failed', actions: ['manage'],
                sourceClass: { kind: 'managed_service', managedServiceId: 'lumen' },
                diagnostics: [{ code: 'native_service_output', severity: 'info', message: 'Unable to bind listener' }],
            }] },
        });
        const approval = ApprovalRequestSchema.parse({ ...failedWriteFile(),
            actionId: 'localServices.launcher.start', summary: 'Start Lumen web',
            actionArgs: { machineId: 'machine', targetId: 'declared:lumen',
                declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'Lumen web' } } },
            execution: { executedAtMs: 3, ok: true, result } });
        const screen = await renderCard(approval, { chrome: 'inline' });
        expect(screen.getTextContent()).toContain('localServices.actions.failure.namedStartFailed');
        expect(screen.findByTestId('approval-prompt-service-start-output-toggle')).toBeTruthy();
        // The output stays closed until asked for.
        expect(screen.getTextContent()).not.toContain('Unable to bind listener');
    });

    it('names the failed action for a failure with no typed copy', async () => {
        const approval = ApprovalRequestSchema.parse({ ...failedWriteFile(), status: 'failed', actionId: 'session.list', actionArgs: {},
            execution: { executedAtMs: 3, ok: false, errorCode: 'boom_happened', error: 'boom_happened' } });
        const screen = await renderCard(approval, { chrome: 'inline' });
        // A failure with no typed copy still names what failed, never the bare "approved action failed".
        expect(screen.getTextContent()).toContain('approvals.failureNamed');
        expect(screen.getTextContent()).not.toContain('approvals.failureGeneric');
    });

    it('says the failed action once: a summary that only repeats its title is not a second line', async () => {
        const { resolveApprovalActionTitle } = await import('./approvalFailureOutcome');
        const base = ApprovalRequestSchema.parse({ ...failedWriteFile(), status: 'failed', actionId: 'session.list', actionArgs: {},
            execution: { executedAtMs: 3, ok: false, errorCode: 'boom_happened', error: 'boom_happened' } });
        const title = resolveApprovalActionTitle(base);
        const screen = await renderCard({ ...base, summary: `${title}.`, preview: { summary: `${title}.` } } as ApprovalRequest, { chrome: 'inline' });
        // The headline already names the action; no subtitle repeats it, with or without its full stop.
        expect(screen.getTextContent()).not.toContain(title);
    });

    it('heads a stale failure as not run, not as the action it never attempted', async () => {
        const approval = ApprovalRequestSchema.parse({ ...failedWriteFile(), status: 'failed',
            execution: { executedAtMs: 3, ok: false, errorCode: 'approval_stale', error: 'approval_stale' } });
        const screen = await renderCard(approval, { chrome: 'inline' });
        const text = screen.getTextContent();
        expect(text).toContain('approvals.failureNotRun');
        expect(text).not.toContain('approvals.failureFileWrite');
        expect(text).toContain('approvals.staleFailure');
    });

    it('heads a non-stale pre-effect failure as not run', async () => {
        const base = localUiApprovalRequest();
        const approval = ApprovalRequestSchema.parse({
            ...base,
            status: 'failed',
            updatedAtMs: 3,
            actionId: 'daemon.filesystem.writeFile',
            actionArgs: { rootPath: '/workspace', path: 'notes.txt', content: 'hello' },
            summary: 'Write notes.txt',
            executionOriginV1: { ...base.executionOriginV1, actionId: 'daemon.filesystem.writeFile' },
            decision: { kind: 'approve', decidedAtMs: 2 },
            execution: {
                executedAtMs: 3,
                effectAttempted: false,
                ok: false,
                errorCode: 'approval_context_unavailable',
                error: 'approval_context_unavailable',
            },
        });
        const screen = await renderCard(approval, { chrome: 'inline' });
        const text = screen.getTextContent();
        expect(text).toContain('approvals.failureNotRun');
        expect(text).not.toContain('approvals.failureFileWrite');
    });

    it('dismisses a settled failure on this device only, and keeps open approvals undismissable', async () => {
        storage.setState({ profileScope: { serverId: homeId, accountId: 'account-1' } });
        const screen = await renderCard(failedWriteFile(), { chrome: 'inline' });
        await screen.pressByTestIdAsync('approval-prompt-dismiss');
        const { failedApprovalDismissalsState, failedApprovalDismissalScopeKey } = await import('@/sync/domains/state/failedApprovalUiState');
        expect(failedApprovalDismissalsState.read(failedApprovalDismissalScopeKey(storage.getState().profileScope!))?.['approval-1'])
            .toEqual(expect.any(Number));
        expect(readApproval().status).toBe('executed');
        const open = await renderCard(approvalRequest(), { chrome: 'inline' });
        expect(open.findByTestId('approval-prompt-dismiss')).toBeNull();
    });

    it.each(['owner', 'view', 'notGranted', 'readOnly', 'public'] as const)('preserves artifact decision authority on an inactive %s transcript', async access => {
        const approval = localUiApprovalRequest();
        await seedApproval(approval);
        const interaction = deriveReadOnlyTranscriptInteraction(access === 'public' ? deriveTranscriptInteraction({ kind: 'public' }) : deriveTranscriptInteractionFromSession({
            active: false, access: createSessionAccessFixture(access === 'view' ? 'view' : access === 'notGranted' ? 'edit' : 'owner',
                { approveRuntimePermissions: access === 'owner' || access === 'readOnly' }),
        }), access === 'readOnly');
        const source = { ...createApprovalTestSource(), useInteraction: () => interaction };
        const screen = await renderWithSessionTranscriptSource(<ApprovalPromptCard
            artifact={approvalArtifact(homeId)} approval={approval} sessionId="session-1"
            canApprovePermissions={interaction.canApprovePermissions} disabledReason={interaction.permissionDisabledReason}
        />, source);
        expect(screen.findByTestId('approval-prompt-card')).toBeTruthy();
        const approve = screen.findByTestId('approval-prompt-approve');
        if (access === 'owner') {
            expect(approve).toBeTruthy();
            await screen.pressByTestIdAsync('approval-prompt-approve');
            await expectDecision('approve');
        } else {
            expect(approve).toBeNull();
            expect(readApproval().status).toBe('open');
        }
    });

    it('reads an agent\'s Discussion draft in a Session as the answer it would post, with Post and Decline', async () => {
        const { createWorkflowPublicationApprovalArtifact } = await import('@/dev/testkit/fixtures/workflowPublicationApprovalFixture');
        const approval = ApprovalRequestSchema.parse(JSON.parse(createWorkflowPublicationApprovalArtifact({
            id: 'approval-1', runId: 'run-1', scope: { serverId: homeId, accountId: 'account-1' },
        }).body));
        const screen = await renderCard(approval, { chrome: 'inline' });
        // The same presentation the Discussion's own waiting card draws: the answer, who sees it, then the decision.
        expect(screen.findByTestId('approval-prompt-discussion-draft')).toBeTruthy();
        const text = screen.getTextContent();
        expect(text).toContain('session.collaboration.discussion.draftReview.onlyYou');
        expect(text).toContain('session.collaboration.discussion.draftReview.post');
        expect(text).toContain('session.collaboration.discussion.draftReview.decline');
        // The Action's operands wait behind Details instead of leading the card.
        expect(text).not.toContain('Durable message identity');
    });

    it('reads a summary that only repeats the Action title once', async () => {
        const repeated = await renderCard({ ...approvalRequest(), actionId: 'browser.view.open', actionArgs: {}, summary: 'Open browser view', preview: undefined });
        expect(repeated.getTextContent().match(/browser\.view\.open|Open browser view/g)).toHaveLength(1);
        // A summary that adds only a full stop or another case is the same words.
        const stopped = await renderCard({ ...approvalRequest(), actionId: 'browser.view.open', actionArgs: {}, summary: 'Open browser view.', preview: undefined });
        expect(stopped.getTextContent().match(/browser\.view\.open|Open browser view/g)).toHaveLength(1);
    });

    it('names a declared Session reference on the same Home used by the approval decision', async () => {
        const fixture = createSessionFixture();
        if (!fixture.metadata) throw new Error('Missing Session metadata fixture');
        storage.getState().applySessions([createSessionFixture({
            id: 'session-1', serverId: homeId,
            metadata: { ...fixture.metadata, name: 'Release captain' },
        })]);
        const screen = await renderCard({ ...approvalRequest(), actionId: 'session.turn.cancel',
            actionArgs: { sessionId: 'session-1' } });
        expect(screen.getTextContent()).toContain('Release captain');
        expect(screen.getTextContent()).not.toContain('session-1');
    });

    it('shows an Agent instructions edit as its proposed document diff, not raw Action fields', async () => {
        const screen = await renderCard({ ...approvalRequest(), actionId: 'prompt_doc.update', summary: 'Update its instructions',
            actionArgs: { artifactId: 'instructions-doc', title: 'Release captain', markdown: 'Check prerelease versions first.' } });
        expect(screen.findByTestId('approval-prompt-prompt-doc-diff')).toBeTruthy();
        expect(screen.getTextContent()).toContain('sessionInstructions.nextBoundary');
    });

    describe('an Agent instructions edit that has settled', () => {
        const proposed = { actionId: 'prompt_doc.update', summary: 'Update its instructions',
            actionArgs: { artifactId: 'instructions-doc', title: 'Release captain', markdown: 'Check prerelease versions first.',
                expectedRevision: { headerVersion: 1, bodyVersion: 1 } } };
        const settledText = async (patch: Record<string, unknown>) => {
            const screen = await renderCard(ApprovalRequestSchema.parse({ ...approvalRequest(), ...proposed, ...patch }), { chrome: 'inline' });
            return screen.getTextContent();
        };

        it('says the previous instructions were kept when it was denied or canceled, with no promise to apply', async () => {
            for (const status of ['rejected', 'canceled'] as const) {
                const text = await settledText(status === 'rejected' ? { status, decision: { kind: 'reject', decidedAtMs: 2 } } : { status });
                expect(text).toContain('sessionInstructions.saveDenied');
                expect(text).not.toContain('sessionInstructions.nextBoundary');
            }
        });

        it('says a denied edit\'s outcome once: the kept instructions, not a second generic Rejected line', async () => {
            const screen = await renderCard(ApprovalRequestSchema.parse({ ...approvalRequest(), ...proposed,
                status: 'rejected', decision: { kind: 'reject', decidedAtMs: 2 } }), { chrome: 'inline' });
            expect(screen.getTextContent()).toContain('sessionInstructions.saveDenied');
            expect(screen.findAllByTestId('approval-prompt-declined')).toHaveLength(0);
        });

        it('says it updated, and when it applies, once the write executed', async () => {
            const text = await settledText({ status: 'executed', decision: { kind: 'approve', decidedAtMs: 2 },
                execution: { executedAtMs: 3, ok: true } });
            expect(text).toContain('sessionInstructions.updated');
            expect(text).toContain('sessionInstructions.nextBoundary');
            expect(text).not.toContain('sessionInstructions.saveConflict');
        });

        it('reports a revision mismatch as the conflict it is, and still-pending as waiting', async () => {
            expect(await settledText({ status: 'failed', decision: { kind: 'approve', decidedAtMs: 2 },
                execution: { executedAtMs: 3, ok: false, errorCode: 'version_mismatch', error: 'version_mismatch' } }))
                .toContain('sessionInstructions.saveConflict');
            const pending = await settledText({});
            expect(pending).toContain('sessionInstructions.nextBoundary');
            expect(pending).not.toContain('sessionInstructions.updated');
            expect(pending).not.toContain('sessionInstructions.saveDenied');
        });
    });

    it('keeps the failure code behind Technical details when a specialized body replaces the Details card', async () => {
        const failed = ApprovalRequestSchema.parse({ ...approvalRequest(), status: 'failed', actionId: 'prompt_doc.update', summary: 'Update its instructions',
            actionArgs: { artifactId: 'instructions-doc', title: 'Release captain', markdown: 'Check prerelease versions first.' },
            decision: { kind: 'approve', decidedAtMs: 2 },
            execution: { executedAtMs: 3, ok: false, errorCode: 'prompt_doc_unavailable', error: 'prompt_doc_unavailable' } });
        const screen = await renderCard(failed, { chrome: 'inline' });
        // The specialized body is shown in place of the generic fields card.
        expect(screen.findByTestId('approval-prompt-prompt-doc-diff')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('prompt_doc_unavailable');
        const disclosure = screen.findAllByTestId('approvals.technical-details').find(node => typeof node.props.onExpandedChange === 'function');
        expect(disclosure).toBeTruthy();
        await act(async () => { disclosure?.props.onExpandedChange(true); });
        expect(screen.getTextContent()).toContain('prompt_doc_unavailable');
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
        const screen = await renderCard(await invitationApprovalRequest());
        expect(screen.getTextContent()).toContain('Acme Platform');
        expect(screen.getTextContent()).toContain('a•••@example.com');
        expect(screen.getTextContent()).not.toContain(bearer);
        expect(screen.findByTestId('approval-prompt-approve')?.props.disabled).toBe(false);
    });

    it('withholds approval when required invitation context is unavailable while preserving rejection', async () => {
        const screen = await renderCard(await invitationApprovalRequest(false));
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
        home.answer(homeId, '/v1/actions/approval.request.decide', { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.target).toEqual({ kind: 'machine', machineId: 'machine-exact' });
            expect(envelope.input).toEqual({ artifactId: 'approval-1', decision: 'approve',
                serverIdentityId: 'srv_stable-home-a', originServerId: 'local-A' });
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'approval.request.decide',
                requestId: envelope.requestId, execution: { ok: true, result: { status: 'executed' } } }) };
        } });
        const screen = await renderCard(daemonApprovalRequest());
        await screen.pressByTestIdAsync('approval-prompt-approve');
        await vi.waitFor(() => expect(home.requestsFor('/v1/actions/approval.request.decide')).toHaveLength(1));
        expect(home.requestsFor('/v1/actions/approval.request.decide')[0]?.serverId).toBe(homeId);
        expect(daemonRpc).not.toHaveBeenCalled();
        expect(readApproval()).toMatchObject({ status: 'approved', decision: { kind: 'approve' } });
        expect(home.artifacts(headerHomeId).list()).toEqual([]);
    });

    it('does not locally replay a V2 approval when the exact daemon reports approval_stale', async () => {
        home.answer(homeId, '/v1/actions/approval.request.decide', { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.target).toEqual({ kind: 'machine', machineId: 'machine-exact' });
            expect(envelope.input).toEqual({ artifactId: 'approval-1', decision: 'approve',
                serverIdentityId: 'srv_stable-home-a', originServerId: 'local-A' });
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'approval.request.decide',
                requestId: envelope.requestId, execution: { ok: false, errorCode: 'approval_stale', error: 'approval_stale' } }) };
        } });
        const screen = await renderCard(daemonApprovalRequest());
        await screen.pressByTestIdAsync('approval-prompt-approve');
        await vi.waitFor(() => expect(home.requestsFor('/v1/actions/approval.request.decide')).toHaveLength(1));
        expect(home.requestsFor('/v1/actions/approval.request.decide')[0]?.serverId).toBe(homeId);
        expect(daemonRpc).not.toHaveBeenCalled();
        expect(home.requests.filter(request => request.path.includes('/sessions/'))).toEqual([]);
        const { Modal } = await import('@/modal');
        await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalledWith('common.error', 'approvals.staleFailure'));
    });

    it('settles a recorded stale decision on the card itself, with no modal repeating it', async () => {
        // Owner ruling C3: the decision was saved and its effect refused as stale, so the card reads
        // "Request not run" from the settled record; a dialog saying the same thing is a second message.
        home.answer(homeId, '/v1/actions/approval.request.decide', { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'approval.request.decide',
                requestId: envelope.requestId, execution: { ok: true, result: { status: 'failed',
                    execution: { executedAtMs: 3, ok: false, errorCode: 'approval_stale', error: 'approval_stale' } } } }) };
        } });
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockClear();
        const screen = await renderCard(daemonApprovalRequest());
        await screen.pressByTestIdAsync('approval-prompt-approve');
        await vi.waitFor(() => expect(home.requestsFor('/v1/actions/approval.request.decide')).toHaveLength(1));
        await vi.waitFor(() => expect(screen.findByTestId('approval-prompt-approve')).toBeFalsy());
        expect(Modal.alert).not.toHaveBeenCalled();
    });

    it('says on the card that a request whose stored input no longer fits its Action cannot run, and keeps Deny', async () => {
        // Owner ruling C3: the canonical executor resolver already knows this request can never run
        // (`invalid_input`), so the card says so in place; Approve is withheld and no modal appears.
        const request = daemonApprovalRequest();
        const unrunnable = withApiAdmission({ ...request, actionArgs: { sessionId: 'session-1', retiredOption: true } });
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockClear();
        const screen = await renderCard(unrunnable);
        expect(screen.findByTestId('approval-prompt-cannot-run')).toBeTruthy();
        expect(screen.findByTestId('approval-prompt-approve')?.props).toMatchObject({
            disabled: true, accessibilityHint: 'approvals.cannotRun',
        });
        await screen.pressByTestIdAsync('approval-prompt-approve');
        expect(Modal.alert).not.toHaveBeenCalled();
        expect(readApproval().status).toBe('open');
        await screen.pressByTestIdAsync('approval-prompt-reject');
        await expectDecision('reject');
        expect(readApproval().status).toBe('rejected');
        expect(Modal.alert).not.toHaveBeenCalled();
    });

    it('fails closed on an API approval whose daemon placement is missing, and says so on the card', async () => {
        // Owner ruling C3: no Machine is recorded to run it, so the card says so in place and keeps Deny; no modal.
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockClear();
        const screen = await renderCard(unplacedApiApprovalRequest());
        expect(screen.findByTestId('approval-prompt-cannot-run')).toBeTruthy();
        expect(screen.getTextContent()).toContain('approvals.cannotRunNoMachine');
        expect(screen.findByTestId('approval-prompt-approve')?.props).toMatchObject({
            disabled: true, accessibilityHint: 'approvals.cannotRunNoMachine',
        });
        await screen.pressByTestIdAsync('approval-prompt-approve');
        expect(daemonRpc).not.toHaveBeenCalled();
        expect(Modal.alert).not.toHaveBeenCalled();
        expect(readApproval().status).toBe('open');
        expect(screen.findByTestId('approval-prompt-reject')?.props.disabled).toBe(false);
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
