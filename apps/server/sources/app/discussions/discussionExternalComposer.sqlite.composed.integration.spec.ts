import * as React from 'react';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { buildDiscussionMutationRequestBodyV1, DISCUSSION_AGENT_POST_EVENT_V1 } from '@happier-dev/protocol/discussions/api';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createDiscussion } from './mutations';
import { inviteDiscussionParticipant } from './accessService';
import { observePendingSessionFollowForDestinationInTx } from '@/app/session/follow/sessionFollowEdgeService';
import { deriveDiscussionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { applySessionTurnMutation, createSessionMessage } from '@/app/session/sessionWriteService';
import { deriveSessionMessageReplyReturnLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { SessionInputRequestV1Schema, SessionInputAdmissionReceiptV1Schema, settleSessionInputRequestV1, withSessionInputAuthorityV1,
    settleSessionMessageProvenanceV1, readSessionMessageProvenance, SESSION_MESSAGE_PROVENANCE_META_KEY } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { sessionUpdateHandler } from '@/app/api/socket/sessionUpdateHandler';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { createAuthenticatedFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { getOrCreateServerIdentityId, initializeServerIdentityCache } from '@/app/serverIdentity/serverIdentity';
import { registerDiscussionRoutes } from '@/app/api/routes/discussions/registerDiscussionRoutes';
import { enqueuePendingMessageByAuthenticatedMachine, materializeNextPendingMessage, settlePendingInputAdmission, resolveAcceptedPendingDelivery } from '@/app/session/pending/pendingMessageService';
import { sessionPendingRoutes } from '@/app/api/routes/session/pendingRoutes';
import { createActionExecutor, FeaturesResponseSchema, normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { DiscussionPostInputV1Schema, DiscussionPostResultV1Schema } from '@happier-dev/protocol/discussions/actions';
import { createPluginTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { createDiscussionActionDeps } from '../../../../cli/src/discussions/discussionActionDeps';
import { createDiscussionFollowInputIntake } from '../../../../cli/src/agent/runtime/session/follow/discussionFollowInput';
import { ApiSessionClient } from '../../../../cli/src/api/session/sessionClient';
import { createPlainSessionFixture } from '../../../../cli/src/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub } from '../../../../cli/src/testkit/backends/apiSessionSocketHarness';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerSessionListingRoutes } from '@/app/api/routes/session/registerSessionListingRoutes';
import { registerSessionLookupByTagsRoute } from '@/app/api/routes/session/registerSessionLookupByTagsRoute';
import { registerSessionFollowRoutes } from '@/app/api/routes/session/registerSessionFollowRoutes';
import { registerSessionMessageRoutes } from '@/app/api/routes/session/registerSessionMessageRoutes';
import { SessionPendingEnqueueByMachineRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { readSessionInputRequest } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { recoverSessionMessageRepliesForMachine, type DiscussionReplyReturnPublication } from '../../../../cli/src/session/services/sessionMessageReply';
import { createDiscussionReplyReturnPublisher } from '../../../../cli/src/discussions/discussionReplyReturnPublisher';
import { runWithServerHttpBaseUrl } from '../../../../cli/src/api/client/serverHttpBaseUrl';
import { applyRunnerMcpSessionContext } from '../../../../cli/src/mcp/runtime/applyRunnerMcpSessionContext';
import * as sessionSockets from '../../../../cli/src/api/session/sockets';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { featuresRoutes } from '@/app/api/routes/features/featuresRoutes';
import { registerSessionTurnMutationRoute } from '@/app/api/routes/session/registerSessionTurnMutationRoute';
import { registerMachineSessionMessageReplyRoutes } from '@/app/api/routes/machines/registerMachineSessionMessageReplyRoutes';
import type { SessionTurnMutationV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import { createDiscussionParticipantQuestion } from '../../../../../packages/tests/fixtures/plugin-platform/composer-external-dogfood/src/discussionComposer.mjs';
import { activate as activateExternalPlugin, manifest as externalManifest } from '../../../../../packages/tests/fixtures/plugin-platform/composer-external-dogfood/src/index.mjs';
import { discoverExecutablePluginUiArtifacts } from '../../../../../packages/plugin-sdk/src/ui/build/manifestArtifactDiscovery';
import { renderScreen } from '../../../../ui/sources/dev/testkit';
import { installAgentInputCommonModuleMocks } from '../../../../ui/sources/components/sessions/agentInput/agentInputTestHelpers';
import { DiscussionComposer, type DiscussionComposerValue } from '../../../../ui/sources/components/discussions/DiscussionComposer';
import { buildContributedComposerReferenceSelection } from '../../../../ui/sources/sync/domains/input/composerReferenceSelection';
import { createComposerPresentationHostHandlers } from '../../../../ui/sources/components/sessions/presentation/sessionComposerPresentationTargets';
import { createCanonicalPluginReactNativeHostApiAdapter } from '../../../../ui/sources/components/plugins/reactNative/hostApi';
import { PluginReactNativeSurface, type PluginReactNativeSurfaceModule } from '../../../../ui/sources/components/plugins/reactNative/PluginReactNativeSurface';

installAgentInputCommonModuleMocks();
vi.mock('expo-image', () => ({ Image: (props: Record<string, unknown>) => React.createElement('Image', props, null) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function MountedComposer(props: Readonly<{ serverId: string; accountId: string; discussionId: string; onSend(content: unknown): void }>) {
    const [value, setValue] = React.useState<DiscussionComposerValue>({ text: '', mentions: [] });
    const scope = React.useMemo(() => ({ serverId: props.serverId, accountId: props.accountId }), [props.serverId, props.accountId]);
    const lifetime = React.useMemo(() => ({ scope, isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) }), [scope]);
    return React.createElement(DiscussionComposer, { scope, accountLifetime: lifetime, address: { serverId: props.serverId },
        discussionId: props.discussionId, draftAddress: { kind: 'discussion', discussionId: props.discussionId },
        availability: 'available', disabled: false, value, onChange: setValue, onSend: props.onSend });
}

const document = (text: string) => ({ v: 1 as const, parts: [{ t: 'text' as const, text }] });
const authentication = createPresentUserSessionAccessAuthentication();
const plainMachine = (accountId: string) => db.machine.create({ data: { id: crypto.randomUUID(), installationId: crypto.randomUUID(), accountId,
    metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
    dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
    operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] }, sessionMessageReply: { protocolVersions: [1] } },
    operationProtocolCapabilitiesRevision: 1 } });

describe('External Discussion composer through the public Action and native reply owners (SQLite composition)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-external-discussion-', initAuth: false,
        env: { HAPPIER_FEATURE_SESSIONS__ENABLED: '1', HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
        // Manual Fastify composition still needs the normal Home startup owner:
        // fresh features reads publish its initialized canonical identity cache.
        await initializeServerIdentityCache();
    }, 120_000);
    afterAll(async () => { await harness?.close(); });
    async function fixture() {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id,
            request: buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: crypto.randomUUID(),
                titleContent: { t: 'plain', v: { v: 1, title: 'External composer' } }, firstMessage: {
                    localId: crypto.randomUUID(), content: { t: 'plain', v: document('Hello') },
                    authoredContent: document('Hello'), mentionedAccountIds: [] } }) });
        if (!created.ok) throw new Error(created.error);
        return { owner, discussionId: created.value.discussion.id };
    }
    async function publisherSocket(accountId: string, sessionId: string) {
        const machine = await plainMachine(accountId);
        await db.accessKey.create({ data: { accountId, machineId: machine.id, sessionId, data: 'encrypted' } });
        const socket = createAuthenticatedFakeSocket();
        // Only Socket.IO is replaced. Current publisher admission and all writes remain real.
        sessionUpdateHandler(accountId, socket as never, { connectionType: 'session-scoped', socket, userId: accountId, sessionId } as never,
            { presence: createSessionPublisherPresence(), binding: { accountId, machineId: machine.id, sessionId } });
        await getSocketHandler(socket, 'session-runtime-activity-snapshot')({ sessionId, mutationId: crypto.randomUUID(), snapshot: { state: 'idle', activeCount: 0 } }, () => {});
        return { socket, machine };
    }
    it.each(['final', 'explicit'] as const)('carries the external mounted-composer Action producer through Follow and Pending to one protected reply (%s)', async answer => {
        const control = externalManifest.contributes.composerControls.find(control => control.id === 'discussion-helper');
        expect(control, 'The actual external fixture must declare its Discussion composer entry').toBeDefined();
        if (!control || control.interaction.kind !== 'surface') throw new Error('The Discussion control has no declared renderer');
        const rendererId = control.interaction.renderer.renderer;
        const renderer = externalManifest.contributes.ui.renderers.find(renderer => renderer.id === rendererId);
        expect(renderer).toMatchObject({ id: 'discussion-surface', kind: 'reactNative', artifact: 'issue-surface-native' });
        if (!renderer) throw new Error('The Discussion renderer is not declared');
        // Discover the actual authored entry from the real package exports and
        // source manifest. No fixture-only Re.Pack export can stand in for the
        // production renderer ABI, and no release artifact is produced here.
        const projectRoot = fileURLToPath(new URL('../../../../../packages/tests/fixtures/plugin-platform/composer-external-dogfood/', import.meta.url));
        const manifestPath = join(harness.baseDir, `external-${answer}-manifest.json`);
        await writeFile(manifestPath, JSON.stringify(externalManifest));
        const artifacts = await discoverExecutablePluginUiArtifacts(projectRoot, manifestPath);
        const artifact = artifacts.find(artifact => artifact.artifactId === renderer.artifact);
        expect(artifact?.requestedExports).toEqual(['renderSurface']);
        if (!artifact) throw new Error('The declared renderer has no executable entry');
        const artifactModule = await vi.importActual<Partial<PluginReactNativeSurfaceModule>>(artifact.entryPath);
        expect(artifactModule.renderSurface, 'The declared source entry must export the canonical renderer').toBeTypeOf('function');
        if (!artifactModule.renderSurface) throw new Error('The declared entry has no renderSurface export');
        const nativeModule = { renderSurface: artifactModule.renderSurface } satisfies PluginReactNativeSurfaceModule;
        const { owner, discussionId } = await fixture();
        const receiver = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: receiver.id } } })).toMatchObject({ ok: true });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        const requests: { method: string; url: string; status: number }[] = [];
        app.addHook('onResponse', async (request, reply) => { requests.push({ method: request.method, url: request.url, status: reply.statusCode }); });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // Only credential verification is replaced; the Action adapter uses real
        // loopback HTTP, strict routes, grants, codec and storage below it.
        app.decorate('authenticate', async (request: FastifyRequest) => {
            request.userId = owner.id;
            request.authAuthority = 'present_user';
            request.authTokenKind = 'account';
        });
        // Vitest mode travels in the actual AUTO payload; ambient controller
        // environment is deliberately not assumed to cross execution hosts.
        if (import.meta.env.MODE !== 'u6-subtract-discussion-route') registerDiscussionRoutes(app);
        registerAccountEncryptionRoutes(app);
        registerSessionListingRoutes(app);
        registerSessionLookupByTagsRoute(app);
        registerSessionFollowRoutes(app);
        registerSessionMessageRoutes(app);
        sessionPendingRoutes(app);
        registerSessionTurnMutationRoute(app);
        registerMachineSessionMessageReplyRoutes(app);
        featuresRoutes(app);
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        const serverId = await getOrCreateServerIdentityId();
        const features = { status: 'ready' as const, features: FeaturesResponseSchema.parse({
            features: { sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } },
            capabilities: { serverIdentity: { serverIdentityId: serverId } },
        }) };
        const executor = createActionExecutor(createDiscussionActionDeps({ credentials: { token: 'fixture', encryption: null },
            serverId, serverHttpBaseUrl: origin, resolveServerFeaturesSnapshot: () => features }));
        const context = { serverId, surface: 'ui' as const, authority: 'present_user' as const,
            actionsSettings: normalizeActionsSettingsV1({ v: 1 }) };
        const ref = { kind: 'discussion' as const, discussionId };
        const post = async (value: ReturnType<typeof DiscussionPostInputV1Schema.parse>) => {
            const result = await executor.execute('discussion.post', value, context);
            return result.ok ? result.result : result;
        };
        let sent: Promise<unknown> | undefined;
        let input: ReturnType<typeof DiscussionPostInputV1Schema.parse> | undefined;
        const screen = await renderScreen(React.createElement(MountedComposer, { serverId, accountId: owner.id, discussionId,
            onSend: content => {
                input = DiscussionPostInputV1Schema.parse({ discussionId, localId: 'external-question', content });
                sent = post(input);
            } }));
        let external: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter> | undefined;
        const composerHandlers = createComposerPresentationHostHandlers({ scope: { serverId, accountId: owner.id }, owner: {
            identity: { pluginId: externalManifest.id, localId: control.id }, occurrenceId: 'external-review-v1', surfaceInstanceKey: 'external-review',
        }, publishComposerSnapshot: event => { external?.publishComposerSubscriptionEvent(event); } });
        const composerMethods = ['readDiscussionComposer', 'watchComposer', 'applyComposer', 'focusComposer',
            'acquireComposerInputLock', 'disposeHostResource'] as const;
        const surface = createSurfaceContextFixture({ target: { kind: 'app' } });
        external = createCanonicalPluginReactNativeHostApiAdapter({ surface,
            requestSurface: { pluginId: externalManifest.id, contributionId: control.id, surfaceId: renderer.id, placement: 'composerSurface',
                platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] },
            requestIdPrefix: 'external-declared-composer', installedMethods: composerMethods,
            handleRequest: (request, options) => {
                const method = composerMethods.find(method => method === request.method);
                const handler = method && composerHandlers[method];
                if (!handler) throw new Error(`Unbound Composer method ${request.method}`);
                return handler(request, options);
            },
        });
        let client: ApiSessionClient | undefined;
        const runtimeLifetime = new AbortController();
        let pluginScreen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        let pluginTestkit: Awaited<ReturnType<typeof createPluginTestkit>> | undefined;
        let restoreRpcBoundary: (() => void) | undefined;
        try {
            const participantScenario = createDiscussionParticipantQuestion(receiver.id);
            pluginTestkit = await createPluginTestkit({ manifest: externalManifest, module: { activate: activateExternalPlugin } });
            const declaration = externalManifest.contributes.composerReferences.find(reference => reference.id === 'issues');
            if (!declaration) throw new Error('The external fixture has no declared issue reference');
            const provider = pluginTestkit.registration('composerReferences', declaration.id);
            if (!provider) throw new Error('The external fixture did not register its declared issue reference');
            const candidates = await provider.search('issue-42', runtimeLifetime.signal);
            expect(candidates).toHaveLength(1);
            const candidate = candidates[0];
            if (!candidate) throw new Error('The actual external reference search returned no candidate');
            // The fixture's real declaration-bound registration supplies the
            // candidate; selection uses the same typed-reference owner as the picker.
            const selection = buildContributedComposerReferenceSelection({
                reference: { pluginId: externalManifest.id, localId: declaration.id }, candidate, trigger: '@',
            });
            const reference = { ...selection.payload, token: selection.token };
            expect(await provider.resolve(candidate.id, runtimeLifetime.signal)).toMatchObject({
                id: candidate.id, context: `External issue ${candidate.id}`,
            });
            const scenario = { ...participantScenario, draft: { text: `${participantScenario.draft.text} ${reference.token}` },
                content: { v: 1, parts: [...participantScenario.content.parts.map((part, index, parts) =>
                    part.t === 'text' && index === parts.length - 1 ? { ...part, text: `${part.text} ` } : part),
                { t: 'reference', reference }] } };
            pluginScreen = await renderScreen(React.createElement(PluginReactNativeSurface, {
                surfaceId: renderer.id, decision: { state: 'load', reason: 'compatible', diagnostics: [] }, module: nativeModule,
                renderContext: { plugin: { id: externalManifest.id, version: externalManifest.version }, surface, hostApi: external.api,
                    signal: runtimeLifetime.signal, launchInput: { v: 1, role: 'controlInteraction', controlLocalId: control.id, state: {} } },
                privateHostBindings: { composerRef: ref }, interactionEnabled: true,
            }));
            expect(pluginScreen.findHostByTestId('discussion-helper-participant')).not.toBeNull();
            await act(async () => {
                pluginScreen!.changeTextByTestId('discussion-helper-participant', receiver.id);
            });
            await expect.poll(() => pluginScreen!.findByTestId('discussion-helper-apply')?.props.disabled).toBe(false);
            await pluginScreen.pressByTestIdAsync('discussion-helper-apply');
            const selected = await external.api.readComposer(ref);
            if (selected.status !== 'ready') throw new Error('The public mounted draft is unavailable');
            await act(async () => {
                expect(await external!.api.applyComposer(ref, { expectedRevision: selected.snapshot.revision, operations: [
                    { kind: 'text.set', text: scenario.draft.text },
                    { kind: 'reference.insert', reference: { ...reference, start: participantScenario.draft.text.length + 1,
                        end: scenario.draft.text.length } },
                ] })).toMatchObject({ status: 'applied' });
            });
            const applied = await external.api.readComposer(ref);
            expect(applied).toMatchObject({ status: 'ready', snapshot: { text: scenario.draft.text,
                references: [expect.objectContaining({ token: '@Reviewer' }), expect.objectContaining(reference)] } });
            await expect.poll(() => pluginScreen!.findHostByTestId('discussion-helper-snapshot')?.children.join(''))
                .toContain(scenario.draft.text);
            expect(sent, 'The plugin can edit the draft but cannot publish it').toBeUndefined();
            expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(1);
            await screen.pressByTestIdAsync('new-session-composer-send');
            expect(sent).toBeDefined();
            const questionPayload = await sent;
            expect(input).toMatchObject({ content: scenario.content });
            if (!input) throw new Error('The real mounted composer did not submit');
            for (const forged of [{ ...input, producerV1: { v: 1, kind: 'agent', sessionId: receiver.id } },
                { ...input, accountId: owner.id }, { ...input, throughSeq: 999 }]) {
                expect(await executor.execute('discussion.post', forged, context)).toMatchObject({ ok: false });
            }
            expect(questionPayload, JSON.stringify(requests)).toMatchObject({ message: { localId: input.localId } });
            const question = DiscussionPostResultV1Schema.parse(questionPayload);
            const retry = await post(input);
            expect(retry).toMatchObject({ message: { id: question.message.id } });
            expect(question.message).toMatchObject({ authorAccountId: owner.id, producerV1: null,
                content: scenario.content, addressingV1: { throughSeq: question.message.seq, participantSessionIds: [receiver.id] } });
            expect(await executor.execute('discussion.read', { discussionId, messageId: question.message.id }, context))
                .toMatchObject({ ok: true, result: { messages: [{ content: scenario.content }] } });
            const discussion = { discussionId, messageId: question.message.id, throughSeq: question.message.seq, participantSessionId: receiver.id };
            const observe = () => inTx(tx => observePendingSessionFollowForDestinationInTx(tx, { principal: {
                kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId: receiver.id }));
            const observed = await observe();
            expect(observed.observations).toEqual([{ source: { kind: 'discussion', discussionId }, destinationSessionId: receiver.id,
                addressing: discussion, policy: { preset: 'quiet' }, event: { kind: 'needs_you', type: 'decision', mode: 'wait' } }]);
            const laterMarker = 'LATER_PEER_CONTENT_MUST_NOT_ENTER_THE_QUESTION';
            const later = DiscussionPostResultV1Schema.parse(await post({
                discussionId, localId: 'later-peer-message', content: document(laterMarker),
            }));
            expect(later.message.seq).toBeGreaterThan(discussion.throughSeq);
            const { socket, machine } = await publisherSocket(owner.id, receiver.id);
            await db.session.update({ where: { id: receiver.id }, data: { active: true,
                metadata: JSON.stringify({ machineId: machine.id, path: '/repo', claudeSessionId: 'native' }) } });
            const current = await db.session.findUniqueOrThrow({ where: { id: receiver.id } });
            const publisherAuthority = { accountId: owner.id, sessionId: receiver.id, machineId: machine.id, committedFence: current.lastActiveAt };
            const localId = deriveDiscussionFollowInputLocalIdV1(discussion);
            const fixtureSession = createPlainSessionFixture({ id: receiver.id });
            const defaultSocket = createApiSessionSocketStub();
            let loseNextPublicationAck = false;
            const transportSocket = createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
                if (event !== DISCUSSION_AGENT_POST_EVENT_V1) return defaultSocket.emitWithAck(event, payload);
                let response: unknown;
                await getSocketHandler(socket, event)(payload, (value: unknown) => { response = value; });
                if (loseNextPublicationAck) {
                    loseNextPublicationAck = false;
                    throw new Error('socket has been disconnected');
                }
                return response;
            } });
            const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: owner.id })).toString('base64url')}.fixture`, encryption: null };
            const admissions: unknown[] = [];
            client = new ApiSessionClient(credentials.token, { ...fixtureSession,
                metadata: { ...fixtureSession.metadata, machineId: machine.id } }, {
                metadataAuthority: { kind: 'owner', credentials }, localMachineId: machine.id,
                getServerFeaturesSnapshot: () => features,
                machineAdmissionTransport: async payload => {
                    const emitted = SessionPendingEnqueueByMachineRequestV1Schema.parse(payload);
                    const result = await enqueuePendingMessageByAuthenticatedMachine({ ...emitted, accountId: owner.id, sourceMachineId: machine.id });
                    admissions.push(result);
                    return result;
                },
                transport: { serverId, serverUrl: origin, createSessionSocketTransport: () => ({ socket: transportSocket as never,
                    transport: createSocketTransportAdapter(transportSocket as never) }) },
            });
            {
                const intake = createDiscussionFollowInputIntake({ session: client, credentials });
                for (let retry = 0; retry < 2; retry += 1) {
                    const admitted = await intake({ observation: observed.observations[0]!, signal: new AbortController().signal });
                    expect(admitted, JSON.stringify({ requests, admissions })).toBe(true);
                }
            }
            expect(await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: receiver.id, publisherAuthority,
                deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' }))
                .toMatchObject({ ok: true, didMaterialize: true, message: { localId } });
            const pending = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: receiver.id, localId } } });
            expect(pending.content).toMatchObject({ t: 'plain', v: { content: { text: expect.stringContaining('Check this') } } });
            expect(JSON.stringify(pending.content)).not.toContain(laterMarker);
            if (!pending.content || typeof pending.content !== 'object' || !('t' in pending.content) || pending.content.t !== 'plain') throw new Error('Expected plain Pending content');
            const content = pending.content;
            const body = content.v;
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected Pending user input');
            const meta = 'meta' in body ? body.meta : undefined;
            if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('Expected protected Pending metadata');
            const request = SessionInputRequestV1Schema.parse(readSessionInputRequest(meta, 'stored'));
            expect(request).toMatchObject({ discussionAddressing: discussion, actionRequestAttributionV1: {
                requester: { serverId, accountId: owner.id }, persona: { serverId, sessionId: receiver.id },
            } });
            const receipt = SessionInputAdmissionReceiptV1Schema.parse(pending.inputAdmissionReceipt);
            expect(receipt).toMatchObject({ discussionAddressing: discussion });
            const reply = { mode: 'return' as const, discussion, actionRequestAttributionV1: request.actionRequestAttributionV1 };
            const finalContent = { t: 'plain' as const, v: { ...body, meta: withSessionInputAuthorityV1({ ...meta },
                settleSessionInputRequestV1({ request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt })) } };
            finalContent.v.meta[SESSION_MESSAGE_PROVENANCE_META_KEY] = settleSessionMessageProvenanceV1({ request,
                requestedProvenance: readSessionMessageProvenance(meta, 'stored'), inputAdmissionReceipt: receipt });
            expect(await settlePendingInputAdmission({ actorUserId: owner.id, sessionId: receiver.id, localId, publisherAuthority,
                decision: { kind: 'admit', finalContent, validation: { reply } } })).toMatchObject({ ok: true, result: { status: 'accepted' } });
            const turnId = 'external-question-turn';
            expect(await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: receiver.id, localId, publisherAuthority,
                acceptedTurn: { kind: 'newTurn', turnId } })).toMatchObject({ ok: true, didResolve: true });
            const original = await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: receiver.id, localId } } });
            const observedAt = Date.now();
            expect(await applySessionTurnMutation({ actorUserId: owner.id, authentication, mutation: {
                v: 1, sessionId: receiver.id, mutationId: 'external-turn-begin', action: 'begin', turnId,
                startingInputId: localId, observedAt, transcriptAnchors: { startSeqInclusive: original.seq, userMessageSeqs: [original.seq] },
            } satisfies SessionTurnMutationV1 })).toMatchObject({ ok: true });
            const answerText = 'The external participant answer';
            const answerLocalId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: receiver.id, localId, acceptedTurnId: turnId });
            transportSocket.connected = true;
            applyRunnerMcpSessionContext(client, { getActiveTurnAdmissionWitness: () => null,
                getRuntimeLifetimeSignal: () => runtimeLifetime.signal, getHostTurnAbortSignal: () => runtimeLifetime.signal });
            // Only the user Socket.IO network adapter is substituted. The real
            // RPC codec and registered Session publisher handle its exact packet.
            const rpcBoundary = vi.spyOn(sessionSockets, 'createUserScopedSocketConnection').mockImplementation(() => {
                const rpcSocket = createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
                    expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
                    if (!payload || typeof payload !== 'object' || !('method' in payload) || !('params' in payload)) throw new Error('Invalid RPC packet');
                    expect(payload.method).toBe(`${receiver.id}:${SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1}`);
                    const result = await client!.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1, payload.params);
                    return { ok: true, result };
                } });
                return { socket: rpcSocket as never, transport: createSocketTransportAdapter(rpcSocket as never) };
            });
            restoreRpcBoundary = () => rpcBoundary.mockRestore();
            const returnPublisher = createDiscussionReplyReturnPublisher({ credentials, machineId: machine.id, serverId,
                serverHttpBaseUrl: origin, signal: runtimeLifetime.signal, isCurrent: async () => true,
                actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
                    approvalWaivedSurfaces: { 'discussion.reply': ['agent'] } }) },
            });
            const attempts: DiscussionReplyReturnPublication[] = [];
            const recover = () => runWithServerHttpBaseUrl(origin, () => recoverSessionMessageRepliesForMachine({
                machineId: machine.id, serverId, credentials, signal: runtimeLifetime.signal, isCurrent: async () => true,
                publishDiscussionReply: async original => { attempts.push(original); return returnPublisher(original); },
                machineAdmissionTransport: async () => { throw new Error('A Discussion return must not send another Session input'); },
                markReturned: async () => { throw new Error('A Discussion return must settle through its own append transaction'); },
            }));
            // An explicit reply uses the same real Action adapter and current
            // Session publisher, before terminal fallback considers its result.
            const explicitExecutor = createActionExecutor(createDiscussionActionDeps({ credentials, serverId, serverHttpBaseUrl: origin,
                resolveServerFeaturesSnapshot: () => features, postAgentMessage: async publication => client!.postAgentDiscussionMessage(publication) }));
            const explicit = answer === 'explicit' ? await explicitExecutor.execute('discussion.reply', { discussionId,
                localId: answerLocalId, replyTarget: { kind: 'message', messageId: question.message.id }, content: document(answerText),
            }, { serverId, surface: 'agent', authority: 'account_automation', defaultSessionId: receiver.id,
                sessionInputSource: { sourceSessionId: receiver.id, sourceTurnId: turnId, sourceInputId: localId, via: 'action', discussionAddressing: discussion },
                discussionReplyReturn: { serverId, requestLocalId: localId, acceptedTurnId: turnId },
                actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'discussion.reply': ['agent'] } }),
            }) : null;
            if (explicit) expect(explicit).toMatchObject({ ok: true });
            // The provider boundary yields one exact final; C2's terminal hook
            // and the authenticated publisher retain the real original custody.
            const final = await createSessionMessage({ actorUserId: owner.id, sessionId: receiver.id, publisherAuthority,
                inputAdmission: 'transcriptOnly', messageRole: 'agent', content: { t: 'plain', v: { role: 'agent', content: {
                    type: 'text', text: answer === 'explicit' ? 'A later final cannot replace the explicit answer' : answerText,
                } } } });
            expect(final).toMatchObject({ ok: true });
            if (!final.ok) throw new Error(final.error);
            const terminal = { v: 1, sessionId: receiver.id, mutationId: 'external-turn-complete', action: 'complete', turnId,
                observedAt: observedAt + 1, transcriptAnchors: { startSeqInclusive: original.seq, endSeqInclusive: final.message.seq,
                    userMessageSeqs: [original.seq], finalAssistantMessageSeq: final.message.seq } } satisfies SessionTurnMutationV1;
            expect(await applySessionTurnMutation({ actorUserId: owner.id, authentication, mutation: terminal })).toMatchObject({ ok: true });
            if (answer === 'final') expect((await db.sessionMessage.findUniqueOrThrow({
                where: { sessionId_localId: { sessionId: receiver.id, localId } },
            })).replyProgress).toMatchObject({ disposition: 'return_pending', outcome: {
                kind: 'answer', result: { sessionId: receiver.id, messageId: final.message.id },
            } });
            loseNextPublicationAck = answer === 'final';
            if (answer === 'final') {
                const lostAcknowledgement = recover();
                await expect(lostAcknowledgement).rejects.toBeInstanceOf(RpcError);
                await expect(lostAcknowledgement).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN,
                    cause: { message: 'socket has been disconnected' } });
            } else await recover();
            expect(loseNextPublicationAck).toBe(false);
            const posted = await db.discussionMessage.findUniqueOrThrow({ where: { discussionId_localId: { discussionId, localId: answerLocalId } } });
            expect(posted).toMatchObject({ authorAccountId: owner.id,
                producerV1: { kind: 'agent', sessionId: receiver.id, actionRequestAttributionV1: request.actionRequestAttributionV1 },
                replyTargetV1: { kind: 'message', messageId: question.message.id },
                addressingV1: { participantSessionIds: [] }, content: { t: 'plain', v: document(answerText) } });
            expect(attempts).toHaveLength(answer === 'final' ? 1 : 0);
            // Lost publisher ACK plus repeated native completion rejoins one row.
            expect(await applySessionTurnMutation({ actorUserId: owner.id, authentication, mutation: terminal })).toMatchObject({ ok: true });
            await recover();
            expect(attempts).toHaveLength(answer === 'final' ? 1 : 0);
            expect(await db.discussionMessage.count({ where: { discussionId, localId: answerLocalId } })).toBe(1);
            // Initial message, question, post-cutoff peer message and exactly
            // one reply; a retry with a different id must also be caught.
            expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(4);
            expect(await db.sessionMessage.count({ where: { sessionId: receiver.id, localId } })).toBe(1);
            expect((await observe()).observations).toEqual([]);
            // Recovery consumes the exact native result above; the canonical
            // atomic append settles both paths to the committed publication.
            const outcome = { kind: 'answer', publicationRef: { kind: 'discussion',
                discussion: { serverId, discussionId }, messageId: posted.id } };
            expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: receiver.id, localId } } })).replyProgress)
                .toMatchObject({ disposition: 'returned', discussion, returnedInputLocalId: answerLocalId, outcome });
        } finally {
            restoreRpcBoundary?.();
            runtimeLifetime.abort();
            await pluginTestkit?.dispose();
            await client?.close();
            await act(async () => { pluginScreen?.unmount(); });
            external.dispose(); composerHandlers.dispose(); await act(async () => { screen.unmount(); }); await app.close();
        }
    });
});
