import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';
import type { DiscussionComposerValue } from '@/components/discussions/DiscussionComposer';
import { answerDiscussionThreadForTests, createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createExistingSessionDirectoryPreflightResult, createSessionFixture, createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { DiscussionInviteRequestV1Schema, DiscussionParticipantPolicySetRequestV1Schema, DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { DiscussionMessageV1Schema, DiscussionSummaryV1Schema } from '@happier-dev/protocol/discussions/models';
import { DiscussionModelParticipantLaunchV1Schema, projectDiscussionModelParticipantLaunchV1 } from '@happier-dev/protocol/discussions/modelParticipantLaunch';
import { bindDiscussionActionHttpRequestV1 } from '@happier-dev/protocol/actions/discussionActionFamily';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { ProfileRecordV1Schema, ProfileRowsListResponseV1Schema, PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1, ProfileTransferRowReadResponseV1Schema } from '@happier-dev/protocol/profiles/profileTransferV1';
import { SessionSpawnNewResultV1Schema, type SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { admitSessionSpawnNewActionInputV2, projectSessionSpawnNewActionInputV2, SessionSpawnNewActionInputV2Schema, SessionSpawnNewInputV2Schema, type SessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { DiscussionCreateRequestV1Schema } from '@happier-dev/protocol/discussions/api';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { encodeBase64 } from '@/encryption/base64';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { deriveDocCommentDiscussionCreationLocalIdV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';

installAgentInputCommonModuleMocks({ modal: async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module });

// The person accepts the real Action policy's UI confirmation at the presentation boundary.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
// Genuine third-party renderer boundary, shared with the repository lifecycle
// and Workflow-row suites. This data-owner composition never renders Markdown.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: (text: string) => [{ text, reveal: false }],
}));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let spawnServerId = '';
let spawnResultOverride: SessionSpawnNewResultV1 | null = null;
let spawnResponseGate: Promise<void> | null = null;
let onSpawnRequest: (() => void) | null = null;
const spawnRequests: SessionSpawnNewActionInputV2[] = [];
const spawnParseIssues: unknown[] = [];
let stopAnswer: ((request: SocketRpcRequestPayload) => unknown) | null = null;
const stopRequests: SocketRpcRequestPayload[] = [];
// Own-Machine spawn, directory preflight and ordinary Stop use native RPC.
installDisconnectedServerSocketBoundary(socket => {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, request: SocketRpcRequestPayload) => {
        if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
        if (request.method === `machine-a:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`) {
            return { ok: true, result: createExistingSessionDirectoryPreflightResult(request.params) };
        }
        if (request.method === `machine-a:${RPC_METHODS.SESSION_SPAWN_NEW}`) {
            return { ok: true, result: await answerModelSpawn(projectSessionSpawnNewActionInputV2(
                SessionSpawnNewInputV2Schema.parse(request.params))) };
        }
        if (stopAnswer && (request.method === `machine-a:${RPC_METHODS.STOP_SESSION}` || request.method.endsWith(':killSession'))) {
            stopRequests.push(request);
            return { ok: true, result: await stopAnswer(request) };
        }
        throw new Error(`Unexpected daemon request: ${request.method}`);
    });
});

async function answerModelSpawn(input: unknown): Promise<SessionSpawnNewResultV1> {
    const parsed = SessionSpawnNewActionInputV2Schema.safeParse(input);
    if (!parsed.success) {
        spawnParseIssues.push(...parsed.error.issues);
        return { type: 'error', code: 'invalid_input', retryable: false };
    }
    spawnRequests.push(parsed.data);
    onSpawnRequest?.();
    await spawnResponseGate;
    return spawnResultOverride ?? SessionSpawnNewResultV1Schema.parse({
        type: 'success', disposition: 'created', sessionId: 'owned-model-session',
        executionTarget: { serverId: spawnServerId, machineId: 'machine-a' },
        organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' },
    });
}

const { getStorage } = await import('@/sync/domains/state/storage');
const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
const { createDiscussionClient } = await import('./discussionActions');
const { createDiscussionRepository } = await import('@/sync/ops/discussions/discussionRepository');
const { buildExecutableModelParticipantSelectionFromAuthoringDraft, buildExecutableParticipantPickerOption } = await import('@/components/sessions/authoring/executableParticipantPicker');
const { buildNewSessionAuthoringDraftFromTempData } = await import('@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters');
const initial = getStorage().getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeEach(async () => { await homes.reset(); spawnRequests.length = 0; spawnParseIssues.length = 0; spawnResultOverride = null;
    spawnResponseGate = null; onSpawnRequest = null;
    stopAnswer = null; stopRequests.length = 0; });
afterEach(async () => {
    await connection?.dispose();
    connection = undefined;
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    // An HTTP 503 answer marks the Home offline in its supervisors; that must not outlive its test.
    const { resetEndpointSupervisorPoolForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
    const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    await resetEndpointSupervisorPoolForTests();
    await resetServerReachabilitySupervisors();
    getStorage().setState(initial, true);
    standardCleanup();
    const { resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const { clearDiscussionRepositoryRegistryForTests } = await import('@/sync/ops/discussions/discussionRepositoryRegistry');
    resetSessionDraftRepositoryForTests();
    clearDiscussionRepositoryRegistryForTests();
});

function answerDiscussionRead(serverId: string) {
    const message = DiscussionMessageV1Schema.parse({ id: 'first-message', discussionId: 'discussion-a', localId: 'first-local',
        seq: 1, authorAccountId: 'alice', accountActor: { v: 1, accountId: 'alice', profile: null }, producerV1: null,
        content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Please review.' }] } }, mentionedAccountIds: [], createdAt: 1 });
    const { discussionId: _discussionId, content: _content, mentionedAccountIds: _mentions, ...latestMessage } = message;
    homes.answer(serverId, '/v1/discussions/discussion-a', { body: { discussion: DiscussionSummaryV1Schema.parse({
        id: 'discussion-a', ownerAccountId: 'alice', encryptionMode: 'plain', anchor: null, access: 'owner',
        keyReadiness: true, dataEncryptionKey: null, creationLocalId: 'discussion-create-a',
        titleContent: { t: 'plain', v: { v: 1, title: 'Review' } }, latestMessage,
        messageSeq: 1, lastReadSeq: 1, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: ['alice'], archivedAt: null,
        capabilities: { postMessages: true, rename: true, archive: true, restore: false,
            askAgent: true, sendToSession: true, manageAccess: true, leave: false },
    }) } });
    homes.answer(serverId, '/v1/discussions/discussion-a/messages', { body: {
        messages: [message], hasMoreOlder: false, messageSeq: 1,
    } });
}

it('retains resolved initial Session invitations and the original E2EE key after a lost create response', async () => {
    const secret = new Uint8Array(32).fill(17);
    const credentials = { token: createAccountTokenForTests('alice', { currentAccount: true }), secret: encodeBase64(secret, 'base64url') };
    const serverId = await homes.addHome({ name: 'Encrypted review', serverUrl: 'https://encrypted-review.test', accountId: 'alice',
        currentAccount: true, accountEncryptionMode: 'e2ee', credentials });
    const contentKeyFingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint);
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: { mode: 'e2ee', version: 1,
        signingKeyFingerprint: 'a'.repeat(64), contentKeyFingerprint, updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } } });
    const transport = answerDiscussionThreadForTests(homes, serverId, { accountId: 'alice', mode: 'e2ee', loseCreate: true, loseFirstRejoin: false });
    let selected = 'chosen-at-submit';
    homes.answer(serverId, '/v1/discussions/source/participants', { select: () => ({ body: {
        discussionId: 'source', ownerAccountId: 'alice', access: 'owner', grants: [],
        participants: [{ participant: { kind: 'session', sessionId: selected }, answerPolicy: 'when_addressed', createdAt: 1 }],
    } }) });
    homes.answer(serverId, '/v1/discussions/committed-thread/data-key/recipients', { select: () => ({ body: {
        discussionId: 'committed-thread', ownerAccountId: 'alice', access: 'owner', encryptionMode: 'e2ee',
        dataEncryptionKey: transport.stored()?.discussion.dataEncryptionKey,
        callerDataEncryptionKey: transport.stored()?.discussion.dataEncryptionKey,
        recipients: [{ recipientAccountId: 'bob', contentKey: { status: 'unavailable', reason: 'plain_account' },
            contentPublicKeyFingerprint: null, encryptedDataKey: null, recipientContentPublicKeyFingerprint: null }],
    } }) });
    const scope = { serverId, accountId: 'alice' };
    const repository = createDiscussionRepository({ scope, address: { serverId }, client: createDiscussionClient({ scope, availability: 'available' }) });
    expect(await repository.create({ creationLocalId: 'create-selected', messageLocalId: 'first-selected', title: 'Review',
        content: { v: 1, parts: [{ t: 'text', text: 'Question' }] },
        participants: [{ kind: 'account', accountId: 'bob' }, { kind: 'session', sessionId: { selector: 'discussion', discussionId: 'source' } }],
        draftSubmission: { scope, address: { kind: 'newDiscussion' }, currentness: { address: { kind: 'newDiscussion' }, mutationIds: {} } },
    })).toMatchObject({ kind: 'checking' });
    await vi.waitFor(() => expect(repository.getSnapshot().mutations['create-selected']?.status).toBe('outcome_unknown'));
    selected = 'joined-later';
    const retried = await repository.retry('create-selected');
    const creates = homes.requestsFor('/v1/discussions').filter(request => request.input && typeof request.input === 'object'
        && 'firstMessage' in request.input).map(request => DiscussionCreateRequestV1Schema.parse(request.input));
    expect(creates).toHaveLength(2);
    expect(creates[1].participants).toEqual(creates[0].participants);
    expect(creates[1].dataEncryptionKey).toBe(creates[0].dataEncryptionKey);
    expect(creates[1].creationLocalId).toBe('create-selected');
    expect(creates[1].firstMessage.localId).toBe('first-selected');
    expect(homes.requestsFor('/v1/discussions/source/participants')).toHaveLength(1);
    expect(retried).toMatchObject({ kind: 'succeeded' });
});

