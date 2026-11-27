import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import axios, { AxiosError } from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveAccountMachineKeyFromRecoverySecret, deriveBoxPublicKeyFromSeed, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { ExternalActionRequestEnvelopeSchema, ExternalActionResponseEnvelopeV1Schema, openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { configuration } from '@/configuration';
import { writeDaemonState } from '@/persistence';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { reconcileExternalActionTarget } from '@/daemon/externalActions/reconcileExternalActionTarget';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { createCurrentSessionProjectionRecordFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { decryptSessionPayload, encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

const network = vi.hoisted(() => ({ observe: undefined as
    ((auth: Record<string, unknown>) => ReturnType<typeof createApiSessionSocketStub>) | undefined }));
vi.mock('socket.io-client', async importOriginal => {
    const socketIo = await importOriginal<typeof import('socket.io-client')>();
    return { ...socketIo, io: (url: string, options: Parameters<typeof socketIo.io>[1]) =>
        network.observe ? network.observe(options?.auth as Record<string, unknown>) : socketIo.io(url, options) };
});

describe('original CLI Session Action delivery', () => {
    afterEach(() => { network.observe = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
    it.each(['editor', 'inactive editor', 'viewer', 'outsider', 'archived editor', 'owner',
        'terminal owner after Machine use withdrawal',
        'terminal owner reply-wait after Machine use withdrawal'] as const)(
        'sends to a live shared encrypted Session with the correct admission route for %s', async role => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-cli-shared-send-' }, async () => {
            const replyWait = role === 'terminal owner reply-wait after Machine use withdrawal';
            const withdrawn = role === 'terminal owner after Machine use withdrawal' || replyWait;
            const owner = role === 'owner' || withdrawn;
            const accountId = owner ? 'alice' : 'bob';
            const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 4,
                provenance: withdrawn ? { v: 1, kind: 'terminal', authority: 'account_automation' }
                    : { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const machineKey = new Uint8Array(32).fill(17);
            const publicKey = nacl.box.keyPair.fromSecretKey(machineKey).publicKey;
            const credentials = { token, credentialProvenance: 'stored_session' as const,
                encryption: { type: 'dataKey' as const, machineKey, publicKey } };
            const sessionId = 'cmwiqxdcs00r2mcnz01awx7f5';
            const sessionKey = new Uint8Array(32).fill(21);
            const session = createSessionRecordFixture({ id: sessionId, active: role !== 'inactive editor' && role !== 'archived editor', encryptionMode: 'e2ee',
                ...(role === 'archived editor' ? { archivedAt: 42 } : {}),
                metadataLayoutVersion: 1,
                metadata: encryptSessionPayload({ ctx: { encryptionKey: sessionKey, encryptionVariant: 'dataKey' }, payload: { v: 1 } }),
                dataEncryptionKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: sessionKey, recipientPublicKey: publicKey,
                    randomBytes: length => new Uint8Array(length).fill(22) })).toString('base64'),
                ...(owner ? { share: null, machineId: 'alice-machine',
                    ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
                        material: credentials.encryption, ownerMetadata: { v: 1 },
                        randomBytes: length => new Uint8Array(length).fill(23),
                    }) }
                    : { share: { accessLevel: role === 'viewer' ? 'view' : 'edit', canApprovePermissions: false } }) });
            const actionId = 'session.message.send';
            const input = { sessionId, message: 'Shared Bot request',
                reply: replyWait ? 'wait' : 'none', localId: 'shared-input',
                ...(replyWait ? {} : { requestedAction: { v: 1, kind: 'enqueue' } }) };
            const restoredInputPath = `/v2/sessions/${sessionId}/messages/by-local-id/restored-input`;
            const replyProgress = { v: 1, mode: 'wait', disposition: 'observing', outcome: { kind: 'pass' } };
            const reads = vi.spyOn(axios, 'get').mockImplementation(async url => {
                if (url.endsWith(`/v2/sessions/${sessionId}`)) {
                    if (role === 'outsider') return { status: 404, data: { error: 'session-not-found' } };
                    return { status: 200, data: { session } };
                }
                if (role === 'outsider' && /\/v2\/sessions(?:\/archived)?\?/.test(url)) {
                    return { status: 200, data: { sessions: [], nextCursor: null, hasNext: false } };
                }
                if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'e2ee', version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
                if (replyWait && url.endsWith(`/v2/sessions/${sessionId}/messages/reply-capability`)) {
                    return { status: 200, data: { v: 1, protocolVersions: [1] } };
                }
                if (replyWait && url.endsWith(restoredInputPath)) return { status: 404, data: { error: 'message-not-found' } };
                if (replyWait && url.endsWith(`${restoredInputPath}/reply`)) {
                    return { status: 200, data: { v: 1, status: 'available', progress: replyProgress } };
                }
                throw new Error(`Unexpected Home read: ${url}`);
            });
            let machineUseWithdrawn = withdrawn;
            const delivered = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
                if (role === 'outsider' && url.endsWith('/lookup-by-tags')) {
                    return { status: 200, data: { sessions: [] } };
                }
                if (withdrawn && url === `https://home.test/v1/actions/${actionId}`) {
                    return { status: 409, data: { error: 'invalid_request', code: 'target_unavailable' } };
                }
                if (replyWait && url.endsWith(`${restoredInputPath}/reply`)) {
                    expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
                    expect(body).toEqual({ kind: 'inline' });
                    return { status: 200, data: { v: 1, ok: true, progress: { ...replyProgress, disposition: 'inline' } } };
                }
                if (role === 'owner') {
                    expect(url).toBe(`https://home.test/v1/actions/${actionId}`);
                    const envelope = ExternalActionRequestEnvelopeSchema.parse(body);
                    if (envelope.v !== 2) throw new Error('Expected encrypted Machine delivery');
                    const target = { kind: 'session' as const, sessionId };
                    expect(envelope.target).toEqual(target);
                    const binding = { serverIdentityId: 'srv_home', accountId,
                        authentication: { kind: 'account' as const, tokenEpoch: 4 }, actionId, requestId: envelope.requestId, target };
                    const material = { type: 'dataKey' as const, machineKey };
                    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                        envelope, binding, material })?.input).toEqual(input);
                    return { status: 200, data: prepareExternalActionResponseV2({ request: envelope, binding, material,
                        executedMachineId: 'alice-machine', randomBytes: length => new Uint8Array(length).fill(6),
                        execution: { ok: true, result: { status: 'accepted', localId: input.localId } } }).response };
                }
                expect(url).toBe(`https://home.test/v2/sessions/${sessionId}/pending`);
                expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
                if (machineUseWithdrawn) throw Object.assign(new Error('Publisher binding unavailable'), { response: {
                    status: 403, data: { error: 'forbidden', code: 'session_input_machine_binding_unavailable' },
                } });
                if (role === 'viewer') throw Object.assign(new Error('Forbidden'), { response: { status: 403, data: { error: 'forbidden' } } });
                expect(body).toMatchObject({ localId: withdrawn ? 'restored-input' : input.localId,
                    requestedAction: { v: 1, kind: replyWait ? 'steer_if_active' : 'enqueue' } });
                if (replyWait) expect(body).toHaveProperty('reply.mode', 'wait');
                expect(body).not.toHaveProperty('e2eeTag');
                if (withdrawn) expect(body).toHaveProperty('targetMachineId', 'alice-machine');
                else expect(body).not.toHaveProperty('targetMachineId');
                const opened = decryptSessionPayload({ ctx: { encryptionKey: sessionKey, encryptionVariant: 'dataKey' },
                    ciphertextBase64: body.ciphertext });
                expect(opened).toMatchObject({ content: { text: input.message } });
                expect(opened).not.toHaveProperty('meta.happierInputRequestV1.actionRequestAttributionV1');
                return { status: 200, data: { didWrite: true, terminal: false } };
            });
            const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true, serverId: configuration.activeServerId,
                serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({
                    v: 1, approvalWaivedSurfaces: { [actionId]: ['cli'] },
                }) } });
            const result = await executor.execute(actionId, input, { surface: 'cli' });
            if (withdrawn) {
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true,
                    result: { status: 'rejected', code: 'session_input_machine_binding_unavailable' } });
                expect(delivered.mock.calls.map(([url]) => url)).toEqual([`https://home.test/v2/sessions/${sessionId}/pending`]);
                expect(reads.mock.calls.filter(([url]) => new URL(url).pathname.startsWith('/v1/machines'))).toEqual([]);
                machineUseWithdrawn = false;
                expect(await executor.execute(actionId, { ...input, localId: 'restored-input' }, { surface: 'cli' }))
                    .toMatchObject({ ok: true, result: replyWait ? { status: 'replied', localId: 'restored-input', outcome: { kind: 'pass' } }
                        : { status: 'accepted', localId: 'restored-input' } });
                return;
            }
            if (role === 'outsider' || role === 'archived editor') {
                expect(result).toEqual({ ok: true, result: { status: 'rejected', code: 'session_input_target_unavailable',
                    failureCause: expect.objectContaining({ phase: 'session.message.target_lookup', errorCode: 'session_input_target_unavailable', httpStatus: null }),
                } });
                expect(delivered.mock.calls.filter(([url]) => !url.endsWith('/lookup-by-tags'))).toEqual([]);
                return;
            }
            if (role === 'viewer') {
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true,
                    result: { status: 'rejected', code: 'session_input_unauthorized' } });
                expect(delivered).toHaveBeenCalledOnce();
                return;
            }
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true,
                result: { status: 'accepted', localId: input.localId } });
            expect(delivered).toHaveBeenCalledOnce();
        });
    });
    it.each([
        ['session.status.get', false], ['session.activity.get', false],
        ['session.status.get', true], ['session.activity.get', true],
    ] as const)(
        'reads archived shared Session status without the owner publisher metadata or worker (%s, external client %s)', async (actionId, externalActionClient) => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-cli-shared-status-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'recipient', tokenEpoch: 4,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            const sessionId = 'cmwiqxdcs00r2mcnz01awx7f5';
            // Shared detail intentionally excludes owner-only Machine/workspace metadata.
            const session = createSessionRecordFixture({ id: sessionId, active: false, archivedAt: 123,
                encryptionMode: 'plain', metadata: JSON.stringify({}),
                share: { accessLevel: 'view', canApprovePermissions: false } });
            const reads: string[] = [];
            vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
                reads.push(url);
                expect(options?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
                if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session } };
                if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                throw new Error(`Unexpected Home read: ${url}`);
            });
            const dispatch = vi.spyOn(axios, 'post').mockRejectedValue(new Error('unexpected worker admission'));
            const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient, serverId: configuration.activeServerId,
                serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            const input = actionId === 'session.status.get' ? { sessionId, live: false } : { sessionId, view: 'awareness' };
            const result = await executor.execute(actionId, input, { surface: 'cli' });
            expect(result, JSON.stringify(result))
                .toMatchObject({ ok: true, result: actionId === 'session.status.get'
                    ? { session: { id: sessionId, archivedAt: 123 } } : { sessionId } });
            expect(dispatch).not.toHaveBeenCalled();
            expect(reads.filter(url => /\/v1\/(?:machines|actions)(?:\/|$)/.test(url))).toEqual([]);
        });
    });
    it.each([
        { actionId: 'session.archive', mode: 'plain' },
        { actionId: 'session.archive', mode: 'e2ee' },
        { actionId: 'session.unarchive', mode: 'plain' },
        { actionId: 'session.unarchive', mode: 'e2ee' },
    ] as const)('changes its own inactive record without worker admission ($actionId, $mode)', async ({ actionId, mode }) => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-cli-archive-withdrawn-worker-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'recipient', tokenEpoch: 4,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const secret = new Uint8Array(32).fill(17);
            const credentials = { token, credentialProvenance: 'stored_session' as const,
                encryption: mode === 'e2ee' ? { type: 'legacy' as const, secret } : null };
            const sessionId = 'c123456789012345678901234';
            const machineId = 'withdrawn-foreign-worker';
            const metadata = { machineId, path: '/workspace', flavor: 'claude' };
            const session = createSessionRecordFixture({ id: sessionId, active: false, encryptionMode: mode, share: null,
                metadata: mode === 'e2ee' ? encryptSessionPayload({ ctx: { encryptionKey: secret, encryptionVariant: 'legacy' }, payload: metadata })
                    : JSON.stringify(metadata) });
            const requests: string[] = [];
            // Only HTTP is substituted. Real CLI routing, policy, Session resolution,
            // archive service and transport must reach Home without the withdrawn worker.
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                requests.push(url);
                if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session } };
                if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode, version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 1 } };
                if (url.endsWith('/v1/machines')) return { status: 200, data: [] };
                throw new Error(`Unexpected Home read: ${url}`);
            });
            let archivedAt: number | null = actionId === 'session.archive' ? null : 123;
            vi.spyOn(axios, 'post').mockImplementation(async url => {
                requests.push(url);
                if (url.endsWith(`/v2/sessions/${sessionId}/${actionId === 'session.archive' ? 'archive' : 'unarchive'}`)) {
                    archivedAt = actionId === 'session.archive' ? 456 : null;
                    return { status: 200, data: { success: true, archivedAt } };
                }
                return { status: 503, data: { error: 'admission_unavailable' } };
            });
            const daemonRequests: string[] = [];
            vi.stubGlobal('fetch', async (url: string | URL | Request, options?: RequestInit) => {
                if (String(url) === 'https://home.test/v1/features/authenticated') {
                    expect(new Headers(options?.headers).get('Authorization')).toBe(`Bearer ${token}`);
                    return Response.json({ features: {}, capabilities: {} });
                }
                daemonRequests.push(String(url));
                return Response.json({ ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' });
            });
            const executor = createCliActionExecutorFromCredentials({ credentials, serverId: configuration.activeServerId,
                serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test', externalActionClient: true,
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            const result = await executor.execute(actionId, { sessionId }, { surface: 'cli' });
            expect(result, JSON.stringify(result))
                .toMatchObject({ ok: true, result: { sessionId, archivedAt: actionId === 'session.archive' ? 456 : null } });
            expect(archivedAt).toBe(actionId === 'session.archive' ? 456 : null);
            expect(daemonRequests).toEqual([]);
            expect(requests.filter(url => /\/v1\/(?:machines|actions)(?:\/|$)/.test(url))).toEqual([]);
        });
    });

    it.each([
        { mode: 'e2ee', method: 'execute', offline: false, selector: 'id' },
        { mode: 'plain', method: 'prepare', offline: false, selector: 'tag' },
        { mode: 'plain', method: 'execute', offline: true, selector: 'id' },
        { mode: 'plain', method: 'execute', offline: false, selector: 'default' },
    ] as const)('delivers a remote visual through its owning Machine ($mode, $method, $selector, offline=$offline)', async ({ mode, method, offline, selector }) => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-cli-session-target-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 4,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const secret = new Uint8Array(32).fill(17);
            const credentials = { token, credentialProvenance: 'stored_session' as const,
                encryption: mode === 'e2ee' ? { type: 'legacy' as const, secret } : null };
            const sessionId = 'c123456789012345678901234';
            const machineId = 'machine-b';
            const metadata = { machineId, path: '/workspace', flavor: 'claude' };
            const session = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: mode, share: null,
                metadata: mode === 'e2ee' ? encryptSessionPayload({ ctx: { encryptionKey: secret, encryptionVariant: 'legacy' }, payload: metadata })
                    : JSON.stringify(metadata) });
            writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture-control-token', machineId: 'machine-a', accountId: 'owner' });
            const actionId = 'session.board.item.upsert';
            const input = { sessionId, itemId: 'remote-visual', expectedItemRevision: null, destination: 'transcript',
                item: { v: 1, title: 'Remote visual', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
                    source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'On Machine B' } } } } };
            const { sessionId: _sessionId, ...withoutSession } = input;
            const invokedInput = selector === 'default' ? withoutSession : selector === 'tag' ? { ...input, sessionId: 'remote-board' } : input;
            const context = { surface: 'cli' as const, ...(selector === 'default' ? { defaultSessionId: sessionId } : {}) };
            expect(getActionSpec(actionId).inputSchema.safeParse(input).success).toBe(true);
            const execution = { ok: true as const, result: getActionSpec(actionId).outputSchema!.parse({
                v: 1, serverId: 'srv_home', sessionId, destination: null, itemDestination: 'transcript',
                result: { operation: 'upsert_item', itemId: input.itemId, outcome: 'created', itemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
            }) };
            const material = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) };
            const delivered: unknown[] = [];
            // Substitute HTTP only: keep credentials, Session opening, origin routing,
            // encrypted envelope production and receiver reconciliation real.
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode, version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session } };
                if (url.endsWith('/v2/sessions/remote-board')) return { status: 404, data: { error: 'not_found' } };
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 1 } };
                if (url === `https://home.test/v1/machines/${machineId}`) return { status: 200, data: { machine: { id: machineId, active: !offline,
                    kind: 'persistent', revokedAt: null, replacedByMachineId: null,
                    managedMachineRef: null,
                    access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: mode, accessState: 'ready' } } } };
                throw new Error(`Unexpected Home read: ${url}`);
            });
            vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
                if (url.endsWith('/v2/sessions/lookup-by-tags')) return { status: 200, data: { sessions: [session] } };
                expect(url).toBe(`https://home.test/v1/actions/${actionId}`);
                const envelope = ExternalActionRequestEnvelopeSchema.parse(body);
                const target = { kind: 'machine' as const, machineId };
                expect(envelope.target).toEqual(target);
                expect(envelope).not.toHaveProperty('machineRuntimeDemand');
                delivered.push(body);
                if (offline) return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId,
                    requestId: envelope.requestId, execution: { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' } }) };
                const binding = { serverIdentityId: 'srv_home', accountId: 'owner', authentication: { kind: 'account' as const, tokenEpoch: 4 },
                    actionId, requestId: envelope.requestId!, target };
                const decoded = envelope.v === 2 ? openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding, material })?.input : envelope.input;
                expect(decoded).toEqual(input);
                expect(reconcileExternalActionTarget({ actionId, rawInput: decoded, target, currentMachineId: machineId }))
                    .toMatchObject({ kind: 'ready', target: { kind: 'session', sessionId } });
                return { status: 200, data: envelope.v === 2
                    ? prepareExternalActionResponseV2({ request: envelope, binding, material, executedMachineId: machineId,
                        randomBytes: length => new Uint8Array(length).fill(6), execution }).response
                    : ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: envelope.requestId, execution }) };
            });
            vi.stubGlobal('fetch', async () => Response.json({ ok: false, errorCode: 'target_not_local', error: 'target_not_local' }));
            const options = { credentials, serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                externalActionClient: true as const,
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } };
            const executor = createCliActionExecutorFromCredentials(options);
            const result = method === 'execute' ? await executor.execute(actionId, invokedInput, context)
                : await executor.prepare(actionId, invokedInput, context).then(prepared => prepared.kind === 'ready'
                    ? prepared.invocation.run() : prepared.result);
            expect(result).toEqual(offline ? { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable',
                requestId: ExternalActionRequestEnvelopeSchema.parse(delivered[0]).requestId } : execution);
            expect(await executor.execute(actionId, input, { surface: 'cli', externalActionTarget: { kind: 'machine', machineId: 'machine-a' } }))
                .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
            expect(await createCliActionExecutorFromCredentials({ ...options, machineId: 'machine-a' }).execute(actionId, input, { surface: 'cli' }))
                .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
            expect(delivered).toHaveLength(1);
        });
    });

    it('delivers an attached CLI Review to the Session publisher', async () => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-cli-review-target-' }, async () => {
            const accountId = 'owner';
            const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 4,
                provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
            const secret = new Uint8Array(32).fill(17);
            const credentials = { token, credentialProvenance: 'stored_session' as const, encryption: { type: 'legacy' as const, secret } };
            const sessionId = 'c123456789012345678901234';
            const machineId = 'machine-b';
            const session = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'e2ee', share: null,
                metadata: encryptSessionPayload({ ctx: { encryptionKey: secret, encryptionVariant: 'legacy' },
                    payload: { machineId, path: '/workspace', flavor: 'codex' } }) });
            writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture-control-token', machineId: 'machine-a', accountId });
            const actionId = 'review.start';
            const input = getActionSpec(actionId).inputSchema.parse({ sessionId, scope: 'repository', instructions: 'Review this checkout.',
                reviewers: [{ kind: 'engine', engineId: 'codex' }, { kind: 'engine', engineId: 'muse', modelId: 'spark1.3' }] });
            const run = { id: 'review-workflow', sourceArtifactId: null, ownerAccountId: accountId, visibleTeamId: null,
                attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null,
                finishedAt: null, origin: { kind: 'direct' }, state: 'running', revision: 1, machineId, workflowCustodyState: 'pending',
                originDeliveryAckRevision: null,
                availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
                createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
            const execution = { ok: true as const, result: { run, admission: 'created', reviewRound: { reviewId: 'review', roundOrdinal: 1 } } };
            const material = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) };
            // Substitute network I/O, keeping Session resolution, routing and the encrypted Action carrier real.
            network.observe = () => createApiSessionSocketStub();
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'e2ee', version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
                if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session } };
                if (url.endsWith(`/v1/machines/${machineId}`)) return { status: 200, data: { machine: { id: machineId, active: true,
                    kind: 'persistent', revokedAt: null, replacedByMachineId: null, managedMachineRef: null,
                    access: { custodian: { accountId, displayName: 'Owner' }, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' } } } };
                throw new Error(`Unexpected Home read: ${url}`);
            });
            const deliver = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
                expect(url).toBe(`https://home.test/v1/actions/${actionId}`);
                const envelope = ExternalActionRequestEnvelopeSchema.parse(body);
                if (envelope.v !== 2) throw new Error('Expected encrypted Machine delivery');
                const target = { kind: 'machine' as const, machineId };
                expect(envelope.target).toEqual(target);
                const binding = { serverIdentityId: 'srv_home', accountId, authentication: { kind: 'terminal' as const, tokenEpoch: 4 },
                    actionId, requestId: envelope.requestId, target };
                const decoded = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                    envelope, binding, material })?.input;
                expect(decoded).toEqual(input);
                expect(reconcileExternalActionTarget({ actionId, rawInput: decoded, target, currentMachineId: machineId }))
                    .toMatchObject({ kind: 'ready', target: { kind: 'session', sessionId } });
                return { status: 200, data: prepareExternalActionResponseV2({ request: envelope, binding, material,
                    executedMachineId: machineId, randomBytes: length => new Uint8Array(length).fill(6), execution }).response };
            });
            vi.stubGlobal('fetch', async () => Response.json({ ok: false, errorCode: 'target_not_local', error: 'target_not_local' }));
            const executor = createCliActionExecutorFromCredentials({ credentials, serverId: configuration.activeServerId,
                serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({
                    v: 1, approvalWaivedSurfaces: { [actionId]: ['cli'] },
                }) } });
            const result = await executor.execute(actionId, input, { surface: 'cli' });
            expect(deliver, JSON.stringify(result)).toHaveBeenCalledWith(
                `https://home.test/v1/actions/${actionId}`, expect.anything(), expect.anything());
            expect(result).toEqual(execution);
        });
    });

    it.each([
        { login: 'account login with an explicit Machine', terminal: false, reply: 'none' },
        { login: 'ordinary terminal login', terminal: true, reply: 'none' },
        { login: 'ordinary terminal reply-wait', terminal: true, reply: 'wait' },
        { login: 'ordinary terminal reply-wait with a finite deadline', terminal: true, reply: 'wait', timeoutSeconds: 1 },
    ] as const)('opens Team-only E2EE detail and sends as the authenticated member with $login', async testCase => {
        const { terminal, reply } = testCase;
        const timeoutSeconds = 'timeoutSeconds' in testCase ? testCase.timeoutSeconds : undefined;
        await withConfiguredDaemonTestHome({ prefix: 'happier-cli-team-send-' }, async () => {
            const accountId = 'team-member';
            const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 4,
                provenance: terminal ? { v: 1, kind: 'terminal', authority: 'account_automation' }
                    : { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const machineKey = new Uint8Array(32).fill(34);
            const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
            const credentials = { token, credentialProvenance: 'stored_session' as const,
                encryption: { type: 'dataKey' as const, machineKey, publicKey } };
            const sessionId = 'cmwiqxdcs00r2mcnz01awx7f5';
            const ctx = { encryptionKey: new Uint8Array(32).fill(35), encryptionVariant: 'dataKey' as const };
            const session = createCurrentSessionProjectionRecordFixture({
                id: sessionId, active: true, encryptionMode: 'e2ee', metadataLayoutVersion: 1,
                metadata: encryptSessionPayload({ ctx, payload: { v: 1 } }),
                dataEncryptionKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: ctx.encryptionKey,
                    recipientPublicKey: publicKey, randomBytes: length => new Uint8Array(length).fill(36) })).toString('base64'),
                effectiveAccess: { v: 1, level: 'edit', sources: [{ kind: 'team', teamId: 'team', requiredByTeamPolicy: false }],
                    capabilities: projectSessionAccessCapabilitiesV1({ owner: false,
                        grants: [{ accessLevel: 'edit', canApprovePermissions: false }] }) },
            });
            vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
                if (url !== 'https://home.test/v1/features/authenticated') return new Response(null, { status: 404 });
                expect(new Headers(options?.headers).get('Authorization')).toBe(`Bearer ${token}`);
                return Response.json({ features: { sharing: { session: { enabled: true } } }, capabilities: {} });
            });
            const localId = 'team-input';
            const inputPath = `/v2/sessions/${sessionId}/messages/by-local-id/${localId}`;
            const replyPath = `${inputPath}/reply`;
            const answerId = 'original-answer';
            const turnId = 'accepted-turn';
            let pending = false;
            let answered = false;
            let readUnansweredTurn = false;
            let disposition = 'observing';
            const sockets = new Set<ReturnType<typeof createApiSessionSocketStub>>();
            if (reply === 'wait') network.observe = auth => {
                expect(auth.token).toBe(token);
                const socket = createApiSessionSocketStub();
                // Home #182 refused this Team editor's Session handshake and admitted its Account socket.
                if (auth.clientType === 'session-scoped') socket.connect.mockImplementation(() => {
                    socket.trigger('connect_error', Object.assign(new Error('invalid-session'), { data: { statusCode: 403, code: 'invalid-session' } }));
                    return socket;
                });
                else sockets.add(socket);
                return socket;
            };
            const replyProgress = () => ({ v: 1, mode: 'wait', disposition, ...(pending ? {} : { acceptedTurnId: turnId }),
                ...(answered ? { outcome: { kind: 'answer', result: { sessionId, messageId: answerId } } } : {}) });
            const row = (id: string, seq: number, payload: object, messageLocalId: string | null = null) => ({
                id, seq, localId: messageLocalId, createdAt: Date.now(), updatedAt: Date.now(),
                content: { t: 'encrypted', c: encryptSessionPayload({ ctx, payload }) },
            });
            vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
                const { pathname, searchParams } = new URL(url);
                if (pathname === `/v2/sessions/${sessionId}`) {
                    expect(options?.headers?.Authorization).toBe(`Bearer ${token}`);
                    return searchParams.get('accessProjectionVersion') === '1'
                        ? { status: 200, data: { session } }
                        : { status: 404, data: { error: 'session-not-found' } };
                }
                if (reply === 'wait') {
                    if (reply === 'wait' && pathname === `/v2/sessions/${sessionId}/messages/reply-capability`) {
                        expect(options?.headers?.Authorization).toBe(`Bearer ${token}`);
                        return { status: 200, data: { v: 1, protocolVersions: [1] } };
                    }
                    if (pathname === inputPath) {
                        expect(options?.headers?.Authorization).toBe(`Bearer ${token}`);
                        if (pending) throw Object.assign(new AxiosError('Message not found'), {
                            response: { status: 404, data: { error: 'Message not found' } },
                        });
                        return { status: 200, data: { message: row('original-input', 1,
                            { role: 'user', content: { type: 'text', text: 'Team-only input' } }, localId) } };
                    }
                    if (pathname === replyPath) {
                        expect(options?.headers?.Authorization).toBe(`Bearer ${token}`);
                        return { status: 200, data: { v: 1, status: 'available', progress: replyProgress() } };
                    }
                    if (pathname === `/v2/sessions/${sessionId}/pending`) {
                        return { status: 200, data: { pending: pending ? [{ localId, deliveryStatus: { status: 'queued' } }] : [] } };
                    }
                    if (pathname === `/v1/sessions/${sessionId}/turns`) {
                        readUnansweredTurn = true;
                        return { status: 404, data: {} };
                    }
                    if (pathname === `/v1/sessions/${sessionId}/messages`) {
                        expect(options?.headers?.Authorization).toBe(`Bearer ${token}`);
                        const assistant = (id: string, seq: number, text: string) => row(id, seq, {
                            role: 'agent', content: { type: 'text', text },
                        });
                        return { status: 200, data: { hasMore: false, messages: [
                            ...(answered ? [assistant(answerId, 2, 'Exact Muse reply')] : []),
                            assistant('unrelated-answer', 3, 'Unrelated assistant text'),
                        ] } };
                    }
                }
                if (pathname === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'e2ee', version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                if (pathname === '/v1/account/encryption') return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
                if (pathname === '/v2/sessions' || pathname === '/v2/sessions/archived') {
                    return { status: 200, data: { sessions: [], nextCursor: null, hasNext: false } };
                }
                throw new Error(`Unexpected Home read: ${url}`);
            });
            const machineId = 'team-session-publisher';
            const actionId = 'session.message.send';
            const input = { sessionId, message: 'Team-only input', reply, localId,
                ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
                requestedAction: { v: 1, kind: 'enqueue' } };
            const delivered = vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
                if (url.endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: [] } };
                expect(options?.headers?.Authorization).toBe(`Bearer ${token}`);
                if (reply === 'wait' && url === `https://home.test${replyPath}`) {
                    disposition = body.kind === 'inline' ? 'inline' : 'released';
                    return { status: 200, data: { v: 1, ok: true, progress: replyProgress() } };
                }
                if (terminal) {
                    expect(url).toBe(`https://home.test/v2/sessions/${sessionId}/pending`);
                    expect(body).toMatchObject({ localId: input.localId, requestedAction: input.requestedAction });
                    if (reply === 'wait') expect(body).toHaveProperty('reply.mode', 'wait');
                        pending = true;
                    expect(body).not.toHaveProperty('targetMachineId');
                    const opened = decryptSessionPayload({ ctx, ciphertextBase64: body.ciphertext });
                    expect(opened).toMatchObject({ content: { text: input.message } });
                    expect(opened).not.toHaveProperty('meta.happierInputRequestV1.actionRequestAttributionV1');
                    return { status: 200, data: { didWrite: true, terminal: false } };
                }
                expect(url).toBe(`https://home.test/v1/actions/${actionId}`);
                const envelope = ExternalActionRequestEnvelopeSchema.parse(body);
                if (envelope.v !== 2) throw new Error('Expected encrypted Session delivery');
                const target = { kind: 'session' as const, sessionId };
                expect(envelope.target).toEqual(target);
                const binding = { serverIdentityId: 'srv_home', accountId,
                    authentication: { kind: 'account' as const, tokenEpoch: 4 }, actionId, requestId: envelope.requestId, target };
                const material = { type: 'dataKey' as const, machineKey };
                expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                    envelope, binding, material })?.input).toEqual(input);
                return { status: 200, data: prepareExternalActionResponseV2({ request: envelope, binding, material,
                    executedMachineId: machineId, randomBytes: length => new Uint8Array(length).fill(37),
                    execution: { ok: true, result: { status: 'accepted', localId: input.localId } } }).response };
            });
            const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
                ...(terminal ? {} : { machineId }),
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({
                    v: 1, approvalWaivedSurfaces: { [actionId]: ['cli'] },
                }) } });
            expect(await executor.execute('session.status.get', { sessionId, live: false }, { surface: 'cli' }))
                .toMatchObject({ ok: true, result: { session: { id: sessionId } } });
            if (reply === 'none') {
                expect(await executor.execute(actionId, input, { surface: 'cli' }))
                    .toMatchObject({ ok: true, result: { status: 'accepted', localId } });
                expect(delivered.mock.calls.filter(([url]) => !url.endsWith('/lookup-by-tags'))).toHaveLength(1);
                return;
            }
            const lifetime = new AbortController();
            let completed = false;
            const result = executor.execute(actionId, input, { surface: 'cli', signal: lifetime.signal }).then(value => {
                completed = true;
                return value;
            });
            const wake = () => {
                for (const socket of sockets) socket.trigger('ephemeral', {
                    type: 'session-message-reply-pending-v1', v: 1, sessionId, requestLocalId: localId,
                });
            };
            try {
                await vi.waitFor(() => expect(pending).toBe(true));
                // Provider accepted the input and Pending retired. Muse is still working.
                pending = false;
                wake();
                await vi.waitFor(() => expect(readUnansweredTurn || completed).toBe(true));
                if (timeoutSeconds !== undefined) {
                    await expect(result).resolves.toMatchObject({ ok: false, errorCode: 'session_reply_timeout' });
                    expect(disposition).toBe('released');
                } else {
                    expect(completed).toBe(false);
                    expect(disposition).toBe('observing');
                    answered = true;
                    wake();
                    await vi.waitFor(() => expect(completed).toBe(true));
                    await expect(result).resolves.toMatchObject({ ok: true, result: { status: 'replied', localId,
                        outcome: { kind: 'answer', text: 'Exact Muse reply', messageRef: { messageId: answerId } } } });
                    expect(disposition).toBe('inline');
                }
            } finally {
                lifetime.abort();
                await result;
            }
        });
    });
});
