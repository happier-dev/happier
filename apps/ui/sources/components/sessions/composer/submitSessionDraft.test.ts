import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { actionSpecToActionDefinitionV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { projectSessionInputReferencesV1 } from '@happier-dev/protocol/sessions/messages/sessionInputReferenceProjectionV1';
import { buildUploadedAttachment } from '@happier-dev/protocol/messages/structured/sessionAttachmentsInputV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { SessionAttachmentUploadInitRequestV1Schema } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentUploadInitRequestV1';
import { StructuredImageInputV1Schema } from '@happier-dev/protocol/runtime/input/imageInputV1';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionFixture, installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let daemonAnswer: (request: SocketRpcRequestPayload) => unknown = () => { throw new Error('Unexpected daemon request'); };
installSessionActionRpcBoundary(request => daemonAnswer(request));
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { createExistingSessionComposerDocumentOwner } = await import('./existingSessionComposerDocumentOwner');
const { captureSessionDraftCurrentness, getOrCreateSessionMessagingDraftMutationAttempt, resetSessionDraftRepositoryForTests } =
    await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { writeSessionAttachmentDrafts, readSessionAttachmentDrafts, resolveSessionAttachmentDraftScope } =
    await import('@/components/sessions/attachments/sessionAttachmentDraftStore');
const { submitSessionDraft } = await import('./submitSessionDraft');
const originalState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId = '';
const sessionId = 'capture-destination';
const target = () => ({ serverId, accountId: 'alice', sessionId });

beforeEach(async () => {
    daemonAnswer = () => { throw new Error('Unexpected daemon request'); };
    await (await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage')).prepareSessionDraftPersistenceStorage();
    await homes.reset();
    storage.setState(originalState, true);
    const credentials = { token: createAccountTokenForTests('alice', { currentAccount: true }) };
    serverId = await homes.addHome({ name: 'Capture destination', serverUrl: 'https://capture-submit.test',
        serverIdentityId: 'srv_capture_home', accountId: 'alice', credentials });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://capture-submit.test', accountId: 'alice',
        serverIdentityId: 'srv_capture_home', credentials,
        request: createSessionReadBatchFetchBoundary(homes.request) });
    serverId = connection.serverId;
    storage.getState().activateProfileScope({ serverId, accountId: 'alice' });
    await storage.getState().activateSettingsScope({ serverId, accountId: 'alice' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    installSessionActionFixture({ homes, storage, serverId, session: { id: sessionId } });
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const machine = { ...createPlainMachineRowFixture({ id: 'machine_1', accountId: 'alice' }),
        installationId: 'capture-installation', installationPublicKey: encodeBase64(installation.publicKey),
        operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1 };
    homes.answer(serverId, '/v1/machines', { body: [machine] });
    homes.answer(serverId, '/v1/machines/machine_1', { body: { machine } });
    // This Session uses an ordinary enrolled machine, with no managed wake to admit.
    homes.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [] } });
    for (const actionId of ['action.spec.get', 'session.message.send'] as const) {
        homes.answer(serverId, `/v1/actions/${actionId}/execution-authorization`, { select: body => {
            const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            return { body: { v: 1, token: 'capture-root', binding: { accountId: 'alice', authentication: { kind: 'account', tokenEpoch: 0 },
                serverIdentityId: 'srv_capture_home', machineId: 'machine_1', installationId: 'capture-installation', custodianAccountId: 'alice',
                accountEncryptionMode: 'plain', actionId, requestId: authorized.envelope.requestId,
                target: authorized.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(authorized.envelope) } } };
        } });
    }
    homes.answer(serverId, '/v1/actions/action.spec.get', { select: body => {
        const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        return { body: { v: 1, actionId: 'action.spec.get', requestId: authorized.envelope.requestId, execution: { ok: true,
            result: { actionSpec: actionSpecToActionDefinitionV1(getActionSpec('session.message.send'), { surface: 'ui', includeOutputSchema: false }) } } } };
    } });
});

afterEach(async () => {
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    resetSessionDraftRepositoryForTests();
    writeSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(target()), []);
    storage.setState(originalState, true);
});

