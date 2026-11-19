import fastify from 'fastify';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { buildQualifiedPluginContributionKey, MACHINE_PLAIN_DATA_KEY_MARKER, projectSessionAccessCapabilitiesV1, ComposerAttachmentInputV1Schema, type SessionPendingEnqueueByMachineRequestV1 } from '@happier-dev/protocol';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
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

it('admits an Account Action send through the daemon attachment callback before Pending custody', async () => {
    const accountId = 'composer-owner';
    const serverId = 'srv_account_composer';
    const sessionId = 'c1234567890123456789012345';
    const machineId = 'composer-machine';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({
        sub: accountId, tokenEpoch: 1, provenance: { v: 1, kind: 'account', authority: 'present_user' },
    })).toString('base64url')}.signature`, encryption: null };
    const app = fastify();
    const missingHomeRoutes: string[] = [];
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
        id: machineId, managedMachineRef: null, metadata: null, metadataVersion: 0,
        daemonState: null, daemonStateVersion: 0, storageMode: 'plain',
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, active: true,
        revokedAt: null, replacedByMachineId: null,
    }) }));
    const pending = new Map<string, SessionPendingEnqueueByMachineRequestV1['content']>();
    app.get(`/v2/sessions/${sessionId}/pending`, async () => ({ pending: [...pending].map(([localId, content]) => ({ localId, content })) }));
    app.get(`/v2/sessions/${sessionId}/messages/by-local-id/:localId`, async (_, reply) => reply.code(404).send({ error: 'Message not found' }));

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
    onTestFinished(installDaemonMachineAdmissionTransport({ serverId, transport: async request => {
        if (request.v !== 1) throw new Error('Expected ordinary Session input');
        writes.push(request);
        if (pending.has(request.localId)) return { status: 'alreadyAccepted', localId: request.localId };
        pending.set(request.localId, request.content);
        return { status: 'accepted', localId: request.localId };
    } }));

    await runWithServerHttpBaseUrl(origin, async () => {
        await release.publishArtifacts(credentials);
        await ensureCliActionPolicySettings(credentials, origin);
        const accountHome = resolve(native.happyHomeDir, 'account');
        await mkdir(accountHome);
        const account = await resolveAccountExecutionRuntime({ happyHomeDir: accountHome,
            resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }),
            accountExecution: { credentials, serverId, serverUrl: origin, isCurrent: () => true },
        });
        try {
            await account.registry.activateContributionsOnDemand([{ pluginId: manifest.id, family: 'actions', localId: 'send' }]);
            const send = (mode: string) => executeContributedAction({
                runtimeRegistry: account.registry, actionId: buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: 'send' }),
                input: { sessionId, mode }, context: { surface: 'cli' },
            });

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
