import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import { accountRoutes } from '../../../../server/sources/app/api/routes/account/accountRoutes';
import { artifactsRoutes } from '../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import { sessionRoutes } from '../../../../server/sources/app/api/routes/session/sessionRoutes';
import { featuresRoutes } from '../../../../server/sources/app/api/routes/features/featuresRoutes';
import { publicShareRoutes } from '../../../../server/sources/app/api/routes/share/publicShareRoutes';
import { loadPublicShareViewerContent } from '../../../../server/sources/app/api/routes/share/publicShareViewerClient';
import { registerAccountSecurityRoutes } from '../../../../server/sources/app/api/routes/auth/registerAccountSecurityRoutes';
import { initializeServerIdentityCache } from '../../../../server/sources/app/serverIdentity/serverIdentity';
import { createAuthenticatedFakeSocket, getSocketHandler } from '../../../../server/sources/app/api/testkit/socketHarness';
import { sessionUpdateHandler } from '../../../../server/sources/app/api/socket/sessionUpdateHandler';
import { createSessionPublisherPresence } from '../../../../server/sources/app/presence/sessionPublisherPresence';
import { auth } from '../../../../server/sources/app/auth/auth';
import { db } from '../../../../server/sources/storage/db';
import { initializeSessionSystemRecordsProtocolV1Activation, resetSessionSystemRecordsProtocolV1ActivationForTests } from '../../../../server/sources/app/session/systemRecords/sessionSystemRecordProtocolContract';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '@happier-dev/protocol/account/settings/sessionAgentSpawnPolicyV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { SessionSurfaceItemV1StoredSchema } from '@happier-dev/protocol/sessions/board/item';
import { readSessionTranscriptSurfaceItemReferencesV1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { configuration, reloadConfiguration } from '@/configuration';
import { updateSettings, SUPPORTED_SCHEMA_VERSION } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { prepareCommittedAgentMessageViaPort } from '@/api/session/client/transcript/commitMessages';
import type { SessionClientTranscriptSendPort } from '@/api/session/client/transcript/sendMessages';
import { seedForkVisualCopies } from '@/session/fork/seedForkVisuals';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';

// Real Action approval/execution, Artifact CAS, native transcript socket writer,
// SQLite and fork HTTP readers/writers. Only the socket transport is in-process.
describe('approved folder visual through native publication and fork', () => {
    let sqlite: Awaited<ReturnType<typeof createLightSqliteHarness>>;
    beforeAll(async () => {
        sqlite = await createLightSqliteHarness({ tempDirPrefix: 'happier-visual-approval-fork-', initAuth: true, initEncrypt: true, initFiles: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST: 'none',
                HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test',
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'preview.example.test',
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: '1',
                HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED: '1' } });
        expect(await initializeSessionSystemRecordsProtocolV1Activation(db)).toBe(true);
    }, 0);
    afterAll(async () => { resetSessionSystemRecordsProtocolV1ActivationForTests(); await sqlite?.close(); });

    it('keeps the approved Ask occurrence and its independent content when the child is seeded', async () => {
        const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_ACTIVE_SERVER_ID']);
        const app = createAuthenticatedTestApp({ authentication: 'real' }) as import('../../../../server/sources/app/api/types').Fastify;
        try {
            const settings = { agentHtmlNetworkPolicy: 'ask', actionsSettingsV1: { v: 1, actions: {
                'session.board.item.upsert': { approvalRequiredSurfaces: ['agent'] },
            } } };
            const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 1, settings: JSON.stringify(settings) } });
            const machineId = randomUUID();
            await db.machine.create({ data: { id: machineId, accountId: account.id, metadata: '{}' } });
            const directory = join(sqlite.baseDir, 'workspace');
            await mkdir(directory);
            await mkdir(join(directory, 'site'));
            await writeFile(join(directory, 'site', 'index.html'), '<p>Approved folder visual</p>');
            const metadata = createTestMetadata({ machineId, path: directory });
            const parent = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: JSON.stringify(metadata) } });
            const child = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: JSON.stringify(metadata) } });
            await db.accessKey.create({ data: { accountId: account.id, machineId, sessionId: parent.id, data: 'fixture' } });
            const credentials = { token: await auth.createToken(account.id, undefined, { kind: 'terminal', authority: 'account_automation' }),
                encryption: null, credentialProvenance: 'stored_session' as const };
            accountRoutes(app); artifactsRoutes(app); sessionRoutes(app); publicShareRoutes(app); registerAccountSecurityRoutes(app);
            const serverIdentityId = await initializeServerIdentityCache(); featuresRoutes(app);
            if (!serverIdentityId) throw new Error('Missing Home identity');
            const url = await app.listen({ port: 0, host: '127.0.0.1' });
            env.patch({ HAPPIER_HOME_DIR: join(sqlite.baseDir, 'cli'), HAPPIER_SERVER_URL: url, HAPPIER_WEBAPP_URL: url });
            reloadConfiguration(); resetInMemoryAccountSettingsContextForTests();
            const profile = await addServerProfile({ name: 'visual-home', serverUrl: url, webappUrl: url });
            await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
                v: 1, homeServerIdentityId: serverIdentityId, canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }],
            } });
            env.patch({ HAPPIER_ACTIVE_SERVER_ID: profile.id });
            reloadConfiguration();
            await updateSettings(current => ({ ...current, schemaVersion: SUPPORTED_SCHEMA_VERSION, onboardingCompleted: true,
                machineIdByServerId: { ...current.machineIdByServerId, [configuration.activeServerId]: machineId } }));
            expect(await resolveServerProfileHomeIdentityId(configuration.activeServerId)).toBe(serverIdentityId);
            await runWithServerHttpBaseUrl(url, async () => {
                await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' });
                const deps = createCliActionDeps({ credentials, token: credentials.token, sessionId: parent.id, mode: 'plain', ctx: null, serverHttpBaseUrl: url });
                const executor = createActionExecutor(deps);
                const input = { sessionId: parent.id, itemId: 'approved-folder', expectedItemRevision: null, destination: 'transcript', item: {
                    v: 1, title: 'Approved visual', frame: 'card', height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'hostedHtml',
                        publicationSource: { path: 'site', entrypoint: 'index.html' }, requestedCapabilities: { network: 'none' } },
                } };
                const port: SessionClientTranscriptSendPort = {
                    sessionId: parent.id, serverId: serverIdentityId, socket: { connected: true, emit() {} },
                    outboundShapeLogger: { log() {} }, debug() {}, debugLargeJson() {}, getMetadataSnapshot: () => metadata,
                    buildOutboundSessionMessagePayload: content => ({ t: 'plain', v: content }),
                    toolCallCanonicalNameByProviderAndId: new Map(), permissionToolCallRawInputByProviderAndId: new Map(), toolCallInputByProviderAndId: new Map(),
                };
                const socket = createAuthenticatedFakeSocket({ id: randomUUID() });
                sessionUpdateHandler(account.id, socket as never,
                    { connectionType: 'session-scoped', socket, userId: account.id, sessionId: parent.id } as never,
                    { presence: createSessionPublisherPresence(), binding: { accountId: account.id, machineId, sessionId: parent.id } });
                await getSocketHandler(socket, 'session-runtime-activity-snapshot')({ sessionId: parent.id, mutationId: randomUUID(),
                    snapshot: { state: 'idle', activeCount: 0 } }, () => {});
                const commit = async (prepared: Awaited<ReturnType<typeof prepareCommittedAgentMessageViaPort>>) => {
                    let ack: unknown;
                    await getSocketHandler(socket, 'transcript-observation-v1')({ v: 2, sessionId: parent.id, localId: prepared.localId,
                        content: prepared.payload, messageRole: prepared.messageRole, createdAt: 1, updatedAt: 1,
                        provenance: { kind: 'non_dependent', source: 'external' },
                        ...(prepared.approvalRequestArtifactId ? { approvalRequestArtifactId: prepared.approvalRequestArtifactId } : {}),
                    }, (value: unknown) => { ack = value; });
                    expect(ack).toMatchObject({ ok: true });
                };
                await commit(await prepareCommittedAgentMessageViaPort(port, 'codex', {
                    type: 'tool-call', callId: 'ask-call', id: 'call', name: 'mcp__happier__action_execute', input: { actionId: 'session.board.item.upsert', input },
                }, { localId: 'ask-call' }));
                const pending = await executor.execute('session.board.item.upsert', input, {
                    surface: 'agent', authority: 'account_automation', serverId: configuration.activeServerId, serverIdentityId,
                    runtimeAccountId: account.id, defaultSessionId: parent.id, defaultSessionMachineId: machineId,
                    actionsSettings: normalizeActionsSettingsV1(settings.actionsSettingsV1),
                    actionRequestId: 'ask-call', sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
                    actionCaller: { kind: 'session', sessionId: parent.id, starterDepth: 0, turnDepth: 0 },
                    approvalOrigin: { kind: 'transcript_tool_call', sessionId: parent.id, toolName: 'action_execute', toolCallId: 'ask-call' },
                });
                expect(pending, JSON.stringify(pending)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                if (!pending.ok) throw new Error(pending.errorCode);
                const { artifactId } = ActionApprovalRequestCreatedResultSchema.parse(pending.result);
                await commit(await prepareCommittedAgentMessageViaPort(port, 'codex', {
                    type: 'tool-result', callId: 'ask-call', id: 'result', output: { content: [{ type: 'text', text: JSON.stringify(pending.result) }] },
                }, { localId: 'ask-result' }));
                const native = await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: parent.id, localId: 'ask-result' } } });
                expect(native.messageRole).toBe('event');
                expect(native.surfaceItemReference).toBeNull();
                expect(await db.sessionSystemRecord.count({ where: { sessionId: parent.id, kind: 'item.v1' } })).toBe(0);
                const isApprovalExecutionOriginCurrent = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
                    credentials, machineId, serverId: configuration.activeServerId, serverApiUrl: url,
                    // The native runner's live-process witness is a system boundary.
                    // Home/Account/target/permission/policy currentness stays real.
                    isSessionCallerCurrent: async ({ caller }) => caller.sessionId === parent.id,
                });
                if (!isApprovalExecutionOriginCurrent) throw new Error('Missing daemon approval currentness owner');
                const decider = createCliActionExecutorFromCredentials({ credentials, serverId: configuration.activeServerId,
                    serverApiUrl: url, serverIdentityId, machineId, pluginActionExecutionOwner: 'current_process',
                    isApprovalExecutionOriginCurrent, readCredentials: async () => credentials });
                const decided = await decider.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
                    surface: 'cli', authority: 'present_user', serverId: configuration.activeServerId, runtimeAccountId: account.id, actionCaller: { kind: 'host' },
                });
                const settled = ApprovalRequestV2Schema.parse(await deps.approvalsGet!({ artifactId }));
                expect(decided, JSON.stringify({ decided, execution: settled.execution })).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
                const published = await db.sessionMessage.findUniqueOrThrow({ where: { id: native.id } });
                expect(published).toMatchObject({ id: native.id, seq: native.seq, content: native.content, messageRole: 'event' });
                expect(readSessionTranscriptSurfaceItemReferencesV1(published.surfaceItemReference)).toEqual([
                    expect.objectContaining({ itemId: 'approved-folder', approvalRequestArtifactId: artifactId }),
                ]);
                const page = await fetchEncryptedTranscriptMessagesPage({ token: credentials.token, sessionId: parent.id,
                    scope: 'main', limit: configuration.replaySeedCandidateLimit, afterSeq: 0 });
                expect(page.messages).toHaveLength(2);
                expect(page.messages.find(row => row.id === published.id)).toMatchObject({ surfaceItemReference: published.surfaceItemReference });
                const batchResponse = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                    headers: { authorization: `Bearer ${credentials.token}` },
                    payload: { sessionIds: [parent.id], includeSnapshot: false, includeMessages: true } });
                expect(batchResponse.statusCode, batchResponse.body).toBe(200);
                const batched = SessionReadBatchResponseV1Schema.parse(batchResponse.json()).results[0]?.messages;
                if (batched?.status !== 200) throw new Error('Missing batched transcript page');
                expect(batched.body.messages.find(row => row.id === published.id)).toMatchObject({ surfaceItemReference: published.surfaceItemReference });
                const copies = await seedForkVisualCopies({ credentials, sourceSessionId: parent.id, childSessionId: child.id,
                    cutoffSeqInclusive: published.seq, accountEncryptionMode: 'plain' });
                expect(copies).toEqual([expect.objectContaining({ status: 'copied', originItemId: 'approved-folder' })]);
                const copied = await db.sessionSystemRecord.findFirstOrThrow({ where: { sessionId: child.id, kind: 'item.v1' } });
                if (copied.content.t !== 'plain') throw new Error('Expected plain child content');
                expect(SessionSurfaceItemV1StoredSchema.parse(copied.content.v)).toMatchObject({ destination: 'transcript', source: {
                    kind: 'hostedHtml', source: { entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html',
                        contentBase64: Buffer.from('<p>Approved folder visual</p>').toString('base64') } } },
                } });
                const inherited = await db.sessionMessage.findMany({ where: { sessionId: child.id }, orderBy: { seq: 'asc' } });
                expect(inherited).toHaveLength(2);
                expect(inherited.some(row => readSessionTranscriptSurfaceItemReferencesV1(row.surfaceItemReference)
                    ?.some(reference => reference.itemId === copied.localId && 'approvalRequestArtifactId' in reference && reference.approvalRequestArtifactId === artifactId))).toBe(true);

                // The saved folder and its public link use the same actual approval
                // replay as the native visual, not a test-bound Artifact dispatcher.
                const shareContext = { surface: 'cli', authority: 'present_user', serverId: configuration.activeServerId,
                    serverIdentityId, runtimeAccountId: account.id, defaultSessionId: parent.id,
                    defaultSessionMachineId: machineId, actionCaller: { kind: 'host' } } as const;
                const approve = async (actionId: 'artifact.publish_from_file' | 'artifact.public_link.create', input: unknown) => {
                    const requested = await executor.execute(actionId, input, { ...shareContext, surface: 'agent', authority: 'account_automation',
                        actionCaller: { kind: 'session', sessionId: parent.id, starterDepth: 0, turnDepth: 0 }, actionRequestId: randomUUID() });
                    expect(requested).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                    if (!requested.ok) throw new Error(requested.errorCode);
                    const pendingId = ActionApprovalRequestCreatedResultSchema.parse(requested.result).artifactId;
                    const decision = await decider.execute('approval.request.decide', { artifactId: pendingId, decision: 'approve' }, shareContext);
                    expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
                    const receipt = ApprovalRequestV2Schema.parse(await deps.approvalsGet!({ artifactId: pendingId }));
                    return receipt.execution?.result;
                };
                const saved = ArtifactActionOutputSchemasV1['artifact.publish_from_file'].parse(await approve('artifact.publish_from_file', {
                    path: join(directory, 'site'), entrypoint: 'index.html', title: 'Public folder', kind: 'html',
                    mime: 'text/html', requestedCapabilities: { network: 'open' },
                }));
                const beforeShare = await db.artifact.findUniqueOrThrow({ where: { id: saved.artifactId } });
                const expiresAt = Date.now() + 60_000;
                const publication = ArtifactActionOutputSchemasV1['artifact.public_link.create'].parse(await approve('artifact.public_link.create', {
                    artifactId: saved.artifactId, networkOff: true, isConsentRequired: true, expiresAt, maxUses: 4 }));
                if (!publication.url) throw new Error('Explicit anonymous creation did not issue a URL');
                const link = new URL(publication.url);
                const share = await db.publicSessionShare.findUniqueOrThrow({ where: { artifactId: saved.artifactId } });
                expect(share).toMatchObject({ networkOff: true, isConsentRequired: true, maxUses: 4, expiresAt: new Date(expiresAt) });
                expect(await db.artifact.findUniqueOrThrow({ where: { id: saved.artifactId } })).toMatchObject({
                    header: beforeShare.header, body: beforeShare.body, headerVersion: beforeShare.headerVersion, bodyVersion: beforeShare.bodyVersion,
                });
                const viewerFetch: typeof fetch = async (input, init) => {
                    const target = new URL(input instanceof Request ? input.url : String(input));
                    expect(target.origin).toBe(link.origin);
                    const response = await app.inject({ method: 'GET', url: target.pathname + target.search, headers: { host: target.host } });
                    return new Response(response.body, { status: response.statusCode });
                };
                const location = { origin: link.origin, pathname: link.pathname, hash: link.hash };
                expect(await loadPublicShareViewerContent({ location, fetch: viewerFetch })).toEqual({ status: 'consent_required' });
                expect(await loadPublicShareViewerContent({ location, fetch: viewerFetch, consent: true }))
                    .toMatchObject({ status: 'ready', title: 'Public folder', networkOff: true, html: { entrypoint: 'index.html' } });
                expect(await executor.execute('artifact.public_link.revoke', { artifactId: saved.artifactId, shareId: share.id },
                    { ...shareContext, presentUserConfirmation: { actionId: 'artifact.public_link.revoke' } }))
                    .toMatchObject({ ok: true });
                expect(await loadPublicShareViewerContent({ location, fetch: viewerFetch, consent: true })).toEqual({ status: 'unavailable' });
            });
        } finally {
            await app.close(); env.restore(); reloadConfiguration(); resetInMemoryAccountSettingsContextForTests();
        }
    });
});