describe('submitSessionDraft', () => {
    it.each([
        { fresh: true, includeWindowText: false }, { fresh: true, includeWindowText: true },
        { fresh: false, includeWindowText: false }, { fresh: false, includeWindowText: true },
    ])('starts frontmost through shared delivery with fresh=$fresh and included text=$includeWindowText', async ({ fresh, includeWindowText }) => {
        const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
        const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');
        const { isApprovalRequiredByActionsSettings } = await import('@happier-dev/protocol/actions/actionApprovalPolicy');
        const { createNativeScreenCaptureAction } = await import('@/sync/ops/actions/screenCaptureActions');
        const { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } = await import(
            '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption');
        const bytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX7sAAAAASUVORK5CYII=', 'base64'));
        const recipient = createTransferRecipientKeyPair();
        const nativeCommands: string[] = [];
        const secureStorage = createDesktopSecureStorageBoundary();
        const transferred: number[] = [];
        let uploadCount = 0;
        let prepared = !fresh;
        const windowText = { status: 'ready', text: 'Only explicitly disclosed text', source: null } as const;
        const captured = { captureRef: 'frontmost', kind: 'still', path: '/Pictures/Happier/frontmost.png',
            mimeType: 'image/png', byteSize: bytes.length, pixelSize: { width: 1, height: 1 }, scale: 1,
            origin: null, source: null, windowTextRef: null, disclosure: null };
        const owner = createExistingSessionComposerDocumentOwner({ scope: target(), ref: { kind: 'session', sessionId } });
        const before = owner.read().document;
        storage.setState(state => ({ localSettings: { ...state.localSettings,
            screenCaptureIncludeWindowText: fresh ? includeWindowText : !includeWindowText } }));
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command.startsWith('desktop_secure_storage_')) return secureStorage.invoke(command, args);
            nativeCommands.push(command);
            if (command === 'desktop_capture_start') {
                expect(args).toMatchObject({ mode: 'still', target: { kind: 'frontmost' }, targetSession: target(), presentCaptureWindow: false });
                return { status: 'completed', operationRef: 1, result: captured };
            }
            if (command === 'desktop_capture_read_result') return captured;
            if (command === 'desktop_capture_read_delivery_state') return { inUse: false,
                disclosure: fresh ? null : { hasMarks: true, includeWindowText }, windowText: fresh ? null : windowText };
            if (command === 'desktop_capture_read_source_png') {
                if (args?.captureRef === captured.captureRef) expect(fresh).toBe(true);
                else expect(args?.captureRef).toBe('frontmost-retained');
                return Array.from(bytes);
            }
            if (command === 'desktop_capture_retain_prepared_png') {
                expect(prepared).toBe(true);
                return { ...captured, captureRef: 'frontmost-retained' };
            }
            if (command === 'desktop_capture_read_prepared_png') return Array.from(bytes);
            if (command === 'desktop_capture_write_prepared_png') {
                expect(args?.disclosure).toEqual({ hasMarks: false, includeWindowText });
                expect(args?.bytes).toEqual(Array.from(bytes)); prepared = true;
                return { captureRef: captured.captureRef, path: '/Pictures/Happier/frontmost-prepared.png', mimeType: 'image/png', byteSize: bytes.length,
                    pixelSize: captured.pixelSize };
            }
            if (command === 'desktop_capture_window_text') {
                if (!prepared) throw 'blurred_capture';
                return windowText;
            }
            if (command === 'desktop_capture_settle') return { status: 'idle' };
            throw new Error('Unexpected desktop command');
        } });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await TokenStorage.setCredentialsForServerUrl('https://capture-submit.test', { serverId },
            { token: createAccountTokenForTests('alice', { currentAccount: true }) });
        daemonAnswer = async request => {
            expect(prepared).toBe(true);
            if (request.method === `${sessionId}:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT}`) {
                const input = SessionAttachmentUploadInitRequestV1Schema.parse(request.params);
                expect(input.fileName).toBe('frontmost.png'); uploadCount += 1;
                return { success: true, uploadId: 'frontmost-upload', chunkSizeBytes: bytes.length,
                    recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 };
            }
            if (request.method === `${sessionId}:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK}`) {
                const chunk = request.params as { uploadId: string; index: number; payloadBase64: string; encryptedDataKeyEnvelopeBase64: string };
                transferred.push(...await decryptEncryptedTransferChunkEnvelope({ transferId: chunk.uploadId,
                    sequence: chunk.index, payloadBase64: chunk.payloadBase64, encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64,
                    recipientSecretKeySeed: recipient.recipientSecretKeySeed }));
                return { success: true };
            }
            if (request.method === `${sessionId}:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE}`) return { success: true,
                path: 'frontmost.png', sizeBytes: transferred.length, sha256: 'b'.repeat(64),
                attachmentHandle: { v: 1, sessionId, id: 'frontmost-upload' } };
            throw new Error('Unexpected daemon method');
        };
        const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'screenCapture.start': ['agent'] } });
        let executionError: unknown;
        const captureAction = createNativeScreenCaptureAction();
        try {
            const result = await createActionExecutor(createActionExecutorBoundaryFixture({ screenCaptureAction: async args => {
                try { return await captureAction(args); } catch (error) { executionError = error; throw error; }
            },
                isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context) }))
                .execute('screenCapture.start', { mode: 'screenshot', target: { kind: 'frontmost' } }, { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
                    serverId, runtimeAccountId: 'alice', defaultSessionId: sessionId, defaultSessionMachineId: 'machine_1' });
            expect(executionError).toBeUndefined();
            expect(result).toMatchObject({ ok: true, result: { captureRef: 'frontmost', media: { mediaKind: 'image', mediaId: 'frontmost-upload',
                file: { sessionId, storage: 'session', path: 'frontmost.png', sha256: 'b'.repeat(64) } } } });
            expect(uploadCount).toBe(1);
            expect(transferred).toEqual(Array.from(bytes));
            expect(owner.read().document).toEqual(before);
            if (includeWindowText) expect(result).toMatchObject({ result: { windowText: { text: windowText.text } } });
            else expect(result.ok && result.result).not.toHaveProperty('windowText');
            expect(nativeCommands.filter(command => command === 'desktop_capture_read_delivery_state')).toHaveLength(1);
            expect(nativeCommands).not.toContain('desktop_capture_read_result');
            expect(nativeCommands).not.toContain('desktop_capture_open');
            expect(nativeCommands.filter(command => command === 'desktop_capture_retain_prepared_png')).toHaveLength(1);
            expect(nativeCommands.filter(command => command === 'desktop_capture_read_source_png')).toHaveLength(fresh ? 2 : 1);
            if (!fresh) {
                expect(nativeCommands).not.toContain('desktop_capture_window_text');
            } else {
                expect(nativeCommands.indexOf('desktop_capture_write_prepared_png')).toBeGreaterThan(nativeCommands.indexOf('desktop_capture_read_source_png'));
                expect(nativeCommands.filter(command => command === 'desktop_capture_window_text')).toHaveLength(includeWindowText ? 1 : 0);
            }
        } finally { vi.unstubAllGlobals(); }
    });

    it('uploads selected recording frames and video with clip-relative notes and sends their whole unmounted draft once', async () => {
        const { appendToSessionDraft } = await import('./appendToSessionDraft');
        const { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } = await import(
            '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption');
        const recipient = createTransferRecipientKeyPair();
        const scope = target();
        const owner = createExistingSessionComposerDocumentOwner({ scope, ref: { kind: 'session', sessionId } });
        const names = ['first.png', 'second.png', 'clip.mp4'];
        const mimeTypes = ['image/png', 'image/png', 'video/mp4'];
        const imageBytes = [
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX7sAAAAASUVORK5CYII=',
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        ].map(encoded => new Uint8Array(Buffer.from(encoded, 'base64')));
        // This boundary proves exact transfer bytes, not codec validity or frame extraction.
        const payloadBytes = [...imageBytes, new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109])];
        owner.replaceDocument({ text: 'Existing words', composerAttachments: [], structuredInputMentions: [] });
        const beforeAppend = owner.read();
        const changed = vi.fn();
        const unobserve = owner.observe(changed);
        let appended;
        try {
            appended = appendToSessionDraft({ sessionTarget: scope, items: [
                { kind: 'image', source: { kind: 'memory', name: names[0]!, mimeType: mimeTypes[0]!, bytes: payloadBytes[0]! },
                    note: '0:00.000 — First selected moment' },
                { kind: 'image', source: { kind: 'memory', name: names[1]!, mimeType: mimeTypes[1]!, bytes: payloadBytes[1]! },
                    note: '0:01.250 — Inspect this moment' },
                { kind: 'video', source: { kind: 'memory', name: names[2]!, mimeType: mimeTypes[2]!, bytes: payloadBytes[2]! } },
            ] });
        } finally { unobserve(); }
        expect(appended).toMatchObject({ status: 'applied', revision: beforeAppend.revision + 1, imageNumbers: [1, 2] });
        expect(changed).toHaveBeenCalledOnce();
        if (appended.status !== 'applied') throw new Error('Expected one recording batch append');
        const ids = appended.attachmentIds;
        expect(ids).toHaveLength(3);
        const text = owner.read().document.text;
        const uploads = new Map<string, Readonly<{
            request: ReturnType<typeof SessionAttachmentUploadInitRequestV1Schema.parse>;
            bytes: number[];
        }>>();
        const finalized: string[] = [];
        daemonAnswer = async request => {
            if (request.method === `${sessionId}:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT}`) {
                const input = SessionAttachmentUploadInitRequestV1Schema.parse(request.params);
                const uploadId = `fresh-upload-${uploads.size + 1}`;
                uploads.set(uploadId, { request: input, bytes: [] });
                return { success: true, uploadId, chunkSizeBytes: Math.max(...payloadBytes.map(bytes => bytes.length)),
                    recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 };
            }
            if (!request.params || typeof request.params !== 'object' || !('uploadId' in request.params)
                || typeof request.params.uploadId !== 'string') throw new Error('Expected upload transfer identity');
            const uploadId = request.params.uploadId;
            const upload = uploads.get(uploadId);
            if (!upload) throw new Error('Unknown upload transfer identity');
            if (request.method === `${sessionId}:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK}`) {
                const chunk = request.params;
                if (!('index' in chunk) || typeof chunk.index !== 'number'
                    || !('payloadBase64' in chunk) || typeof chunk.payloadBase64 !== 'string'
                    || !('encryptedDataKeyEnvelopeBase64' in chunk) || typeof chunk.encryptedDataKeyEnvelopeBase64 !== 'string') {
                    throw new Error('Expected encrypted transfer chunk');
                }
                upload.bytes.push(...await decryptEncryptedTransferChunkEnvelope({ transferId: uploadId,
                    sequence: chunk.index, payloadBase64: chunk.payloadBase64,
                    encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64,
                    recipientSecretKeySeed: recipient.recipientSecretKeySeed }));
                return { success: true };
            }
            if (request.method === `${sessionId}:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE}`) {
                finalized.push(request.params.uploadId);
                return { success: true, path: `${upload.request.fileName}`, sizeBytes: upload.bytes.length, sha256: 'a'.repeat(64),
                    attachmentHandle: { v: 1, sessionId, id: request.params.uploadId } };
            }
            throw new Error(`Unexpected upload method: ${request.method}`);
        };
        const sent: Array<ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>['envelope']> = [];
        homes.answer(serverId, '/v1/actions/session.message.send', { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            if (request.envelope.v !== 1) throw new Error('Plain Account must send a plain Action envelope');
            const input = request.envelope.input;
            if (!input || typeof input !== 'object' || !('localId' in input) || typeof input.localId !== 'string') {
                throw new Error('Expected message admission identity');
            }
            sent.push(request.envelope);
            return { body: { v: 1, actionId: 'session.message.send', requestId: request.envelope.requestId,
                execution: { ok: true, result: SessionMessageSendResultV1Schema.parse({ status: 'accepted', localId: input.localId }) } } };
        } });
        const result = await submitSessionDraft({ sessionTarget: scope });
        expect(result).toMatchObject({ ok: true, result: { status: 'accepted' } });
        expect(uploads.size).toBe(3);
        expect(finalized).toEqual(['fresh-upload-1', 'fresh-upload-2', 'fresh-upload-3']);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ input: { message: text,
            structuredInput: { sessionAttachments: finalized.map(id => ({ v: 1, sessionId, id })) } } });
        expect(JSON.stringify(sent[0])).not.toContain('desktopPath');
        for (const [index, upload] of [...uploads.values()].entries()) {
            expect(upload.request).toMatchObject({ attachmentId: ids[index], fileName: names[index],
                messageLocalId: result.ok ? result.result.localId : null });
            expect(upload.bytes).toEqual([...payloadBytes[index]!]);
        }
        const descriptors = [...uploads.values()].map((upload, index) => buildUploadedAttachment({ id: String(upload.request.attachmentId),
            name: String(upload.request.fileName), path: String(upload.request.fileName), sizeBytes: upload.bytes.length, mimeType: mimeTypes[index] }));
        expect(projectSessionInputReferencesV1({ text, references: { uploads: descriptors,
            imageInputs: descriptors.flatMap(upload => upload.structuredInput ? [StructuredImageInputV1Schema.parse(upload.structuredInput)] : []) } }).text.trimEnd())
            .toBe('Existing words\n\n[Image #1] 0:00.000 — First selected moment\n\n[Image #2] 0:01.250 — Inspect this moment\n\n[File: clip.mp4]');
        expect(owner.read().document.text).toBe('');
        expect(readSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(scope))).toEqual([]);
    });

    it('sends the whole unmounted draft once, retains issued uploads on failure, and clears only after accepted retry', async () => {
        const scope = target();
        const ref = { kind: 'session', sessionId } as const;
        const owner = createExistingSessionComposerDocumentOwner({ scope, ref });
        const text = 'Existing words\n\n[Image #1](happier-ref:attachment:first) first note\n\n[Image #2](happier-ref:attachment:second) second note';
        const mentions = ['first', 'second'].map((id, index) => {
            const tokenText = `[Image #${index + 1}](happier-ref:attachment:${id})`;
            const start = text.indexOf(tokenText);
            return { kind: 'attachment', ref: `attachment:${id}`, label: `Image #${index + 1}`, tokenText, start, end: start + tokenText.length };
        });
        owner.replaceDocument({ text, structuredInputMentions: mentions, composerAttachments: [] });
        const attempt = getOrCreateSessionMessagingDraftMutationAttempt({ scope, sessionId,
            currentness: captureSessionDraftCurrentness({ scope, address: ref }), intent: { kind: 'send', target: sessionId } });
        expect(attempt).not.toBeNull();
        writeSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(scope), ['first', 'second'].map(id => ({ id, status: 'pending',
            source: { kind: 'memory', name: `${id}.png`, bytes: new Uint8Array([1, 2]), mimeType: 'image/png' },
            targetUploadedCheckpoints: [{ id, target: scope, executionTarget: { serverId, machineId: 'machine_1' },
                messageLocalId: attempt!.localId, uploadedPath: `${id}.png`, uploadedSizeBytes: 2,
                uploadedMimeType: 'image/png', attachmentHandle: { v: 1, sessionId, id } }],
        })));
        const sent: Array<ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>['envelope']> = [];
        let accepted = false;
        homes.answer(serverId, '/v1/actions/session.message.send', { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            sent.push(request.envelope);
            return { body: { v: 1, actionId: 'session.message.send', requestId: request.envelope.requestId,
                execution: accepted ? { ok: true, result: SessionMessageSendResultV1Schema.parse({ status: 'accepted', localId: attempt!.localId }) }
                    : { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' } } };
        } });
        const refused = await submitSessionDraft({ sessionTarget: scope });
        expect(refused).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(owner.read().document.text).toBe(text);
        expect(readSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(scope))).toHaveLength(2);
        accepted = true;
        expect(await submitSessionDraft({ sessionTarget: scope })).toMatchObject({ ok: true, result: { status: 'accepted', localId: attempt!.localId } });
        expect(sent).toHaveLength(2);
        for (const envelope of sent) expect(envelope).toMatchObject({ input: { message: text, localId: attempt!.localId,
            structuredInput: { sessionAttachments: [{ id: 'first', sessionId }, { id: 'second', sessionId }] } } });
        // Attachment tokens bind through issued upload selections, not the generic mention wire.
        // Consume the same typed remote descriptors through the actual provider marker owner.
        const uploads = ['first', 'second'].map(id => buildUploadedAttachment({ id, name: `${id}.png`,
            path: `${id}.png`, sizeBytes: 2, mimeType: 'image/png', attachmentHandle: { v: 1, sessionId, id } }));
        const projected = projectSessionInputReferencesV1({ text, references: { uploads,
            imageInputs: uploads.flatMap(upload => upload.structuredInput ? [StructuredImageInputV1Schema.parse(upload.structuredInput)] : []) } });
        expect(projected.text).toBe('Existing words\n\n[Image #1] first note\n\n[Image #2] second note');
        expect(owner.read().document.text).toBe('');
        expect(readSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(scope))).toEqual([]);
    });
});
