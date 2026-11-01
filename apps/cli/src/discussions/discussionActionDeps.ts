import axios, { type Method } from 'axios';
import { randomUUID } from 'node:crypto';
import { ApprovalRequestOriginV1Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildDiscussionAttachmentBindingsV1 } from '@happier-dev/protocol/discussions/api';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { bindDiscussionActionHttpRequestV1, discussionActionOutputSchemaV1, hasProtectedDiscussionActionContextV1, readDiscussionCandidatesV1 } from '@happier-dev/protocol/actions/discussionActionFamily';
import { readHomeDomainConfirmedRollbackV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { buildDiscussionMutationRequestBodyV1, DISCUSSION_HTTP_PATHS_V1, DiscussionCreateResponseV1Schema, DiscussionDetailsResponseV1Schema, DiscussionErrorResponseV1Schema, DiscussionListResponseV1Schema, DiscussionMessagesResponseV1Schema, DiscussionAgentPostRequestV1Schema, DiscussionAgentPostResponseV1Schema, DiscussionAgentCreateRequestV1Schema, DiscussionAgentCreateResponseV1Schema, type DiscussionAgentPublisherRequestV1, type DiscussionAgentPublisherResponseV1, DiscussionPostResponseV1Schema, DiscussionReadResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { DISCUSSION_ACTION_INPUT_SCHEMAS_V1, DiscussionCreateInputV1Schema, DiscussionCreateResultV1Schema, DiscussionDetailsResultV1Schema, DiscussionListResultV1Schema, DiscussionOpenedMessageV1Schema, DiscussionOpenedSummaryV1Schema, DiscussionPostInputV1Schema, DiscussionPostResultV1Schema, DiscussionReadInputV1Schema, DiscussionReadResultV1Schema, DiscussionReadStateResultV1Schema, DiscussionRenameInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { DiscussionMessageV1Schema, DiscussionSummaryV1Schema, type DiscussionSummaryV1 } from '@happier-dev/protocol/discussions/models';
import { DiscussionMessageContentV1StoredSchema, readDiscussionMentionedParticipantIdsV1, DiscussionTitleV1Schema, DiscussionTitleV1StoredSchema } from '@happier-dev/protocol/discussions/content';
import { deriveDiscussionMutationEqualityTagV1, serializeDiscussionMutationEqualityIntentV1 } from '@happier-dev/protocol/discussions/equality';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { DiscussionAddressingV1Schema } from '@happier-dev/protocol/discussions/references';
import { DiscussionInitialParticipantsV1Schema } from '@happier-dev/protocol/discussions/participants';
import { DiscussionAccessRecipientCensusResponseV1Schema, DiscussionRecipientKeyEnvelopeCommitResponseV1Schema } from '@happier-dev/protocol/discussions/access';
import { runResourceRecipientKeyPreparationV1 } from '@happier-dev/protocol/teams/resourceRecipientKeyPreparationV1';
import type { ActionExecutorContext, ActionExecutorDeps, StrictSessionStoredMessageContentEnvelope } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { getRandomBytes } from '@/api/encryption';
import { createResourceDataKey, openResourceDataKey, ResourceDataKeyUnavailableError, type ResourceDataKey } from '@/api/encryption/resourceDataKey';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { resolveCliFeatureDecision, resolveCliFeatureDecisionForServer } from '@/features/featureDecisionService';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { openSessionStoredContent, sealSessionStoredContent, type SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionStoredContentCodec';
import { resolveExternalActionServerRequestHeaders, type ExternalActionHomeBinding } from '@/api/externalActionExecutionAuthorization';
import { deriveApprovedDiscussionMutationLocalId } from './discussionPublicationIdentity';
import { projectDiscussionSecondOpinionPreviewInputV1 } from '@happier-dev/protocol/actions/executor/discussionSecondOpinion';
import { DiscussionSecondOpinionStartInputV1Schema } from '@happier-dev/protocol/discussions/secondOpinionActions';
import { DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1, DiscussionSecondOpinionPreviewResponseV1Schema } from '@happier-dev/protocol/discussions/secondOpinion';
import { DiscussionCandidatesListInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { isSessionTargetPreparationAction, SignedRootActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { DiscussionSettingsResponseV1Schema } from '@happier-dev/protocol/discussions/settings';
import type { DiscussionAddressV1 } from '@happier-dev/protocol/discussions/references';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { DiscussionAttachmentReadInputV1Schema, DiscussionAttachmentReadResponseV1Schema, DiscussionAttachmentReadResultV1Schema } from '@happier-dev/protocol/discussions/attachments';
import { readDiscussionAttachmentReferencesV1 } from '@happier-dev/protocol/discussions/content';
import type { BinaryBlobReferenceV1 } from '@happier-dev/protocol/storage/binaryBlobV1';
import { openResourceBinaryContent } from '@/api/encryption/resourceBinaryContent';
import { encodeBase64 } from '@/api/encryption';
import { Readable } from 'node:stream';
import { DISCUSSION_UPLOAD_CONTENT_TYPE_V1, DISCUSSION_UPLOAD_PATH_V1 } from '@happier-dev/transfers';
import { createDiscussionAttachmentFileReader, prepareDiscussionAttachmentUpload, type DiscussionAttachmentSourceReader } from './discussionAttachmentUpload';
import type { DiscussionAttachmentSourceV1 } from '@happier-dev/protocol/discussions/attachments';
import type { DiscussionMessageContentV1 } from '@happier-dev/protocol/discussions/content';

function failure(code: string) {
  return { ok: false as const, errorCode: code, error: code };
}

/** Preserve definite transport/domain failures across auxiliary reads. */
class DiscussionRequestError extends Error {
  constructor(readonly code: string) { super(code); }
}

function cryptoContext(key: ResourceDataKey): SessionStoredContentCryptoContext {
  return key.mode === 'plain' ? { mode: 'plain', ctx: null }
    : { mode: 'e2ee', ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' } };
}

function openPayload(crypto: SessionStoredContentCryptoContext | null, content: StrictSessionStoredMessageContentEnvelope): unknown {
  if (!crypto) return null;
  try { return openSessionStoredContent({ ...crypto, content }); } catch { return null; }
}

type DiscussionActionFixedHome =
  | Readonly<{ serverId?: undefined; serverHttpBaseUrl?: undefined }>
  | Readonly<{ serverId: string; serverHttpBaseUrl: string }>;

/** Process-local reuse of content already opened by the same admitted hydration. */
type OpenedDiscussionAttachment = Readonly<{
  discussionId: string; messageId: string; reference: BinaryBlobReferenceV1; key: ResourceDataKey;
}>;
type DiscussionActionDeps = Pick<ActionExecutorDeps, 'discussionAction'> & Readonly<{
  readOpenedAttachment: (input: OpenedDiscussionAttachment & Readonly<{ throughSeq: number; signal: AbortSignal }>) => Promise<unknown>;
  readAttachmentContext: (input: Readonly<{ discussionId: string; signal: AbortSignal }>) => Promise<ResourceDataKey>;
}>;

/** C2 consumes one captured Home/Account settings observation, never a second check-in policy. */
export function createDiscussionAutonomousCheckInReader(options: Parameters<typeof createDiscussionActionDeps>[0] & Readonly<{
  capturedHomeIdentity?: Promise<string | null>;
}>) {
  const serverId = options.serverId ?? configuration.activeServerId;
  const homeIdentity = options.capturedHomeIdentity ?? Promise.resolve(options.serverIdentityId ?? null);
  const deps = createDiscussionActionDeps(options);
  return async (origin: DiscussionAddressV1): Promise<Readonly<{ afterTurns: number | null }> | undefined | null> => {
    try {
      const homeId = await homeIdentity;
      if (!areServerProfileIdentifiersEquivalent(origin.serverId, serverId,
        id => id === serverId || id === homeId ? homeId : null)) return null;
      const value = DiscussionSettingsResponseV1Schema.safeParse(await deps.discussionAction!({
        actionId: 'discussion.settings.get', input: { discussionId: origin.discussionId },
        context: { serverId, surface: 'cli', authority: 'account_automation' },
      }));
      return value.success && value.data.discussionId === origin.discussionId
        ? value.data.settings.coordination?.autonomousCheckIn : null;
    } catch { return null; }
  };
}

/**
 * Account/Home transport for independent Discussion resources. The server owns
 * access, participants, publication and retries; only the admitted recipient
 * envelope supplies the resource key. Optional Session anchors supply no keys.
 */
export function createDiscussionActionDeps(options: Readonly<{
  credentials: StoredCredentials;
  /** Process-local byte capture for callers such as the UI that already selected a file. */
  readAttachmentSource?: DiscussionAttachmentSourceReader;
  serverHttpBaseUrl?: string;
  resolveServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined | Promise<CliServerFeaturesSnapshot | undefined>;
  /** Actual current Session publisher, supplied by the host's custody owner. */
  postAgentMessage?: (request: DiscussionAgentPublisherRequestV1, options?: Readonly<{
    signal?: AbortSignal;
    approvedActionReplay?: ActionExecutorContext['approvedActionReplay'];
  }>) => Promise<DiscussionAgentPublisherResponseV1>;
  /** Exact accepted Workflow custody, supplied only by its host publication owner. */
  postWorkflowMessage?: (request: Readonly<{ discussionId: string; request: import('@happier-dev/protocol/discussions/api').DiscussionPostRequestV1 }>,
    options: Readonly<{ signal?: AbortSignal; context: ActionExecutorContext;
      content: import('@happier-dev/protocol/discussions/content').DiscussionMessageContentV1 }>) => Promise<import('@happier-dev/protocol/discussions/api').DiscussionAgentPostResponseV1>;
}> & ExternalActionHomeBinding & DiscussionActionFixedHome): DiscussionActionDeps {
  if ((options.serverId === undefined) !== (options.serverHttpBaseUrl === undefined)
    || (options.serverId !== undefined && !options.serverId.trim())
    || (options.serverHttpBaseUrl !== undefined && !options.serverHttpBaseUrl.trim())) {
    throw new Error('fixed_action_server_target_incomplete');
  }
  const serverId = options.serverId ?? configuration.activeServerId;
  const serverUrl = (options.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/, '');

  async function openKey(row: DiscussionSummaryV1): Promise<ResourceDataKey> {
    if (!row.keyReadiness) throw new DiscussionRequestError('encryption_material_unavailable');
    try { return await openResourceDataKey({ credentials: options.credentials, mode: row.encryptionMode, dataEncryptionKey: row.dataEncryptionKey }); }
    catch { throw new DiscussionRequestError('encryption_material_unavailable'); }
  }

  function projectMessage(key: ResourceDataKey, discussionId: string, input: unknown) {
    const stored = DiscussionMessageV1Schema.parse(input);
    const { content, ...row } = stored;
    const opened = DiscussionMessageContentV1StoredSchema.safeParse(openPayload(cryptoContext(key), content));
    return DiscussionOpenedMessageV1Schema.parse({
      ...row, content: opened.success ? opened.data : null,
      messageRef: createDiscussionMessageRefV1({ serverId, discussionId }, stored),
    });
  }

  function createTransport({ actionId, context, signal }: Pick<Parameters<NonNullable<ActionExecutorDeps['discussionAction']>>[0], 'actionId' | 'context' | 'signal'>) {
    const root = SignedRootActionIdSchema.safeParse(context.externalActionExecutionAuthorization?.binding.actionId);
    // Roster preparation remains signed under its admitted containing operation.
    const effectActionId = actionId === 'discussion.participants.list' && root.success
      && (isSessionTargetPreparationAction(root.data) || root.data === 'discussion.post' || root.data === 'discussion.reply')
      ? root.data : actionId;
    const authorizationFor = (method: string, path: string, body?: unknown) => resolveExternalActionServerRequestHeaders({
      context, effectActionId, method, path, ...(body === undefined ? {} : { body }),
      daemonToken: options.credentials.token, serverIdentityId: options.serverIdentityId,
      ...(options.externalActionMachineRequestPrivateKey ? { privateKey: options.externalActionMachineRequestPrivateKey } : {}),
      ...(options.externalActionMachineInstallationId ? { installationId: options.externalActionMachineInstallationId } : {}),
    });
    async function rawRequest(method: string, path: string, body?: unknown, binary?: Readonly<{ body: AsyncIterable<Uint8Array>; contentType: string }>) {
      if (signal?.aborted) throw new DiscussionRequestError('cancelled');
      const authorization = authorizationFor(method, path, body);
      if (!authorization.ok) throw new DiscussionRequestError('not_authenticated');
      try {
        return await axios.request<unknown>({ url: serverUrl + path, method: method as Method,
          ...(binary ? { data: Readable.from(binary.body) } : body === undefined ? {} : { data: JSON.stringify(body) }),
          headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...authorization.headers,
            'Content-Type': binary?.contentType ?? 'application/json' },
          timeout: configuration.sessionControlHttpTimeoutMs, validateStatus: () => true, signal,
        });
      } catch {
        throw new DiscussionRequestError(method === 'GET'
          ? signal?.aborted ? 'cancelled' : 'discussions_unavailable' : 'outcome_unknown');
      }
    }
    async function request(bound: ReturnType<typeof bindDiscussionActionHttpRequestV1>, body = bound.body,
      binary?: Readonly<{ body: AsyncIterable<Uint8Array>; contentType: string }>): Promise<unknown> {
      const response = await rawRequest(bound.method, bound.path, body, binary);
      if (response.status !== 200) {
        if (response.status === 403 && response.data && typeof response.data === 'object'
          && 'error' in response.data && response.data.error === 'present_user_required') throw new DiscussionRequestError('present_user_required');
        const rollback = readHomeDomainConfirmedRollbackV1(response.status, response.data);
        const error = DiscussionErrorResponseV1Schema.safeParse(response.data);
        throw new DiscussionRequestError(rollback?.code ?? (error.success ? error.data.error
          : bound.method === 'GET' ? 'discussions_unavailable' : 'outcome_unknown'));
      }
      return response.data;
    }
    async function getSummary(discussionId: string) {
      const value = DiscussionDetailsResponseV1Schema.parse(await request(bindDiscussionActionHttpRequestV1('discussion.get', { discussionId })));
      if (value.discussion.id !== discussionId) throw new DiscussionRequestError('discussion_content_unavailable');
      return value.discussion;
    }
    return { authorizationFor, rawRequest, request, getSummary };
  }

  const discussionAction = async ({ actionId, input, context, signal }: Parameters<NonNullable<ActionExecutorDeps['discussionAction']>>[0],
    openedAttachment?: OpenedDiscussionAttachment): Promise<unknown> => {
    if (context.serverId && context.serverId !== serverId) return failure('server_target_mismatch');
    const parsed = DISCUSSION_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
    if (!parsed.success) return failure('discussion_invalid_content');
    if (signal?.aborted) return failure('cancelled');
    const isPost = actionId === 'discussion.post' || actionId === 'discussion.reply';
    if ((actionId === 'discussion.create' || isPost) && 'attachmentSources' in parsed.data
      && parsed.data.attachmentSources !== undefined
      && (context.externalActionCredential || context.externalActionExecutionAuthorization)) {
      return failure('discussion_attachment_upload_authority_unavailable');
    }
    const agentOrigin = context.surface === 'agent' || context.actionCaller?.kind === 'session';
    const workflowReturn = context.discussionReplyReturn && 'kind' in context.discussionReplyReturn
      ? context.discussionReplyReturn : undefined;
    const admittedSessionId = context.actionCaller?.kind === 'session' ? context.actionCaller.sessionId : context.defaultSessionId;
    const source = context.sessionInputSource !== null && typeof context.sessionInputSource === 'object'
      ? context.sessionInputSource as Record<string, unknown> : null;
    const protectedDiscussionContext = hasProtectedDiscussionActionContextV1(context);
    const origin = ApprovalRequestOriginV1Schema.safeParse(context.approvalOrigin);
    const publicationOptions = { ...(signal ? { signal } : {}),
      // Original caller defaults are host-only, not part of the private RPC ABI.
      ...(context.approvedActionReplay?.artifactId ? { approvedActionReplay: { artifactId: context.approvedActionReplay.artifactId } } : {}) };
    const omittedLocalId = (purpose: Parameters<typeof deriveApprovedDiscussionMutationLocalId>[0]['purpose']) =>
      context.approvedActionReplay && context.actionRequestId
        ? deriveApprovedDiscussionMutationLocalId({ requestId: context.actionRequestId, purpose }) : randomUUID();
    if (agentOrigin && !(isPost && options.postWorkflowMessage && workflowReturn) && (isPost || actionId === 'discussion.create')
      && (!admittedSessionId || (context.defaultSessionId !== undefined && context.defaultSessionId !== admittedSessionId)
        || (context.approvalOrigin !== undefined && (!origin.success || origin.data.sessionId !== admittedSessionId))
        || !options.postAgentMessage)) return failure('discussion_post_denied');

    async function projectSummary(input: unknown) {
      const { titleContent, firstMessage, ...row } = DiscussionSummaryV1Schema.parse(input);
      let key: ResourceDataKey | null = null;
      let crypto: SessionStoredContentCryptoContext | null = null;
      try { key = await openKey({ ...row, titleContent }); crypto = cryptoContext(key); } catch { /* Locked resources remain visible without disclosure. */ }
      const first = firstMessage === undefined ? {} : { firstMessage: firstMessage === null || key === null
        ? null : projectMessage(key, row.id, firstMessage) };
      const title = DiscussionTitleV1StoredSchema.safeParse(openPayload(crypto, titleContent));
      const latestMessage = row.latestMessage;
      if (latestMessage?.content !== undefined) {
        // U2's discussion.read is the bounded content port for an addressed turn. A current
        // summary is not a cutoff snapshot, including when returned by a mutation.
        const opened = protectedDiscussionContext ? null
          : DiscussionMessageContentV1StoredSchema.safeParse(openPayload(crypto, latestMessage.content));
        return DiscussionOpenedSummaryV1Schema.parse({ ...row, ...first, title: title.success ? title.data.title : null,
          latestMessage: { ...latestMessage, content: opened?.success ? opened.data : null } });
      }
      return DiscussionOpenedSummaryV1Schema.parse({ ...row, ...first, title: title.success ? title.data.title : null });
    }

    const { authorizationFor, rawRequest, request, getSummary } = createTransport({ actionId, context, signal });
    async function writeMutation(bound: ReturnType<typeof bindDiscussionActionHttpRequestV1>, operation: 'create' | 'post' | 'reply',
      body: unknown, content: DiscussionMessageContentV1, key: ResourceDataKey, discussionId?: string,
      sources?: readonly DiscussionAttachmentSourceV1[]): Promise<unknown> {
      const references = readDiscussionAttachmentReferencesV1(content);
      if (references.length === 0) return await request(bound, body);
      if (context.externalActionExecutionAuthorization || context.externalActionCredential) {
        throw new DiscussionRequestError('discussion_attachment_upload_authority_unavailable');
      }
      const uploadRequest = operation === 'create' ? body : body && typeof body === 'object' ? { ...body, discussionId } : body;
      const prepared = prepareDiscussionAttachmentUpload({ operation, request: uploadRequest, key, references,
        readAttachmentSource: sources ? createDiscussionAttachmentFileReader({ references, sources }) : options.readAttachmentSource, signal });
      return await request({ method: 'POST', path: DISCUSSION_UPLOAD_PATH_V1, body: prepared.metadata }, prepared.metadata,
        { body: prepared.body, contentType: DISCUSSION_UPLOAD_CONTENT_TYPE_V1 });
    }
    function narrowRead<T extends Readonly<{ discussionId: string; throughSeq?: number }>>(args: T): T {
      const addressed = protectedDiscussionContext ? DiscussionAddressingV1Schema.safeParse(source?.discussionAddressing) : null;
      if (addressed && (!addressed.success || source?.sourceSessionId !== addressed.data.participantSessionId
        || admittedSessionId !== addressed.data.participantSessionId)) throw new DiscussionRequestError('discussion_read_denied');
      const cutoff = addressed?.success && addressed.data.discussionId === args.discussionId ? addressed.data.throughSeq : undefined;
      return cutoff === undefined ? args : { ...args, throughSeq: Math.min(args.throughSeq ?? cutoff, cutoff) };
    }
    async function recoverCreation(creationLocalId: string) {
      for (const state of ['active', 'archived'] as const) {
        let cursor: string | undefined;
        do {
          const value = DiscussionListResponseV1Schema.parse(await request(bindDiscussionActionHttpRequestV1('discussion.list', {
            creationLocalId, state, ...(cursor === undefined ? {} : { cursor }),
          })));
          const row = value.discussions.find(row => row.creationLocalId === creationLocalId);
          if (row) return row;
          cursor = value.nextCursor ?? undefined;
        } while (cursor !== undefined);
      }
      return null;
    }
    async function prepareRecipients(discussion: DiscussionSummaryV1, key: ResourceDataKey | null) {
      if (discussion.encryptionMode === 'plain') return;
      const path = (template: string) => template.replace(':discussionId', encodeURIComponent(discussion.id));
      await runResourceRecipientKeyPreparationV1({
        dataKey: key?.dataKey ?? null, openedDataEncryptionKey: key?.dataEncryptionKey ?? null, randomBytes: getRandomBytes, signal,
        readCensus: async () => DiscussionAccessRecipientCensusResponseV1Schema.parse(await request({
          method: 'GET', path: path(DISCUSSION_HTTP_PATHS_V1.recipientCensus), body: undefined,
        })),
        validateIdentity: census => {
          if (census.discussionId !== discussion.id || census.ownerAccountId !== discussion.ownerAccountId
            || census.encryptionMode !== discussion.encryptionMode) throw new DiscussionRequestError('discussion_content_unavailable');
        },
        dataKeyChangedError: () => new DiscussionRequestError('discussion_data_key_changed'),
        commit: async body => DiscussionRecipientKeyEnvelopeCommitResponseV1Schema.parse(await request({
          method: 'PUT', path: path(DISCUSSION_HTTP_PATHS_V1.recipientEnvelopes), body,
        })),
      });
    }

    try {
      let decision: Awaited<ReturnType<typeof resolveCliFeatureDecisionForServer>>['decision'];
      if (options.resolveServerFeaturesSnapshot) {
        let serverSnapshot: CliServerFeaturesSnapshot | undefined;
        try { serverSnapshot = await options.resolveServerFeaturesSnapshot(); } catch { serverSnapshot = undefined; }
        decision = resolveCliFeatureDecision({ featureId: 'sessions.conversations', env: process.env,
          ...(serverSnapshot ? { serverSnapshot } : {}) });
      } else {
        decision = (await resolveCliFeatureDecisionForServer({
          featureId: 'sessions.conversations', env: process.env, serverUrl,
          ...(context.externalActionCredential ? { resolveAuthorizationHeaders: (request: Readonly<{ method: 'GET'; path: string }>) => {
            const authorization = authorizationFor(request.method, request.path);
            return authorization.ok ? authorization.headers : null;
          } } : {}),
        })).decision;
      }
      if (decision.state !== 'enabled') return failure('unsupported_action');
      if (actionId === 'discussion.candidates.list') {
        const accountId = context.externalActionExecutionAuthorization?.binding.accountId ?? readAccountIdFromToken(options.credentials.token);
        if (!accountId) return failure('not_authenticated');
        return await readDiscussionCandidatesV1({ scope: { serverId, accountId },
          args: DiscussionCandidatesListInputV1Schema.parse(parsed.data), signal,
          request: requestInput => request({ ...requestInput, body: requestInput.body }) });
      }
      if (actionId === 'discussion.second_opinion.start') {
        const args = DiscussionSecondOpinionStartInputV1Schema.parse(parsed.data);
        if (args.intent !== 'preview') return failure('unsupported_action');
        return DiscussionSecondOpinionPreviewResponseV1Schema.parse(await request({ method: 'POST',
          path: DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1,
          body: projectDiscussionSecondOpinionPreviewInputV1(args) }));
      }
      const bound = bindDiscussionActionHttpRequestV1(actionId, parsed.data);
      const envelope = { v: 1 as const, serverId };

      if (actionId === 'discussion.list') {
        const value = DiscussionListResponseV1Schema.parse(await request(bound));
        const discussions = await Promise.all(value.discussions.map(projectSummary));
        return DiscussionListResultV1Schema.parse({ ...envelope, discussions, nextCursor: value.nextCursor,
          incomplete: discussions.some(row => row.title === null || row.latestMessage?.content === null) });
      }
      if (actionId === 'discussion.get') {
        const value = DiscussionDetailsResponseV1Schema.parse(await request(bound));
        return DiscussionDetailsResultV1Schema.parse({ ...envelope, discussion: await projectSummary(value.discussion) });
      }
      if (actionId === 'discussion.create') {
        const args = DiscussionCreateInputV1Schema.parse(parsed.data);
        const participants = args.participants === undefined ? undefined : DiscussionInitialParticipantsV1Schema.parse(args.participants);
        const creationLocalId = args.creationLocalId ?? omittedLocalId('creation');
        const localId = args.firstMessage.localId ?? omittedLocalId('first_message');
        const currentness = await fetchAccountEncryptionCurrentness({
          token: options.credentials.token, serverBaseUrl: serverUrl, allowCredentialRecovery: false, signal,
          request: () => rawRequest('GET', '/v1/account/encryption/currentness'),
        });
        const existing = (args.creationLocalId || context.approvedActionReplay) && currentness.mode === 'e2ee' ? await recoverCreation(creationLocalId) : null;
        if (currentness.mode === 'e2ee' && !currentness.contentKeyFingerprint) throw new DiscussionRequestError('recipient_key_unavailable');
        let ownerContentPublicKeyFingerprint: string | undefined;
        if (currentness.mode === 'e2ee') {
          const encryption = options.credentials.encryption;
          if (!encryption) throw new ResourceDataKeyUnavailableError();
          let material;
          try {
            material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: encryption,
              ...(encryption.type === 'dataKey' ? { dataKeyPublicKey: encryption.publicKey } : {}) });
          } catch { throw new ResourceDataKeyUnavailableError(); }
          // Account currentness encodes the same digest differently from resource recipient bindings.
          if (convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint)
            !== currentness.contentKeyFingerprint) throw new ResourceDataKeyUnavailableError();
          ownerContentPublicKeyFingerprint = material.contentPublicKeyFingerprint;
        }
        const key = existing ? await openKey(existing) : await createResourceDataKey({
          credentials: options.credentials, mode: currentness.mode,
          ...(ownerContentPublicKeyFingerprint ? { expectedContentPublicKeyFingerprint: ownerContentPublicKeyFingerprint } : {}),
        });
        const title = DiscussionTitleV1Schema.parse({ v: 1, title: args.title });
        const mentions = readDiscussionMentionedParticipantIdsV1(args.firstMessage.content);
        const firstMessage = { localId, content: args.firstMessage.content, mentionedAccountIds: args.firstMessage.mentionedAccountIds ?? mentions.mentionedAccountIds,
          mentionedSessionIds: args.firstMessage.mentionedSessionIds ?? mentions.mentionedSessionIds,
          ...buildDiscussionAttachmentBindingsV1(args.firstMessage.content, key.mode === 'plain' ? 'plain' : 'encrypted'),
          ...(args.firstMessage.replyTarget === undefined ? {} : { replyTarget: args.firstMessage.replyTarget }) };
        const equality = (canonicalIntent: string) => key.mode === 'e2ee'
          ? { kind: 'e2eeTag' as const, tag: deriveDiscussionMutationEqualityTagV1({ dataKey: key.dataKey, canonicalIntent }) } : undefined;
        const crypto = cryptoContext(key);
        const body = buildDiscussionMutationRequestBodyV1({
          kind: 'create', creationLocalId, titleContent: sealSessionStoredContent({ ...crypto, payload: title }),
          creationEqualityEvidenceV1: equality(serializeDiscussionMutationEqualityIntentV1({ kind: 'create', title, firstMessage, anchor: args.anchor, participants })),
          ...(args.anchor === undefined ? {} : { anchor: args.anchor }),
          ...(participants === undefined ? {} : { participants }),
          ...(key.mode === 'e2ee' ? { dataEncryptionKey: key.dataEncryptionKey,
            expectedOwnerContentPublicKeyFingerprint: ownerContentPublicKeyFingerprint } : {}),
          firstMessage: { ...firstMessage, authoredContent: firstMessage.content, content: sealSessionStoredContent({ ...crypto, payload: firstMessage.content }),
            requestEqualityEvidenceV1: equality(serializeDiscussionMutationEqualityIntentV1({ kind: 'post', ...firstMessage })) },
        });
        let value;
        if (agentOrigin) {
          if (readDiscussionAttachmentReferencesV1(firstMessage.content).length && !args.attachmentSources) return failure('discussion_attachment_source_unavailable');
          if (!options.postAgentMessage || !admittedSessionId) return failure('discussion_post_denied');
          const toolCallId = origin.success ? origin.data.toolCallId : context.actionRequestId;
          let response;
          try {
            response = DiscussionAgentCreateResponseV1Schema.parse(await options.postAgentMessage(DiscussionAgentCreateRequestV1Schema.parse({
              v: 1, operation: 'create', sessionId: admittedSessionId, request: body,
              ...(args.attachmentSources ? { attachmentSources: args.attachmentSources } : {}),
              ...(context.runtimeRunId ? { runId: context.runtimeRunId } : {}), ...(toolCallId ? { toolCallId } : {}),
            }), publicationOptions));
          } catch { return failure('outcome_unknown'); }
          if (!response.ok) return failure(response.error);
          value = response.value;
        } else value = DiscussionCreateResponseV1Schema.parse(await writeMutation(bound, 'create', body, firstMessage.content, key, undefined, args.attachmentSources));
        // The create transaction already includes every chosen grant. Key
        // delivery then uses the admitted resource census, never a fake one.
        if (key.mode === 'e2ee' && participants?.some(participant => participant.kind === 'account')) {
          try { await prepareRecipients(value.discussion, key); }
          catch { return failure('outcome_unknown'); }
        }
        return DiscussionCreateResultV1Schema.parse({ ...envelope, discussion: await projectSummary(value.discussion),
          firstMessage: projectMessage(key, value.discussion.id, value.firstMessage) });
      }
      if (actionId === 'discussion.read') {
        const args = DiscussionReadInputV1Schema.parse(parsed.data);
        const boundedArgs = narrowRead(args);
        const cutoff = boundedArgs.throughSeq;
        const key = await openKey(await getSummary(args.discussionId));
        const value = DiscussionMessagesResponseV1Schema.parse(await request(bindDiscussionActionHttpRequestV1('discussion.read', boundedArgs)));
        if (cutoff !== undefined && (value.messageSeq > cutoff || value.messages.some(message => message.seq > cutoff))) {
          return failure('discussion_content_unavailable');
        }
        const messages = value.messages.map(row => projectMessage(key, args.discussionId, row));
        return DiscussionReadResultV1Schema.parse({ ...envelope, discussionId: args.discussionId, messages,
          hasMoreOlder: value.hasMoreOlder, messageSeq: value.messageSeq, incomplete: messages.some(row => row.content === null) });
      }
      if (actionId === 'discussion.attachment.read') {
        const args = narrowRead(DiscussionAttachmentReadInputV1Schema.parse(parsed.data));
        const summary = openedAttachment ? null : await getSummary(args.discussionId);
        const key = openedAttachment?.key ?? await openKey(summary!);
        let reference: BinaryBlobReferenceV1 | undefined;
        if (openedAttachment) {
          if (openedAttachment.discussionId !== args.discussionId || openedAttachment.messageId !== args.messageId
            || openedAttachment.reference.blobId !== args.blobId) throw new DiscussionRequestError('discussion_content_unavailable');
          reference = openedAttachment.reference;
        } else {
          const value = DiscussionMessagesResponseV1Schema.parse(await request(bindDiscussionActionHttpRequestV1('discussion.read', {
            discussionId: args.discussionId, messageId: args.messageId,
            ...(args.throughSeq === undefined ? {} : { throughSeq: args.throughSeq }),
          })));
          const row = value.messages.find(row => row.id === args.messageId && row.discussionId === args.discussionId
            && (args.throughSeq === undefined || row.seq <= args.throughSeq));
          const opened = row ? projectMessage(key, args.discussionId, row) : null;
          reference = opened?.content ? readDiscussionAttachmentReferencesV1(opened.content).find(file => file.blobId === args.blobId) : undefined;
        }
        if (!reference) throw new DiscussionRequestError('discussion_content_unavailable');
        const response = DiscussionAttachmentReadResponseV1Schema.parse(await request(bindDiscussionActionHttpRequestV1(actionId, args)));
        if (response.blobId !== reference.blobId) throw new DiscussionRequestError('discussion_content_unavailable');
        let bytes: Uint8Array;
        try { bytes = await openResourceBinaryContent(key, reference, response.content); }
        catch { throw new DiscussionRequestError('discussion_content_unavailable'); }
        if (summary) {
          const current = await getSummary(args.discussionId);
          if (!current.keyReadiness || current.encryptionMode !== summary.encryptionMode || current.dataEncryptionKey !== summary.dataEncryptionKey) {
            throw new DiscussionRequestError('discussion_content_unavailable');
          }
        }
        signal?.throwIfAborted();
        return DiscussionAttachmentReadResultV1Schema.parse({ blobId: reference.blobId, bytesBase64: encodeBase64(bytes),
          mime: reference.mime, sizeBytes: reference.sizeBytes, sha256: reference.sha256 });
      }
      if (isPost) {
        const args = DiscussionPostInputV1Schema.parse(parsed.data);
        const key = await openKey(await getSummary(args.discussionId));
        const mentions = readDiscussionMentionedParticipantIdsV1(args.content);
        const intent = { content: args.content, mentionedAccountIds: args.mentionedAccountIds ?? mentions.mentionedAccountIds,
          mentionedSessionIds: args.mentionedSessionIds ?? mentions.mentionedSessionIds,
          ...buildDiscussionAttachmentBindingsV1(args.content, key.mode === 'plain' ? 'plain' : 'encrypted'),
          ...(args.replyTarget === undefined ? {} : { replyTarget: args.replyTarget }) };
        const postRequest = buildDiscussionMutationRequestBodyV1({
          kind: 'post', ...intent, localId: args.localId ?? omittedLocalId('post'),
          content: sealSessionStoredContent({ ...cryptoContext(key), payload: args.content }),
          authoredContent: args.content,
          ...(key.mode === 'e2ee' ? { requestEqualityEvidenceV1: { kind: 'e2eeTag',
            tag: deriveDiscussionMutationEqualityTagV1({ dataKey: key.dataKey,
              canonicalIntent: serializeDiscussionMutationEqualityIntentV1({ kind: 'post', ...intent }) }) } } : {}),
        });
        let value;
        if (options.postWorkflowMessage && workflowReturn) {
          if (readDiscussionAttachmentReferencesV1(args.content).length) return failure('discussion_attachment_source_unavailable');
          let response;
          try { response = DiscussionAgentPostResponseV1Schema.parse(await options.postWorkflowMessage({
            discussionId: args.discussionId, request: postRequest }, { context, content: args.content, ...(signal ? { signal } : {}) })); }
          catch { return failure('outcome_unknown'); }
          if (!response.ok) return failure(response.error);
          value = response.value;
        } else if (agentOrigin) {
          if (readDiscussionAttachmentReferencesV1(args.content).length && !args.attachmentSources) return failure('discussion_attachment_source_unavailable');
          if (!options.postAgentMessage || !admittedSessionId) return failure('discussion_post_denied');
          const toolCallId = origin.success ? origin.data.toolCallId : context.actionRequestId;
          let response;
          try {
            response = DiscussionAgentPostResponseV1Schema.parse(await options.postAgentMessage(DiscussionAgentPostRequestV1Schema.parse({
              v: 1, sessionId: admittedSessionId, discussionId: args.discussionId, request: postRequest,
              ...(args.attachmentSources ? { attachmentSources: args.attachmentSources } : {}),
              ...(context.discussionReplyReturn ? { replyReturn: context.discussionReplyReturn } : {}),
              ...(context.runtimeRunId ? { runId: context.runtimeRunId } : {}), ...(toolCallId ? { toolCallId } : {}),
            }), publicationOptions));
          } catch { return failure('outcome_unknown'); }
          if (!response.ok) return failure(response.error);
          value = response.value;
        } else value = DiscussionPostResponseV1Schema.parse(await writeMutation(bound,
          actionId === 'discussion.reply' ? 'reply' : 'post', postRequest, args.content, key, args.discussionId, args.attachmentSources));
        return DiscussionPostResultV1Schema.parse({ ...envelope, message: projectMessage(key, args.discussionId, value.message), messageSeq: value.messageSeq });
      }
      if (actionId === 'discussion.rename') {
        const args = DiscussionRenameInputV1Schema.parse(parsed.data);
        const key = await openKey(await getSummary(args.discussionId));
        const value = DiscussionDetailsResponseV1Schema.parse(await request(bound, buildDiscussionMutationRequestBodyV1({
          kind: 'rename', titleContent: sealSessionStoredContent({ ...cryptoContext(key), payload: DiscussionTitleV1Schema.parse({ v: 1, title: args.title }) }),
        })));
        return DiscussionDetailsResultV1Schema.parse({ ...envelope, discussion: await projectSummary(value.discussion) });
      }
      if (actionId === 'discussion.archive' || actionId === 'discussion.restore') {
        const value = DiscussionDetailsResponseV1Schema.parse(await request(bound));
        return DiscussionDetailsResultV1Schema.parse({ ...envelope, ...value, discussion: await projectSummary(value.discussion) });
      }
      if (actionId === 'discussion.read_state.set') {
        return DiscussionReadStateResultV1Schema.parse({ ...envelope, cursor: DiscussionReadResponseV1Schema.parse(await request(bound)) });
      }
      const needsPreparation = actionId === 'discussion.invite' || actionId === 'discussion.access.grants.set';
      const resource = needsPreparation && 'discussionId' in parsed.data && typeof parsed.data.discussionId === 'string'
        ? await getSummary(parsed.data.discussionId) : null;
      // Grant admission does not depend on content-key availability. The
      // shared preparer preserves missing-key readiness without inventing an
      // envelope; content mutations still require a real opened resource key.
      const key = resource ? await openKey(resource).catch(() => null) : null;
      const value = discussionActionOutputSchemaV1(actionId).parse(await request(bound));
      if (resource) {
        try { await prepareRecipients(resource, key); }
        catch { return failure('outcome_unknown'); }
      }
      return value;
    } catch (error) {
      if (error instanceof DiscussionRequestError) return failure(error.code);
      if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return failure(error.code);
      return failure('outcome_unknown');
    }
  };
  return { discussionAction, readAttachmentContext: async input => {
    const { getSummary } = createTransport({ actionId: 'discussion.attachment.read',
      context: { surface: 'cli', authority: 'account_automation', serverId }, signal: input.signal });
    return await openKey(await getSummary(input.discussionId));
  }, readOpenedAttachment: async input => await discussionAction({ actionId: 'discussion.attachment.read',
    input: { discussionId: input.discussionId, messageId: input.messageId, blobId: input.reference.blobId, throughSeq: input.throughSeq },
    context: { surface: 'cli', authority: 'account_automation', serverId }, signal: input.signal }, input) };
}
