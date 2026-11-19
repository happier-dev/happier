import fastify from 'fastify';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { expect, it, onTestFinished, vi } from 'vitest';
import { buildQualifiedPluginContributionKey, MACHINE_PLAIN_DATA_KEY_MARKER, projectSessionAccessCapabilitiesV1, ComposerAttachmentInputV1Schema, type SessionPendingEnqueueByMachineRequestV1 } from '@happier-dev/protocol';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { derivePluginSessionInputLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { installDaemonMachineAdmissionTransport } from '@/daemon/machineAdmissionTransport';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { registerSessionControlHandlers } from '@/rpc/handlers/sessionControls';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import { prepareComposerAttachmentDraftsForSendV1 } from '@/session/composer/prepareComposerAttachmentDraftsForSendV1';
import { admitSessionStructuredInputV1, validateSessionStructuredInputIngressV1 } from '@/session/services/admitSessionStructuredInputV1';
import * as sessionRpc from '@/session/transport/rpc/sessionRpc';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCurrentSessionProjectionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { activate, manifest } from './accountComposerAttachment.testkit';
import { resolveAccountExecutionRuntime } from './accountExecutionRuntime';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';
import { executeContributedAction } from './invocation/actions/executeContributedAction';

it('settles Account Action sends across the Home relay and the daemon Machine admission socket', async () => {
    const accountId = 'composer-owner';
    const serverId = 'srv_account_composer';
    const sessionId = 'c1234567890123456789012345';
    const machineId = 'composer-machine';
    const installationId = 'composer-installation';
    const seed = new Uint8Array(32).fill(19);
    const installationPublicKey = ed25519.getPublicKey(seed);
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({
        sub: accountId, tokenEpoch: 1, provenance: { v: 1, kind: 'account', authority: 'present_user' },
    })).toString('base64url')}.signature`, encryption: null, credentialProvenance: 'stored_session' as const };
    const app = fastify();
    const missingHomeRoutes: string[] = [];
    const relayResponses: Array<{ route: string; status: number }> = [];
    const relayFixtureErrors: string[] = [];
    app.addHook('onResponse', async (request, reply) => {
        if (request.is404 && reply.statusCode === 404) missingHomeRoutes.push(`${request.method} ${request.url}`);
    });
    onTestFinished(async () => { await app.close(); resetActiveAccountSettingsSnapshotForTests(); });
    const features = registerAccountHomeHttp(app, { accountId, serverId, settings: {
        actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'session.message.send': ['plugin'] } },
    } });
    app.get('/v1/features', async () => features);
    app.get('/v1/features/authenticated', async () => features);
    app.get(`/v2/sessions/${sessionId}`, async () => ({ session: createCurrentSessionProjectionRecordFixture({
        id: sessionId, active: true, activeAt: 1, machineId, encryptionMode: 'plain',
        metadata: JSON.stringify({ machineId, permissionMode: 'yolo' }),
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
    }) }));
    app.get(`/v1/machines/${machineId}`, async () => ({ machine: MachinePublishedRowV1Schema.parse({
        id: machineId, kind: 'persistent', managedMachineRef: null, metadata: null, metadataVersion: 0,
        daemonState: null, daemonStateVersion: 0, storageMode: 'plain',
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, active: true,
        revokedAt: null, replacedByMachineId: null,
        installationId, installationPublicKey: Buffer.from(installationPublicKey).toString('base64'),
        access: { custodian: { accountId, displayName: 'Composer Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
    }) }));
    const pending = new Map<string, SessionPendingEnqueueByMachineRequestV1['content']>();
    app.get(`/v2/sessions/${sessionId}/pending`, async () => ({ pending: [...pending].map(([localId, content]) => ({ localId, content })) }));
    app.get(`/v2/sessions/${sessionId}/messages/by-local-id/:localId`, async (_, reply) => reply.code(404).send({ error: 'Message not found' }));
    const sendActionId = 'session.message.send';
    const mintPath = bindExternalActionExecutionAuthorizationHttpPathV1(sendActionId);
    const relayPath = `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${sendActionId}`;
    app.addHook('onError', async (request, _reply, error) => {
        if (request.url === mintPath || request.url === relayPath) relayFixtureErrors.push(error.message);
    });
    app.addHook('onResponse', async (request, reply) => {
        if (request.url === mintPath || request.url === relayPath || request.url === `/v1/machines/${machineId}`) {
            relayResponses.push({ route: request.url, status: reply.statusCode });
        }
    });
    let authorizationAvailable = false;
    app.post(mintPath, async (request, reply) => {
        expect(request.headers[AUTHORITY_CEILING_HEADER_V1.toLowerCase()]).toBe('account_automation');
        const { envelope } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.body);
        if (!authorizationAvailable) return reply.code(404).send({ error: 'invalid_request', code: 'target_unavailable' });
        return ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-send-root', binding: {
            accountId, custodianAccountId: accountId, authentication: { kind: 'account', tokenEpoch: 1 },
            accountEncryptionMode: 'plain', serverIdentityId: serverId, installationId, machineId, actionId: sendActionId,
            requestId: envelope.requestId, target: { kind: 'machine', machineId },
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } });
    });
    const dispatchedLocalIds: string[] = [];
    let loseAcknowledgement = false;
    app.post(relayPath, async (request, reply) => {
        const { envelope, executionAuthorization } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.body);
        expect(executionAuthorization?.binding.target).toEqual({ kind: 'machine', machineId });
        const opened = executionAuthorization && openExternalActionRequesterAccountContextV1({ authorization: executionAuthorization,
            includeInvocation: true, machineId, installationId, serverIdentityId: serverId, purpose: { kind: 'external_action' },
            installationPrivateKey: new Uint8Array([...seed, ...installationPublicKey]) });
        expect(opened?.invocation).toMatchObject({ surface: 'plugin', authority: 'account_automation',
            caller: { kind: 'plugin', pluginId: manifest.id, contributionLocalId: 'send' } });
        if (opened?.invocation?.caller.kind !== 'plugin' || envelope.v !== 1) throw new Error('Missing plugin Send invocation');
        expect(envelope.input).toMatchObject({ sessionId, idempotencyKey: 'issue-42',
            attachments: [{ attachmentLocalId: 'issue', value: { value: { issue: 'issue-42' } } }] });
        const localId = derivePluginSessionInputLocalIdV1({ caller: opened.invocation.caller, sessionId, idempotencyKey: 'issue-42' });
        const duplicate = dispatchedLocalIds.includes(localId);
        dispatchedLocalIds.push(localId);
        if (loseAcknowledgement) {
            reply.hijack();
            reply.raw.destroy();
            return;
        }
        return { v: 1, actionId: sendActionId, requestId: envelope.requestId,
            execution: { ok: true, result: { status: duplicate ? 'alreadyAccepted' : 'accepted', localId } } };
    });

    const release = await registerAuthoredAccountActionRelease(app, accountId, { primary: {
        manifest, projectRoot: resolve(import.meta.dirname, '../../..'),
        entryPath: resolve(import.meta.dirname, 'accountComposerAttachment.testkit.ts'),
    } });
    // The accepted Account Action reads authenticated Home facts over HTTP.
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const native = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{
        manifest, files: { 'daemon.mjs': 'export function activate() {}' },
        instantiateCommittedModule: () => ({ activate }),
    }] });
    onTestFinished(native.dispose);
    const publication = await pluginReloadController.adoptPreparedRuntimeRegistry({
        registry: native.registry, changedPluginIds: [manifest.id], runningSessionDisposition: 'retainRunningSessions',
    });
    onTestFinished(() => pluginReloadController.shutdown());
    expect(publication.ok).toBe(true);
    const registry = native.registry.composerAttachments;
    if (!registry) throw new Error('Daemon Composer registry is required');

    const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' });
    const preparedLocalIds: string[] = [];
    registerSessionControlHandlers(rpc, { sessionRuntimeControls: {
        async preparePendingMessageComposerAdmission({ text, localId, meta }) {
            preparedLocalIds.push(localId);
            const prepared = await prepareComposerAttachmentDraftsForSendV1({
                attachments: registry, sessionId, messageLocalId: localId,
                drafts: validateSessionStructuredInputIngressV1({ meta }), signal: new AbortController().signal,
            });
            const finalized = prepared.map(attachment => ComposerAttachmentInputV1Schema.parse(attachment));
            const admitted = admitSessionStructuredInputV1({ text, meta,
                preparedComposerAttachments: registry.admit({ phase: 'prepared', attachments: finalized }),
            });
            return { text: admitted.text, meta: admitted.meta, composerAttachments: admitted.structuredInput?.composerAttachments ?? [] };
        },
    } });
    // Replace the Session and authenticated Machine socket boundaries.
    const rpcResults: unknown[] = [];
    const rpcAuthorityCeilings: unknown[] = [];
    const socket = vi.spyOn(sessionRpc, 'callSessionRpc').mockImplementation(async request => {
        // Nested plugin work keeps its admitted automation authority at the Socket boundary.
        rpcAuthorityCeilings.push(request.authorityCeiling);
        expect(request.authorityCeiling).toBe('account_automation');
        const response = await rpc.invokeLocal(request.method.slice(request.sessionId.length + 1), request.request);
        rpcResults.push(response);
        return response;
    });
    onTestFinished(() => socket.mockRestore());
    const writes: SessionPendingEnqueueByMachineRequestV1[] = [];
    const admit = async (request: Parameters<Parameters<typeof installDaemonMachineAdmissionTransport>[0]['transport']>[0]) => {
        if (request.v !== 1) throw new Error('Expected ordinary Session input');
        writes.push(request);
        if (pending.has(request.localId)) return { status: 'alreadyAccepted' as const, localId: request.localId };
        pending.set(request.localId, request.content);
        return { status: 'accepted' as const, localId: request.localId };
    };

    await runWithServerHttpBaseUrl(origin, async () => {
        await release.publishArtifacts(credentials);
        await ensureCliActionPolicySettings(credentials, origin);
        const accountHome = resolve(native.happyHomeDir, 'account');
        await mkdir(accountHome);
        const openAccount = () => resolveAccountExecutionRuntime({ happyHomeDir: accountHome,
            resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }),
            accountExecution: { credentials, serverId, serverIdentityId: serverId, serverUrl: origin, isCurrent: () => true },
        });
        const createSend = async ({ registry }: Awaited<ReturnType<typeof openAccount>>) => {
            await registry.activateContributionsOnDemand([{ pluginId: manifest.id, family: 'actions', localId: 'send' }]);
            return (mode: string) => executeContributedAction({
                runtimeRegistry: registry, actionId: buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: 'send' }),
                input: { sessionId, mode }, context: { surface: 'cli' },
            });
        };
        const standalone = await openAccount();
        try {
            const send = await createSend(standalone);
            const refusal = await send('issue-42');
            expect(refusal, JSON.stringify({ refusal, missingHomeRoutes })).toMatchObject({ matched: true, result: {
                ok: true, result: { status: 'rejected', code: 'session_input_target_unavailable' },
            } });
            expect(dispatchedLocalIds).toEqual([]);
            authorizationAvailable = true;
            loseAcknowledgement = true;
            const uncertain = await send('issue-42');
            expect(uncertain, JSON.stringify({ uncertain, relayResponses, relayFixtureErrors, missingHomeRoutes })).toMatchObject({ matched: true, result: {
                ok: true, result: { status: 'outcomeUnknown', localId: dispatchedLocalIds[0] },
            } });
            expect(dispatchedLocalIds).toHaveLength(1);
            loseAcknowledgement = false;
            const retry = await send('issue-42');
            expect(retry, JSON.stringify({ retry, relayResponses, relayFixtureErrors })).toMatchObject({ matched: true, result: {
                ok: true, result: { status: 'alreadyAccepted', localId: dispatchedLocalIds[0] },
            } });
            expect(dispatchedLocalIds).toEqual([dispatchedLocalIds[0], dispatchedLocalIds[0]]);
            expect(preparedLocalIds).toEqual([]);
        } finally {
            await standalone.registry.dispose();
        }

        onTestFinished(installDaemonMachineAdmissionTransport({ serverId, transport: admit }));
        const account = await openAccount();
        try {
            const send = await createSend(account);

            const plain = await send('plain');
            expect(plain.matched).toBe(true);
            if (!plain.matched || !plain.result.ok) throw new Error(JSON.stringify({ plain, missingHomeRoutes }));
            expect(plain.result.result).toEqual({ status: 'accepted', localId: expect.any(String) });
            expect(preparedLocalIds).toEqual([]);

            const issue = await send('issue-42');
            expect(rpcAuthorityCeilings[0]).toBe('account_automation');
            expect(issue, JSON.stringify({ issue, preparedLocalIds, rpcResults, missingHomeRoutes })).toMatchObject({
                matched: true, result: { ok: true, result: { status: 'accepted' } },
            });
            expect(writes[1]).toMatchObject({ localId: preparedLocalIds[0], content: { t: 'plain', v: {
                meta: { [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: { composerAttachments: [{
                    attachment: { pluginId: manifest.id, localId: 'issue' },
                    value: { issue: 'prepared on daemon' },
                    presentation: { typeLabel: 'Issue' },
                }] } },
            } } });

            expect(await send('blocked')).toMatchObject({ matched: true, result: {
                ok: true, result: { status: 'rejected', code: 'session_input_invalid' },
            } });
            expect(writes).toHaveLength(2);
            expect(preparedLocalIds).toHaveLength(2);

            expect(await send('issue-42')).toMatchObject({ matched: true, result: { ok: true, result: { status: 'alreadyAccepted' } } });
            expect(writes[2]?.content).toEqual(writes[1]?.content);
            expect(preparedLocalIds).toHaveLength(2);
        } finally {
            await account.registry.dispose();
        }
    });
});