it('does not resurrect a retired create intent when Session resolution finishes late', async () => {
    const serverId = await homes.addHome({ name: 'Review', serverUrl: 'https://review.test', accountId: 'alice', currentAccount: true });
    answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    homes.answer(serverId, '/v1/discussions/source/participants', { select: async () => {
        entered.resolve();
        await release.promise;
        return { body: { discussionId: 'source', ownerAccountId: 'alice', access: 'owner', grants: [],
            participants: [{ participant: { kind: 'session', sessionId: 'chosen' }, answerPolicy: 'when_addressed', createdAt: 1 }] } };
    } });
    const scope = { serverId, accountId: 'alice' };
    const repository = createDiscussionRepository({ scope, address: { serverId }, client: createDiscussionClient({ scope, availability: 'available' }) });
    const creating = repository.create({ creationLocalId: 'retired-create', messageLocalId: 'retired-first', title: 'Review',
        content: { v: 1, parts: [{ t: 'text', text: 'Question' }] },
        participants: [{ kind: 'session', sessionId: { selector: 'discussion', discussionId: 'source' } }],
        draftSubmission: { scope, address: { kind: 'newDiscussion' }, currentness: { address: { kind: 'newDiscussion' }, mutationIds: {} } },
    });
    await entered.promise;
    repository.clear();
    const retired = repository.getSnapshot();
    release.resolve();
    expect(await creating).toMatchObject({ kind: 'failed', errorCode: 'discussion_read_denied' });
    expect(repository.getSnapshot()).toBe(retired);
    expect(await repository.retry('retired-create')).toEqual({ kind: 'failed', errorCode: 'discussion_retry_not_found' });
});

it.each(['create', 'reconciliation'] as const)('retains unrelated Home state and create custody after a %s readiness refusal', async phase => {
    const secret = new Uint8Array(32).fill(17);
    const credentials = { token: createAccountTokenForTests('alice', { currentAccount: true }), secret: encodeBase64(secret, 'base64url') };
    const serverId = await homes.addHome({ name: 'Encrypted review', serverUrl: 'https://encrypted-review.test', accountId: 'alice',
        currentAccount: true, accountEncryptionMode: 'e2ee', credentials });
    const contentKeyFingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint);
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: { mode: 'e2ee', version: 1,
        signingKeyFingerprint: 'a'.repeat(64), contentKeyFingerprint, updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } } });
    answerDiscussionThreadForTests(homes, serverId, { accountId: 'alice', mode: 'e2ee', loseCreate: false, loseFirstRejoin: false });
    const scope = { serverId, accountId: 'alice' };
    const repository = createDiscussionRepository({ scope, address: { serverId }, client: createDiscussionClient({ scope, availability: 'available' }) });
    const draftSubmission = { scope, address: { kind: 'newDiscussion' as const },
        currentness: { address: { kind: 'newDiscussion' as const }, mutationIds: {} } };
    const input = { creationLocalId: 'unrelated-create', messageLocalId: 'unrelated-first', title: 'Keep this review',
        content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Unrelated retained question' }] }, draftSubmission };
    expect(await repository.create(input)).toMatchObject({ kind: 'succeeded' });
    await repository.refreshDiscussion('committed-thread');
    const unrelated = repository.getSnapshot().threads['committed-thread'];
    expect(unrelated?.messages).toHaveLength(1);
    // Real atomic server admission returns this refusal for an unprepared
    // foreign runtime. Only the native HTTP boundary is substituted here.
    if (phase === 'create') {
        homes.answer(serverId, 'POST /v1/discussions', { status: 409, body: { error: 'discussion_content_unavailable' } });
    } else {
        let dispatched = false;
        homes.answer(serverId, 'GET /v1/discussions', { select: () => dispatched
            ? { status: 409, body: { error: 'discussion_content_unavailable' } }
            : { body: { discussions: [], nextCursor: null } } });
        homes.answer(serverId, 'POST /v1/discussions', { select: () => {
            dispatched = true;
            return { dispatchThenFail: true };
        } });
    }
    const outcome = await repository.create({ ...input, creationLocalId: 'declined-create', messageLocalId: 'declined-first',
        participants: [{ kind: 'session', sessionId: 'foreign-runtime' }] });
    if (phase === 'create') expect(outcome).toEqual({ kind: 'failed', errorCode: 'discussion_content_unavailable' });
    else {
        expect(outcome).toEqual({ kind: 'checking' });
        await vi.waitFor(() => expect(repository.getSnapshot().mutations['declined-create']?.status).not.toBe('checking'));
    }
    expect(repository.getSnapshot().threads['committed-thread']).toBe(unrelated);
    expect(repository.getSnapshot().lists.active.items.map(row => row.id)).toContain('committed-thread');
    expect(repository.getSnapshot().mutations['declined-create']).toMatchObject({ status: phase === 'create' ? 'failed' : 'outcome_unknown',
        errorCode: phase === 'create' ? 'discussion_content_unavailable' : 'outcome_unknown', draftSubmission });
    expect(await repository.retry('declined-create')).toEqual({ kind: 'failed', errorCode: 'discussion_content_unavailable' });
    expect(repository.getSnapshot().threads['committed-thread']).toBe(unrelated);
});

