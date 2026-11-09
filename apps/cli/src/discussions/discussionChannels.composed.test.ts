import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { FeaturesResponseSchema, accountSettingsParse, createActionExecutor } from '@happier-dev/protocol';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { decideApprovalRequestTransition, createApprovalRequestArtifact } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { DiscussionPostRequestV1Schema } from '@happier-dev/protocol/discussions/api';
import { DiscussionSummaryV1Schema, type DiscussionMessageV1 } from '@happier-dev/protocol/discussions/models';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createDiscussionActionDeps } from './discussionActionDeps';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { deriveKey } from '@/utils/deriveKey';
import { openSessionStoredContent, sealSessionStoredContent, type SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionStoredContentCodec';
import { createBackgroundServiceRunnerHost } from '@/plugins/runtime/lifecycle/contributions/backgroundServices';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { channelsTargetedContributionServices } from '../../../../packages/plugins/channels/src/testkit/operationOnlyTargetedContributionsFixture';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import { createPluginActionCallerMaterializationFixture } from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { createEmailTransportFixture, config as emailConfig, connection as emailConnection, mailbox } from '../../../../packages/plugins/channel-email/testkit/emailTransportFixture';
import { createChannelsJourneyFixture } from '../../../../packages/plugins/channels/src/testkit/channelsJourney';
import { createCurrentConversationConnectionFixture } from '../../../../packages/plugins/channels/src/testkit/currentConnectionFixture';
import { createConversationDiscussionProjectionFrontierRow } from '../../../../packages/plugins/channels/src/discussionProjection';
import { CHANNEL_STATE_COLLECTION, CHANNEL_DELIVERIES_COLLECTION } from '../../../../packages/plugins/channels/src/collections';
import { decodeDiscussionUploadMetadataV1, readBinaryUploadFrameV1, DISCUSSION_UPLOAD_PATH_V1 } from '@happier-dev/transfers';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import { openResourceBinaryContent } from '@/api/encryption/resourceBinaryContent';
import { DiscussionMessageContentV1Schema, readDiscussionAttachmentReferencesV1 } from '@happier-dev/protocol/discussions/content';

const { axiosRequest } = vi.hoisted(() => ({ axiosRequest: vi.fn() }));
// Home HTTP is the transport boundary; the real Discussion codec and Actions run below it.
vi.mock('axios', () => ({ default: { defaults: {}, request: axiosRequest } }));
const credentials = { token: 'token-1', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } };
const keyless = { token: 'token-1', encryption: null };
const plain = { mode: 'plain' as const, ctx: null };
const features = { status: 'ready' as const, features: FeaturesResponseSchema.parse({
  features: { sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } }, capabilities: {},
}) };
const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Hello' }] };
let ownerFingerprint: string;
const currentness = (mode: 'plain' | 'e2ee') => ({
  mode, version: 1, signingKeyFingerprint: mode === 'e2ee' ? 'a'.repeat(64) : null,
  contentKeyFingerprint: mode === 'e2ee' ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(ownerFingerprint) : null, updatedAt: 1,
  recipientEnvelopeReadiness: mode === 'plain' ? { status: 'unavailable', reason: 'plain_account' } : { status: 'available' },
});
function wireMessage(crypto: SessionStoredContentCryptoContext) {
  return { id: 'message-1', discussionId: 'discussion-1', localId: 'message-1', seq: 1,
    authorAccountId: 'account-1', accountActor: { v: 1, accountId: 'account-1', profile: null },
    producerV1: null, content: sealSessionStoredContent({ ...crypto, payload: content }),
    mentionedAccountIds: [], createdAt: 1 } satisfies DiscussionMessageV1;
}
function wireSummary(crypto: SessionStoredContentCryptoContext, envelope: string | null) {
  return DiscussionSummaryV1Schema.parse({ id: 'discussion-1', ownerAccountId: 'account-1', encryptionMode: crypto.mode,
    anchor: null, access: 'owner', keyReadiness: true, dataEncryptionKey: envelope, creationLocalId: 'creation-1',
    titleContent: sealSessionStoredContent({ ...crypto, payload: { v: 1, title: 'Title' } }),
    latestMessage: { id: 'message-1', localId: 'message-1', seq: 1, authorAccountId: 'account-1',
      accountActor: { v: 1, accountId: 'account-1', profile: null }, producerV1: null, createdAt: 1 },
    messageSeq: 1, lastReadSeq: 0, unreadCount: 1, unreadMentionCount: 0, recentAuthorAccountIds: ['account-1'],
    archivedAt: null, capabilities: { postMessages: true, rename: true, archive: true, restore: false,
      askAgent: true, sendToSession: true, manageAccess: true, leave: false } });
}
function action(options: Partial<Parameters<typeof createDiscussionActionDeps>[0]> = {}) {
  return createDiscussionActionDeps({ credentials: keyless, serverId: 'server-1', serverHttpBaseUrl: 'https://home.example.test',
    resolveServerFeaturesSnapshot: () => features, ...options }).discussionAction!;
}
async function createBackgroundOccurrence(occurrenceId: string) {
  let ready!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>(resolve => { ready = resolve; });
  let begin!: () => void;
  const beginWork = new Promise<void>(resolve => { begin = resolve; });
  let work: Promise<unknown> | undefined;
  const host = createBackgroundServiceRunnerHost({
    registrations: [{ pluginId: 'happier.channels', pluginVersion: '0.0.0', occurrenceId,
      localId: 'ingress', activation: 'demand', async runner(context) {
        ready(context.signal);
        await beginWork;
        await work;
      } }],
    createContext(input) { return { context: { plugin: { id: input.pluginId, version: input.pluginVersion },
      contribution: { id: input.localId, qualifiedId: `${input.pluginId}/backgroundServices/${input.localId}` },
      surface: 'background', invokedAtMs: Date.now(), signal: input.signal, services: createUnavailablePluginServices(),
    }, complete() {} }; },
  });
  const demand = host.demand({ pluginId: 'happier.channels', localId: 'ingress', occurrenceId });
  void demand.settlement.catch(() => undefined);
  onTestFinished(async () => { begin(); await host.dispose(); });
  return { signal: await started,
    run<T>(start: () => Promise<T>): Promise<T> { const task = start(); work = task; begin(); return task; },
    async retire() { host.retire(['happier.channels']); await host.settle(['happier.channels']); },
  };
}
beforeEach(async () => {
  vi.clearAllMocks();
  ownerFingerprint = computeContentPublicKeyFingerprint(libsodiumPublicKeyFromSecretKey(
    await deriveKey(credentials.encryption.secret, 'Happy EnCoder', ['content'])));
});
describe('Channels to Discussion native acceptance', () => {
  it.each([
    ['plain', false, false, 'approve', false, false], ['e2ee', false, false, 'approve', false, false],
    ['plain', true, false, 'approve', false, false], ['e2ee', true, false, 'approve', false, false],
    ['plain', true, true, 'approve', false, false], ['e2ee', true, true, 'approve', false, false],
    ['plain', false, true, 'approve', false, false], ['e2ee', false, true, 'approve', false, false],
    ['plain', false, true, 'reject', false, false], ['e2ee', false, true, 'reject', false, false],
    ['plain', false, true, 'canceled', false, false], ['e2ee', false, true, 'canceled', false, false],
    ['plain', false, true, 'approve', true, false],
    ['plain', false, true, 'denied', false, false],
    ['plain', false, true, 'approve', false, true], ['e2ee', false, true, 'approve', false, true],
  ] as const)('composes mailbox-bound Email thread ingress, Discussion %s writer/reader and reply delivery (files=%s, approval=%s, decision=%s, generation update=%s, concurrent mail=%s)', async (mode, withFiles, requiresApproval, decision, replaceGeneration, concurrentMail = false) => {
    const caller = mode === 'plain' ? keyless : credentials;
    const key = await createResourceDataKey({ credentials: caller, mode });
    const crypto: SessionStoredContentCryptoContext = key.mode === 'plain' ? plain
      : { mode: 'e2ee', ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' } };
    // Discussion creation atomically commits its first message; an empty
    // resource is not a valid Home state. This unrelated root must not echo.
    const messages: DiscussionMessageV1[] = [wireMessage(crypto)];
    const posts: ReturnType<typeof DiscussionPostRequestV1Schema.parse>[] = [];
    const receivedFiles: Buffer[] = [];
    let deniedPosts = 0;
    // Substitute only Home transport/persistence; the Action executor, resource
    // encryption, Discussion writer/reader and all Channels owners stay real.
    axiosRequest.mockImplementation(async (request: { url: string; method: string; data?: string | AsyncIterable<Uint8Array>; params?: Record<string, unknown> }) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/encryption/currentness')) return { status: 200, data: currentness(mode) };
      if (url.pathname === '/v1/discussions/discussion-1') {
        const latest = messages.at(-1);
        return { status: 200, data: { discussion: { ...wireSummary(crypto, key.dataEncryptionKey), messageSeq: messages.length,
          latestMessage: latest ? { id: latest.id, localId: latest.localId, seq: latest.seq, authorAccountId: latest.authorAccountId,
            accountActor: latest.accountActor, producerV1: latest.producerV1, createdAt: latest.createdAt } : null } } };
      }
      if ((url.pathname.endsWith('/messages') || url.pathname === DISCUSSION_UPLOAD_PATH_V1) && request.method === 'POST') {
        if (decision === 'denied') { deniedPosts += 1; return { status: 403, data: { error: 'discussion_post_denied' } }; }
        let body: ReturnType<typeof DiscussionPostRequestV1Schema.parse>;
        if (typeof request.data === 'string') body = DiscussionPostRequestV1Schema.parse(JSON.parse(request.data));
        else {
          if (!request.data) throw new Error('Expected attachment upload body');
          let uploaded: ReturnType<typeof DiscussionPostRequestV1Schema.parse> | undefined;
          await readBinaryUploadFrameV1(request.data, { metadataMaxBytes: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1,
            decodeMetadata: decodeDiscussionUploadMetadataV1,
            onMetadata: async metadata => {
              if (metadata.operation !== 'post') throw new Error('Expected Discussion post upload');
              const { discussionId, ...request } = metadata.input;
              expect(discussionId).toBe('discussion-1');
              uploaded = DiscussionPostRequestV1Schema.parse(request);
              expect(JSON.stringify(metadata)).not.toContain('Private attachment');
              if (mode === 'e2ee') expect(JSON.stringify(metadata)).not.toContain('evidence.bin');
              return metadata.attachments;
            },
            onSegment: async (index, chunks) => {
              const pieces: Uint8Array[] = [];
              for await (const chunk of chunks) pieces.push(chunk);
              const bytes = Buffer.concat(pieces);
              const opened = openSessionStoredContent({ ...crypto, content: uploaded!.content });
              const file = readDiscussionAttachmentReferencesV1(DiscussionMessageContentV1Schema.parse(opened))[index]!;
              receivedFiles.push(Buffer.from(await openResourceBinaryContent(key, file, mode === 'plain'
                ? { t: 'plain', v: bytes.toString('base64') } : { t: 'encrypted', c: bytes.toString('base64') })));
            } });
          if (!uploaded) throw new Error('Expected admitted upload metadata');
          body = uploaded;
        }
        posts.push(body);
        let message = messages.find(row => row.localId === body.localId);
        if (!message) {
          message = { ...wireMessage(crypto), id: `message-${messages.length + 1}`, seq: messages.length + 1,
            localId: body.localId, content: body.content, mentionedAccountIds: body.mentionedAccountIds,
            ...('replyTarget' in body ? { replyTarget: body.replyTarget } : {}) };
          messages.push(message);
        }
        if (mode === 'e2ee') expect(JSON.stringify(body)).not.toContain('Private');
        return { status: 200, data: { message, messageSeq: messages.length } };
      }
      if (url.pathname.endsWith('/messages') && request.method === 'GET') {
        const messageId = request.params?.messageId ?? url.searchParams.get('messageId');
        const localId = request.params?.localId ?? url.searchParams.get('localId');
        const afterSeq = Number(request.params?.afterSeq ?? url.searchParams.get('afterSeq') ?? 0);
        return { status: 200, data: { messages: messages.filter(row => messageId ? row.id === messageId : localId ? row.localId === localId : row.seq > afterSeq),
          hasMoreOlder: false, messageSeq: messages.length } };
      }
      throw new Error(`Unexpected Discussion transport ${request.method} ${url.pathname}`);
    });
    let actionsSettings = setActionApprovalOverride({ actionId: 'discussion.post', surface: 'plugin', approvalRequired: requiresApproval,
      settings: normalizeActionsSettingsV1({}) });
    let approval: ApprovalRequestV2 | null = null;
    let approvalArtifactId = '';
    const approvals = new Map<string, ApprovalRequestV2>();
    const approvalArtifactIds: string[] = [];
    const approvalId = (index: number) => approvalArtifactIds[index] ?? '';
    let approvalCreates = 0;
    let approvalCancellations = 0;
    const coordinator = createBlockingApprovalCoordinator();
    onTestFinished(() => coordinator.dispose());
    const decidePendingApproval = async (artifactId = approvalArtifactId, requestedDecision: 'approve' | 'reject' | 'cancel' = decision === 'denied' ? 'approve' : decision === 'canceled' ? 'cancel' : decision) => {
      if (!approval) throw new Error('Expected pending approval');
      const result = await host.executor.execute('approval.request.decide', {
        artifactId, decision: requestedDecision,
      }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    };
    // Artifact persistence/notifications are the boundary. A recorded consent
    // without a delivered decision must leave the original ingress waiter held.
    const writeApproval = async (request: ApprovalRequestV2, artifactId = approvalArtifactId) => {
      const previous = approvals.get(artifactId);
      if (!previous) throw new Error('Expected approval');
      const transition = decideApprovalRequestTransition(previous, request);
      if (!transition.ok) return transition;
      if (request.status === 'canceled') approvalCancellations += 1;
      const updated = ApprovalRequestV2Schema.parse(request);
      approvals.set(artifactId, updated);
      if (artifactId === approvalArtifactId) approval = updated;
      coordinator.notifyApprovalUpdated({ artifactId, request: updated });
      return { ok: true };
    };
    const actionFailures: unknown[] = [];
    const host = createCliActionExecutorHarness({ token: caller.token, credentials: caller, sessionId: 'cli-global',
      mode, ctx: crypto.ctx, serverId: 'server-1', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.example.test',
      resolveServerFeaturesSnapshot: () => features, actionsSettingsProvider: {
        getAccountSettings: () => accountSettingsParse({ actionsSettingsV1: actionsSettings }), getActionsSettings: () => actionsSettings,
      } }, { discussionAction: action({ credentials: caller }),
      approvalsCreate: async ({ request, serverId }) => createApprovalRequestArtifact({
        request, serverId, newId: () => 'legacy-approval',
        read: async artifactId => {
          const stored = approvals.get(artifactId);
          return stored ? { header: buildApprovalRequestArtifactHeaderV1(stored, { legacyServerId: serverId }),
            body: JSON.stringify(stored), access: 'owner' } : null;
        },
        create: async (artifactId, header, body) => {
          if (approvals.has(artifactId)) throw Object.assign(new Error('conflict'), { code: 'conflict' });
          approvalCreates += 1;
          approvalArtifactIds.push(artifactId);
          approvalArtifactId = artifactId;
          approval = ApprovalRequestV2Schema.parse(JSON.parse(body));
          approvals.set(artifactId, approval);
          return { header, body, access: 'owner' };
        },
      }),
      approvalsGet: async ({ artifactId }) => approvals.get(artifactId) ?? null,
      approvalsUpdate: async ({ artifactId, request }) => writeApproval(ApprovalRequestV2Schema.parse(request), artifactId),
      approvalsResolveBlockingDecision: args => coordinator.resolveBlockingDecision(args),
      approvalsWaitForDecision: async args => {
        const waiting = coordinator.waitForDecision({ ...args, readRequest: async () => approvals.get(args.artifactId) ?? null });
        // The first Ask remains undecided while recovery ticks run. Later
        // inputs exercise the ordinary decision and original-thread reply path.
        if (!concurrentMail && !replaceGeneration && approvalCreates > 1) await decidePendingApproval();
        const result = await waiting;
        return { ...result, request: ApprovalRequestV2Schema.parse(result.request) };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    });
    let backgroundOccurrence = replaceGeneration || concurrentMail ? await createBackgroundOccurrence('discussion-journey') : undefined;
    const createActions = (signal: AbortSignal, occurrenceId: string) => createPluginInvocationActionsService({ seed: {
      plugin: { id: 'happier.channels', version: '0.0.0' },
      contribution: { id: 'inbound', qualifiedId: 'happier.channels/actions/inbound' }, occurrenceId,
      correlationId: occurrenceId,
      sourceCustody: { kind: 'development', registeredRootId: 'channels-discussion-root' },
      resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('happier.channels', {
        machineId: 'discussion-machine', materializationId: 'channels-journey-core',
      }).resolveCurrentPluginMaterializationRef,
      surface: 'background', signal, isOccurrenceCurrent: () => !signal.aborted,
      approvalContext: { serverId: 'server-1', serverIdentityId: 'srv_home', runtimeAccountId: 'account-1', expectedAccountId: 'account-1' },
    }, actionExecutor: { ...host.executor,
      // The production credentialed host binds each private invocation lifetime.
      bindInvocation: (_signal, hostActionApprovalLifetime) => {
        const executor = createActionExecutor({ ...host.deps, hostActionApprovalLifetime });
        return { ...executor, execute: async (id, input, context) => {
          const result = await executor.execute(id, input, context);
          if (!result.ok) actionFailures.push(result);
          return result;
        } };
      },
    },
    invokeContributedAction: async () => { throw new Error('Discussion is a host Action'); } });
    let actions = createActions(backgroundOccurrence?.signal ?? new AbortController().signal, 'discussion-journey');
    const email = await createEmailTransportFixture();
    onTestFinished(() => email.dispose());
    vi.useFakeTimers({ toFake: concurrentMail ? ['Date', 'setTimeout', 'clearTimeout'] : ['Date'] });
    vi.setSystemTime(email.receivedAtMs);
    onTestFinished(() => vi.useRealTimers());
    const providerId = email.materializationRef.pluginId;
    const placement = { serverIdentityId: 'srv_plugin_testkit', materializationRef: email.materializationRef };
    const connection = createCurrentConversationConnectionFixture({ connectionId: 'connection-1',
      authority: { providerPluginId: providerId, providerContributionSelection: { contributionId: 'email-provider' },
        providerSetupInput: { ...emailConfig, credentialRef: null }, credentialRef: null, transportOrigin: placement,
        providerConnectionKey: emailConnection.providerConnectionKey, providerConfig: emailConfig,
        routingIdentityKey: 'r'.repeat(43), integrationPrincipal: { id: mailbox }, authorityEpoch: 1 } });
    const endpoint = { kind: 'direct', audience: 'direct', id: mailbox, label: 'Private support' } as const;
    const threadEndpoint = { kind: 'thread', audience: 'direct', id: '<thread-1@example.test>', parentId: endpoint.id, label: endpoint.label } as const;
    const binding = { id: 'binding-1', 'record-kind': 'binding', v: 1, 'connection-id': 'connection-1', 'binding-id': 'binding-1',
      'created-at': 1, 'updated-at': 1, payload: { endpoint, authorityEpoch: 1, enabled: true, deletionState: 'none',
        target: { kind: 'discussion', discussionId: 'discussion-1', policy: { deliveryMode: 'repliesOnly' } },
        allowedPrincipalIds: ['alice@example.com'], allowBotSenders: false, inputMode: 'allAllowedMessages', inboundDebounceMs: 750,
        linkPreviewPolicy: 'suppress', senderFeedback: 'off' } };
    // Session transport is a separate host boundary and must never be reached.
    const sessions = { get: async () => { throw new Error('Discussion binding must not use a Session'); } } as unknown as PluginServices['sessions'];
    let journey = await createChannelsJourneyFixture({ provider: email.email, connection, binding, sessions, actions,
      resolveCurrentProviderExecutionOrigin: () => placement });
    onTestFinished(() => journey.dispose());
    await journey.state.put(createConversationDiscussionProjectionFrontierRow({ bindingId: 'binding-1',
      targetDiscussionId: 'discussion-1', lastScannedSeq: 0, now: 1 }), { expectedRevision: 'absent' });
    const runDue = () => backgroundOccurrence
      ? journey.kit.invokeAction('journey/due', {}, { surface: 'plugin', signal: backgroundOccurrence.signal,
        services: channelsTargetedContributionServices(journey.kit) }) : journey.due();
    const retainedMail: Array<readonly [string, Buffer]> = [];
    const addInbound = (sender: string, id: string, threadId = threadEndpoint.id, fileInput?: 'mixed' | 'filesOnly') => {
      const raw = Buffer.from([`From: Private sender <${sender}>`, `To: ${mailbox}`, `Message-ID: <${id}@example.com>`,
        `References: ${threadId}`, 'Authentication-Results: mx.example.com; dmarc=pass header.from=example.com',
        'Subject: Private support', ...(fileInput ? ['MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="files"', '',
          '--files', 'Content-Type: text/plain; charset=utf-8', '', fileInput === 'mixed' ? 'Private inbound' : '',
          '--files', 'Content-Type: application/octet-stream; name="evidence.bin"', 'Content-Disposition: attachment; filename="evidence.bin"',
          'Content-Transfer-Encoding: base64', '', Buffer.from('Private attachment\0\xff', 'latin1').toString('base64'), '--files--']
          : ['Content-Type: text/plain; charset=utf-8', '', 'Private inbound'])].join('\r\n'));
      retainedMail.push([id, raw]);
      email.setMessages(concurrentMail ? retainedMail : [[id, raw]]);
      email.addMessage(`<${id}@example.com>`, raw);
    };
    const inbound = async (sender: string, id: string, threadId = threadEndpoint.id, fileInput?: 'mixed' | 'filesOnly') => {
      addInbound(sender, id, threadId, fileInput);
      await journey.poll();
      vi.setSystemTime(Date.now() + 750);
      await runDue();
    };
    email.setMessages([]);
    await journey.poll();
    if (concurrentMail) {
      if (!backgroundOccurrence) throw new Error('Expected native background lifetime');
      const occurrence = backgroundOccurrence;
      addInbound('alice@example.com', 'mail-A');
      const supervising = occurrence.run(() => journey.kit.invokeAction('journey/supervise', {}, {
        surface: 'plugin', signal: occurrence.signal, services: channelsTargetedContributionServices(journey.kit),
      }));
      void supervising.catch(() => undefined);
      const ingressRows = () => [...journey.state.rows.values()].filter(row => row.value['record-kind'] === 'ingress-obligation');
      try {
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.waitFor(() => expect(coordinator.getLiveWaiterCount(approvalId(0))).toBe(1), { timeout: 5_000 });
        addInbound('alice@example.com', 'mail-B', '<thread-B@example.test>');
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.waitFor(() => expect(coordinator.getLiveWaiterCount(approvalId(1))).toBe(1));
        expect([...journey.state.rows.values()].filter(row => row.value['record-kind'] === 'ingress-census')).toHaveLength(2);
        expect(ingressRows()).toHaveLength(2);
        const pendingRows = ingressRows();
        for (let tick = 0; tick < 5; tick += 1) {
          await vi.advanceTimersByTimeAsync(1_000);
          expect(approvalCreates).toBe(2);
          expect(approvalCancellations).toBe(0);
          expect(coordinator.getLiveWaiterCount(approvalId(0))).toBe(1);
          expect(coordinator.getLiveWaiterCount(approvalId(1))).toBe(1);
          expect(ingressRows()).toEqual(pendingRows);
          expect(posts).toHaveLength(0);
        }
        await decidePendingApproval(approvalId(1), 'reject');
        await vi.waitFor(() => expect(ingressRows().filter(row => row.value.terminal === true)).toHaveLength(1));
        expect(approvals.get(approvalId(1))).toMatchObject({ status: 'rejected' });
        expect(coordinator.getLiveWaiterCount(approvalId(0))).toBe(1);
        expect(posts).toHaveLength(0);
        await decidePendingApproval(approvalId(0), 'approve');
        await vi.waitFor(() => expect(ingressRows().filter(row => row.value.terminal === true)).toHaveLength(2));
        expect(approvals.get(approvalId(0))).toMatchObject({ status: 'executed', execution: { ok: true } });
        expect(posts).toHaveLength(1);
        expect(openSessionStoredContent({ ...crypto, content: messages[1]!.content })).toMatchObject({
          parts: [{ t: 'text', text: 'Private inbound' }],
        });
        expect(ingressRows()).toEqual(expect.arrayContaining([
          expect.objectContaining({ value: expect.objectContaining({ payload: expect.objectContaining({
            disposition: 'admitted', lifecycle: expect.objectContaining({ phase: 'terminal', attemptCount: 1 }),
          }) }) }),
          expect.objectContaining({ value: expect.objectContaining({ payload: expect.objectContaining({
            disposition: 'rejected', lifecycle: expect.objectContaining({ phase: 'terminal', attemptCount: 1 }),
          }) }) }),
        ]));
        const settledRows = ingressRows();
        for (let tick = 0; tick < 5; tick += 1) {
          await vi.advanceTimersByTimeAsync(1_000);
          expect(ingressRows()).toEqual(settledRows);
          expect(approvalCreates).toBe(2);
          expect(approvalCancellations).toBe(0);
          expect(posts).toHaveLength(1);
        }
      } finally {
        await occurrence.retire();
        await Promise.allSettled([supervising]);
      }
      return;
    }
    await inbound('stranger@example.com', 'refused');
    expect(posts).toHaveLength(0);
    const accept = () => inbound('alice@example.com', 'accepted', threadEndpoint.id, withFiles ? 'mixed' : undefined);
    const accepted = backgroundOccurrence ? backgroundOccurrence.run(accept) : accept();
    // Keep a rejection observed even if an assertion interrupts the journey.
    void accepted.catch(() => undefined);
    if (requiresApproval) {
      await vi.waitFor(() => expect(coordinator.getLiveWaiterCount(approvalId(0))).toBe(1));
      const pendingRows = [...journey.state.rows.values()];
      const ticks: Promise<unknown>[] = [];
      for (const status of decision === 'approve' && !replaceGeneration ? ['open', 'approved'] as const : ['open'] as const) {
        if (status === 'approved') {
          expect(await writeApproval({ ...ApprovalRequestV2Schema.parse(approval), status, updatedAtMs: Date.now(),
            decision: { kind: 'approve', authority: 'present_user', decidedAtMs: Date.now() } })).toMatchObject({ ok: true });
        }
        for (let tick = 0; tick < 5; tick += 1) {
          vi.setSystemTime(Date.now() + 750);
          const recovery = runDue();
          void recovery.catch(() => undefined);
          ticks.push(recovery);
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(approval).toMatchObject({ status });
          expect(coordinator.getLiveWaiterCount(approvalId(0))).toBe(1);
          expect(approvalCreates).toBe(1);
          expect(approvalCancellations).toBe(0);
          expect(posts).toHaveLength(0);
          expect([...journey.state.rows.values()]).toEqual(pendingRows);
        }
      }
      if (replaceGeneration) {
        if (!backgroundOccurrence) throw new Error('Expected original background occurrence');
        await backgroundOccurrence.retire();
        await Promise.allSettled([accepted, ...ticks]);
        expect(backgroundOccurrence.signal.aborted).toBe(true);
        expect(approvals.get(approvalId(0))).toMatchObject({ status: 'open' });
        expect(approvals.get(approvalId(0))?.decision).toBeUndefined();
        expect(approvals.get(approvalId(0))?.execution).toBeUndefined();
        expect(coordinator.getLiveWaiterCount(approvalId(0))).toBe(0);
        expect(approvalCancellations).toBe(0);
        expect(posts).toHaveLength(0);
        const state = journey.state;
        const deliveries = journey.deliveries;
        await journey.dispose();
        backgroundOccurrence = await createBackgroundOccurrence('discussion-journey-successor');
        actions = createActions(backgroundOccurrence.signal, 'discussion-journey-successor');
        journey = await createChannelsJourneyFixture({ provider: email.email, connection, binding, sessions, actions,
          state, deliveries, resolveCurrentProviderExecutionOrigin: () => placement });
        const resumed = backgroundOccurrence.run(runDue);
        void resumed.catch(() => undefined);
        await vi.waitFor(() => expect(coordinator.getLiveWaiterCount(approvalId(0))).toBe(1));
        const successorRows = [...state.rows.values()];
        const successorTicks: Promise<unknown>[] = [];
        for (let tick = 0; tick < 5; tick += 1) {
          vi.setSystemTime(Date.now() + 750);
          const recovery = runDue();
          void recovery.catch(() => undefined);
          successorTicks.push(recovery);
          await new Promise<void>(resolve => setImmediate(resolve));
          expect([...approvals.values()].filter(request => request.status === 'open')).toHaveLength(1);
          expect(approvals.get(approvalId(0))).toMatchObject({ status: 'open' });
          expect(approvals.has(approvalId(1))).toBe(false);
          expect(approvalCreates).toBe(1);
          expect(approvalCancellations).toBe(0);
          expect(posts).toHaveLength(0);
          expect([...state.rows.values()]).toEqual(successorRows);
        }
        await decidePendingApproval();
        await Promise.all([resumed, ...successorTicks]);
        expect(approvals.get(approvalId(0))).toMatchObject({ status: 'executed', execution: { ok: true } });
        expect(posts).toHaveLength(1);
        expect(approvalCreates).toBe(1);
        expect(approvalCancellations).toBe(0);
        expect([...state.rows.values()].filter(row => row.value['record-kind'] === 'ingress-obligation')).toEqual(expect.arrayContaining([
          expect.objectContaining({ value: expect.objectContaining({ terminal: true,
            payload: expect.objectContaining({ disposition: 'admitted' }) }) }),
        ]));
        return;
      }
      await decidePendingApproval();
      await Promise.all(ticks);
    }
    await accepted;
    if (requiresApproval) expect(approval, JSON.stringify(actionFailures)).not.toBeNull();
    if (decision === 'denied') {
      expect(approval).toMatchObject({ decision: { kind: 'approve', authority: 'present_user' }, execution: { ok: false } });
      expect(actionFailures).toEqual(expect.arrayContaining([expect.objectContaining({ errorCode: 'discussion_post_denied' })]));
      expect([...journey.state.rows.values()]).toEqual(expect.arrayContaining([expect.objectContaining({
        value: expect.objectContaining({ 'record-kind': 'ingress-obligation', terminal: true, attention: true,
          payload: expect.objectContaining({ lifecycle: expect.objectContaining({ phase: 'terminal', attemptCount: 1, dueAt: null }),
            disposition: 'rejected', nonAdmission: expect.objectContaining({ reason: 'targetUnavailable' }) }),
        }),
      })]));
      const settled = [...journey.state.rows.values()];
      for (let tick = 0; tick < 5; tick += 1) {
        vi.setSystemTime(Date.now() + 1_000_000);
        await runDue();
        expect([...journey.state.rows.values()]).toEqual(settled);
        expect(approvalCreates).toBe(1);
        expect(deniedPosts).toBe(1);
        expect(posts).toHaveLength(0);
      }
      return;
    }
    if (decision !== 'approve') {
      expect(posts).toHaveLength(0);
      expect(approval).toMatchObject({ status: decision === 'reject' ? 'rejected' : 'canceled' });
      expect(actionFailures).toEqual(expect.arrayContaining([expect.objectContaining({
        errorCode: decision === 'reject' ? 'approval_rejected' : 'approval_canceled',
      })]));
      expect([...journey.state.rows.values()]).toEqual(expect.arrayContaining([expect.objectContaining({
        value: expect.objectContaining({ 'record-kind': 'ingress-obligation', terminal: true, attention: true,
          payload: expect.objectContaining({ lifecycle: expect.objectContaining({ phase: 'terminal', attemptCount: 1, dueAt: null }),
            disposition: 'rejected', nonAdmission: expect.objectContaining({ reason: 'targetUnavailable' }) }),
        }),
      })]));
      const settled = [...journey.state.rows.values()];
      for (let recovery = 0; recovery < 3; recovery += 1) {
        vi.setSystemTime(Date.now() + 1_000_000);
        await runDue();
      }
      expect([...journey.state.rows.values()]).toEqual(settled);
      expect(approvalCreates).toBe(1);
      expect(posts).toHaveLength(0);
      return;
    }
    expect(posts, JSON.stringify([...journey.state.rows.values()].filter(row => row.value['record-kind'] === 'ingress-obligation'))).toHaveLength(1);
    const inboundMessage = messages[1]!;
    expect(openSessionStoredContent({ ...crypto, content: inboundMessage.content })).toMatchObject({ v: 1,
      parts: [{ t: 'text', text: 'Private inbound' }, ...(withFiles ? [{ t: 'attachment', attachment: { name: 'evidence.bin' } }] : [])], externalSource: { kind: 'channel', providerPluginId: providerId,
        conversationDisplayName: endpoint.label } });
    expect(await actions.execute('discussion.read', { discussionId: 'discussion-1' })).toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ id: inboundMessage.id, content: expect.objectContaining({
        externalSource: expect.objectContaining({ kind: 'channel', providerPluginId: providerId,
          conversationDisplayName: endpoint.label }),
      }) })]),
    });
    await journey.poll();
    expect(posts).toHaveLength(1);
    expect(approvalCreates).toBe(requiresApproval ? 1 : 0);
    const delivered = [...journey.state.rows.values()].filter(row => row.value['record-kind'] === 'ingress-obligation'
      && row.value.payload && typeof row.value.payload === 'object' && !Array.isArray(row.value.payload)
      && row.value.payload.disposition === 'admitted');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.value.payload).toMatchObject({ lifecycle: { phase: 'terminal', attemptCount: 1, dueAt: null } });
    if (requiresApproval) expect(approval).toMatchObject({ status: 'executed', execution: { ok: true } });
    const settledRows = [...journey.state.rows.values()];
    for (let tick = 0; tick < 3; tick += 1) {
      vi.setSystemTime(Date.now() + 750);
      await runDue();
    }
    expect([...journey.state.rows.values()]).toEqual(settledRows);
    expect(posts).toHaveLength(1);
    expect(approvalCreates).toBe(requiresApproval ? 1 : 0);
    const occurrences = [...journey.state.rows.values()].filter(row => row.value['record-kind'] === 'ingress-census');
    expect(occurrences.length).toBeGreaterThan(0);
    for (const occurrence of occurrences) expect(occurrence.value.payload).toMatchObject({ normalizedIngress: null });
    expect(JSON.stringify([...journey.state.rows.values()])).not.toContain('Private inbound');
    await inbound('alice@example.com', 'followup', threadEndpoint.id, withFiles ? 'filesOnly' : undefined);
    expect(posts).toHaveLength(2);
    const followupMessage = messages[2]!;
    expect(followupMessage.replyTarget).toEqual({ kind: 'message', messageId: inboundMessage.id });
    expect(openSessionStoredContent({ ...crypto, content: followupMessage.content })).toMatchObject({
      parts: withFiles ? [{ t: 'attachment', attachment: { name: 'evidence.bin' } }] : [{ t: 'text', text: 'Private inbound' }],
    });
    expect(receivedFiles).toEqual(withFiles ? [Buffer.from('Private attachment\0\xff', 'latin1'), Buffer.from('Private attachment\0\xff', 'latin1')] : []);
    actionsSettings = setActionApprovalOverride({ actionId: 'discussion.post', surface: 'plugin', approvalRequired: false, settings: actionsSettings });
    const secondThread = { ...threadEndpoint, id: '<thread-2@example.test>' };
    await inbound('alice@example.com', 'second', secondThread.id);
    expect(posts).toHaveLength(3);
    const secondMessage = messages[3]!;
    expect(secondMessage.replyTarget).toBeUndefined();
    const replyTarget = { kind: 'message' as const, messageId: inboundMessage.id };
    await actions.execute('discussion.post', { discussionId: 'discussion-1', localId: 'human-reply', replyTarget,
      content: { v: 1, parts: [{ t: 'text', text: 'Private reply' }] } });
    await actions.execute('discussion.post', { discussionId: 'discussion-1', localId: 'doc-reply', replyTarget,
      content: { kind: 'doc_passage_comment', passage: { ref: { kind: 'doc', serverId: 'server-1', artifactId: 'doc-1' },
        revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 1 }, quote: 'Q' },
      content: { v: 1, parts: [{ t: 'text', text: 'Private passage reply' }] } } });
    await actions.execute('discussion.post', { discussionId: 'discussion-1', localId: 'second-thread-reply',
      replyTarget: { kind: 'message', messageId: secondMessage.id }, content: { v: 1, parts: [{ t: 'text', text: 'Private second reply' }] } });
    await actions.execute('discussion.post', { discussionId: 'discussion-1', localId: 'followup-reply',
      replyTarget: { kind: 'message', messageId: followupMessage.id }, content: { v: 1, parts: [{ t: 'text', text: 'Private followup reply' }] } });
    await journey.outward();
    expect(email.submissions).toHaveLength(4);
    const rawReplies = email.submissions.map(value => Buffer.from(value.mimeBase64, 'base64').toString());
    expect(rawReplies[0]).toContain('In-Reply-To: <accepted@example.com>');
    expect(rawReplies[1]).toContain('In-Reply-To: <accepted@example.com>');
    expect(rawReplies[2]).toContain('In-Reply-To: <second@example.com>');
    expect(rawReplies[3]).toContain('In-Reply-To: <followup@example.com>');
    expect(rawReplies[0]).toContain(threadEndpoint.id);
    expect(rawReplies[2]).toContain(secondThread.id);
    expect(email.submissions.map(value => value.envelope.to)).toEqual([['alice@example.com'], ['alice@example.com'], ['alice@example.com'], ['alice@example.com']]);
    const outward = [...journey.deliveries.rows.values()].map(row => row.value.payload);
    expect(outward).toMatchObject([
      { endpoint: threadEndpoint, replyContext: { replyToMessageId: '<accepted@example.com>', threadId: threadEndpoint.id } },
      { endpoint: threadEndpoint, replyContext: { replyToMessageId: '<accepted@example.com>', threadId: threadEndpoint.id } },
      { endpoint: secondThread, replyContext: { replyToMessageId: '<second@example.com>', threadId: secondThread.id } },
      { endpoint: threadEndpoint, replyContext: { replyToMessageId: '<followup@example.com>', threadId: threadEndpoint.id } },
    ].map(({ endpoint: { label: _label, ...endpoint }, ...rest }) => ({ endpoint, ...rest })));
    await journey.outward();
    expect(email.submissions).toHaveLength(4);
    for (const [collection, declaration] of [[journey.state, CHANNEL_STATE_COLLECTION], [journey.deliveries, CHANNEL_DELIVERIES_COLLECTION]] as const) {
      const schema = compilePluginJsonSchema(declaration.schema);
      for (const row of collection.rows.values()) {
        if (!row.deleted) expect(isValidPluginJsonSchemaValue(schema, row.value), JSON.stringify(row.value)).toBe(true);
      }
    }
  });

});
