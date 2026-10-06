import axios, { type Method } from 'axios';
import { randomUUID } from 'node:crypto';
import { ApprovalRequestOriginV1Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { bindSessionDiscussionActionHttpRequestV1 } from '@happier-dev/protocol/actions/sessionDiscussionActionFamily';
import { buildSessionDiscussionMutationRequestBodyV1, SessionDiscussionCreateResponseV1Schema, SessionDiscussionDetailsResponseV1Schema, SessionDiscussionErrorResponseV1Schema, SessionDiscussionListResponseV1Schema, SessionDiscussionMessagesResponseV1Schema, SessionDiscussionAgentPostRequestV1Schema, SessionDiscussionAgentPostResponseV1Schema, SessionDiscussionPostResponseV1Schema, SessionDiscussionReadResponseV1Schema } from '@happier-dev/protocol/sessions/discussions/api';
import { SESSION_DISCUSSION_ACTION_INPUT_SCHEMAS_V1, SessionDiscussionCreateInputV1Schema, SessionDiscussionCreateResultV1Schema, SessionDiscussionDetailsResultV1Schema, SessionDiscussionListResultV1Schema, SessionDiscussionOpenedMessageV1Schema, SessionDiscussionOpenedSummaryV1Schema, SessionDiscussionPostInputV1Schema, SessionDiscussionPostResultV1Schema, SessionDiscussionReadInputV1Schema, SessionDiscussionReadResultV1Schema, SessionDiscussionReadStateResultV1Schema, SessionDiscussionRenameInputV1Schema } from '@happier-dev/protocol/sessions/discussions/actions';
import { SessionDiscussionMessageV1Schema, SessionDiscussionSummaryV1Schema } from '@happier-dev/protocol/sessions/discussions/models';
import { SessionDiscussionMessageContentV1Schema, SessionDiscussionTitleV1Schema } from '@happier-dev/protocol/sessions/discussions/content';
import { serializeSessionDiscussionMutationEqualityIntentV1 } from '@happier-dev/protocol/sessions/discussions/equality';
import { SESSION_DISCUSSION_MUTATION_EQUALITY_HKDF_LABEL_V1, deriveSessionMutationEqualityTagV1 } from '@happier-dev/protocol/sessions/mutations/sessionMutationEqualityV1';
import type { ActionExecutorDeps, SessionDiscussionActionIdV1, SessionDiscussionAgentPostRequestV1, SessionDiscussionAgentPostResponseV1, SessionDiscussionMessageContentV1, StrictSessionStoredMessageContentEnvelope } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { resolveCliFeatureDecision, resolveCliFeatureDecisionForServer } from '@/features/featureDecisionService';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import {
  resolveExactSessionOrCredentialCryptoContext,
  type SessionTransportEncryptionMaterial,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  openSessionStoredContent,
  sealSessionStoredContent,
  type SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionStoredContentCodec';
import {
  resolveExternalActionServerRequestHeaders,
  type ExternalActionHomeBinding,
} from '@/api/externalActionExecutionAuthorization';

function failure(code: string) {
  return { ok: false as const, errorCode: code, error: code };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Bind Agent operations to the Session whose runtime admitted the call. */
function validateAgentDiscussionSessionBinding(params: Readonly<{
  actionId: SessionDiscussionActionIdV1;
  sessionId: string;
  hasTrustedAgentPostTransport: boolean;
  context: Parameters<NonNullable<ActionExecutorDeps['sessionDiscussionAction']>>[0]['context'];
}>):
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errorCode: string }> {
  if (params.context.surface !== 'agent') return { ok: true };

  const admittedSessionId = readNonEmptyString(params.context.defaultSessionId);
  const origin = ApprovalRequestOriginV1Schema.safeParse(params.context.approvalOrigin);
  if (
    params.context.authority !== 'account_automation'
    || !admittedSessionId
    || admittedSessionId !== params.sessionId
    || (params.context.approvalOrigin !== undefined && !origin.success)
    || (origin.success && origin.data.sessionId !== admittedSessionId)
  ) {
    return {
      ok: false,
      errorCode: params.actionId === 'session.discussion.post'
        ? 'session_discussion_post_denied'
        : 'session_discussion_read_denied',
    };
  }

  // Agent provenance is admitted only through the current Session publisher
  // carrier. The public HTTP route remains human-only and cannot be selected
  // as an attribution fallback.
  if (params.actionId === 'session.discussion.post' && !params.hasTrustedAgentPostTransport) {
    return { ok: false, errorCode: 'session_discussion_post_denied' };
  }
  return { ok: true };
}

/**
 * The storage envelope for one discussion payload.
 *
 * Sealing is the executor's job precisely because the Action layer carries
 * strict semantic plaintext: a plaintext Action input is never a valid
 * encrypted persistence request, and the Home never receives E2EE plaintext.
 */
function sealDiscussionPayload(
  crypto: SessionStoredContentCryptoContext,
  payload: Parameters<typeof sealSessionStoredContent>[0]['payload'],
) {
  return sealSessionStoredContent({ ...crypto, payload });
}

/**
 * Opens one stored envelope. A row this caller cannot open returns `null`
 * rather than a plaintext guess, and the caller marks its page incomplete.
 */
function openDiscussionPayload(
  crypto: SessionStoredContentCryptoContext,
  content: StrictSessionStoredMessageContentEnvelope,
): unknown {
  try {
    return openSessionStoredContent({ ...crypto, content });
  } catch {
    return null;
  }
}

function openTitle(
  crypto: SessionStoredContentCryptoContext,
  value: StrictSessionStoredMessageContentEnvelope,
): string | null {
  const parsed = SessionDiscussionTitleV1Schema.safeParse(openDiscussionPayload(crypto, value));
  return parsed.success ? parsed.data.title : null;
}

function openContent(
  crypto: SessionStoredContentCryptoContext,
  value: StrictSessionStoredMessageContentEnvelope,
): SessionDiscussionMessageContentV1 | null {
  const parsed = SessionDiscussionMessageContentV1Schema.safeParse(openDiscussionPayload(crypto, value));
  return parsed.success ? parsed.data : null;
}

type SessionDiscussionActionFixedHome =
  | Readonly<{ serverId?: undefined; serverHttpBaseUrl?: undefined }>
  | Readonly<{ serverId: string; serverHttpBaseUrl: string }>;

function projectSummary(
  crypto: SessionStoredContentCryptoContext,
  input: unknown,
) {
  const { titleContent, ...row } = SessionDiscussionSummaryV1Schema.parse(input);
  return SessionDiscussionOpenedSummaryV1Schema.parse({
    ...row,
    title: openTitle(crypto, titleContent),
  });
}

function projectMessage(
  crypto: SessionStoredContentCryptoContext,
  input: unknown,
) {
  const { content, ...row } = SessionDiscussionMessageV1Schema.parse(input);
  return SessionDiscussionOpenedMessageV1Schema.parse({
    ...row,
    content: openContent(crypto, content),
  });
}

/**
 * The CLI/daemon host for the one Session human-discussion Action family.
 *
 * It owns only transport, Session encryption context and the opened projection.
 * Authorization, sequence allocation, idempotency binding, mention validation
 * and invalidation stay at the server's discussion service; this host never
 * re-derives or relaxes them.
 */
export function createSessionDiscussionActionDeps(options: Readonly<{
  credentials: StoredCredentials;
  serverHttpBaseUrl?: string;
  /** Exact Home snapshot already owned by the caller's runtime/connection; never fetched here. */
  resolveServerFeaturesSnapshot?: () =>
    | CliServerFeaturesSnapshot
    | undefined
    | Promise<CliServerFeaturesSnapshot | undefined>;
  postAgentMessage?: (
    request: SessionDiscussionAgentPostRequestV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<SessionDiscussionAgentPostResponseV1>;
  /**
   * Stored-content material this composition already holds for one exact
   * Session. See `createSessionBoardActionDeps`: a Session-scoped runtime
   * principal has no Account encryption material, and this is the only material
   * that can open its own discussions. Bound to one Session id, fail-closed.
   */
  resolveExactSessionEncryptionMaterial?: (sessionId: string) => SessionTransportEncryptionMaterial | null;
}> & ExternalActionHomeBinding & SessionDiscussionActionFixedHome): Pick<ActionExecutorDeps, 'sessionDiscussionAction'> {
  if (
    (options.serverId === undefined) !== (options.serverHttpBaseUrl === undefined)
    || (options.serverId !== undefined && options.serverId.trim().length === 0)
    || (options.serverHttpBaseUrl !== undefined && options.serverHttpBaseUrl.trim().length === 0)
  ) {
    throw new Error('fixed_action_server_target_incomplete');
  }
  const serverId = options.serverId ?? configuration.activeServerId;
  const serverUrl = options.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();

  async function request(
    bound: ReturnType<typeof bindSessionDiscussionActionHttpRequestV1>,
    params: Readonly<{
      context: Parameters<NonNullable<ActionExecutorDeps['sessionDiscussionAction']>>[0]['context'];
      actionId: SessionDiscussionActionIdV1;
      body?: unknown;
      signal?: AbortSignal;
    }>,
  ) {
    if (params.signal?.aborted) return failure('cancelled');
    const authorization = resolveExternalActionServerRequestHeaders({
      context: params.context,
      effectActionId: params.actionId,
      method: bound.method,
      path: bound.path,
      ...(params.body === undefined ? {} : { body: params.body }),
      daemonToken: options.credentials.token,
      serverIdentityId: options.serverIdentityId,
      ...(options.externalActionMachineRequestPrivateKey
        ? { privateKey: options.externalActionMachineRequestPrivateKey }
        : {}),
      ...(options.externalActionMachineInstallationId
        ? { installationId: options.externalActionMachineInstallationId }
        : {}),
    });
    if (!authorization.ok) return failure('not_authenticated');
    let response;
    try {
      response = await axios.request<unknown>({
        url: `${serverUrl}${bound.path}`,
        method: bound.method as Method,
        ...(params.body === undefined ? {} : { data: JSON.stringify(params.body) }),
        headers: {
          ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
          ...authorization.headers,
          'Content-Type': 'application/json',
        },
        timeout: configuration.sessionControlHttpTimeoutMs,
        validateStatus: () => true,
        signal: params.signal,
      });
    } catch {
      return failure('outcome_unknown');
    }
    if (response.status !== 200) {
      const error = SessionDiscussionErrorResponseV1Schema.safeParse(response.data);
      // The domain code is preserved rather than remapped to a generic failure.
      return error.success ? failure(error.data.error) : failure('outcome_unknown');
    }
    return { ok: true as const, data: response.data };
  }

  return {
    sessionDiscussionAction: async ({ actionId, input, context, signal }) => {
      if (context.serverId && context.serverId !== serverId) return failure('server_target_mismatch');
      const parsed = SESSION_DISCUSSION_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
      if (!parsed.success) return failure('session_discussion_invalid_content');
      const common = parsed.data as { sessionId?: string };
      const sessionId = common.sessionId ?? context.defaultSessionId;
      if (!sessionId) return failure('session_discussion_invalid_content');
      const resolveAuthorizationHeaders = (request: Readonly<{ method: 'GET'; path: string }>) => {
        const authorization = resolveExternalActionServerRequestHeaders({
          context,
          effectActionId: actionId,
          method: request.method,
          path: request.path,
          daemonToken: options.credentials.token,
          serverIdentityId: options.serverIdentityId,
          ...(options.externalActionMachineRequestPrivateKey
            ? { privateKey: options.externalActionMachineRequestPrivateKey }
            : {}),
          ...(options.externalActionMachineInstallationId
            ? { installationId: options.externalActionMachineInstallationId }
            : {}),
        });
        return authorization.ok ? authorization.headers : null;
      };
      const sessionBinding = validateAgentDiscussionSessionBinding({
        actionId,
        sessionId,
        context,
        hasTrustedAgentPostTransport: options.postAgentMessage !== undefined,
      });
      if (!sessionBinding.ok) return failure(sessionBinding.errorCode);
      let bound;
      try {
        bound = bindSessionDiscussionActionHttpRequestV1(actionId, {
          ...parsed.data,
          sessionId,
        });
      } catch {
        return failure('session_discussion_invalid_content');
      }

      // Exact-Home decision first: only a positive sessions.conversations decision from the
      // caller's already-owned Home snapshot may widen detail to accessProjectionVersion=1
      // via the canonical fetchSessionById owner. Missing/malformed/unsupported snapshots
      // retain the released bare owner/direct request; this host never probes here.
      let decision: Awaited<ReturnType<typeof resolveCliFeatureDecisionForServer>>['decision'];
      let serverSnapshot: CliServerFeaturesSnapshot | undefined;
      if (typeof options.resolveServerFeaturesSnapshot === 'function') {
        try {
          serverSnapshot = await options.resolveServerFeaturesSnapshot();
        } catch {
          serverSnapshot = undefined;
        }
        decision = resolveCliFeatureDecision({
          featureId: 'sessions.conversations',
          env: process.env,
          ...(serverSnapshot ? { serverSnapshot } : {}),
        });
      } else {
        const resolved = await resolveCliFeatureDecisionForServer({
          featureId: 'sessions.conversations',
          env: process.env,
          serverUrl,
          ...(context.externalActionCredential ? { resolveAuthorizationHeaders } : {}),
        });
        decision = resolved.decision;
        serverSnapshot = resolved.serverSnapshot;
      }
      if (decision.state !== 'enabled') return failure('unsupported_action');

      const rawSession = await fetchSessionById({
        token: options.credentials.token,
        serverUrl,
        sessionId,
        ...(serverSnapshot ? { serverFeaturesSnapshot: serverSnapshot } : {}),
        resolveAuthorizationHeaders,
        signal,
      });
      if (!rawSession || rawSession.id !== sessionId) return failure('session_discussion_not_found');

      // Missing E2EE material fails closed; it never falls back to plaintext.
      const crypto = resolveExactSessionOrCredentialCryptoContext({
        credentials: options.credentials,
        ...(options.resolveExactSessionEncryptionMaterial
          ? { resolveExactSessionEncryptionMaterial: options.resolveExactSessionEncryptionMaterial }
          : {}),
      }, sessionId, rawSession);
      if (!crypto) return failure('encryption_material_unavailable');
      const ctx = crypto.mode === 'e2ee' ? crypto.ctx : null;

      /**
       * Only an E2EE client can derive the tag. A Plain request deliberately
       * carries no client-asserted equality: the server derives that digest
       * from the normalized semantic request itself.
       */
      const equalityEvidence = (canonicalIntent: string) => (
        ctx
          ? {
              kind: 'e2eeTag' as const,
              tag: deriveSessionMutationEqualityTagV1({
                keyMaterial: ctx.encryptionKey,
                sessionId,
                purpose: SESSION_DISCUSSION_MUTATION_EQUALITY_HKDF_LABEL_V1,
                canonicalIntent,
              }),
            }
          : undefined
      );

      if (actionId === 'session.discussion.list') {
        const result = await request(bound, { context, actionId, signal });
        if (!result.ok) return result;
        const value = SessionDiscussionListResponseV1Schema.parse(result.data);
        const discussions = value.discussions.map((row) => projectSummary(crypto, row));
        return SessionDiscussionListResultV1Schema.parse({
          v: 1,
          serverId,
          sessionId,
          discussions,
          nextCursor: value.nextCursor,
          incomplete: discussions.some((row) => row.title === null),
        });
      }

      if (actionId === 'session.discussion.get') {
        const result = await request(bound, { context, actionId, signal });
        if (!result.ok) return result;
        return SessionDiscussionDetailsResultV1Schema.parse({
          v: 1,
          serverId,
          sessionId,
          discussion: projectSummary(crypto, SessionDiscussionDetailsResponseV1Schema.parse(result.data).discussion),
        });
      }

      if (actionId === 'session.discussion.read') {
        const args = SessionDiscussionReadInputV1Schema.parse(parsed.data);
        const result = await request(bound, { context, actionId, signal });
        if (!result.ok) return result;
        const value = SessionDiscussionMessagesResponseV1Schema.parse(result.data);
        const messages = value.messages.map((row) => projectMessage(crypto, row));
        return SessionDiscussionReadResultV1Schema.parse({
          v: 1,
          serverId,
          sessionId,
          discussionId: args.discussionId,
          messages,
          hasMoreOlder: value.hasMoreOlder,
          messageSeq: value.messageSeq,
          incomplete: messages.some((row) => row.content === null),
        });
      }

      if (actionId === 'session.discussion.create') {
        const args = SessionDiscussionCreateInputV1Schema.parse(parsed.data);
        const title = SessionDiscussionTitleV1Schema.parse({ v: 1, title: args.title });
        const mentionedAccountIds = args.firstMessage.mentionedAccountIds ?? [];
        const creationLocalId = args.creationLocalId ?? randomUUID();
        const messageLocalId = args.firstMessage.localId ?? randomUUID();
        const creationEvidence = equalityEvidence(serializeSessionDiscussionMutationEqualityIntentV1({
          kind: 'create',
          title,
          firstMessage: {
            localId: messageLocalId,
            content: args.firstMessage.content,
            mentionedAccountIds,
          },
        }));
        const firstMessageEvidence = equalityEvidence(serializeSessionDiscussionMutationEqualityIntentV1({
          kind: 'post',
          content: args.firstMessage.content,
          mentionedAccountIds,
        }));
        const result = await request(bound, {
          context,
          actionId,
          body: buildSessionDiscussionMutationRequestBodyV1({
            kind: 'create',
            creationLocalId,
            ...(creationEvidence ? { creationEqualityEvidenceV1: creationEvidence } : {}),
            titleContent: sealDiscussionPayload(crypto, title),
            firstMessage: {
              localId: messageLocalId,
              ...(firstMessageEvidence ? { requestEqualityEvidenceV1: firstMessageEvidence } : {}),
              content: sealDiscussionPayload(crypto, args.firstMessage.content),
              mentionedAccountIds,
            },
          }),
          signal,
        });
        if (!result.ok) return result;
        const value = SessionDiscussionCreateResponseV1Schema.parse(result.data);
        return SessionDiscussionCreateResultV1Schema.parse({
          v: 1,
          serverId,
          sessionId,
          discussion: projectSummary(crypto, value.discussion),
          firstMessage: projectMessage(crypto, value.firstMessage),
        });
      }

      if (actionId === 'session.discussion.post') {
        const args = SessionDiscussionPostInputV1Schema.parse(parsed.data);
        const mentionedAccountIds = args.mentionedAccountIds ?? [];
        const requestEqualityEvidenceV1 = equalityEvidence(serializeSessionDiscussionMutationEqualityIntentV1({
          kind: 'post',
          content: args.content,
          mentionedAccountIds,
        }));
        const postRequest = buildSessionDiscussionMutationRequestBodyV1({
          kind: 'post',
          localId: args.localId ?? randomUUID(),
          ...(requestEqualityEvidenceV1 ? { requestEqualityEvidenceV1 } : {}),
          content: sealDiscussionPayload(crypto, args.content),
          mentionedAccountIds,
        });
        let value;
        if (context.surface === 'agent') {
          if (!options.postAgentMessage) return failure('session_discussion_post_denied');
          const origin = ApprovalRequestOriginV1Schema.safeParse(context.approvalOrigin);
          const runId = readNonEmptyString(context.runtimeRunId);
          const toolCallId = origin.success
            ? readNonEmptyString(origin.data.toolCallId)
            : readNonEmptyString(context.actionRequestId);
          let response: SessionDiscussionAgentPostResponseV1;
          try {
            response = SessionDiscussionAgentPostResponseV1Schema.parse(await options.postAgentMessage(
              SessionDiscussionAgentPostRequestV1Schema.parse({
                v: 1,
                sessionId,
                discussionId: args.discussionId,
                request: postRequest,
                ...(runId ? { runId } : {}),
                ...(toolCallId ? { toolCallId } : {}),
              }),
              signal ? { signal } : undefined,
            ));
          } catch {
            return failure('outcome_unknown');
          }
          if (!response.ok) return failure(response.error);
          value = response.value;
        } else {
          const result = await request(bound, {
            context,
            actionId,
            body: postRequest,
            signal,
          });
          if (!result.ok) return result;
          value = SessionDiscussionPostResponseV1Schema.parse(result.data);
        }
        return SessionDiscussionPostResultV1Schema.parse({
          v: 1,
          serverId,
          sessionId,
          message: projectMessage(crypto, value.message),
          messageSeq: value.messageSeq,
        });
      }

      if (actionId === 'session.discussion.rename') {
        const args = SessionDiscussionRenameInputV1Schema.parse(parsed.data);
        const title = SessionDiscussionTitleV1Schema.parse({ v: 1, title: args.title });
        const result = await request(bound, {
          context,
          actionId,
          body: buildSessionDiscussionMutationRequestBodyV1({
            kind: 'rename',
            titleContent: sealDiscussionPayload(crypto, title),
          }),
          signal,
        });
        if (!result.ok) return result;
        return SessionDiscussionDetailsResultV1Schema.parse({
          v: 1,
          serverId,
          sessionId,
          discussion: projectSummary(crypto, SessionDiscussionDetailsResponseV1Schema.parse(result.data).discussion),
        });
      }

      if (actionId === 'session.discussion.archive' || actionId === 'session.discussion.restore') {
        const result = await request(bound, { context, actionId, signal });
        if (!result.ok) return result;
        return SessionDiscussionDetailsResultV1Schema.parse({
          v: 1,
          serverId,
          sessionId,
          discussion: projectSummary(crypto, SessionDiscussionDetailsResponseV1Schema.parse(result.data).discussion),
        });
      }

      const result = await request(bound, {
        context,
        actionId,
        body: bound.body,
        signal,
      });
      if (!result.ok) return result;
      return SessionDiscussionReadStateResultV1Schema.parse({
        v: 1,
        serverId,
        sessionId,
        cursor: SessionDiscussionReadResponseV1Schema.parse(result.data),
      });
    },
  };
}