it('keeps model Home admission at the canonical Action before any reservation HTTP request', async () => {
    const serverId = await homes.addHome({ name: 'Review', serverUrl: 'https://review.test', accountId: 'alice', currentAccount: true });
    const launch = { executionTarget: { serverId: 'foreign-home', machineId: 'foreign-machine' },
        directory: { kind: 'path' as const, path: '/workspace' },
        agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
    const client = createDiscussionClient({ scope: { serverId, accountId: 'alice' }, availability: 'available' });
    expect(await client.invite({ discussionId: 'discussion-a', participant: {
        kind: 'model', participantSlotId: 'retained-slot', launch,
    } })).toEqual({ kind: 'failed', errorCode: 'server_target_mismatch' });
    expect(await client.inviteExecutableParticipant({ discussionId: 'discussion-a',
        selection: { kind: 'model', launch }, participantSlotId: 'retained-slot',
    })).toEqual({ kind: 'failed', errorCode: 'server_target_mismatch' });
    expect(homes.requestsFor('/v1/discussions/discussion-a/participants/invite')).toHaveLength(0);
});

it.each(['first comment', 'reply'] as const)('admits the selected Session before a Doc %s through the real client and Action owner', async entry => {
    const serverId = await homes.addHome({ name: 'Doc reader', serverUrl: 'https://doc-reader.test', accountId: 'bob', currentAccount: true });
    const thread = answerDiscussionThreadForTests(homes, serverId, { accountId: 'bob', loseCreate: false, loseFirstRejoin: false });
    const client = createDiscussionClient({ scope: { serverId, accountId: 'bob' }, availability: 'available' });
    const passage = { ref: { kind: 'doc' as const, artifactId: 'alice-doc', serverId }, revision: { headerVersion: 1, bodyVersion: 1 },
        range: { start: 0, end: 5 }, quote: 'again' };
    const content = { v: 1 as const, parts: [{ t: 'mention' as const, participant: { kind: 'session' as const, sessionId: 'bob-session' } }] };
    const localId = 'doc-root';
    const created = await client.create({ creationLocalId: deriveDocCommentDiscussionCreationLocalIdV1({ ref: passage.ref, localId }),
        messageLocalId: localId, title: 'Document comments', content: { kind: 'doc_passage_comment', passage,
            content: entry === 'first comment' ? content : { v: 1, parts: [{ t: 'text', text: 'Review' }] } } });
    expect(created).toMatchObject({ kind: 'succeeded' });
    if (created.kind !== 'succeeded') throw new Error(JSON.stringify(created));
    const create = homes.requestsFor('/v1/discussions').map(row => row.input).find(input => !!input && typeof input === 'object' && 'firstMessage' in input);
    const admitted = new Set(DiscussionCreateRequestV1Schema.parse(create).participants?.flatMap(row => row.kind === 'session' ? [row.sessionId] : []));
    if (entry === 'first comment') expect(admitted.has('bob-session')).toBe(true);
    else expect(create).not.toHaveProperty('participants');
    const discussionId = created.value.discussion.id;
    homes.answer(serverId, `/v1/discussions/${discussionId}/participants`, { body: { discussionId, ownerAccountId: 'bob', access: 'owner',
        grants: [],
        participants: [...admitted].map(sessionId => ({ participant: { kind: 'session', sessionId }, answerPolicy: 'when_addressed', createdAt: 1 })) } });
    homes.answer(serverId, `POST /v1/discussions/${discussionId}/participants/invite`, { select: input => {
        const request = DiscussionInviteRequestV1Schema.parse(input);
        if (request.participant.kind !== 'session') throw new Error('A Session mention must not share the Doc with an Account');
        admitted.add(request.participant.sessionId);
        return { body: { discussionId, ownerAccountId: 'bob', access: 'owner', grants: [], changed: true } };
    } });
    if (entry === 'reply') {
        const posted = await client.post({ discussionId, localId: 'doc-reply', content,
            replyTarget: { kind: 'message', messageId: created.value.firstMessage.id } });
        expect(posted).toMatchObject({ kind: 'succeeded' });
        expect(admitted.has('bob-session')).toBe(true);
        expect(thread.messages.at(-1)?.content).toEqual({ t: 'plain', v: content });
    }
    const proposal = await client.post({ discussionId, localId: 'doc-proposal', content: { kind: 'doc_edit_proposal', proposal: {
        target: passage, baseRevision: passage.revision, before: passage.quote, after: 'again, clearly', reason: 'Clarify' } } });
    expect(proposal).toMatchObject({ kind: 'succeeded', value: { message: { docEditProposalDispositionV1: { state: 'open' } } } });
});

it('retains a Session-addressed draft when its explicit invitation is refused', async () => {
    const serverId = await homes.addHome({ name: 'Review', serverUrl: 'https://mention-refused.test', accountId: 'alice', currentAccount: true });
    const thread = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
    const client = createDiscussionClient({ scope: { serverId, accountId: 'alice' }, availability: 'available' });
    const passage = { ref: { kind: 'doc' as const, artifactId: 'doc', serverId }, revision: { headerVersion: 1, bodyVersion: 1 },
        range: { start: 0, end: 5 }, quote: 'again' };
    const created = await client.create({ messageLocalId: 'root', creationLocalId: deriveDocCommentDiscussionCreationLocalIdV1({ ref: passage.ref, localId: 'root' }),
        title: 'Review', content: { kind: 'doc_passage_comment', passage, content: { v: 1, parts: [{ t: 'text', text: 'Review' }] } } });
    if (created.kind !== 'succeeded') throw new Error(JSON.stringify(created));
    const discussionId = created.value.discussion.id;
    homes.answer(serverId, `/v1/discussions/${discussionId}/participants`, { body: { discussionId, ownerAccountId: 'alice', access: 'owner', grants: [], participants: [] } });
    homes.answer(serverId, `POST /v1/discussions/${discussionId}/participants/invite`, { status: 403, body: { error: 'discussion_subject_ineligible' } });
    expect(await client.post({ discussionId, localId: 'addressed', content: { v: 1, parts: [
        { t: 'mention', participant: { kind: 'session', sessionId: 'uninvitable' } },
    ] } })).toMatchObject({ kind: 'failed', errorCode: 'discussion_subject_ineligible' });
    expect(thread.messages).toHaveLength(1);
});

it('invites an executable Session choice through the real captured-Home Action and HTTP owner', async () => {
    const serverId = await homes.addHome({ name: 'Review', serverUrl: 'https://review.test', accountId: 'alice', currentAccount: true });
    const path = '/v1/discussions/discussion-a/participants/invite';
    answerDiscussionRead(serverId);
    homes.answer(serverId, `POST ${path}`, { body: {
        discussionId: 'discussion-a', ownerAccountId: 'alice', access: 'owner', grants: [], changed: true,
    } });
    const client = createDiscussionClient({ scope: { serverId, accountId: 'alice' }, availability: 'available' });
    const repository = createDiscussionRepository({ scope: { serverId, accountId: 'alice' }, address: { serverId }, client });
    const outcome = await repository.inviteExecutableParticipant({ discussionId: 'discussion-a',
        selection: { kind: 'bot', session: { serverId, sessionId: 'actual-bot-session' } } });
    expect(outcome).toMatchObject({ kind: 'succeeded', value: { discussionId: 'discussion-a' } });
    const requests = homes.requestsFor(path);
    expect(requests).toHaveLength(1);
    expect(DiscussionInviteRequestV1Schema.parse(requests[0]?.input)).toEqual({
        participant: { kind: 'session', sessionId: 'actual-bot-session' },
    });
    expect(repository.getSnapshot().threads['discussion-a']?.summary).toMatchObject({ id: 'discussion-a', title: 'Review' });
    homes.answer(serverId, `POST ${path}`, { dispatchThenFail: true });
    expect(await repository.inviteExecutableParticipant({ discussionId: 'discussion-a',
        selection: { kind: 'session', session: { serverId, sessionId: 'another-session' } },
    })).toEqual({ kind: 'failed', errorCode: 'outcome_unknown' });
});

it('changes answer policy through the captured-Home client, real Action executor and repository', async () => {
    const serverId = await homes.addHome({ name: 'Review', serverUrl: 'https://review.test', accountId: 'alice', currentAccount: true });
    const path = '/v1/discussions/discussion-a/participants/policy';
    answerDiscussionRead(serverId);
    homes.answer(serverId, `PUT ${path}`, { body: {
        discussionId: 'discussion-a', ownerAccountId: 'alice', access: 'owner', grants: [], changed: true,
    } });
    const client = createDiscussionClient({ scope: { serverId, accountId: 'alice' }, availability: 'available' });
    const repository = createDiscussionRepository({ scope: { serverId, accountId: 'alice' }, address: { serverId }, client });
    expect(await repository.setParticipantPolicy({ discussionId: 'discussion-a',
        participant: { kind: 'session', sessionId: 'agent-session' }, answerPolicy: 'reads_only' }))
        .toMatchObject({ kind: 'succeeded', value: { changed: true } });
    const requests = homes.requestsFor(path);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.serverId).toBe(serverId);
    expect(DiscussionParticipantPolicySetRequestV1Schema.parse(requests[0]?.input)).toEqual({
        participant: { kind: 'session', sessionId: 'agent-session' }, answerPolicy: 'reads_only',
    });
    expect(repository.getSnapshot().threads['discussion-a']?.summary).toMatchObject({ id: 'discussion-a', title: 'Review' });
});

