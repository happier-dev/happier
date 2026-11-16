import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createDeferred, createSessionFixture, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { SessionPendingMessageComposerAdmissionPrepareResponseV1Schema, type SessionPendingMessageComposerAdmissionPrepareResponseV1 } from '@happier-dev/protocol/sessions/userMessageRpc';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let prepareGate: ReturnType<typeof createDeferred<void>> | undefined;
let prepareStarted: ReturnType<typeof createDeferred<void>>;
let preparedLocalId: string;
let rejectPreparation = false;
let includeCleanup = false;
let failSettlement = false;
let preparedMedia: Pick<Extract<SessionPendingMessageComposerAdmissionPrepareResponseV1, { ok: true }>, 'stagedMediaHandles' | 'stagedMediaReleaseIntents' | 'sessionMediaMetadata' | 'sessionAttachmentMetadata'> | undefined;
const settlement: string[] = [];
const acceptedFacts: unknown[] = [];
const patchBodies: unknown[] = [];
const abandonments: string[] = [];
installDisconnectedServerSocketBoundary(socket => {
    configureConnectedServerSocketBoundary(socket);
    socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
    // The daemon RPC is an external process boundary. Admission and Pending writing stay real.
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload: unknown) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
        if (!payload || typeof payload !== 'object') throw new Error('Missing RPC request');
        const method = Reflect.get(payload, 'method');
        const input = Reflect.get(payload, 'params');
        if (typeof method !== 'string' || !input || typeof input !== 'object') throw new Error('Invalid RPC request');
        if (method.endsWith(SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1)) {
            preparedLocalId = String(Reflect.get(input, 'localId'));
            prepareStarted.resolve(undefined);
            await prepareGate?.promise;
            return { ok: true, result: SessionPendingMessageComposerAdmissionPrepareResponseV1Schema.parse(rejectPreparation
                ? { ok: false, errorCode: 'composer_attachment_unavailable', error: 'composer_attachment_unavailable' }
                : { ok: true, text: Reflect.get(input, 'text'), structuredInput: Reflect.get(input, 'structuredInput'),
                    stagedMediaHandles: [], ...preparedMedia, ...(includeCleanup ? { sessionMediaCleanup: {
                        workingDirectory: '/repo', createdWorkspaceRelativePaths: ['.happier/uploads/pending.png'],
                    } } : {}) }) };
        }
        if (method.endsWith(SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ACCEPTED_V1)) {
            settlement.push(String(Reflect.get(input, 'localId')));
            acceptedFacts.push(input);
            return { ok: true, result: { ok: !failSettlement } };
        }
        if (method.endsWith(SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ABANDONED_V1)) {
            abandonments.push(String(Reflect.get(input, 'localId')));
            return { ok: true, result: { ok: true } };
        }
        throw new Error(`Unexpected RPC method ${method}`);
    });
});
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { Modal } = await import('@/modal');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { executePendingMessageEditWithActionApproval } = await import('@/components/sessions/composer/pendingMessageEditAction');
const { createPendingMessageComposerDocumentOwner } = await import('@/components/sessions/composer/pendingMessageComposerDocumentOwner');
const { createUiClientActionReverseHandler } = await import('./clientActionReverseDispatch');
const { createClientActionReverseDispatcher } = await import('../../../../../cli/src/session/actions/clientActionReverseDispatch');
let serverId: string;
const path = '/v2/sessions/pending-edit-session/pending/queued-input';