it('reconciles an unknown model reservation with the retained explicit slot before acknowledging a started participant', async () => {
    const serverId = await homes.addHome({ name: 'Review', serverUrl: 'https://review.test', accountId: 'alice', currentAccount: true });
    const path = '/v1/discussions/discussion-a/participants/invite';
    const draft = buildNewSessionAuthoringDraftFromTempData({ prompt: 'Unsent picker draft', directory: '/workspace',
        executionTarget: { kind: 'machine', target: { serverId, machineId: 'unavailable-machine' } },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    });
    const beforePreview = homes.requests.length;
    const selection = buildExecutableModelParticipantSelectionFromAuthoringDraft({ draft, permissionMode: 'read-only', configurationUpdatedAtMs: 123 });
    const option = buildExecutableParticipantPickerOption({ selection, label: 'Review Agent', readiness: {
        configured: true, machine: { scope: { serverId, accountId: 'alice' }, selectedMachineId: 'unavailable-machine',
            machine: null, requireExactSpawnReadiness: true, rpcAvailable: false, keyAvailable: false },
        agent: null, selection: null, inventory: { status: 'ready', lastCheckedAt: 1 }, invocation: null, mayRepairAgent: false,
    } });
    expect(option).toMatchObject({ value: selection, readiness: { status: 'unknown' } });
    expect(homes.requests).toHaveLength(beforePreview);
    const launch = selection.launch;
    answerDiscussionRead(serverId);
    const reservation = {
        discussionId: 'discussion-a', ownerAccountId: 'alice', access: 'owner', grants: [], changed: true,
        modelParticipant: { participant: { kind: 'model', participantSlotId: 'retained-slot' }, launch,
            sessionId: null, answerPolicy: 'when_addressed', createdAt: 1 },
    };
    let loseReserveResponse = true;
    homes.answer(serverId, `POST ${path}`, { select: () => {
        if (loseReserveResponse) { loseReserveResponse = false; return { dispatchThenFail: true }; }
        return { body: reservation };
    } });
    const client = createDiscussionClient({ scope: { serverId, accountId: 'alice' }, availability: 'available' });
    const repository = createDiscussionRepository({ scope: { serverId, accountId: 'alice' }, address: { serverId }, client });
    for (let attempt = 0; attempt < 2; attempt++) {
        const outcome = await repository.inviteExecutableParticipant({ discussionId: 'discussion-a',
            selection: option?.value, participantSlotId: 'retained-slot' });
        expect(outcome).not.toBeNull();
        expect(outcome).not.toMatchObject({ kind: 'succeeded' });
        if (attempt === 0) expect(outcome).toEqual({ kind: 'checking' });
    }
    const requests = homes.requestsFor(path);
    expect(requests).toHaveLength(2);
    expect(requests.map(request => DiscussionInviteRequestV1Schema.parse(request.input)))
        .toEqual(Array.from({ length: 2 }, () => ({ participant: { kind: 'model', participantSlotId: 'retained-slot', launch } })));
});

it.each(['success', 'repeated', 'failed', 'pending', 'unknown', 'approval', 'removed', 'bound', 'edited', 'birth_edited', 'unmounted', 'disabled', 'unavailable', 'retired', 'context', 'superseded'] as const)(
    'offers a reserved model slot in the actual composer and starts it only on Send before posting a real Session mention (%s)', async scenario => {
    await loadSyncSingletonForTests();
    const serverUrl = 'https://model-mention.test';
    const serverId = await homes.addHome({ name: 'Model mention', serverUrl, serverIdentityId: 'srv_model_mention', accountId: 'alice', currentAccount: true });
    const token = homes.findByServerUrl(serverUrl)?.token;
    if (!token) throw new Error('Missing fixture Account token');
    connection = await restoreServerAccountForTest({ serverUrl, serverIdentityId: 'srv_model_mention', accountId: 'alice', credentials: { token },
        request: createSessionReadBatchFetchBoundary(homes.request) });
    spawnServerId = serverId;
    const machineRow = createPlainMachineRowFixture({ id: 'machine-a', accountId: 'alice' });
    const machine = createMachineFixture({ id: 'machine-a', activeAt: machineRow.activeAt,
        storageMode: 'plain', dataEncryptionKey: machineRow.dataEncryptionKey, access: machineRow.access });
    getStorage().setState({ machines: { [machine.id]: machine } });
    await publishMachineInventoryForTest({ serverId, accountId: 'alice' }, [machine]);
    homes.answer(serverId, '/v1/machines', { body: { machines: [machineRow] } });
    homes.answer(serverId, '/v1/machines/machine-a', { body: { machine: machineRow } });
    homes.answer(serverId, '/v1/machines/machine-a/access', { body: MachineAccessGrantsListResponseV1Schema.parse({
        machineId: machineRow.id, custodian: machineRow.access!.custodian, access: machineRow.access,
        canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
    }) });
    const scope = { serverId, accountId: 'alice' };
    const thread = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
    const client = createDiscussionClient({ scope, availability: 'available' });
    const created = await client.create({ creationLocalId: 'mention-discussion', messageLocalId: 'mention-first',
        title: 'Model review', content: { v: 1, parts: [{ t: 'text', text: 'Review' }] } });
    if (created.kind !== 'succeeded') throw new Error(JSON.stringify(created));
    const discussionId = created.value.discussion.id;
    const path = `/v1/discussions/${discussionId}`;
    const launch = DiscussionModelParticipantLaunchV1Schema.parse({ executionTarget: { serverId, machineId: 'machine-a' },
        directory: { kind: 'path', path: '/workspace' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        configuration: { mode: { value: null, updatedAtMs: 1 }, model: { value: 'gpt-6-luna', updatedAtMs: 1 },
            permissionIntent: { value: 'read-only', updatedAtMs: 1 }, options: {} } });
    const model = { participant: { kind: 'model' as const, participantSlotId: 'saved-mention-slot' }, launch,
        sessionId: null, answerPolicy: 'reads_only' as const, createdAt: 1 };
    const roster = DiscussionParticipantsListResponseV1Schema.parse({ discussionId, ownerAccountId: 'alice', access: 'owner', grants: [], participants: [model] });
    let currentPolicy: (typeof roster.participants)[number]['answerPolicy'] = model.answerPolicy;
    let loseInvite = false;
    homes.answer(serverId, `${path}/participants`, { body: roster });
    homes.answer(serverId, `POST ${path}/participants/invite`, { select: input => {
        expect(DiscussionInviteRequestV1Schema.parse(input)).toEqual({ participant: { ...model.participant, launch }, answerPolicy: currentPolicy });
        if (loseInvite) { loseInvite = false; return { dispatchThenFail: true }; }
        return { body: { discussionId, ownerAccountId: 'alice', access: 'owner', grants: [], changed: false,
            modelParticipant: { ...model, answerPolicy: currentPolicy } } };
    } });
    const repository = createDiscussionRepository({ scope, address: { serverId }, client });
    await repository.refreshDiscussion(discussionId);
    const { DiscussionComposer } = await import('@/components/discussions/DiscussionComposer');
    const { AgentInput } = await import('@/components/sessions/agentInput');
    const { useDiscussionDraft } = await import('@/components/discussions/useDiscussionDraft');
    const { useDiscussionParticipantManagement } = await import('@/components/discussions/useDiscussionParticipantManagement');
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const { renderScreen, act } = await import('@/dev/testkit');
    let posted: Promise<unknown> | undefined;
    let disabled = false;
    let available = true;
    let currentDiscussionId = discussionId;
    function Harness() {
        const { binding: accountLifetime } = useServerCredentialAccountScopeBinding(serverId);
        const draft = useDiscussionDraft({ scope, address: { kind: 'discussion', discussionId: scenario === 'superseded' ? discussionId : currentDiscussionId } });
        const management = useDiscussionParticipantManagement({ accountLifetime: accountLifetime ?? null, discussionId: currentDiscussionId, repository,
            enabled: true, summary: repository.getSnapshot().threads[currentDiscussionId]?.summary ?? null });
        if (!accountLifetime) return null;
        return React.createElement(DiscussionComposer, { scope, accountLifetime, address: { serverId }, discussionId: currentDiscussionId,
            draftAddress: { kind: 'discussion', discussionId: scenario === 'superseded' ? discussionId : currentDiscussionId },
            roster: management.roster, onRefreshParticipants: management.refresh,
            availability: available ? 'available' : 'unavailable', value: { text: draft.text, mentions: draft.mentions }, onChange: draft.setComposer,
            disabled,
            prepareParticipantMentions: async (document: DiscussionComposerValue, isCurrent: () => boolean) => {
                const { prepareDiscussionParticipantMentions } = await vi.importActual<typeof import('@/components/discussions/prepareDiscussionParticipantMentions')>(
                    '@/components/discussions/prepareDiscussionParticipantMentions');
                const result = await prepareDiscussionParticipantMentions({ document, discussionId: currentDiscussionId, repository,
                    inviteExecutable: management.inviteExecutable, isCurrent });
                return result.kind === 'ready' ? result.content : null;
            },
            onSend: content => { posted = repository.post({ discussionId, localId: 'model-question', content }); },
        });
    }
    const throughDetails = ['success', 'repeated', 'failed', 'pending', 'unknown', 'approval', 'removed', 'bound'].includes(scenario);
    const { DiscussionDetailsView } = throughDetails
        ? await import('@/components/discussions/DiscussionDetailsView') : { DiscussionDetailsView: null };
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
    if (throughDetails) {
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const { tryWriteServerEnabledBitInPlace } = await import('@happier-dev/protocol/features/serverEnabledBit');
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const features = createRootLayoutFeaturesResponse();
        expect(tryWriteServerEnabledBitInPlace(features, 'sessions.conversations', true)).toBe(true);
        homes.answer(serverId, '/v1/features', { body: features });
        homes.answer(serverId, '/v1/features/authenticated', { body: features });
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    }
    const element = () => DiscussionDetailsView ? React.createElement(DiscussionDetailsView, {
        target: { kind: 'discussion', address: { serverId }, discussionId }, active: true, standaloneSurface: true,
    }) : React.createElement(Harness);
    const screen = await renderScreen(element(), throughDetails ? { wrapper: AppPaneProvider } : {});
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    let unmounted = false;
    try {
        const input = () => screen.root.findByType(AgentInput);
        await vi.waitFor(() => expect(screen.root.findAllByType(AgentInput)).toHaveLength(1));
        const suggestions = await input().props.autocompleteSuggestions('@', new AbortController().signal);
        const selected = suggestions.find((item: { structuredInput?: { ref?: string } }) => item.structuredInput?.ref?.includes('saved-mention-slot'));
        expect(selected, JSON.stringify(suggestions)).toBeDefined();
        expect(selected.label).toContain('gpt-6-luna');
        homes.answer(serverId, `${path}/participants`, { body: DiscussionParticipantsListResponseV1Schema.parse({ ...roster,
            participants: [...Array.from({ length: 24 }, (_, index) => ({ participant: { kind: 'session', sessionId: `unrelated-session-${index}` },
                answerPolicy: 'when_addressed', createdAt: 1 })), model],
        }) });
        const narrowed = await input().props.autocompleteSuggestions('@gpt-6-luna', new AbortController().signal);
        expect(narrowed).toMatchObject([{ structuredInput: { ref: selected.structuredInput.ref } }]);
        expect(await input().props.autocompleteSuggestions('@file:gpt-6-luna', new AbortController().signal)).toEqual([]);
        expect(await input().props.autocompleteSuggestions('/gpt-6-luna', new AbortController().signal)).toEqual([]);
        expect(spawnRequests).toEqual([]);
        expect(homes.requestsFor(`${path}/participants/invite`)).toEqual([]);
        await act(async () => {
            const text = scenario === 'repeated' ? `${selected.text} ${selected.text}` : selected.text;
            input().props.onChangeText(text);
            input().props.onStructuredInputMentionsChange([
                { ...selected.structuredInput, tokenText: selected.text, start: 0, end: selected.text.length },
                ...(scenario === 'repeated' ? [{ ...selected.structuredInput, tokenText: selected.text,
                    start: selected.text.length + 1, end: text.length }] : []),
            ]);
        });
        expect(spawnRequests).toEqual([]);
        expect(input().props.disabled, JSON.stringify(homes.requests.map(request => request.path))).toBe(false);
        if (['edited', 'disabled', 'unavailable', 'retired', 'context', 'superseded'].includes(scenario)) {
            homes.answer(serverId, `${path}/participants`, { select: async () => {
                entered.resolve(); await release.promise; return { body: roster };
            } });
        } else if (scenario === 'removed' || scenario === 'bound') {
            homes.answer(serverId, `${path}/participants`, { body: { ...roster,
                participants: scenario === 'removed' ? [] : [{ ...model, sessionId: 'already-bound-session' }],
            } });
        } else if (scenario === 'failed') {
            spawnResultOverride = SessionSpawnNewResultV1Schema.parse({ type: 'error', code: 'spawn_failed', retryable: true });
        } else if (scenario === 'pending') {
            spawnResultOverride = SessionSpawnNewResultV1Schema.parse({ type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' });
        } else if (scenario === 'unknown') {
            loseInvite = true;
        } else if (scenario === 'approval') {
            await homes.requireUiApproval(serverId, 'discussion.invite');
        } else if (scenario === 'birth_edited' || scenario === 'unmounted') {
            spawnResponseGate = release.promise;
            onSpawnRequest = () => entered.resolve();
        }
        let sending: Promise<unknown> | undefined;
        await act(async () => { sending = input().props.onSend(); });
        if (['edited', 'birth_edited', 'unmounted', 'disabled', 'unavailable', 'retired', 'context', 'superseded'].includes(scenario)) {
            await entered.promise;
            await act(async () => {
                if (scenario === 'edited' || scenario === 'birth_edited') input().props.onChangeText(`${selected.text} newer question`);
                if (scenario === 'disabled') disabled = true;
                if (scenario === 'unavailable') available = false;
                if (scenario === 'retired') await homes.switchAccount(serverId, 'bob', { currentAccount: true });
                if (scenario === 'context' || scenario === 'superseded') {
                    currentDiscussionId = 'other-discussion';
                    homes.answer(serverId, '/v1/discussions/other-discussion/participants', { body: { ...roster,
                        discussionId: currentDiscussionId, participants: [] } });
                }
            });
            if (scenario === 'unmounted') { await screen.unmount(); unmounted = true; }
            else await screen.update(element());
            if (scenario === 'context' || scenario === 'superseded') {
                if (scenario === 'context') await act(async () => {
                        input().props.onChangeText(selected.text);
                        input().props.onStructuredInputMentionsChange([{ ...selected.structuredInput, tokenText: selected.text, start: 0, end: selected.text.length }]);
                    });
                const before = homes.requestsFor('/v1/discussions/other-discussion/participants').length;
                await act(async () => { await input().props.onSend(); });
                expect(homes.requestsFor('/v1/discussions/other-discussion/participants').length).toBeGreaterThan(before);
                if (scenario === 'superseded') {
                    currentDiscussionId = discussionId;
                    await screen.update(element());
                }
            }
            release.resolve();
        }
        await act(async () => { await sending; });
        if (!['success', 'repeated', 'bound'].includes(scenario)) {
            expect(thread.messages).toHaveLength(1);
            if (scenario !== 'retired' && !unmounted) expect(input().props.value).toBe(scenario === 'edited' || scenario === 'birth_edited' ? `${selected.text} newer question` : selected.text);
            if (throughDetails) {
                const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
                const { t } = await import('@/text');
                const notice = screen.root.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'session-discussion-notice');
                expect(notice?.props.title).toBe(t(scenario === 'approval' ? 'approvals.status.open'
                    : scenario === 'pending' || scenario === 'unknown' ? 'session.collaboration.discussion.manage.checking'
                        : scenario === 'removed' ? 'session.collaboration.discussion.invalidMention' : 'session.collaboration.discussion.sendFailed'));
            }
            if (scenario === 'failed' || scenario === 'pending' || scenario === 'unknown') {
                expect(spawnRequests).toHaveLength(scenario === 'unknown' ? 0 : 1);
                spawnResultOverride = null;
                currentPolicy = 'when_addressed';
                homes.answer(serverId, `${path}/participants`, { body: { ...roster, participants: [{ ...model, answerPolicy: currentPolicy }] } });
                await act(async () => { await input().props.onSend(); });
                await posted;
                await vi.waitFor(() => expect(thread.messages).toHaveLength(2));
                expect(spawnRequests).toHaveLength(scenario === 'unknown' ? 1 : 2);
                if (spawnRequests.length === 2) expect(spawnRequests[1].creationKey).toBe(spawnRequests[0].creationKey);
                expect(homes.requestsFor(`${path}/participants/invite`).map(request => DiscussionInviteRequestV1Schema.parse(request.input)))
                    .toEqual(['reads_only', 'when_addressed'].map(answerPolicy => ({ participant: { ...model.participant, launch }, answerPolicy })));
                expect(thread.messages).toHaveLength(2);
            } else expect(spawnRequests).toHaveLength(scenario === 'birth_edited' || scenario === 'unmounted' ? 1 : 0);
            return;
        }
        await posted;
        await vi.waitFor(() => expect(thread.messages).toHaveLength(2));
        expect(spawnRequests).toHaveLength(scenario === 'bound' ? 0 : 1);
        expect(spawnParseIssues).toEqual([]);
        for (const request of spawnRequests) expect(request).toMatchObject({
            discussionParticipant: { discussionId, participantSlotId: model.participant.participantSlotId }, initialTriggers: [],
        });
        for (const request of spawnRequests) expect(request.initialInput).toBeUndefined();
        expect(thread.messages.at(-1)?.content).toEqual({ t: 'plain', v: { v: 1, parts: [
            { t: 'mention', participant: { kind: 'session', sessionId: scenario === 'bound' ? 'already-bound-session' : 'owned-model-session' } },
            ...(scenario === 'repeated' ? [{ t: 'text', text: ' ' }, { t: 'mention', participant: { kind: 'session', sessionId: 'owned-model-session' } }] : []),
        ] } });
        expect(thread.messages).toHaveLength(2);
    } finally { release.resolve(); if (!unmounted) await screen.unmount(); }
});

it.each(['stopped', 'already_stopped', 'active', 'unknown', 'not_found', 'unreadable', 'requested', 'ambiguous', 'detached', 'archive_conflict', 'archive_unavailable', 'account_retired'] as const)(
    'uses ordinary Stop confirmation for participant removal (%s)', async confirmation => {
    await loadSyncSingletonForTests();
    const serverUrl = 'https://model-removal.test';
    const serverId = await homes.addHome({ name: 'Model removal', serverUrl, serverIdentityId: 'srv_model_removal', accountId: 'alice', currentAccount: true });
    const token = homes.findByServerUrl(serverUrl)?.token;
    if (!token) throw new Error('Missing fixture Account token');
    connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', credentials: { token }, request: createSessionReadBatchFetchBoundary(homes.request) });
    const machineRow = createPlainMachineRowFixture({ id: 'machine-a', accountId: 'alice' });
    homes.answer(serverId, '/v1/machines', { body: { machines: [machineRow] } });
    homes.answer(serverId, '/v1/machines/machine-a', { body: { machine: machineRow } });
    homes.answer(serverId, '/v1/machines/machine-a/access', { body: MachineAccessGrantsListResponseV1Schema.parse({
        machineId: machineRow.id, custodian: machineRow.access!.custodian, access: machineRow.access,
        canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
    }) });
    const sessionId = 'owned-model-session';
    const session = createSessionFixture({ id: sessionId, serverId, active: true,
        metadata: { path: '/workspace', host: 'model-machine', machineId: 'machine-a' } });
    const machine = createMachineFixture({ id: 'machine-a', activeAt: machineRow.activeAt,
        storageMode: 'plain', dataEncryptionKey: machineRow.dataEncryptionKey, access: machineRow.access });
    getStorage().setState({ sessions: { [sessionId]: session }, machines: { [machine.id]: machine } });
    await publishMachineInventoryForTest({ serverId, accountId: 'alice' }, [machine]);
    const effects: string[] = [];
    let stopped = false;
    let archivedAt: number | null = null;
    let freshInactiveReads = 0;
    const sessionAnswer = { select: () => {
        if (stopped) freshInactiveReads++;
        if (stopped && confirmation === 'not_found') return { status: 404, body: { error: 'Session not found' } };
        if (stopped && confirmation === 'unreadable') return { status: 403, body: { error: 'Forbidden' } };
        const body = createPlainSessionByIdResponseFixture({ ...session, active: !stopped || confirmation === 'active' });
        return { body: { session: { ...body.session, archivedAt,
            ...(stopped && confirmation === 'unknown' ? { active: undefined } : {}) } } };
    } };
    homes.answer(serverId, `/v2/sessions/${sessionId}`, sessionAnswer);
    homes.answer(serverId, `/v2/sessions/${sessionId}?accessProjectionVersion=1`, sessionAnswer);
    // Stop first persists the explicit-Stop hold through the owner metadata tuple (Home HTTP persistence boundary).
    homes.answer(serverId, `PATCH /v2/sessions/${sessionId}`, { select: input => {
        const patch = input as { sharedMetadata: { expectedVersion: number }; agentState: { expectedVersion: number } };
        return { body: { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: patch.sharedMetadata.expectedVersion + 1 },
            agentState: { version: patch.agentState.expectedVersion + 1 } } };
    } });
    stopAnswer = async request => {
        if (request.method === `${sessionId}:killSession`) {
            effects.push('runner-stop');
            return { status: 'not_found' };
        }
        expect(request.method).toBe(`machine-a:${RPC_METHODS.STOP_SESSION}`);
        expect(request.params).toEqual({ sessionId });
        stopped = true;
        effects.push('stop');
        if (confirmation === 'account_retired') {
            await homes.switchAccount(serverId, 'bob', { currentAccount: true });
            return { status: 'stopped' };
        }
        if (confirmation === 'ambiguous') throw Object.assign(new Error('Stop acknowledgement lost'), { rpcErrorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
        if (confirmation === 'requested') return { status: 'requested' };
        return { status: confirmation === 'stopped' || confirmation.startsWith('archive_') ? 'stopped' : 'not_found' };
    };
    const removal = { discussionId: 'discussion-a', participant: confirmation === 'detached'
        ? { kind: 'session' as const, sessionId } : { kind: 'model' as const, participantSlotId: 'retained-slot' } };
    const { path, method } = bindDiscussionActionHttpRequestV1('discussion.participant.remove', removal);
    answerDiscussionRead(serverId);
    homes.answer(serverId, `${method} ${path}`, { select: input => {
        expect(input).toEqual({ participant: removal.participant });
        effects.push('remove');
        return { body: { discussionId: 'discussion-a', ownerAccountId: 'alice', access: 'owner', grants: [], changed: true,
            ...(confirmation === 'detached' ? {} : { ownedSession: { discussionId: 'discussion-a', participantSlotId: 'retained-slot', sessionId } }) } };
    } });
    homes.answer(serverId, `POST /v2/sessions/${sessionId}/archive`, { select: () => {
        effects.push('archive');
        if (confirmation === 'archive_conflict') return { status: 409, body: { error: 'session_active' } };
        if (confirmation === 'archive_unavailable') return { status: 503, body: { error: 'service_unavailable' } };
        archivedAt = 123;
        return { body: { archivedAt } };
    } });
    const client = createDiscussionClient({ scope: { serverId, accountId: 'alice' }, availability: 'available' });
    const repository = createDiscussionRepository({ scope: { serverId, accountId: 'alice' }, address: { serverId }, client });
    const outcome = await repository.removeParticipant(removal);
    if (confirmation === 'account_retired') {
        expect(outcome, JSON.stringify({ outcome, effects })).toMatchObject({ kind: 'failed' });
        expect(effects).toEqual(['remove', 'stop']);
        expect(homes.requestsFor(`/v2/sessions/${sessionId}/archive`)).toEqual([]);
        expect(archivedAt).toBeNull();
        return;
    }
    if (confirmation === 'detached') {
        expect(outcome).toMatchObject({ kind: 'succeeded' });
        expect(effects).toEqual(['remove']);
        expect(stopRequests).toEqual([]);
        expect(homes.requestsFor(`/v2/sessions/${sessionId}/archive`)).toEqual([]);
        expect(archivedAt).toBeNull();
        return;
    }
    expect(stopRequests[0], JSON.stringify({ outcome, effects })).toMatchObject({ method: `machine-a:${RPC_METHODS.STOP_SESSION}` });
    if (confirmation === 'archive_conflict' || confirmation === 'archive_unavailable') {
        const code = confirmation === 'archive_conflict' ? 'session_active' : 'unknown_error';
        expect(outcome, JSON.stringify({ outcome, effects })).toMatchObject({ kind: 'failed', errorCode: code });
        expect(effects).toEqual(['remove', 'stop', 'archive']);
        expect(archivedAt).toBeNull();
        const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
        expect(await executeSessionLifecycleAction('session.archive', sessionId, { serverId }))
            .toMatchObject({ success: false, code, message: expect.any(String) });
        expect(archivedAt).toBeNull();
        return;
    }
    if (confirmation !== 'stopped' && confirmation !== 'already_stopped') {
        expect(outcome, JSON.stringify({ outcome, effects })).toMatchObject({ kind: 'failed' });
        expect(homes.requestsFor(`/v2/sessions/${sessionId}/archive`)).toEqual([]);
        expect(archivedAt).toBeNull();
        expect(getStorage().getState().sessions[sessionId]?.archivedAt).not.toBe(123);
        return;
    }
    expect(outcome, JSON.stringify({ outcome, effects })).toMatchObject({ kind: 'succeeded', value: { changed: true } });
    expect(effects).toEqual(['remove', 'stop', 'archive']);
    if (confirmation === 'already_stopped') expect(freshInactiveReads).toBeGreaterThan(0);
    expect(stopRequests).toHaveLength(1);
    expect(homes.requestsFor(`/v2/sessions/${sessionId}/archive`).map(request => request.serverId)).toEqual([serverId]);
    expect(getStorage().getState().sessions[sessionId]?.archivedAt).toBe(123);
    expect(archivedAt).toBe(123);
    if (confirmation === 'already_stopped') {
        expect(await repository.removeParticipant(removal)).toMatchObject({ kind: 'succeeded' });
        expect(effects).toEqual(['remove', 'stop', 'archive', 'remove', 'stop', 'archive']);
        expect(homes.requestsFor(path).map(request => request.input)).toEqual([
            { participant: removal.participant }, { participant: removal.participant },
        ]);
    }
});

it.each([{ enriched: false, failure: false, pending: false }, { enriched: true, failure: false, pending: false },
    { enriched: false, failure: true, pending: false }, { enriched: false, failure: false, pending: true }])(
    'sends the selected model launch through the daemon boundary and participant projection (Profile/Role: $enriched, startup failure: $failure, pending: $pending)', async ({ enriched, failure, pending }) => {
    await loadSyncSingletonForTests();
    const serverUrl = 'https://model-transport.test';
    const serverId = await homes.addHome({ name: 'Model transport', serverUrl, serverIdentityId: 'srv_model_transport', accountId: 'alice', currentAccount: true });
    const token = homes.findByServerUrl(serverUrl)?.token;
    if (!token) throw new Error('Missing fixture Account token');
    connection = await restoreServerAccountForTest({ serverUrl, serverIdentityId: 'srv_model_transport', accountId: 'alice', credentials: { token },
        request: createSessionReadBatchFetchBoundary(homes.request) });
    spawnServerId = serverId;
    const row = createPlainMachineRowFixture({ id: 'machine-a', accountId: 'alice' });
    const machine = createMachineFixture({ id: row.id, activeAt: row.activeAt,
        storageMode: 'plain', dataEncryptionKey: row.dataEncryptionKey, access: row.access });
    getStorage().setState({ machines: { [machine.id]: machine } });
    await publishMachineInventoryForTest({ serverId, accountId: 'alice' }, [machine]);
    homes.answer(serverId, '/v1/machines', { body: { machines: [row] } });
    homes.answer(serverId, '/v1/machines/machine-a', { body: { machine: row } });
    homes.answer(serverId, '/v1/machines/machine-a/access', { body: MachineAccessGrantsListResponseV1Schema.parse({
        machineId: row.id, custodian: row.access!.custodian, access: row.access,
        canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
    }) });
    if (enriched) {
        const record = ProfileRecordV1Schema.parse({ v: 1, id: 'review-profile', enabled: true,
            definition: { kind: 'inline', profile: { v: 2, id: 'review-profile', name: 'Review', createdAt: 1, updatedAt: 1 } },
            promptStack: [], secretBindings: {}, skillSeeds: ['review-seed'] });
        const transferControl = ProfileTransferRowReadResponseV1Schema.parse({ status: 'present', revision: 1, content: { t: 'plain', v: {
            v: 1, phase: 'active', sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory: [],
        } } });
        homes.answer(serverId, PROFILE_REFERENCE_GUARD_ROUTE_V1, { body: { status: 'ready', revision: 1 } });
        homes.answer(serverId, PROFILE_TRANSFER_ROUTE_V1, { body: transferControl });
        homes.answer(serverId, PROFILE_ROWS_ROUTE_V1, { body: ProfileRowsListResponseV1Schema.parse({
            status: 'listed', rows: [{ id: record.id, revision: 1, content: { t: 'plain', v: record } }],
            nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: 1,
            transferControl,
        }) });
    }
    const launch = DiscussionModelParticipantLaunchV1Schema.parse({ executionTarget: { serverId, machineId: 'machine-a' },
        directory: { kind: 'path' as const, path: '/workspace' },
        agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        permissionMode: 'read-only' as const, configuration: { mode: { value: null, updatedAtMs: 1 },
            model: { value: 'selected-model', updatedAtMs: 1 }, permissionIntent: { value: 'read-only' as const, updatedAtMs: 1 }, options: {} },
        connectedServices: { v: 2 as const, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
            source: 'connected' as const, selection: 'profile' as const, profileId: 'selected-login',
        } } },
        ...(enriched ? { profileId: 'review-profile', roleId: 'reviewer' } : {}),
    });
    answerDiscussionRead(serverId);
    homes.answer(serverId, 'POST /v1/discussions/discussion-a/participants/invite', { body: {
        discussionId: 'discussion-a', ownerAccountId: 'alice', access: 'owner', grants: [], changed: true,
        modelParticipant: { participant: { kind: 'model', participantSlotId: 'retained-slot' }, launch,
            sessionId: null, answerPolicy: 'when_addressed', createdAt: 1 },
    } });
    const client = createDiscussionClient({ scope: { serverId, accountId: 'alice' }, availability: 'available' });
    const startFailure = SessionSpawnNewResultV1Schema.parse({ type: 'error', code: 'target_unavailable', retryable: false });
    if (failure) spawnResultOverride = startFailure;
    if (pending) spawnResultOverride = { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' };
    const invitation = { discussionId: 'discussion-a', selection: { kind: 'model' as const, launch }, participantSlotId: 'retained-slot' };
    let outcome: Awaited<ReturnType<typeof client.inviteExecutableParticipant>> | undefined;
    if (failure || pending) {
        const { act, renderHook } = await import('@/dev/testkit/hooks/renderHook');
        const { useDiscussionParticipantManagement } = await import('@/components/discussions/useDiscussionParticipantManagement');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const repository = createDiscussionRepository({ scope: { serverId, accountId: 'alice' }, address: { serverId }, client });
        await repository.refreshDiscussion('discussion-a');
        homes.answer(serverId, '/v1/discussions/discussion-a/participants', { body: DiscussionParticipantsListResponseV1Schema.parse({
            discussionId: 'discussion-a', ownerAccountId: 'alice', access: 'owner', grants: [], participants: [{
                participant: { kind: 'model', participantSlotId: 'retained-slot' }, launch, sessionId: null,
                answerPolicy: 'when_addressed', createdAt: 1,
            }],
        }) });
        const hook = await renderHook(() => {
            const { binding: accountLifetime } = useServerCredentialAccountScopeBinding(serverId);
            return useDiscussionParticipantManagement({ accountLifetime,
                discussionId: 'discussion-a', repository, enabled: true, summary: repository.getSnapshot().threads['discussion-a']?.summary ?? null });
        });
        await vi.waitFor(() => expect(hook.getCurrent().roster?.participants).toHaveLength(1));
        expect(hook.getCurrent().modelParticipants).toMatchObject([{ birth: { kind: 'unknown' }, canRetry: true }]);
        await act(async () => { outcome = await hook.getCurrent().inviteExecutable(invitation.selection, { participantSlotId: invitation.participantSlotId }); });
        expect(hook.getCurrent().modelParticipants).toMatchObject([{ birth: failure
            ? { kind: 'failed', errorCode: 'target_unavailable', sessionStart: startFailure }
            : { kind: 'unknown', reason: 'pending' }, canRetry: !failure }]);
        if (failure) {
            await act(async () => { await hook.getCurrent().retry(); });
            expect(spawnRequests).toHaveLength(1);
        }
        await hook.unmount();
    } else outcome = await client.inviteExecutableParticipant(invitation);
    expect(outcome, JSON.stringify({ outcome, spawnParseIssues })).toMatchObject(failure ? {
        kind: 'failed', errorCode: 'target_unavailable', value: { modelParticipant: { participant: { participantSlotId: 'retained-slot' }, sessionId: null },
            sessionStart: startFailure },
    } : pending ? { kind: 'checking', value: { sessionStart: spawnResultOverride } } : { kind: 'succeeded', value: {
        modelParticipant: { sessionId: 'owned-model-session' }, sessionStart: { type: 'success', sessionId: 'owned-model-session' },
    } });
    expect(spawnParseIssues).toEqual([]);
    expect(spawnRequests).toHaveLength(1);
    const outgoing = SessionSpawnNewActionInputV2Schema.parse(spawnRequests[0]);
    expect(projectDiscussionModelParticipantLaunchV1(admitSessionSpawnNewActionInputV2(outgoing))).toEqual(launch);
    expect(outgoing).toMatchObject({ creationKey: 'retained-slot',
        discussionParticipant: { discussionId: 'discussion-a', participantSlotId: 'retained-slot' }, initialTriggers: [] });
    expect(outgoing).not.toHaveProperty('initialInput');
    if (enriched) expect(homes.requestsFor(PROFILE_ROWS_ROUTE_V1).length).toBeGreaterThan(0);
});