beforeEach(async () => {
    await homes.reset();
    await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Pending Home', serverUrl: 'https://pending-edit.test', accountId: 'pending-owner' });
    const scope = { serverId, accountId: 'pending-owner' };
    storage.getState().activateProfileScope(scope);
    await storage.getState().activateSettingsScope(scope);
    storage.getState().activateSessionLocalStateScope(scope);
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(true);
    prepareGate = undefined;
    prepareStarted = createDeferred<void>();
    preparedLocalId = '';
    rejectPreparation = false;
    includeCleanup = false;
    failSettlement = false;
    preparedMedia = undefined;
    settlement.length = 0;
    acceptedFacts.length = 0;
    patchBodies.length = 0;
    abandonments.length = 0;
    const session = createSessionFixture({ id: 'pending-edit-session', serverId, encryptionMode: 'plain',
        metadata: { path: '/repo', host: 'machine', machineId: 'pending-machine', flavor: 'claude' } });
    storage.setState({ sessions: { [session.id]: session } });
    homes.answer(serverId, `GET /v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
    storage.getState().upsertPendingMessage(session.id, { id: 'queued-input', localId: 'queued-input', text: 'Before',
        source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: scope,
        createdAt: 1, updatedAt: 1, rawRecord: { role: 'user', content: { type: 'text', text: 'Before' }, meta: {} } });
    homes.answer(serverId, `PATCH ${path}`, { select: input => {
        patchBodies.push(input);
        return { body: { ok: true, localId: input && typeof input === 'object'
            ? Reflect.get(input, 'replacementLocalId') ?? 'queued-input' : 'queued-input' } };
    } });
});
afterEach(async () => { prepareGate?.resolve(undefined); await standardCleanup(); await homes.reset(); });

describe('Pending content edit Action composition', () => {
    it.each([false, true])('keeps the target-issued upload descriptor in the edited Pending content (retained=%s)', async retained => {
        const envelope = { kind: 'attachments.v1' as const, payload: { attachments: [{
            id: 'tray-file', name: 'notes.txt', path: '.happier/uploads/messages/input/issued-notes.txt',
            sizeBytes: 42, sha256: 'a'.repeat(64),
            attachmentHandle: { v: 1 as const, sessionId: 'pending-edit-session', id: 'issued-file' },
        }] } };
        preparedMedia = { stagedMediaHandles: [], sessionAttachmentMetadata: { key: 'happier', envelope } };
        const sibling = { kind: 'context.v1', payload: { source: 'preserved' } };
        if (retained) storage.getState().upsertPendingMessage('pending-edit-session', {
            id: 'queued-input', localId: 'queued-input', text: 'Before', source: 'server_pending', deliveryStatus: 'accepted',
            pendingOutboxScope: { serverId, accountId: 'pending-owner' }, createdAt: 1, updatedAt: 1,
            rawRecord: { role: 'user', content: { type: 'text', text: 'Before' }, meta: {
                happier: sibling, happierAttachments: { ...envelope, payload: { attachments: [{
                    ...envelope.payload.attachments[0], path: '.happier/uploads/messages/input/previous-notes.txt',
                }] } },
            } },
        });
        const result = await createDefaultActionExecutor().execute(ActionIdSchema.parse('session.pending.edit'), {
            sessionId: 'pending-edit-session', localId: 'queued-input', text: '[notes](happier-ref:attachment:tray-file)', structuredInput: { v: 1 },
        }, { surface: 'ui', authority: 'present_user', serverId });
        expect(result).toMatchObject({ ok: true, result: { status: 'accepted' } });
        expect(patchBodies).toMatchObject([{ content: { t: 'plain', v: { meta: retained
            ? { happier: sibling, happierAttachments: envelope } : { happier: envelope } } } }]);
        expect(settlement).toEqual(['queued-input']);
    });

    it.each([
        { retired: false, confirmed: true },
        { retired: true, confirmed: true },
        { retired: false, confirmed: false },
    ])('retains the original editor across in-place Ask confirmation (retired=$retired, confirmed=$confirmed)', async ({ retired, confirmed }) => {
        await homes.setActionPolicy(serverId, 'session.pending.edit', 'ui', 'ask');
        const entered = createDeferred<void>();
        const answer = createDeferred<boolean>();
        vi.mocked(Modal.confirm).mockImplementationOnce(() => { entered.resolve(); return answer.promise; });
        const cancellation = new AbortController();
        let editorCurrent = true;
        const pending = executePendingMessageEditWithActionApproval({
            input: { sessionId: 'pending-edit-session', localId: 'queued-input', text: 'Approved content', structuredInput: { v: 1 } },
            context: { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'pending-owner' },
            scope: { serverId, accountId: 'pending-owner' }, isCurrent: () => editorCurrent,
            registerApproval: () => { throw new Error('Own UI Ask unexpectedly created an approval Artifact'); }, signal: cancellation.signal,
        });
        try {
            const observed = await Promise.race([entered.promise.then(() => 'waiting'), pending.then(() => 'returned')]);
            expect(observed).toBe('waiting');
            expect(homes.artifacts(serverId).list()).toHaveLength(0);
            expect(homes.requestsFor(path)).toEqual([]);
            expect(preparedLocalId).toBe('');
            expect(storage.getState().sessionPending['pending-edit-session']?.messages[0]?.text).toBe('Before');
            if (retired) editorCurrent = false;
            answer.resolve(confirmed);
            const accepted = confirmed && !retired;
            expect(await pending).toMatchObject({ status: accepted ? 'accepted' : 'rejected' });
            expect(homes.requestsFor(path)).toHaveLength(accepted ? 1 : 0);
            expect(storage.getState().sessionPending['pending-edit-session']?.messages[0]?.text).toBe(accepted ? 'Approved content' : 'Before');
            expect(homes.artifacts(serverId).list()).toHaveLength(0);
        } finally { answer.resolve(false); cancellation.abort(); await pending; }
    });
    it.each(['ui', 'mcp'] as const)('edits through %s admission, the existing Pending writer, and post-accept settlement', async surface => {
        const actionId = ActionIdSchema.parse('session.pending.edit');
        const attachment = { v: 1 as const, instanceId: 'image-42', attachment: { pluginId: 'acme.media', localId: 'image' },
            key: '42', value: { prepared: true }, presentation: { label: 'Image', typeLabel: 'Image' } };
        const handle = { v: 1 as const, id: 'stage-42', executionTarget: { serverId, machineId: 'pending-machine' },
            owner: attachment.attachment, mediaKind: 'image' as const, mimeType: 'image/png', name: 'image.png', sizeBytes: 42, sha256: 'a'.repeat(64) };
        preparedMedia = {
            stagedMediaHandles: [handle],
            stagedMediaReleaseIntents: [{ handle, executionTarget: handle.executionTarget, owner: handle.owner,
                claimant: { composer: { kind: 'pendingMessage', sessionId: 'pending-edit-session', localId: 'queued-input' },
                    attachmentInstanceId: attachment.instanceId } }],
            sessionMediaMetadata: { key: 'happier', envelope: { kind: 'session_media.v1', payload: { media: [{
                id: 'media-42', role: 'input', category: 'attachment', mediaKind: 'image', mimeType: 'image/png',
                name: 'image.png', path: '.happier/uploads/image.png', sizeBytes: 42, sha256: 'a'.repeat(64), origin: { source: 'user-upload' },
            }] } } },
        };
        const input = { sessionId: 'pending-edit-session', localId: 'queued-input', text: 'After',
            structuredInput: { v: 1 as const, mentions: [], composerAttachments: [attachment] }, replacementLocalId: 'replacement-input' };
        const receive = createUiClientActionReverseHandler({ serverId, accountId: 'pending-owner', isCurrent: () => true });
        const reverse = createClientActionReverseDispatcher(() => ({ hasConnectedClientRpcHandler: () => true,
            callConnectedClientRpc: async (_method, payload, options) => {
                options.onIssued();
                return { ok: true, result: await receive(JSON.parse(JSON.stringify(payload)),
                    { signal: options.signal ?? new AbortController().signal }) };
            } }));
        const context = { surface, authority: surface === 'ui' ? 'present_user' : 'account_automation', serverId,
            expectedAccountId: 'pending-owner', defaultSessionId: input.sessionId } as const;
        const result = surface === 'ui' ? { ok: true as const, result: await executePendingMessageEditWithActionApproval({
            input, context, scope: { serverId, accountId: 'pending-owner' }, isCurrent: () => true,
            registerApproval: () => { throw new Error('Direct editing unexpectedly requested approval'); }, signal: new AbortController().signal,
        }) } : await createActionExecutor({ clientActionExecute: reverse, }).execute(actionId, input, context);
        if (!result.ok) throw new Error(result.errorCode);
        expect(result).toMatchObject({ ok: true, result: { status: 'accepted', localId: 'replacement-input',
            structuredInput: { v: 1, composerAttachments: [attachment] }, settlement: 'complete' } });
        expect(preparedLocalId).toBe('replacement-input');
        expect(settlement).toEqual(['replacement-input']);
        expect(acceptedFacts).toEqual([expect.objectContaining({ localId: 'replacement-input',
            stagedMediaHandles: preparedMedia.stagedMediaHandles, stagedMediaReleaseIntents: preparedMedia.stagedMediaReleaseIntents,
            sessionMediaMetadata: preparedMedia.sessionMediaMetadata,
        })]);
        const writes = homes.requestsFor(path);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ serverId });
        expect(patchBodies[0]).toMatchObject({ content: { t: 'plain', v: {
            role: 'user', content: { type: 'text', text: 'After' },
            meta: { happierStructuredInputV1: { v: 1, composerAttachments: [attachment] },
                happier: preparedMedia.sessionMediaMetadata?.envelope },
        } }, replacementLocalId: 'replacement-input' });
        expect(storage.getState().sessionPending[input.sessionId]?.messages).toMatchObject([
            { localId: 'replacement-input', text: 'After' },
        ]);
    });

    it('edits an exact loaded second-Home Pending row without borrowing the focused Account', async () => {
        const targetServerId = await homes.addHome({ name: 'Other Pending Home', serverUrl: 'https://other-pending.test',
            accountId: 'other-pending-owner', active: false });
        const scope = { serverId: targetServerId, accountId: 'other-pending-owner' };
        const session = createSessionFixture({ id: 'pending-edit-session', serverId: targetServerId, encryptionMode: 'plain',
            metadata: { path: '/repo', host: 'other-machine', machineId: 'pending-machine', flavor: 'claude' } });
        storage.setState({ sessions: { [session.id]: session } });
        storage.getState().upsertPendingMessage(session.id, { id: 'queued-input', localId: 'queued-input', text: 'Other original',
            source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: scope, createdAt: 1, updatedAt: 1,
            rawRecord: { role: 'user', content: { type: 'text', text: 'Other original' }, meta: {} } });
        homes.answer(targetServerId, `GET /v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
        homes.answer(targetServerId, `PATCH ${path}`, { body: { ok: true, localId: 'queued-input' } });
        expect(storage.getState().profileScope).toEqual({ serverId, accountId: 'pending-owner' });
        const result = await createDefaultActionExecutor().execute(ActionIdSchema.parse('session.pending.edit'), {
            sessionId: session.id, localId: 'queued-input', text: 'Other edited', structuredInput: { v: 1 },
        }, { surface: 'ui', authority: 'present_user', serverId: targetServerId, expectedAccountId: scope.accountId });
        expect(result.ok, result.ok ? '' : result.errorCode).toBe(true);
        expect(result).toMatchObject({ ok: true, result: { status: 'accepted', localId: 'queued-input' } });
        expect(homes.requestsFor(path)).toMatchObject([{ serverId: targetServerId }]);
        expect(settlement).toEqual(['queued-input']);
    });

    it('retains the original queued input when the daemon refuses structured-input admission', async () => {
        rejectPreparation = true;
        const result = await createDefaultActionExecutor().execute(ActionIdSchema.parse('session.pending.edit'), {
            sessionId: 'pending-edit-session', localId: 'queued-input', text: 'After', structuredInput: { v: 1 },
        }, { surface: 'ui', authority: 'present_user', serverId });
        expect(result).toMatchObject({ ok: false, errorCode: 'composer_attachment_unavailable' });
        expect(homes.requestsFor(path)).toEqual([]);
        expect(storage.getState().sessionPending['pending-edit-session']?.messages[0]?.text).toBe('Before');
    });

    it('keeps a durable PATCH accepted when post-accept custody notification fails', async () => {
        failSettlement = true;
        const result = await createDefaultActionExecutor().execute(ActionIdSchema.parse('session.pending.edit'), {
            sessionId: 'pending-edit-session', localId: 'queued-input', text: 'After', structuredInput: { v: 1 },
        }, { surface: 'ui', authority: 'present_user', serverId });
        expect(result).toMatchObject({ ok: true, result: { status: 'accepted', localId: 'queued-input', settlement: 'failed' } });
        expect(homes.requestsFor(path)).toHaveLength(1);
        expect(storage.getState().sessionPending['pending-edit-session']?.messages[0]?.text).toBe('After');
    });

    it('abandons prepared media when a mounted edit changes during daemon preparation', async () => {
        prepareGate = createDeferred<void>();
        includeCleanup = true;
        const ref = { kind: 'pendingMessage', sessionId: 'pending-edit-session', localId: 'queued-input' } as const;
        const owner = createPendingMessageComposerDocumentOwner({ ref, initialDocument: {
            text: 'After', structuredInputMentions: [], composerAttachments: [],
        }, isCurrent: () => true });
        try {
            const revision = owner.read().revision;
            const action = executePendingMessageEditWithActionApproval({
                input: { sessionId: ref.sessionId, localId: ref.localId, text: 'After', structuredInput: { v: 1 } },
                context: { surface: 'ui', authority: 'present_user', serverId }, scope: { serverId, accountId: 'pending-owner' },
                isCurrent: () => owner.read().revision === revision, registerApproval: () => { throw new Error('Unexpected approval'); },
                signal: new AbortController().signal,
            });
            await prepareStarted.promise;
            owner.apply(revision, { text: 'Newer draft', references: [], attachments: [] });
            prepareGate.resolve(undefined);
            expect(await action).toMatchObject({ status: 'rejected' });
            expect(homes.requestsFor(path)).toEqual([]);
            expect(abandonments).toEqual(['queued-input']);
        } finally { prepareGate.resolve(undefined); }
    });

    it('retires an abandoned UI edit even if another editor occupies the same pending identity', async () => {
        prepareGate = createDeferred<void>();
        includeCleanup = true;
        let originalEditorCurrent = true;
        const action = executePendingMessageEditWithActionApproval({
            input: { sessionId: 'pending-edit-session', localId: 'queued-input', text: 'Abandoned content', structuredInput: { v: 1 } },
            context: { surface: 'ui', authority: 'present_user', serverId }, scope: { serverId, accountId: 'pending-owner' },
            isCurrent: () => originalEditorCurrent, registerApproval: () => { throw new Error('Unexpected approval'); },
            signal: new AbortController().signal,
        });
        await prepareStarted.promise;
        originalEditorCurrent = false;
        prepareGate.resolve(undefined);
        expect(await action).toMatchObject({ status: 'rejected' });
        expect(homes.requestsFor(path)).toEqual([]);
        expect(abandonments).toEqual(['queued-input']);
    });

    it.each(['off', 'ask'] as const)('obeys %s at real Action admission before preparing or patching content', async policy => {
        const actionId = ActionIdSchema.parse('session.pending.edit');
        const actionsSettingsV1 = normalizeActionsSettingsV1({ v: 1, actions: {
            [actionId]: policy === 'off' ? { enabled: false } : { approvalRequiredSurfaces: ['ui'] },
        } });
        // The mounted Account reads its live settings owner, while background callers read HTTP.
        storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1 } });
        homes.answer(serverId, '/v2/account/settings', { body: AccountSettingsV2GetResponseSchema.parse({
            content: { t: 'plain', v: { actionsSettingsV1 } }, version: 1,
        }) });
        vi.mocked(Modal.confirm).mockResolvedValueOnce(false);
        const result = await createDefaultActionExecutor().execute(actionId, {
            sessionId: 'pending-edit-session', localId: 'queued-input', text: 'After', structuredInput: { v: 1 },
        }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId });
        expect(result).toMatchObject({ ok: false, errorCode: policy === 'off' ? 'action_disabled' : 'approval_canceled' });
        expect(Modal.confirm).toHaveBeenCalledTimes(policy === 'ask' ? 1 : 0);
        expect(homes.artifacts(serverId).list()).toHaveLength(0);
        expect(preparedLocalId).toBe('');
        expect(homes.requestsFor(path)).toEqual([]);
    });
});
